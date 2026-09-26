import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import type { GameData } from '../../../packages/data/src/index.ts';
import type { Config } from './config.ts';
import { SkillMatcher, type SkillMatch } from '../../../packages/data/src/skill-match.ts';
import { checkNewIndividual } from './individual-request.ts';
import { IndividualStore } from './individuals.ts';
import { JobRunner, QueueFullError, type Job } from './jobs.ts';
import { OcrEngine } from './ocr.ts';
import { checkRequest, RequestError } from './request.ts';
import { classifierCoverage, classifierSkillIds, SkillClassifier } from './skill-classifier.ts';
import { ReadingJudge, SkillVerifier } from './skill-verify.ts';
import { readStatusHeader, StatusOutOfFrameError } from './status-reader.ts';

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

/**
 * 分類器（skill-classifier.ts）の確信度の下限。
 * 実機の1枚では、正しい行はほぼ1.0、空の行（一覧の末尾で片方の列だけ空く場合）
 * は0.5以下だった。間を大きく取ってある。
 */
const CLASSIFIER_MIN_CONFIDENCE = 0.5;

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

/** 画像を丸ごと受け取る。文字の本文より大きいので上限を別に持つ。 */
async function readBinaryBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new RequestError(`画像が大きすぎます（上限 ${Math.floor(limit / 1024 / 1024)} MB）。`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestError('本文が大きすぎます。');
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

/**
 * その場で縮める下限。これより小さいと縮めても効かず、CPU だけ使う。
 *
 * スキル一覧の表（apps/web/public/skill-list/<版>/<場>-<コース>.json、issue #83）は
 * 1 コース 200 KB 前後ある。縮めずに出すと、ここだけで他の資産を全部合わせたより大きくなる。
 * 数字の並びなので gzip がよく効く。
 */
const GZIP_MIN_BYTES = 64 * 1024;

/**
 * 縮めて効く型。画像とフォント（woff2）は既に圧縮済みなので触らない。
 */
const GZIP_TYPES = new Set(['.html', '.js', '.css', '.json', '.svg']);

/**
 * 名前が変わらないまま中身が入れ替わるファイル。**長く持たせてはいけない。**
 *
 * 資産は名前にハッシュが入り、スキル一覧の表はパスに版が入るので、どちらも不変にできる。
 * 入口だけが同じ名前のまま差し替わる。`index.html` と、スキル一覧の版を教える
 * `skill-list/index.json`（`SkillListIndex`、issue #83）がそれである。
 * 不変として配ると、**新しい版を置いても画面が古い名前を取りに行き続ける。**
 * 版がパスに入っている効き目が、入口のところで消える。
 */
const REVALIDATE_NAMES = new Set(['index.html', 'index.json']);

async function serveStatic(
  root: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // パスを正規化してから根の下にあることを確かめる。
  // "../" を含む要求で外に出られると、コンテナの中身が読めてしまう。
  const rootPath = resolve(root);
  const requested = normalize(decodeURIComponent(pathname));
  const target = resolve(join(rootPath, requested === '/' ? 'index.html' : requested));
  if (target !== rootPath && !target.startsWith(rootPath + sep)) return false;

  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    const head = req.method === 'HEAD';
    const gzip =
      !head &&
      info.size >= GZIP_MIN_BYTES &&
      GZIP_TYPES.has(extname(target)) &&
      /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      // 縮めると長さが先に分からない。chunked で流す。
      ...(gzip ? { 'content-encoding': 'gzip' } : { 'content-length': info.size }),
      // 名前にハッシュや版が付くものは長く持たせ、入口は持たせない。
      'cache-control': REVALIDATE_NAMES.has(basename(target))
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      // 縮めた応答と縮めていない応答が同じ URL で出る。手前に proxy を置いたときに
      // 取り違えられないようにする。
      vary: 'accept-encoding',
    });
    if (head) {
      res.end();
      return true;
    }
    const file = createReadStream(target);
    // 探索の Worker と同じコアを使うので、圧縮率より速さを取る。
    // 数字の並びなので、いちばん弱い段でも 10 分の 1 以下になる。
    if (gzip) file.pipe(createGzip({ level: 1 })).pipe(res);
    else file.pipe(res);
    return true;
  } catch {
    return false;
  }
}

export function createApiServer(config: Config, data: GameData, runner: JobRunner, individuals: IndividualStore) {
  // 読み取りは要求されたときに初めて立ち上げる。
  // 学習データの置き場が指定されていなければ、口ごと閉じる。
  const ocr =
    config.tessdataPath === null
      ? null
      : new OcrEngine({ tessdataPath: config.tessdataPath, threshold: config.ocrThreshold });
  const matcher = new SkillMatcher(data.skills);
  const skillClassifier = new SkillClassifier();
  // 分類モデルが名前を知らないスキルを、文字認識で拾い直す（skill-verify.ts）。
  // モデルは知らないスキルを「いちばん近い既知のスキル」として高い確信度で返すため、
  // 確信度では見分けられない。読み取りに使う口が無ければ裏取りもできない。
  const verifier =
    ocr === null ? null : new SkillVerifier(ocr, new ReadingJudge(data.skills, classifierSkillIds()));

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
        // 読み取りが使える版かどうかを、画面を触らずに確かめられるようにする
        ocr: ocr !== null,
        // スキル分類モデルの古さを見るための数。`skills` に対して `classifier.named`
        // がずっと少なければ、モデルが取り残されている（skill-classifier.ts）。
        skills: data.skills.length,
        classifier: classifierCoverage(),
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
        sendJson(res, 404, { error: '知らないジョブです。保持期間を過ぎて消えた可能性があります。' });
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
      sendJson(res, 405, { error: `${method} は受け付けません。` });
      return;
    }

    if (path === '/api/ocr/skills' && method === 'POST') {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!IMAGE_TYPES.includes(type)) {
        sendJson(res, 415, { error: `content-type は ${IMAGE_TYPES.join(' / ')} のいずれかにしてください。` });
        return;
      }
      let image: Buffer;
      try {
        image = await readBinaryBody(req, config.maxImageBytes);
      } catch (error) {
        sendJson(res, 413, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (image.length === 0) {
        sendJson(res, 400, { error: '本文が空です。' });
        return;
      }
      const started = performance.now();
      // 「ウマ娘詳細」画面のスキル一覧は、まず画像分類（skill-classifier.ts）で試す。
      // 文字認識と違い、丸いアイコンや装飾つきの背景に壊されない。分類器が行を
      // 1つも見つけられなければ（その形の画面ではない）、文字認識に任せる。
      // 画像として読めない場合も同様に任せ、文字認識側の「理由の付いた失敗」に
      // 揃える（分類器自身の生の例外をそのまま外に出さない）。
      let classified: Awaited<ReturnType<typeof skillClassifier.recognize>> = [];
      let classifyError: unknown = null;
      try {
        classified = await skillClassifier.recognize(image);
      } catch (error) {
        classifyError = error;
      }
      let text: string;
      let found: SkillMatch[];
      if (classified.length > 0) {
        text = '';
        // モデルの語彙に無いスキルは、いちばん近い既知のスキルとして高い確信度で
        // 返ってくる。同じ帯を文字認識にかけ、読めた文字を分類器の答えと比べる
        // （skill-verify.ts）。はっきり語彙に無い名前を指していれば置き換え、
        // 紛らわしければ要確認にする。
        const rows = classified.map((prediction) => ({
          crop: prediction.crop,
          predicted:
            prediction.skillId === null || prediction.confidence < CLASSIFIER_MIN_CONFIDENCE
              ? null
              : (data.skillsById.get(prediction.skillId) ?? null),
        }));
        const readings = verifier === null ? null : await verifier.read(image, rows);
        const bySkillId = new Map<string, SkillMatch>();
        for (const [index, prediction] of classified.entries()) {
          const predicted = rows[index]!.predicted;
          const reading = readings?.[index] ?? null;
          const verdict = reading?.verdict ?? { kind: 'keep' };
          let match: SkillMatch | null;
          // 文字認識の結果を使った行は、読めた文字をそのまま返す。
          // 画面で「なぜその答えになったか」を確かめられるようにしておく。
          if (verdict.kind === 'replace') {
            match = {
              skill: verdict.skill,
              text: reading!.text,
              score: verdict.score,
              margin: verdict.margin,
              runnerUp: null,
            };
          } else if (verdict.kind === 'doubt') {
            // 語彙に無いスキルらしいが、紛らわしい。そのスキルとして出し、分類器の
            // 答えを「かもしれません」に回す。差を 0 にして要確認にし、既定では
            // 選ばれないようにする（Import.tsx の `uncertain`）。`uncertain` は
            // 完全一致を紛れなしとみなすので、一致の度合いは 1 未満に抑える。
            match = {
              skill: verdict.skill,
              text: reading!.text,
              score: Math.min(verdict.score, 0.99),
              margin: 0,
              runnerUp: predicted,
            };
          } else if (predicted !== null) {
            match = {
              skill: predicted,
              text: predicted.name,
              score: prediction.confidence,
              margin: 1,
              runnerUp: null,
            };
          } else {
            match = null;
          }
          if (match === null) continue;
          const kept = bySkillId.get(match.skill.id);
          if (kept === undefined || match.score > kept.score) bySkillId.set(match.skill.id, match);
        }
        found = [...bySkillId.values()].sort((a, b) => b.score - a.score);
      } else if (ocr !== null) {
        const recognized = await ocr.recognize(image);
        text = recognized.text;
        found = matcher.matchAll(text);
      } else if (classifyError !== null) {
        const reason = classifyError instanceof Error ? classifyError.message : String(classifyError);
        throw new Error(`読み取りに失敗しました: ${reason}`);
      } else {
        text = '';
        found = [];
      }
      const matches = found.map((match) => ({
        id: match.skill.id,
        name: match.skill.name,
        rarity: match.skill.rarity,
        sp: match.skill.sp,
        text: match.text,
        score: match.score,
        margin: match.margin,
        runnerUp: match.runnerUp === null ? null : { id: match.runnerUp.id, name: match.runnerUp.name },
      }));
      sendJson(res, 200, { text, matches, elapsedMs: performance.now() - started });
      return;
    }

    if (path === '/api/ocr/status' && method === 'POST') {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!IMAGE_TYPES.includes(type)) {
        sendJson(res, 415, { error: `content-type は ${IMAGE_TYPES.join(' / ')} のいずれかにしてください。` });
        return;
      }
      if (ocr === null) {
        // スキルの読み取りと違い、こちらは分類器を持たない。文字認識が
        // 無ければできることが無いので、黙って空を返さずそう言う。
        // この文言は画面にそのまま出る。環境変数の名前は利用者には意味が無いので、
        // 置く側への案内は起動時のログ（main.ts）に任せる。
        sendJson(res, 503, {
          error: 'このサーバでは、ステータスの読み取りを使えません（文字認識の学習データが置かれていません）。',
        });
        return;
      }
      let image: Buffer;
      try {
        image = await readBinaryBody(req, config.maxImageBytes);
      } catch (error) {
        sendJson(res, 413, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (image.length === 0) {
        sendJson(res, 400, { error: '本文が空です。' });
        return;
      }
      const started = performance.now();
      let reading: Awaited<ReturnType<typeof readStatusHeader>>;
      try {
        reading = await readStatusHeader(image, ocr);
      } catch (error) {
        if (error instanceof StatusOutOfFrameError) {
          sendJson(res, 422, { error: error.message });
          return;
        }
        throw error;
      }
      sendJson(res, 200, {
        status: reading.status,
        aptitudes: reading.aptitudes,
        content: reading.content,
        elapsedMs: performance.now() - started,
      });
      return;
    }

    if (path === '/api/individuals' && method === 'GET') {
      sendJson(res, 200, { items: individuals.list() });
      return;
    }

    if (path === '/api/individuals' && method === 'POST') {
      let input;
      try {
        input = checkNewIndividual(JSON.parse(await readBody(req)), data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
        return;
      }
      sendJson(res, 201, individuals.create(input));
      return;
    }

    const individualMatch = /^\/api\/individuals\/([0-9a-f-]{36})$/.exec(path);
    if (individualMatch !== null && method === 'DELETE') {
      const removed = individuals.remove(individualMatch[1]!);
      if (!removed) {
        sendJson(res, 404, { error: '知らない個体です。' });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: '知らない口です。' });
      return;
    }

    if (config.staticRoot !== null && (method === 'GET' || method === 'HEAD')) {
      if (await serveStatic(config.staticRoot, path, req, res)) return;
      // サブパスに置いたとき、手前の reverse proxy がその接頭辞を外さずに
      // 転送してくる場合がある（例 "/raceemu/assets/x.js" をそのまま渡す）。
      // 資産はこの階層に無いので、先頭の 1 段を外した経路でも試す。
      const stripped = path.replace(/^\/[^/]+/, '') || '/';
      if (stripped !== path && (await serveStatic(config.staticRoot, stripped, req, res))) return;
      // **データを求める経路は index.html に落とさない。**
      // スキル一覧の表（/skill-list/<版>/<場>-<コース>.json、issue #83）のように取りに行く JSON は、
      // 無いときに HTML が 200 で返ると、読む側は JSON.parse が投げるまで気付けない。
      // 版を取り違えたのか配り忘れたのかも分からなくなるので、ここで 404 にする。
      if (extname(path) === '.json') {
        sendJson(res, 404, { error: '見つかりません。' });
        return;
      }
      // 残りは index.html に落とす。共有 URL はハッシュなので本来は要らないが、
      // 後で経路を足したときに 404 で詰まらないようにする。
      if (await serveStatic(config.staticRoot, '/index.html', req, res)) return;
    }

    sendJson(res, 404, { error: '見つかりません。' });
  }
}
