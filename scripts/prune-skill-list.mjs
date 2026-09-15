/**
 * スキル一覧の古い版を落とし、版とコースの一覧（index.json）を実際の中身に合わせる。
 *
 *   node scripts/prune-skill-list.mjs <ディレクトリ> <残す世代数> < <古さの一覧>
 *
 * 材料が動いた回だけ走る .github/workflows/build-skill-list.yml がこれを呼ぶ。
 * 決めごとの理由は docs/deploy.md の 6 節にある。
 *
 * ## 版はディレクトリである
 *
 * 表は**コースごとに 1 枚**配られ、1 つの版は `<版>/<場>-<コース>.json` を並べた
 * ディレクトリになる（`packages/solver/src/skill-list.ts`）。掃除の単位もディレクトリである。
 *
 * ## なぜ別のスクリプトにするか
 *
 * 掃除と index.json は**食い違っても誰も落ちない**。generations に消した版の名前が
 * 残っても、index.json は正しい JSON のままで、画面は取りに行って初めて 404 を引く。
 * 表が出ないのがネットワークのせいなのか配り方のせいなのかも区別が付かない。
 * ワークフローの中にシェルで書くと手元で動かせず、この食い違いを試せない。
 * ここに出してあるので test/workflows.test.ts が実際に走らせて確かめられる。
 *
 * ## 何をするか
 *
 * 1. 版を新しい順に並べる。**index.json が指す版（version）を必ず先頭に置く。**
 * 2. 先頭から <残す世代数> だけ残し、それより古いものをディレクトリごと消す。
 * 3. index.json の generations を、実際に残ったものに書き直す。
 *
 * **index.json は版ではない。** 掃除の対象から外す。並べて数えると、
 * 版として数えられて消えるか、いちばん古いものとして最初に落ちる。
 *
 * ## 並びをどう決めるか
 *
 * 標準入力から `<unix 秒> <版のディレクトリ名>` の行を読む。git の commit の時刻を渡す前提である。
 * checkout した直後はファイルの更新時刻が全部同じになるので、ファイルシステムからは決まらない。
 * **行の無い版は、まだ commit されていない＝今回作ったものとして、いちばん新しく扱う。**
 *
 * generations の並びには頼らない。CLI が何を書くかに関わらず、
 * 「何世代残すか」はワークフロー側の決めごとだからである（docs/deploy.md 6.5 節）。
 * version だけは CLI に従う。どの版が新しいかは、指紋を計算した CLI しか知らない。
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 版とコースの一覧の名前。`packages/solver/src/skill-list.ts` の `SkillListIndex`。 */
const INDEX_NAME = 'index.json';

/** 行の無い版に与える古さ。今回作ったものなので、いちばん新しい。 */
const NEWEST = Number.MAX_SAFE_INTEGER;

function fail(message) {
  // GitHub Actions の注釈にする。ログの流れの中で見落とさないようにする。
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * 掃除して index.json を書き直す。
 *
 * @param {string} dir 版を置いてあるディレクトリ
 * @param {number} keep 残す世代数
 * @param {Map<string, number>} ages 版のディレクトリ名 → 古さ（unix 秒）
 * @returns {{ version: string, generations: string[], removed: string[] }}
 */
export function pruneSkillList(dir, keep, ages) {
  let index;
  try {
    index = JSON.parse(readFileSync(join(dir, INDEX_NAME), 'utf8'));
  } catch (error) {
    // index.json が無いと、画面はどの版を取ればよいか分からない。
    // 表があっても配れていないのと同じなので、ここで赤にする。
    fail(`${dir}/${INDEX_NAME} を読めない（${error instanceof Error ? error.message : error}）`);
    return;
  }

  const version = index.version;
  if (typeof version !== 'string' || version === '') {
    fail(`${INDEX_NAME} に version が無い。生成が版の名前を書いていない`);
    return;
  }

  // 版はディレクトリである。index.json のような 1 枚は数えない。
  const present = readdirSync(dir).filter((name) => {
    if (name === INDEX_NAME) return false;
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (!present.includes(version)) {
    // 掃除の前から食い違っている。このまま配ると画面は 404 を引く。
    fail(`${INDEX_NAME} が指す版 ${version} が ${dir} に無い`);
    return;
  }
  if (!Array.isArray(index.courses) || index.courses.length === 0) {
    // コースが 1 本も載っていない一覧は、画面から見れば「表が無い」と同じである。
    fail(`${INDEX_NAME} にコースが 1 本も載っていない`);
    return;
  }

  // version を必ず先頭に。残りは新しい順。同じ古さなら名前で決めて、
  // 実行のたびに並びが変わらないようにする。
  const rest = present
    .filter((name) => name !== version)
    .sort((a, b) => (ages.get(b) ?? NEWEST) - (ages.get(a) ?? NEWEST) || a.localeCompare(b));
  const ordered = [version, ...rest];

  const generations = ordered.slice(0, Math.max(1, keep));
  const removed = ordered.slice(generations.length);
  for (const name of removed) rmSync(join(dir, name), { recursive: true, force: true });

  // generations を実際に残ったものに揃える。ここを飛ばすと、消した版の名前が
  // 残って画面が 404 を引く。version はそのまま（どれが新しいかは CLI しか知らない）。
  writeIndex(dir, { ...index, version, generations });

  return { version, generations, removed: removed.map((name) => join(dir, name)) };
}

/** 生成側と同じ書き方（2 段の字下げ + 末尾の改行）で書く。差分が読める形にする。 */
function writeIndex(dir, index) {
  writeFileSync(join(dir, INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`);
}

/** 標準入力の `<unix 秒> <版のディレクトリ名>` を読む。 */
function readAges(text) {
  const ages = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\d+) (.+)$/.exec(line.trim());
    if (match) ages.set(match[2], Number(match[1]));
  }
  return ages;
}

// 直に呼ばれたときだけ動かす。テストは pruneSkillList を import する。
if (process.argv[1]?.endsWith('prune-skill-list.mjs')) {
  const [dir, keepArg] = process.argv.slice(2);
  if (dir === undefined || keepArg === undefined) {
    fail('使い方: node scripts/prune-skill-list.mjs <ディレクトリ> <残す世代数>');
  }
  const keep = Number(keepArg);
  if (!Number.isInteger(keep) || keep < 1) fail(`残す世代数が読めない: ${keepArg}`);

  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;

  const result = pruneSkillList(dir, keep, readAges(stdin));
  console.log(`version: ${result.version}`);
  console.log(`generations: ${result.generations.join(' ')}`);
  // ワークフローがこの行を拾って PR 本文に載せる。
  console.log(`removed: ${result.removed.join(' ')}`);
}
