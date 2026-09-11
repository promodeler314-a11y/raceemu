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
