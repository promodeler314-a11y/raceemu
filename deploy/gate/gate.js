/**
 * raceemu ゲートウェイ
 *
 * Discord Bot が配ったマジックリンクを持っている人だけを raceemu に通し、
 * 誰が何をどれだけ使ったかを記録する。
 *
 * 口は 2 つ開ける。
 *   :8080  アプリ。raceemu.promodeler314.win をここに向ける。マジックリンクで守る。
 *   :8090  集計画面。別のホスト名を割り当て、Cloudflare Access で自分だけに絞る。
 *
 * トークンは Bot が MAGIC_SECRET で署名して作る。こちらは署名と期限を確かめるだけで、
 * 検証のたびに Bot へ問い合わせには行かない。Bot が落ちていても、配り終えたリンクは使える。
 * 1 回限りにするための使用済み記録だけ、こちら側の SQLite に持つ。
 *
 * 依存パッケージは無い。node:sqlite は Node 24 で標準に入っている。
 */

import { Agent, createServer, request as upstreamRequest } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が設定されていない`);
  return value;
}

const MAGIC_SECRET = required('MAGIC_SECRET');
const SESSION_SECRET = required('SESSION_SECRET');
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? 'raceemu.raceemu.svc.cluster.local';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 80);
const APP_PORT = Number(process.env.APP_PORT ?? 8080);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8090);
const DB_PATH = process.env.DB_PATH ?? '/data/usage.db';
const SESSION_HOURS = Number(process.env.SESSION_HOURS ?? 24);
const COOKIE = 'raceemu_session';

// Discord がリンクの検査で人より先に URL を取りに行き、1 回限りの権利を使い切ってしまう。
// 実際、成功した認証がすべて Discord 側のクラウド IP からで、利用者のブラウザには replay しか
// 返っていなかった。初回使用から下記の間だけ同じ使い捨て値での再発行を許して受け止める
// （Bot 側 F-13 のマジックリンクも同じ理由で 120 秒の猶予を持っている）。
const REUSE_GRACE_MS = Number(process.env.REUSE_GRACE_SECONDS ?? 120) * 1000;

// 中身を溜めて見るのは探索の口だけにする。記録に使う数字がそこにしか無いためである。
// ここを「/api/ で始まるもの全部」にすると、OCR に送る画像まで溜め込むことになり、
// MAX_BODY が通信の上限として効いてしまう（上流は画像を 8MB まで受けるのに、
// その手前で切られる）。溜めない経路は静的ファイルと同じく素通しで流す。
const INSPECT_PATH = /^\/api\/search(\/[0-9a-f-]{36})?$/;
const MAX_BODY = 1_000_000;

// 上流への接続は使い回さない。
// 上流は本文を読み切る前に応答して接続を落とすことがある（画像が上限を超えた時の 413 など）。
// こちらはまだ書いている最中なので書き込みが失敗し、壊れたソケットが keep-alive の
// プールに戻る。次の要求がそれを掴むと、無関係な経路が ECONNRESET で落ちる。
// 上流は同じクラスタの中にいて接続の確立が安い。使い回しをやめるほうが割に合う。
const upstreamAgent = new Agent({ keepAlive: false });

// ---------------------------------------------------------------- 署名

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** 署名と期限を確かめる。駄目なら null。理由は返さない（外に手掛かりを出さないため）。 */
function verify(token, secret) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  if (typeof payload.u !== 'string' || payload.u === '') return null;
  return payload;
}

// ---------------------------------------------------------------- 記録

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS used_tokens (
    nonce TEXT PRIMARY KEY,
    ts    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    user_id   TEXT NOT NULL,
    user_name TEXT,
    ip        TEXT,
    ua        TEXT
  );
  -- リクエスト 1 本ずつ持つと際限なく伸びるので、日 × 人で畳んでおく。
  CREATE TABLE IF NOT EXISTS traffic (
    day       TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    user_name TEXT,
    requests  INTEGER NOT NULL DEFAULT 0,
    bytes     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, user_id)
  );
  -- 探索は 1 件ずつ持つ。CPU の按分はここが元になる。
  CREATE TABLE IF NOT EXISTS jobs (
    job_id     TEXT PRIMARY KEY,
    ts         INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    user_name  TEXT,
    budget     INTEGER,
    candidates INTEGER,
    races      INTEGER,
    started    INTEGER,
    finished   INTEGER,
    status     TEXT
  );
`);

const stmt = {
  useToken: db.prepare('INSERT INTO used_tokens (nonce, ts) VALUES (?, ?)'),
  tokenUsedAt: db.prepare('SELECT ts FROM used_tokens WHERE nonce = ?'),
  dropOldTokens: db.prepare('DELETE FROM used_tokens WHERE ts < ?'),
  addSession: db.prepare(
    'INSERT INTO sessions (ts, user_id, user_name, ip, ua) VALUES (?, ?, ?, ?, ?)',
  ),
  addTraffic: db.prepare(`
    INSERT INTO traffic (day, user_id, user_name, requests, bytes) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (day, user_id) DO UPDATE
      SET requests = requests + 1, bytes = bytes + excluded.bytes, user_name = excluded.user_name
  `),
  addJob: db.prepare(`
    INSERT INTO jobs (job_id, ts, user_id, user_name, budget, candidates, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id) DO NOTHING
  `),
  updateJob: db.prepare(
    'UPDATE jobs SET races = ?, started = ?, finished = ?, status = ? WHERE job_id = ?',
  ),
  jobOwner: db.prepare('SELECT user_id FROM jobs WHERE job_id = ?'),
};

function today() {
  // 日本時間で日付を切る。集計を見るのが日本にいる人だけなので。
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 使用済みトークンは期限より充分に長く持てばよい。1 時間ごとに 7 日より古いものを捨てる。
setInterval(() => {
  try {
    stmt.dropOldTokens.run(Date.now() - 7 * 86400 * 1000);
  } catch (error) {
    log('warn', { at: 'cleanup', error: String(error) });
  }
}, 3600 * 1000).unref();

function log(level, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

// ---------------------------------------------------------------- 共通

function cookiesOf(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf !== '') return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff !== '') return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // ここで req.destroy() すると 413 を書き出す前に接続が切れ、
        // 呼び出し側には ECONNRESET しか見えない。読むのをやめるだけにして、
        // 応答は handler に任せる。
        req.pause();
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------- アプリ側の口

const DENIED_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>レースエミュレータ</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh;
         background: #14161a; color: #e6e8ea;
         font: 16px/1.7 system-ui, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0 0 .75rem; color: #b9bec4; }
  code { background: #1e2126; padding: .1em .4em; border-radius: .25rem; color: #e6e8ea; }
</style></head>
<body><main>
  <h1>🏇 このページは Discord から開く</h1>
  <p>サークルの Discord で <code>/raceemu</code> を実行すると、専用のリンクが届く。</p>
  <p>リンクは 15 分で切れ、1 回しか使えない。開いたあとは 24 時間そのまま使える。</p>
  <p>リンクが切れていたら、もう一度 <code>/raceemu</code> を実行する。</p>
</main></body></html>`;

/** 数えながら素通しさせる。 */
class Counter extends Transform {
  bytes = 0;
  _transform(chunk, _encoding, done) {
    this.bytes += chunk.length;
    done(null, chunk);
  }
}

function forward(req, res, user, requestBody) {
  const path = req.url ?? '/';
  const headers = { ...req.headers };
  // 上流にこちらのセッションを見せる必要はない。Host も上流のものに任せる。
  delete headers.cookie;
  delete headers.host;
  delete headers['content-length'];
  headers['x-raceemu-user'] = user.u;
  headers['x-forwarded-proto'] = 'https';
  if (requestBody !== null) headers['content-length'] = String(requestBody.length);

  const inspect = INSPECT_PATH.test(path);

  const up = upstreamRequest(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path, headers, agent: upstreamAgent },
    (upRes) => {
      // 上流が本文を読み切らずに応答したときは、こちらも送るのをやめる。
      req.unpipe(up);
      const status = upRes.statusCode ?? 502;
      if (!inspect) {
        const counter = new Counter();
        res.writeHead(status, upRes.headers);
        upRes.pipe(counter).pipe(res);
        res.on('close', () => countTraffic(user, counter.bytes));
        return;
      }
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          recordApi(req, path, status, body, user, requestBody);
        } catch (error) {
          log('warn', { at: 'record', path, error: String(error) });
        }
        res.writeHead(status, upRes.headers);
        res.end(body);
        countTraffic(user, body.length);
      });
    },
  );

  up.on('error', (error) => {
    log('error', { at: 'upstream', path, error: String(error) });
    if (!res.headersSent) sendHtml(res, 502, '<p>上流に届かない。</p>');
    else res.destroy();
  });

  if (requestBody !== null) up.end(requestBody);
  else req.pipe(up);
}

function countTraffic(user, bytes) {
  try {
    stmt.addTraffic.run(today(), user.u, user.n ?? null, bytes);
  } catch (error) {
    log('warn', { at: 'traffic', error: String(error) });
  }
}

/** 探索の要求と応答から、按分に使う数字を拾う。 */
function recordApi(req, path, status, body, user, requestBody) {
  const now = Date.now();
  if (path === '/api/search' && req.method === 'POST' && status === 202) {
    let budget = null;
    let candidates = null;
    if (requestBody !== null) {
      try {
        const sent = JSON.parse(requestBody.toString('utf8'));
        budget = typeof sent?.budget === 'number' ? sent.budget : null;
        candidates = Array.isArray(sent?.candidates) ? sent.candidates.length : null;
      } catch {
        // 上流が 202 を返した以上は読めるはずだが、読めなくても記録は残す。
      }
    }
    const view = JSON.parse(body.toString('utf8'));
    stmt.addJob.run(view.id, now, user.u, user.n ?? null, budget, candidates, view.status ?? null);
    log('info', {
      at: 'search',
      user: user.u,
      name: user.n,
      job: view.id,
      budget,
      candidates,
    });
    return;
  }
  const match = /^\/api\/search\/([0-9a-f-]{36})$/.exec(path);
  if (match !== null && status === 200) {
    const view = JSON.parse(body.toString('utf8'));
    stmt.updateJob.run(
      typeof view.races === 'number' ? view.races : null,
      typeof view.startedAt === 'number' ? view.startedAt : null,
      typeof view.finishedAt === 'number' ? view.finishedAt : null,
      view.status ?? null,
      match[1],
    );
  }
}

const appServer = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/__gate/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // マジックリンク。使い切ってからセッションを配る。
  const auth = /^\/auth\/(.+)$/.exec(path);
  if (auth !== null) {
    const payload = verify(decodeURIComponent(auth[1]), MAGIC_SECRET);
    if (payload === null) {
      sendHtml(res, 403, DENIED_PAGE);
      return;
    }
    const nonce = typeof payload.j === 'string' ? payload.j : null;
    if (nonce === null) {
      sendHtml(res, 403, DENIED_PAGE);
      return;
    }
    try {
      stmt.useToken.run(nonce, Date.now());
    } catch {
      // 主キー衝突。すでに使われたリンクである。初回使用からの間隔で扱いを分ける。
      const used = stmt.tokenUsedAt.get(nonce);
      const age = used === undefined ? Infinity : Date.now() - used.ts;
      if (age > REUSE_GRACE_MS) {
        log('warn', { at: 'auth', reason: 'replay', user: payload.u });
        sendHtml(res, 403, DENIED_PAGE);
        return;
      }
      // 猶予内。Discord の先回りに続く本人のアクセスとみなして通す。
      log('info', { at: 'auth', reason: 'grace', user: payload.u, ageMs: age });
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
    const session = sign({ u: payload.u, n: payload.n ?? null, exp }, SESSION_SECRET);
    stmt.addSession.run(
      Date.now(),
      payload.u,
      payload.n ?? null,
      clientIp(req),
      String(req.headers['user-agent'] ?? '').slice(0, 300),
    );
    log('info', { at: 'auth', user: payload.u, name: payload.n });
    res.writeHead(302, {
      location: '/',
      'set-cookie':
        `${COOKIE}=${session}; Path=/; Max-Age=${SESSION_HOURS * 3600}; ` +
        'HttpOnly; Secure; SameSite=Lax',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  const user = verify(cookiesOf(req)[COOKIE], SESSION_SECRET);
  if (user === null) {
    sendHtml(res, 403, DENIED_PAGE);
    return;
  }

  // 他人のジョブを ID で覗きに行けないようにする。上流は持ち主を知らない。
  const job = /^\/api\/search\/([0-9a-f-]{36})$/.exec(path);
  if (job !== null) {
    const owner = stmt.jobOwner.get(job[1]);
    if (owner !== undefined && owner.user_id !== user.u) {
      sendJson(res, 403, { error: '自分のジョブではない' });
      return;
    }
  }

  let requestBody = null;
  if (INSPECT_PATH.test(path) && (req.method === 'POST' || req.method === 'PUT')) {
    try {
      requestBody = await readBody(req, MAX_BODY);
    } catch {
      sendJson(res, 413, { error: '要求が大きすぎる' });
      return;
    }
  }
  forward(req, res, user, requestBody);
});

// ---------------------------------------------------------------- 集計側の口

function usage() {
  const traffic = db
    .prepare(
      `SELECT user_id, MAX(user_name) AS user_name, SUM(requests) AS requests,
              SUM(bytes) AS bytes, MAX(day) AS last_day
         FROM traffic GROUP BY user_id`,
    )
    .all();
  const searches = db
    .prepare(
      `SELECT user_id, COUNT(*) AS jobs, COALESCE(SUM(races), 0) AS races,
              COALESCE(SUM(CASE WHEN finished IS NOT NULL AND started IS NOT NULL
                                THEN finished - started ELSE 0 END), 0) AS ms
         FROM jobs GROUP BY user_id`,
    )
    .all();
  const byUser = new Map();
  for (const row of traffic) {
    byUser.set(row.user_id, {
      userId: row.user_id,
      userName: row.user_name,
      lastDay: row.last_day,
      requests: row.requests,
      bytes: row.bytes,
      jobs: 0,
      races: 0,
      searchMs: 0,
    });
  }
  for (const row of searches) {
    const entry = byUser.get(row.user_id) ?? {
      userId: row.user_id,
      userName: null,
      lastDay: null,
      requests: 0,
      bytes: 0,
      jobs: 0,
      races: 0,
      searchMs: 0,
    };
    entry.jobs = row.jobs;
    entry.races = row.races;
    entry.searchMs = row.ms;
    byUser.set(row.user_id, entry);
  }
  const users = [...byUser.values()].sort((a, b) => b.races - a.races || b.bytes - a.bytes);
  const recentJobs = db
    .prepare('SELECT * FROM jobs ORDER BY ts DESC LIMIT 50')
    .all();
  const recentLogins = db
    .prepare('SELECT ts, user_id, user_name, ip FROM sessions ORDER BY ts DESC LIMIT 50')
    .all();
  return { users, recentJobs, recentLogins };
}

function iec(bytes) {
  if (typeof bytes !== 'number') return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function jst(ms) {
  if (typeof ms !== 'number') return '-';
  return new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function dashboard() {
  const { users, recentJobs, recentLogins } = usage();
  const userRows = users
    .map(
      (u) => `<tr>
      <td>${escapeHtml(u.userName ?? u.userId)}</td>
      <td class="n">${u.requests}</td>
      <td class="n">${iec(u.bytes)}</td>
      <td class="n">${u.jobs}</td>
      <td class="n">${u.races.toLocaleString('en-US')}</td>
      <td class="n">${(u.searchMs / 1000).toFixed(1)} s</td>
      <td>${escapeHtml(u.lastDay ?? '-')}</td>
    </tr>`,
    )
    .join('');
  const jobRows = recentJobs
    .map(
      (j) => `<tr>
      <td>${jst(j.ts)}</td>
      <td>${escapeHtml(j.user_name ?? j.user_id)}</td>
      <td class="n">${j.budget ?? '-'}</td>
      <td class="n">${j.candidates ?? '-'}</td>
      <td class="n">${j.races === null ? '-' : j.races.toLocaleString('en-US')}</td>
      <td class="n">${
        j.finished !== null && j.started !== null ? ((j.finished - j.started) / 1000).toFixed(1) + ' s' : '-'
      }</td>
      <td>${escapeHtml(j.status ?? '-')}</td>
    </tr>`,
    )
    .join('');
  const loginRows = recentLogins
    .map(
      (s) => `<tr>
      <td>${jst(s.ts)}</td>
      <td>${escapeHtml(s.user_name ?? s.user_id)}</td>
      <td>${escapeHtml(s.ip ?? '-')}</td>
    </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>raceemu 利用状況</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem 1.5rem; background: #14161a; color: #e6e8ea;
         font: 14px/1.6 system-ui, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  h2 { font-size: .95rem; margin: 2rem 0 .5rem; color: #9aa2ab; font-weight: 600; }
  p.note { margin: 0 0 1rem; color: #7f878f; font-size: .85rem; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #262a30; white-space: nowrap; }
  th { color: #9aa2ab; font-weight: 600; font-size: .8rem; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:hover { background: #1a1d22; }
  .empty { color: #7f878f; padding: .6rem; }
</style></head>
<body>
  <h1>raceemu 利用状況</h1>
  <p class="note">時刻は日本時間。探索時間はジョブの開始から終了までの実時間で、Worker 4 本ぶんの合計ではない。</p>

  <h2>ユーザー別（累計）</h2>
  <div class="wrap"><table>
    <thead><tr><th>ユーザー</th><th class="n">リクエスト</th><th class="n">転送量</th>
    <th class="n">探索</th><th class="n">レース数</th><th class="n">探索時間</th><th>最終利用</th></tr></thead>
    <tbody>${userRows || '<tr><td colspan="7" class="empty">まだ記録がない</td></tr>'}</tbody>
  </table></div>

  <h2>直近の探索（50件）</h2>
  <div class="wrap"><table>
    <thead><tr><th>時刻</th><th>ユーザー</th><th class="n">予算</th><th class="n">候補</th>
    <th class="n">レース数</th><th class="n">所要</th><th>状態</th></tr></thead>
    <tbody>${jobRows || '<tr><td colspan="7" class="empty">まだ探索は走っていない</td></tr>'}</tbody>
  </table></div>

  <h2>直近のログイン（50件）</h2>
  <div class="wrap"><table>
    <thead><tr><th>時刻</th><th>ユーザー</th><th>IP</th></tr></thead>
    <tbody>${loginRows || '<tr><td colspan="3" class="empty">まだログインがない</td></tr>'}</tbody>
  </table></div>
</body></html>`;
}

const adminServer = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/__gate/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/usage.json') {
    sendJson(res, 200, usage());
    return;
  }
  if (path === '/') {
    sendHtml(res, 200, dashboard());
    return;
  }
  sendHtml(res, 404, '<p>無い。</p>');
});

appServer.listen(APP_PORT, () => log('info', { at: 'listen', port: APP_PORT, role: 'app' }));
adminServer.listen(ADMIN_PORT, () => log('info', { at: 'listen', port: ADMIN_PORT, role: 'admin' }));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    appServer.close();
    adminServer.close();
    db.close();
    process.exit(0);
  });
}
