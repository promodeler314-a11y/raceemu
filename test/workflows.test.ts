import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * GitHub Actions は `run:` を `bash -e` で回す。`-e` はパイプの途中の失敗を
 * 見ない。終了状態は最後のコマンドのものになる。
 *
 * `sync-skill-model` がこれで嵌まった。モデルの取得が 403 で落ちたのに、
 * 続く `tee` が成功したので job は緑になり、次の段が「差分なし」と判断して
 * 何もせずに終わった。**取り直しが動いていないことに気付けなかった。**
 *
 * 個々のワークフローに `set -o pipefail` を足して直したが、同じ書き方は
 * また現れる。ここで一括して見ておく。
 */
const DIR = '.github/workflows';

function steps(body: string): string[] {
  // `run: |` から、次の同じ深さの項目までを 1 つの塊として取る。
  return body.split(/^\s*- /m).filter((block) => block.includes('run: |'));
}

describe('ワークフローのシェル', () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith('.yml'));

  it('ワークフローを読めている', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const body = readFileSync(`${DIR}/${file}`, 'utf8');
    for (const [index, step] of steps(body).entries()) {
      // ヒアドキュメントや文字列の中の `|` ではなく、コマンドをつないでいる
      // ものだけを見たい。`| tee` と `| grep` のような素の連結を対象にする。
      const piped = /^\s+[^#\n]*\S \| \w/m.test(step);
      if (!piped) continue;

      it(`${file} の ${index + 1} 番目のパイプが失敗を握り潰さない`, () => {
        expect(step).toMatch(/set -o pipefail|set -[a-z]*o[a-z]* pipefail|set -eo pipefail/);
      });
    }
  }
});

/**
 * 本家の計算式の見張り（check-race-model）の配線を見る。
 *
 * この仕組みは 3 つの場所に分かれている。指紋を作るスクリプト、指紋を置く
 * マニフェスト、差分を見て PR を出すワークフローである。**ワークフローが見る
 * パスとスクリプトが書くパスが食い違っても、誰も落ちない。** 書き込みは成功し、
 * `git diff` は「変わっていない」と答え、毎週緑で何も起きなくなる。
 * pipefail の事故と同じ形（取れていないのに緑）なので、ここで結んでおく。
 */
describe('本家の計算式の見張り', () => {
  const workflow = readFileSync(`${DIR}/check-race-model.yml`, 'utf8');
  const script = readFileSync('scripts/check-race-model.py', 'utf8');

  /** スクリプトの `MANIFEST = ROOT / 'a' / 'b'` から、パスを組み立てる。 */
  const declaration = /MANIFEST = ROOT \/ (.+)/.exec(script);
  const manifestPath = [...(declaration?.[1] ?? '').matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .join('/');

  it('スクリプトのマニフェストの置き場を読める', () => {
    expect(manifestPath).toMatch(/\.json$/);
  });

  it('ワークフローがスクリプトを呼んでいる', () => {
    expect(workflow).toContain('python3 scripts/check-race-model.py');
  });

  it('ワークフローが見るパスとスクリプトが書くパスが同じ', () => {
    expect(workflow).toContain(`git diff --quiet -- ${manifestPath}`);
    expect(workflow).toContain(`git add ${manifestPath}`);
  });

  it('マニフェストが本家の race モジュールの指紋を持っている', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      repository: string;
      files: Record<string, string>;
    };
    expect(manifest.repository).toBe('mee1080/umasim');

    const entries = Object.entries(manifest.files);
    // 空で上書きされていたら差分が出なくなる。件数は 2026 年 9 月時点で 13。
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [path, fingerprint] of entries) {
      expect(path.startsWith('race/')).toBe(true);
      // git の blob SHA-1。`git ls-tree -r main -- race` と突き合わせられる。
      expect(fingerprint).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('計算の中心になるファイルを取りこぼしていない', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, string>;
    };
    const kotlin = 'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/';
    // 移植元のうち、動いたら必ず読みに行くもの。本家がファイルを改名したら
    // ここが落ちる。そのときはマニフェストとスクリプトの対応表を直す。
    for (const name of [
      'calc2/RaceCalculator.kt',
      'calc2/RaceState.kt',
      'calc2/SkillChecker.kt',
      'data/constants.kt',
      'data2/SkillData.kt',
    ]) {
      expect(Object.keys(manifest.files)).toContain(kotlin + name);
    }
  });
});
