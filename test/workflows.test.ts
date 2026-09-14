import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * スキル一覧の表の作り直し（build-skill-list）の配線を見る。
 *
 * この仕組みも check-race-model と同じ形で 3 つに分かれている。表の版を決める
 * 契約（`packages/solver/src/skill-list.ts` の `SkillListDataset`）、表を書く CLI、
 * 版が動いたことを見て作り直すワークフローである。
 *
 * **契約に材料が 1 つ増えても、ワークフローは落ちない。** 増えた材料が動いた週に
 * 何も起きず、古い表がそのまま配られ続ける。値が古いことは表を見ても分からない
 * （もっともらしい数字が並ぶ）ので、ここで件数を結んでおく。
 *
 * 場所についても同じで、生成・差分・掃除・commit のどれかが別の場所を見ると
 * 毎回「差分なし」で緑になる。ワークフローは `OUT_DIR` の 1 か所だけで場所を
 * 決めているので、それが実際に使い回されていることを見る。
 */
describe('スキル一覧の表の作り直し', () => {
  const workflow = readFileSync(`${DIR}/build-skill-list.yml`, 'utf8');
  const contract = readFileSync('packages/solver/src/skill-list.ts', 'utf8');

  /** 生成先。ワークフローの `env:` に 1 か所だけ書いてある。 */
  const outDir = /^\s*OUT_DIR:\s*(\S+)\s*$/m.exec(workflow)?.[1] ?? '';
  /** リポジトリに残す世代数。 */
  const keep = Number(/^\s*KEEP:\s*'(\d+)'\s*$/m.exec(workflow)?.[1]);

  /** `on: push: paths:` が見張っているファイルの一覧。 */
  const watched = [
    ...(/^\s*paths:\n((?:[ \t]*(?:#[^\n]*|- \S+)\n)+)/m.exec(workflow)?.[1] ?? '').matchAll(
      /^\s*- (\S+)$/gm,
    ),
  ].map((match) => match[1]!);

  /** `SkillListDataset` が持つ材料の数。 */
  const datasetFields = [
    ...(/export interface SkillListDataset \{\n([\s\S]*?)\n\}/.exec(contract)?.[1] ?? '').matchAll(
      /^\s*readonly (\w+):/gm,
    ),
  ].map((match) => match[1]!);

  it('ワークフローの置き場と世代数を読めている', () => {
    expect(outDir).toMatch(/^apps\/web\/public\//);
    expect(keep).toBeGreaterThanOrEqual(1);
  });

  it('生成・差分・掃除・commit が同じ場所を見ている', () => {
    expect(workflow).toContain('mkdir -p "$OUT_DIR"');
    expect(workflow).toContain('git ls-files --others --exclude-standard -- "$OUT_DIR"');
    expect(workflow).toContain('for f in "$OUT_DIR"/*.json');
    expect(workflow).toContain('git add -A "$OUT_DIR"');
    // 場所を書くのは `env:` の 1 行だけにする。段の中に素のパスを書くと、
    // 置き場を移したときに片方だけが残って黙ってズレる（コメントは数えない）。
    const bare = workflow
      .split('\n')
      .filter((line) => line.includes(outDir) && !/^\s*#/.test(line));
    expect(bare).toHaveLength(1);
  });

  it('版を決める材料が 1 つ残らず見張られている', () => {
    // 契約の材料は 4 つ（skills / courses / raceModel / fieldProfile）。
    // 増やしたらワークフローの paths も増やす。
    expect(datasetFields.length).toBeGreaterThanOrEqual(4);
    expect(watched).toHaveLength(datasetFields.length);
    for (const path of watched) {
      // 綴りを間違えても GitHub は黙って「一致しない」と答えるだけなので、
      // 実在することをここで見る。
      expect(existsSync(path), `${path} が無い`).toBe(true);
    }
  });

  it('材料のそれぞれに対応する道がある', () => {
    for (const path of [
      'packages/data/assets/skills.json',
      'packages/data/assets/courses.json',
      'packages/sim/upstream/race-manifest.json',
      // 相手の束の作り方（defaultFieldProfile）
      'packages/sim/src/field/field.ts',
    ]) {
      expect(watched).toContain(path);
    }
  });

  it('生成が何も書かなかったときに赤で落ちる', () => {
    // 「差分なしで緑」の事故はここでも起こりうる。CLI が黙って終わったら、
    // 次の段は差分が無いと判断して何もせずに終わる。
    expect(workflow).toContain('if ! ls "$OUT_DIR"/*.json >/dev/null 2>&1; then');
    expect(workflow).toMatch(/JSON が 1 つも無い[\s\S]*?exit 1/);
  });

  it('残す世代数の理由が docs にある', () => {
    expect(readFileSync('docs/deploy.md', 'utf8')).toContain(`${keep} 世代`);
  });
});

/**
 * 生成の CLI が入っていれば、ワークフローとの配線も見る。
 *
 * CLI（`packages/solver/src/skill-list-cli.ts`）はワークフローとは別に入る。
 * **CLI が別の場所へ書くと、ワークフローは毎回「差分なし」で緑になる。**
 * 手元の材料に依るテスト（読み取りの 7 件など）と同じで、無ければ静かに飛ばす。
 */
const SKILL_LIST_CLI = 'packages/solver/src/skill-list-cli.ts';
describe.skipIf(!existsSync(SKILL_LIST_CLI))('スキル一覧の CLI とワークフローの配線', () => {
  const workflow = readFileSync(`${DIR}/build-skill-list.yml`, 'utf8');
  const outDir = /^\s*OUT_DIR:\s*(\S+)\s*$/m.exec(workflow)?.[1] ?? '';

  it('ワークフローが呼ぶ pnpm のスクリプトが package.json にある', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(workflow).toContain('pnpm skill-list |');
    expect(Object.keys(pkg.scripts)).toContain('skill-list');
    expect(pkg.scripts['skill-list']).toContain('skill-list-cli.ts');
  });

  it('CLI が書く場所とワークフローが見る場所が同じ', () => {
    expect(readFileSync(SKILL_LIST_CLI, 'utf8')).toContain(outDir);
  });
});
