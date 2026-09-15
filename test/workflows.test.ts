import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** 掃除と `index.json` の整合を持つスクリプト。 */
const PRUNE = 'scripts/prune-skill-list.mjs';

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
    // 版はディレクトリである（1 コース 1 枚を並べたもの）。掃除もその単位で数える。
    expect(workflow).toContain('for d in "$OUT_DIR"/*/');
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

  it('分片が何も書かなかったときに赤で落ちる', () => {
    // 「差分なしで緑」の事故はここでも起こりうる。CLI が黙って終わったら、
    // まとめる段は「そのコースは測っていない」と判断して緑で終わる。
    expect(workflow).toMatch(/コースを 1 枚も書いていない[\s\S]*?exit 1/);
    // 分片が全部こけた回も、表が無いまま PR を出してはならない。
    expect(workflow).toMatch(/分片の成果が 1 つも無い[\s\S]*?exit 1/);
  });

  it('全 137 コースを分けて回し、分片の数が matrix と合っている', () => {
    // **食い違うと、測られないコースが黙って出る。**
    // 分片 i は i, i+N, i+2N ... を取るので、N が matrix より大きければ
    // 上のほうの分片が 1 本も走らず、そのコースは永久に測られない。
    const shards = Number(/^\s*SHARDS:\s*'(\d+)'\s*$/m.exec(workflow)?.[1]);
    const matrix = /^\s*shard: \[([^\]]*)\]\s*$/m
      .exec(workflow)?.[1]
      ?.split(',')
      .map((value) => Number(value.trim()));
    expect(shards).toBeGreaterThan(1);
    expect(matrix).toEqual(Array.from({ length: shards }, (_, i) => i));
    expect(workflow).toContain('--shard "${{ matrix.shard }}/$SHARDS"');
  });

  it('1 ジョブの上限（6 時間）に収まる時間で切ってある', () => {
    const limits = [...workflow.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map((m) =>
      Number(m[1]),
    );
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) expect(limit).toBeLessThanOrEqual(360);
  });

  it('分片が 1 本こけても、測れたぶんは配る', () => {
    // 表はコースごとに 1 枚なので、こけた分片のコースが載らないだけである。
    // fail-fast で全部捨てると、何十時間かけた他の分片まで無駄になる。
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('if: ${{ always() }}');
    // こけたことは PR 本文に出す。黙って少ないコースを配ってはならない。
    expect(workflow).toContain('needs.measure.result');
  });

  it('残す世代数の理由が docs にある', () => {
    expect(readFileSync('docs/deploy.md', 'utf8')).toContain(`${keep} 世代`);
  });

  it('版とコースの一覧が無ければ赤で落ちる', () => {
    // index.json が無いと、画面はどの版のどのコースを取ればよいか分からない。
    // 表があっても配れていないのと同じである。
    expect(workflow).toContain('if [ ! -f "$OUT_DIR/index.json" ]; then');
    expect(workflow).toMatch(/index\.json が無い[\s\S]*?exit 1/);
  });

  it('掃除がスクリプトを呼んでいる', () => {
    expect(workflow).toContain(`node ${PRUNE} "$OUT_DIR" "$KEEP"`);
  });
});

/**
 * 掃除と、版を教える 1 枚（`index.json`）の整合を見る。
 *
 * **食い違っても誰も落ちない。** `generations` に消した版の名前が残っても
 * `index.json` は正しい JSON のままで、画面は取りに行って初めて 404 を引く。
 * 表が出ないのがネットワークのせいなのか配り方のせいなのかも区別が付かない。
 * pipefail の事故や check-race-model のパスの食い違いと同じ形（壊れているのに静か）
 * なので、**実際に走らせて**確かめる。
 */
describe('スキル一覧の掃除', () => {
  const script = readFileSync(PRUNE, 'utf8');

  /**
   * 見本を作って掃除を走らせ、あとに残ったものと `index.json` を返す。
   *
   * ワークフローと同じように子プロセスで呼ぶ。引数と標準入力の読み方まで含めて
   * 通しで見たいからである（呼び出しの形が変わると、本番でだけ壊れる）。
   *
   * **版はディレクトリである。** 1 コース 1 枚を並べたものが 1 つの版になる。
   */
  function run(
    versions: readonly string[],
    index: unknown,
    keep: number,
    ages: readonly string[] = [],
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'raceemu-prune-'));
    try {
      for (const name of versions) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, '10006-10606.json'), '{"format":2}');
      }
      writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
      const run = spawnSync('node', [PRUNE, dir, String(keep)], {
        input: `${ages.join('\n')}\n`,
        encoding: 'utf8',
      });
      const left = readdirSync(dir).sort();
      const after =
        run.status === 0
          ? (JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
              version: string;
              generations: string[];
              courses: unknown[];
            })
          : { version: '', generations: [], courses: [] };
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, left, after };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** コースが 1 本載った一覧。掃除はコースの中身を見ないので、1 本あれば足りる。 */
  const withCourses = (version: string, generations: readonly string[]) => ({
    format: 2,
    version,
    generations,
    courses: [{ course: { location: 10006, course: 10606 }, file: `${version}/10006-10606.json` }],
  });

  // 古い順に a → b、いちばん新しい c はまだ commit されていない（行が無い）。
  const AGES = ['1700000000 v2-a', '1800000000 v2-b'];

  it('掃除のあとに index.json が指す版が実在する', () => {
    const { status, left, after } = run(
      ['v2-a', 'v2-b', 'v2-c'],
      withCourses('v2-c', ['v2-c', 'v2-b', 'v2-a']),
      2,
      AGES,
    );
    expect(status).toBe(0);
    expect(left).toContain(after.version);
    for (const name of after.generations) expect(left).toContain(name);
  });

  it('generations に消した版が残らない', () => {
    const { left, after, stdout } = run(
      ['v2-a', 'v2-b', 'v2-c'],
      withCourses('v2-c', ['v2-c', 'v2-b', 'v2-a']),
      2,
      AGES,
    );
    // 新しい 2 世代（c と b）が残り、いちばん古い a が落ちる。
    expect(after.generations).toEqual(['v2-c', 'v2-b']);
    expect(left).toEqual(['index.json', 'v2-b', 'v2-c']);
    // ワークフローが PR 本文に載せる行。
    expect(stdout).toMatch(/^removed: .*v2-a$/m);
  });

  it('index.json そのものは版として数えない', () => {
    // 残す世代数が 1 でも、index.json は消えない。並べて数えていると、
    // 版として落ちるか、いちばん古いものとして最初に消える。
    const { left, after } = run(['v2-a', 'v2-b'], withCourses('v2-b', ['v2-b', 'v2-a']), 1, AGES);
    expect(left).toEqual(['index.json', 'v2-b']);
    expect(after.generations).toEqual(['v2-b']);
  });

  it('いまの版は残す世代数によらず必ず残る', () => {
    // 版が変わらなかった回に force で作り直すと、いまの版が
    // 「commit の時刻がいちばん古い」側に来ることがありうる。
    const { left, after } = run(['v2-a', 'v2-b'], withCourses('v2-a', ['v2-a']), 1, AGES);
    expect(left).toEqual(['index.json', 'v2-a']);
    expect(after.version).toBe('v2-a');
    expect(after.generations).toEqual(['v2-a']);
  });

  it('index.json が指す版が無ければ赤で落ちる', () => {
    // 掃除の前から食い違っている場合。このまま配ると画面は 404 を引く。
    const { status, stderr } = run(['v2-a'], withCourses('v2-gone', ['v2-gone']), 2, AGES);
    expect(status).toBe(1);
    expect(stderr).toContain('::error::');
    expect(stderr).toContain('v2-gone');
  });

  it('コースが 1 本も載っていない一覧は赤で落ちる', () => {
    // 画面から見れば「表が無い」のと同じである。緑で配ってはならない。
    const { status, stderr } = run(
      ['v2-a'],
      { format: 2, version: 'v2-a', generations: ['v2-a'], courses: [] },
      2,
      AGES,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('::error::');
  });

  it('版とコースの一覧が読めなければ赤で落ちる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raceemu-prune-'));
    try {
      mkdirSync(join(dir, 'v2-a'), { recursive: true });
      const result = spawnSync('node', [PRUNE, dir, '2'], { input: '', encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('::error::');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('使い方が書いてある', () => {
    expect(script).toContain('node scripts/prune-skill-list.mjs');
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
    expect(workflow).toContain('pnpm skill-list \\');
    expect(workflow).toContain('pnpm skill-list-collect');
    expect(Object.keys(pkg.scripts)).toContain('skill-list');
    expect(pkg.scripts['skill-list']).toContain('skill-list-cli.ts');
    expect(pkg.scripts['skill-list-collect']).toContain('skill-list-collect-cli.ts');
  });

  it('CLI が書く場所とワークフローが見る場所が同じ', () => {
    expect(readFileSync(SKILL_LIST_CLI, 'utf8')).toContain(outDir);
  });

  it('分片の取りまとめと生成が同じ版を計算する', () => {
    // **ここが食い違うと、置いてあるコースを 1 本も見つけられない。**
    // 画面からは「表が無い」と区別が付かないまま緑で終わる。
    const collect = readFileSync('packages/solver/src/skill-list-collect-cli.ts', 'utf8');
    for (const source of [readFileSync(SKILL_LIST_CLI, 'utf8'), collect]) {
      expect(source).toContain('readSkillListDataset');
      expect(source).toContain('skillListVersion');
    }
  });
});
