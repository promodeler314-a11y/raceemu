import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { GameData } from '../../../packages/data/src/index.ts';
import type { Config } from './config.ts';
import { JobRunner, QueueFullError, type Job } from './jobs.ts';
import { checkRequest, RequestError } from './request.ts';

/**
 * HTTP の口。
 *
 * アプリと同じオリジンで配る前提なので CORS は付けない。
 * 別オリジンに置くと CORS が要り、平文で出すと mixed content で落ちる。
 * [サーバ側で探索を回す設計](../../../docs/server-design.md)の 5 節を参照。
 *
 * 認証も持たない。Cloudflare Access を前に置く前提である。
 */

const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestError('本文が大きすぎる');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 応答に載せる形。内部の Job から、外に見せてよいものだけを取る。 */
function toView(job: Job) {
  return {
    id: job.id,
    status: job.status,
    races: job.races,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
  };
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<boolean> {
  // パスを正規化してから根の下にあることを確かめる。
  // "../" を含む要求で外に出られると、コンテナの中身が読めてしまう。
  const rootPath = resolve(root);
  const requested = normalize(decodeURIComponent(pathname));
  const target = resolve(join(rootPath, requested === '/' ? 'index.html' : requested));
  if (target !== rootPath && !target.startsWith(rootPath + sep)) return false;

  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'content-length': info.size,
      // 名前にハッシュが付く資産は長く持たせ、index.html は持たせない。
      'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(target).pipe(res);
    return true;
  } catch {
    return false;
  }
}

export function createApiServer(config: Config, data: GameData, runner: JobRunner) {
  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        concurrency: config.concurrency,
        concurrencySource: config.concurrencySource,
        maxRacesPerJob: config.maxRacesPerJob,
        ...runner.stats(),
      });
      return;
    }

    if (path === '/api/search' && method === 'POST') {
      let request;
      try {
        request = checkRequest(JSON.parse(await readBody(req)), data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
        return;
      }
      try {
        const job = runner.submit(request);
        sendJson(res, 202, toView(job));
      } catch (error) {
        if (error instanceof QueueFullError) sendJson(res, 503, { error: error.message });
        else throw error;
      }
      return;
    }

    const match = /^\/api\/search\/([0-9a-f-]{36})$/.exec(path);
    if (match !== null) {
      const id = match[1]!;
      const job = runner.get(id);
      if (job === undefined) {
        sendJson(res, 404, { error: '知らないジョブである。保持期間を過ぎて消えた可能性がある。' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, toView(job));
        return;
      }
      if (method === 'DELETE') {
        runner.cancel(id);
        sendJson(res, 200, toView(job));
        return;
      }
      sendJson(res, 405, { error: `${method} は受け付けない` });
      return;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: '知らない口である' });
      return;
    }

    if (config.staticRoot !== null && (method === 'GET' || method === 'HEAD')) {
      if (await serveStatic(config.staticRoot, path, res)) return;
      // 見つからないものは index.html に落とす。共有 URL はハッシュなので
      // 本来は要らないが、後で経路を足したときに 404 で詰まらないようにする。
      if (await serveStatic(config.staticRoot, '/index.html', res)) return;
    }

    sendJson(res, 404, { error: '見つからない' });
  }
}
