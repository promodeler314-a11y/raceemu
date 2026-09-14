/**
 * スキル一覧の事前計算。
 *
 * 全スキルを「1 つだけ足したときの短縮量」で測り、コース・脚質・基準個体ごとに並べて配る。
 * 配る形は `skill-list.ts` にある。回すのは `skill-list-cli.ts`。
 *
 * ここが持つのは次の 3 つである。
 *
 * 1. **代表コースと基準個体**。表の読み方はこの 2 つで決まる（下の注記）。
 * 2. **測り方**。組ごとに基準を 1 回だけ走らせ、候補はそこからの共通乱数のペア比較で測る。
 * 3. **列への詰め方**。行を素直に並べると数十 MB になるので、列ごとの配列にする。
 *
 * docs/roadmap.md 3.9 節を参照。
 */
import type { GameData } from '../../data/src/index.ts';
import type { Style } from '../../sim/src/data/constants.ts';
import { defaultFieldProfile } from '../../sim/src/field/field.ts';
import { SimulationCancelled, type WorkerPool } from '../../sim/src/parallel/pool.ts';
import {
  SKILL_STAT,
  toSerializable,
  type CriticalSpec,
  type FieldSpec,
  type SerializableRaceSetting,
} from '../../sim/src/parallel/protocol.ts';
import {
  DerivedSetting,
  emptyPassiveBonus,
  type RaceSetting,
  type SystemSetting,
} from '../../sim/src/setting.ts';
import { classifySkill, type Fidelity } from '../../sim/src/skill/classify.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';
import { createCostModel } from './cost.ts';
import { pairedDiff, type Evaluation } from './optimize.ts';
import { canTrigger } from './screen.ts';
import type {
  SkillListBaseline,
  SkillListCategory,
  SkillListColumns,
  SkillListCourse,
  SkillListFile,
  SkillListSettings,
} from './skill-list.ts';

/** 表に載せる脚質。並びは `constants.ts` の Style と同じにする。 */
export const SKILL_LIST_STYLES: readonly Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];

export const SKILL_LIST_CATEGORIES: readonly SkillListCategory[] = ['SHORT', 'MILE', 'MIDDLE', 'LONG'];

/**
 * 代表コース。距離帯 4 × バ場 2 で 8 本ある。
 *
 * **全コースは回せない。** 芝とダートで 137 本あり、1 本増えるごとに
 * 脚質 4 × 基準 2 × 候補数のレースが増える。距離帯ごとに 1 本に絞ってある。
 *
 * 選び方は「その距離帯でゲームの G1 が実際に走るコースを 1 本」である。
 * 表を読む人はチャンピオンズミーティングを見ており、そこで使われるコースを知りたい。
 * コース数が最も多い距離（`courseDistances` で数えられる）にもおおむね当たっている。
 * 唯一 芝長距離だけは 2600m が最多（5 本）だが、菊花賞の 3000m を採った。
 * 長距離の表がスタミナで決まる以上、2600m より 3000m のほうが距離帯を代表する。
 *
 * **ここを変えたら表は作り直しになる**（版は材料の指紋で決まるので自動では変わらない。
 * コースを増減させたときは `courses` の中身が変わるので、読み手には見える）。
 */
export interface RepresentativeCourse {
  readonly category: SkillListCategory;
  /** 1=芝 2=ダート */
  readonly surface: number;
  readonly location: number;
  readonly course: number;
  /** なぜこのコースなのか。docs と CLI の出力に出す。 */
  readonly reason: string;
}

export const REPRESENTATIVE_COURSES: readonly RepresentativeCourse[] = [
  { category: 'SHORT', surface: 1, location: 10005, course: 10501, reason: '中山 芝1200m(外)。スプリンターズS の舞台。芝短距離で最もコース数の多い 1200m' },
  { category: 'MILE', surface: 1, location: 10006, course: 10602, reason: '東京 芝1600m。安田記念・ヴィクトリアマイルの舞台。芝マイルで最もコース数の多い 1600m' },
  { category: 'MIDDLE', surface: 1, location: 10006, course: 10606, reason: '東京 芝2400m。日本ダービー・ジャパンCの舞台。リポジトリの既定コースでもあり、他の実測と並べられる' },
  { category: 'LONG', surface: 1, location: 10008, course: 10810, reason: '京都 芝3000m(外)。菊花賞の舞台。最多は 2600m だが、長距離の表はスタミナで決まるので長いほうを採った' },
  { category: 'SHORT', surface: 2, location: 10005, course: 10508, reason: '中山 ダート1200m。ダート短距離で最もコース数の多い 1200m' },
  { category: 'MILE', surface: 2, location: 10006, course: 10611, reason: '東京 ダート1600m。フェブラリーS の舞台。ダートの G1 はここにある' },
  { category: 'MIDDLE', surface: 2, location: 10006, course: 10613, reason: '東京 ダート2400m。ダート中距離で最もコース数の多い 2400m' },
  { category: 'LONG', surface: 2, location: 10005, course: 10511, reason: '中山 ダート2500m。ダートの長距離はこの 1 距離（2 本）しか無い' },
];

/**
 * 基準個体のステータス。スタミナだけは距離帯ごとに差し替える。
 *
 * **「普通」は相手の束と同じ個体である。**`defaultFieldProfile` が持つ
 * 1100 / 900 / 900 / 600 / 900 をそのまま使う。相手は自分と同格に引き直されるので
 * （`matchSelf`）、普通の行は「同格の集団の中の 1 頭」の話になる。
 * 借り物ではあるが、リポジトリが既に「同格」と決めて使っている唯一の数値である。
 *
 * **「強い」は普通に一律 +150 した個体である。**相手の強さを振る口が
 * `FieldProfile.offset`（一律に足す）なので、その使い方に倣った。
 * ただし **+150 という幅は勘である。** ゲームからの実測ではない。
 * 2 段あることに意味があり、段の間隔そのものに根拠は無い。
 */
const NORMAL_SKELETON = { speed: 1100, power: 900, guts: 600, wisdom: 900 } as const;
/** 強いほうの上乗せ。勘である（上の注記）。 */
export const STRONG_OFFSET = 150;

/**
 * 距離帯ごとのスタミナ。**これは実測で決めた。**
 *
 * 距離帯によらず同じスタミナを置くと、長距離の行は「最大スパートに届かない個体」の
 * 話になり、回復スキルだけが並ぶ表になる。逆に短距離では余り、回復が一切効かない
 * 表になる。どちらも「この表はどの個体の話か」に答えられない。
 *
 * そこで逆算器（`critical.ts`、目標は最大スパート）で代表コースごとに
 * 「最大スパートに要る最小スタミナ」の分布を取り、分位点を採った。
 *
 * - 普通：**50 パーセンタイル**。五分五分で最大スパートが出る個体になる。
 *   回復と速度のどちらも効く、いちばん読み分けが要る位置である。
 * - 強い：**90 パーセンタイル**。ほぼ確実に最大スパートが出る個体になる。
 *   ここでは回復はほとんど効かず、速度と加速の比べ合いになる。
 *
 * 測り直す手順は `pnpm skill-list --calibrate`。結果は docs/roadmap.md 3.9 節にある。
 * 25 の倍数に丸めてある（分位点の標準誤差より細かい桁は意味を持たない）。
 */
export interface StaminaTier {
  readonly normal: number;
  readonly strong: number;
}

export const CALIBRATED_STAMINA: Readonly<Record<string, StaminaTier>> = {
  /** 中山 芝1200m(外)。200 は探索の下限で、短距離ではスタミナが縛りにならない */
  '1:SHORT': { normal: 200, strong: 250 },
  /** 東京 芝1600m */
  '1:MILE': { normal: 300, strong: 400 },
  /** 東京 芝2400m */
  '1:MIDDLE': { normal: 725, strong: 850 },
  /** 京都 芝3000m(外)。4.6 % の試行は 1600 でも最大スパートに届かなかった */
  '1:LONG': { normal: 1225, strong: 1500 },
  /** 中山 ダート1200m */
  '2:SHORT': { normal: 200, strong: 250 },
  /** 東京 ダート1600m */
  '2:MILE': { normal: 325, strong: 425 },
  /** 東京 ダート2400m */
  '2:MIDDLE': { normal: 900, strong: 1000 },
  /** 中山 ダート2500m */
  '2:LONG': { normal: 900, strong: 1025 },
};

/**
 * 実測の値を挟む上下の限り。
 *
 * - **下限 300**：短距離では逆算が探索の下限（200）に張り付く。スタミナが
 *   縛りになっていないので値そのものに意味が無く、そのまま使うとゲームに出てこない
 *   個体になる。**300 という値は勘である。**
 * - **上限 1200**：育成が終わった時点のステータスの上限である。芝の長距離は
 *   逆算が 1225 / 1500 を返すが、そこまで持った個体は基準にならない。
 *   上限に張り付いた距離帯では 2 段のスタミナが同じになる。それは
 *   「長距離では上限でも最大スパートが五分」という実測そのものである。
 */
const STAMINA_FLOOR = 300;
const STAMINA_CAP = 1200;

export function staminaKey(surface: number, category: SkillListCategory): string {
  return `${surface}:${category}`;
}

/**
 * 基準個体の鍵。
 *
 * スタミナが面と距離帯で変わるので、鍵も面と距離帯を含める。
 * 含めないと、同じ `normal` という鍵に距離帯ごとに違うスタミナがぶら下がり、
 * 「この行はどの個体の話か」に答えられなくなる。
 *
 * **段は先頭の要素である。** 画面が「普通／強い」で切り替えるときは
 * `id.split(':')[0]` を見ればよい。
 */
export function baselineId(tier: 'normal' | 'strong', course: RepresentativeCourse): string {
  return `${tier}:${staminaKey(course.surface, course.category)}`;
}

/** 代表コース 1 本ぶんの基準個体 2 段を作る。 */
export function baselinesFor(course: RepresentativeCourse): SkillListBaseline[] {
  const tier = CALIBRATED_STAMINA[staminaKey(course.surface, course.category)];
  const clamp = (value: number) => Math.min(STAMINA_CAP, Math.max(STAMINA_FLOOR, value));
  const normalStamina = clamp(tier?.normal ?? STAMINA_FLOOR);
  const strongStamina = Math.max(normalStamina, clamp(tier?.strong ?? normalStamina));
  return [
    {
      id: baselineId('normal', course),
      label: '普通',
      speed: NORMAL_SKELETON.speed,
      stamina: normalStamina,
      power: NORMAL_SKELETON.power,
      guts: NORMAL_SKELETON.guts,
      wisdom: NORMAL_SKELETON.wisdom,
    },
    {
      id: baselineId('strong', course),
      label: '強い',
      speed: NORMAL_SKELETON.speed + STRONG_OFFSET,
      stamina: strongStamina,
      power: NORMAL_SKELETON.power + STRONG_OFFSET,
      guts: NORMAL_SKELETON.guts + STRONG_OFFSET,
      wisdom: NORMAL_SKELETON.wisdom + STRONG_OFFSET,
    },
  ];
}

/** 表に載せられる候補。買えるものだけを見る（固有そのものは買えない）。 */
const PURCHASABLE_RARITIES = new Set(['normal', 'rare', 'inherit']);

export function purchasableSkills(data: GameData): SkillData[] {
  return data.skills
    .filter((skill) => skill.sp > 0 && PURCHASABLE_RARITIES.has(skill.rarity))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 基準個体を段の名前（`normal` / `strong`）でも鍵そのものでも絞れるようにする。 */
export function wantedBaseline(id: string, wanted: readonly string[] | undefined): boolean {
  if (wanted === undefined) return true;
  return wanted.includes(id) || wanted.includes(id.split(':')[0]!);
}

export interface SkillListOptions {
  readonly trials: number;
  readonly seed: number;
  readonly gateCount: number;
  /** 1=良 2=稍重 3=重 4=不良 */
  readonly trackCondition: number;
  readonly useField: boolean;
  /** 相手の束の本数。`FieldSpec.samples`。 */
  readonly samples: number;
  readonly courses: readonly RepresentativeCourse[];
  readonly styles: readonly Style[];
  /** 基準個体の id を絞る。省くと 2 段とも回す。 */
  readonly baselineIds?: readonly string[];
  /** 候補をこの数で打ち切る。動作の確認用で、表を配るときは使わない。 */
  readonly maxSkills?: number;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
}

/** 1 組（コース × 脚質 × 基準個体）の見積もりと実測に使う数。 */
export interface SkillListPlan {
  /** 組の数 */
  readonly groups: number;
  /** 走らせるレースの総数。基準 1 回ぶんを組ごとに足してある。 */
  readonly races: number;
  /** `screen.ts` が落とした組み合わせの数 */
  readonly screenedOut: number;
  /** 行の数（= 走らせる候補の延べ数） */
  readonly rows: number;
}

/** ある組で走らせる候補を決める。走らせずに落とせるものは落とす。 */
function screenFor(
  skills: readonly SkillData[],
  derived: DerivedSetting,
  maxSkills: number | undefined,
): { kept: SkillData[]; screenedOut: number } {
  const kept: SkillData[] = [];
  let screenedOut = 0;
  for (const skill of skills) {
    if (canTrigger(skill, derived)) kept.push(skill);
    else screenedOut++;
  }
  // 打ち切りは動作の確認用である。落とした数には数えない（測っていないだけで、
  // 発動しないと分かったわけではない）。
  return { kept: maxSkills === undefined ? kept : kept.slice(0, maxSkills), screenedOut };
}

export function buildRaceSetting(
  course: RepresentativeCourse,
  style: Style,
  baseline: SkillListBaseline,
  options: Pick<SkillListOptions, 'gateCount' | 'trackCondition'>,
): RaceSetting {
  return {
    uma: {
      charaName: `スキル一覧(${baseline.label})`,
      speed: baseline.speed,
      stamina: baseline.stamina,
      power: baseline.power,
      guts: baseline.guts,
      wisdom: baseline.wisdom,
      condition: 'BEST',
      style,
      distanceFit: 'A',
      surfaceFit: 'A',
      styleFit: 'A',
      popularity: 1,
      // 枠はランダムにする。固定すると内枠・外枠の条件が片側に寄る。
      gateNumber: 0,
      uniqueLevel: 6,
    },
    track: {
      location: course.location,
      course: course.course,
      condition: options.trackCondition,
      gateCount: options.gateCount,
      // 季節・天候・時刻は指定する。省くと本家と同じ「満たしている扱い」になり、
      // 春夏秋冬のスキルが同時に発動して表が使いものにならない
      // （docs/solver-design.md 8 節）。春・晴・昼に固定する。
      season: 1,
      weather: 1,
      time: 1,
    },
    skills: [],
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
}

function toSerializableWithSkills(
  setting: RaceSetting,
  skillIds: readonly string[],
): SerializableRaceSetting {
  return { ...toSerializable(setting), skillIds: [...skillIds] };
}

/**
 * 組を数え上げる。走らせる前に規模を出すために使う。
 *
 * 候補を絞るのは `screen.ts` なので、数えるには各組の `DerivedSetting` が要る。
 * レースは 1 本も走らせない。
 */
export function planSkillList(data: GameData, options: SkillListOptions): SkillListPlan {
  const skills = purchasableSkills(data);
  let groups = 0;
  let rows = 0;
  let screenedOut = 0;
  for (const course of options.courses) {
    for (const baseline of baselinesFor(course)) {
      if (!wantedBaseline(baseline.id, options.baselineIds)) continue;
      for (const style of options.styles) {
        const setting = buildRaceSetting(course, style, baseline, options);
        const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
        const screened = screenFor(skills, derived, options.maxSkills);
        groups++;
        rows += screened.kept.length;
        screenedOut += screened.screenedOut;
      }
    }
  }
  return { groups, rows, screenedOut, races: (rows + groups) * options.trials };
}

/** 列に詰めるための、書き換えられる入れ物。 */
interface MutableColumns {
  skill: number[];
  baseline: number[];
  style: number[];
  course: number[];
  mean: number[];
  stdError: number[];
  triggerRate: number[];
  meanWhenTriggered: number[];
  cost: number[];
  fidelity: number[];
}

/** 実際に行が付いたコースのうち、最も後ろの添字。無ければ -1。 */
function lastCourseIndex(courseColumn: readonly number[]): number {
  let last = -1;
  for (const index of courseColumn) if (index > last) last = index;
  return last;
}

/** 小数を短く切る。JSON の大きさは桁数でそのまま効く。 */
function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 全スキルの単体評価を回して、配る形にまとめる。
 *
 * 1 組（コース × 脚質 × 基準個体）につき、基準を 1 回だけ走らせて使い回す。
 * 候補はそこからの試行ごとの引き算で測る（共通乱数のペア比較）。
 *
 * **発動率は差分からではなく `skillStats` から取る。** 差が 0 の試行を数えても
 * 「発動したが効かなかった」を発動しなかった側に数えてしまう。Worker は
 * スキルごとに発動回数を集計して返しているので、そちらを使う。
 */
export async function runSkillList(
  pool: WorkerPool,
  data: GameData,
  system: SystemSetting,
  options: SkillListOptions,
): Promise<Omit<SkillListFile, 'format' | 'version' | 'dataset' | 'generatedAt'>> {
  const started = performance.now();
  const report = options.onProgress ?? (() => {});
  const skills = purchasableSkills(data);
  const cost = createCostModel(data.skillsById);

  const skillIndex = new Map<string, number>();
  const skillIds: string[] = [];
  const fidelities: Fidelity[] = ['exact', 'approximate', 'dropped'];
  const styles = [...options.styles];
  const courses: SkillListCourse[] = [];
  const baselines: SkillListBaseline[] = [];
  const baselineIndex = new Map<string, number>();
  const columns: MutableColumns = {
    skill: [], baseline: [], style: [], course: [],
    mean: [], stdError: [], triggerRate: [], meanWhenTriggered: [], cost: [], fidelity: [],
  };

  let screenedOut = 0;
  let races = 0;
  let cancelled = false;

  // 1 回の評価だけで全 Worker に散らばる大きさ。optimize.ts の spreadChunkSize と同じ考え。
  const chunkSize = Math.max(1, Math.ceil(options.trials / Math.max(1, pool.concurrency)));

  const runOne = async (
    setting: RaceSetting,
    skillIdList: readonly string[],
    field: FieldSpec | null,
  ): Promise<{ evaluation: Evaluation; skillStats: Float64Array }> => {
    const { results, skillStats } = await pool.run(
      toSerializableWithSkills(setting, skillIdList),
      system,
      { count: options.trials, seed: options.seed, field, chunkSize, signal: options.signal },
    );
    const times = new Float64Array(results.length);
    const maxSpurt = new Uint8Array(results.length);
    const positionCompetitionCount = new Float64Array(results.length);
    for (let i = 0; i < results.length; i++) {
      times[i] = results[i]!.raceTime;
      maxSpurt[i] = results[i]!.maxSpurt ? 1 : 0;
      positionCompetitionCount[i] = results[i]!.positionCompetitionCount;
    }
    races += results.length;
    return {
      evaluation: { skillIds: [...skillIdList], times, maxSpurt, positionCompetitionCount },
      skillStats,
    };
  };

  const plan = planSkillList(data, options);
  let doneGroups = 0;

  outer: for (const course of options.courses) {
    const location = data.trackData[course.location];
    const detail = location?.courses[course.course];
    if (location === undefined || detail === undefined) {
      throw new Error(`コースが見つからない: ${course.location}/${course.course}`);
    }
    const courseIdx = courses.length;
    courses.push({
      location: course.location,
      course: course.course,
      locationName: location.name,
      courseName: detail.name,
      distance: detail.distance,
      surface: detail.surface,
      category: detail.distanceCategory,
    });

    for (const baseline of baselinesFor(course)) {
      if (!wantedBaseline(baseline.id, options.baselineIds)) continue;
      let baselineIdx = baselineIndex.get(baseline.id);
      if (baselineIdx === undefined) {
        baselineIdx = baselines.length;
        baselineIndex.set(baseline.id, baselineIdx);
        baselines.push(baseline);
      }

      for (const style of styles) {
        const styleIdx = styles.indexOf(style);
        const setting = buildRaceSetting(course, style, baseline, options);
        const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
        const field: FieldSpec | null = options.useField
          ? {
              profile: defaultFieldProfile(options.gateCount),
              track: setting.track,
              seed: options.seed + 9000,
              samples: options.samples,
            }
          : null;
        const screened = screenFor(skills, derived, options.maxSkills);
        screenedOut += screened.screenedOut;
        doneGroups++;
        report(
          `[${doneGroups}/${plan.groups}] ${location.name} ${detail.name}` +
            ` ・ ${style} ・ ${baseline.label}（スタミナ ${baseline.stamina}）` +
            ` ・ 候補 ${screened.kept.length} 個（${screened.screenedOut} 個は走らせずに落とした）`,
        );

        let base;
        try {
          base = await runOne(setting, [], field);
        } catch (error) {
          if (error instanceof SimulationCancelled) { cancelled = true; break outer; }
          throw error;
        }

        for (const [index, skill] of screened.kept.entries()) {
          let measured;
          try {
            measured = await runOne(setting, [skill.id], field);
          } catch (error) {
            if (error instanceof SimulationCancelled) { cancelled = true; break outer; }
            throw error;
          }
          const diff = pairedDiff(base.evaluation, measured.evaluation);
          const triggered = measured.skillStats[SKILL_STAT.triggered] ?? 0;
          const trials = measured.evaluation.times.length;
          const triggerRate = trials === 0 ? 0 : triggered / trials;
          // 発動しなかった試行では、共通乱数により差は厳密に 0 になる
          // （packages/sim/test/optimize.test.ts）。したがって全試行の和は
          // 発動した試行の和に等しく、発動した試行だけの平均は割り直しで出る。
          const meanWhenTriggered = triggered === 0 ? 0 : (diff.mean * trials) / triggered;

          let skillIdx = skillIndex.get(skill.id);
          if (skillIdx === undefined) {
            skillIdx = skillIds.length;
            skillIndex.set(skill.id, skillIdx);
            skillIds.push(skill.id);
          }
          columns.skill.push(skillIdx);
          columns.baseline.push(baselineIdx);
          columns.style.push(styleIdx);
          columns.course.push(courseIdx);
          columns.mean.push(round(diff.mean, 5));
          columns.stdError.push(round(diff.stdError, 5));
          columns.triggerRate.push(round(triggerRate, 4));
          columns.meanWhenTriggered.push(round(meanWhenTriggered, 5));
          columns.cost.push(cost.cost(skill.id));
          columns.fidelity.push(
            fidelities.indexOf(
              classifySkill(skill, derived, { hasField: options.useField }).fidelity,
            ),
          );

          if ((index + 1) % 50 === 0) {
            const rate = races / Math.max(1, performance.now() - started);
            const left = Math.max(0, plan.races - races) / Math.max(0.001, rate) / 1000;
            report(
              `    ${index + 1} / ${screened.kept.length}` +
                `（${(races / 1000).toFixed(0)}k レース済み、残り約 ${(left / 60).toFixed(1)} 分）`,
            );
          }
          if (options.signal?.aborted === true) { cancelled = true; break outer; }
        }
      }
    }
  }

  if (cancelled) report('中断した。ここまでに測った行だけを書き出す。');

  const settings: SkillListSettings = {
    trials: options.trials,
    useField: options.useField,
    gateCount: options.gateCount,
    seed: options.seed,
    trackCondition: options.trackCondition,
  };
  const packed: SkillListColumns = { length: columns.skill.length, ...columns };
  return {
    settings,
    baselines,
    // 中断すると、載せたが 1 行も測らなかったコースが末尾に残る。落としておく。
    courses: courses.slice(0, lastCourseIndex(packed.course) + 1),
    skillIds,
    styles,
    fidelities,
    columns: packed,
    screenedOut,
    races,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** 見積もりを人に読める形にする。CLI が走らせる前に出す。 */
export function describePlan(plan: SkillListPlan, racesPerSecond: number): string {
  const minutes = plan.races / Math.max(1, racesPerSecond) / 60;
  return (
    `${plan.groups} 組 / 約 ${(plan.races / 1_000_000).toFixed(2)}M レース` +
    `（行 ${plan.rows}、走らせずに落とす組み合わせ ${plan.screenedOut}）` +
    ` / 見込み ${minutes.toFixed(1)} 分`
  );
}


/**
 * 基準個体のスタミナを実測で決める。
 *
 * 代表コースごとに「最大スパートを出せる最小のスタミナ」を試行ごとに逆算し
 * （`critical.ts` の考え方。目標が最大スパートなら 1 試行の中で単調なので二分探索でよい）、
 * その分布の分位点を採る。脚質でスタミナの要りようが違うので、**4 脚質ぶんをまとめて**
 * 1 つの分布にする。基準個体は脚質をまたいで同じものを使うからである。
 *
 * 相手（フィールド）は渡さない。ここで測るのは自分の体力の収支であって順位ではなく、
 * 候補を 1 つも持たない裸の個体には順位条件のスキルも無い。
 */
export interface CalibrationRow {
  readonly course: RepresentativeCourse;
  readonly locationName: string;
  readonly courseName: string;
  /** 50 パーセンタイル（普通） */
  readonly p50: number;
  /** 90 パーセンタイル（強い） */
  readonly p90: number;
  /** 範囲内で最大スパートに届かなかった試行の割合 */
  readonly unreachedRate: number;
  readonly races: number;
}

export interface CalibrateOptions {
  readonly trials: number;
  readonly seed: number;
  readonly gateCount: number;
  readonly trackCondition: number;
  readonly styles: readonly Style[];
  readonly courses: readonly RepresentativeCourse[];
  readonly from?: number;
  readonly to?: number;
  readonly step?: number;
  readonly onProgress?: (message: string) => void;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export async function calibrateStamina(
  pool: WorkerPool,
  data: GameData,
  system: SystemSetting,
  options: CalibrateOptions,
): Promise<CalibrationRow[]> {
  const report = options.onProgress ?? (() => {});
  const from = options.from ?? 200;
  const to = options.to ?? 1600;
  const step = options.step ?? 5;
  const rows: CalibrationRow[] = [];

  for (const course of options.courses) {
    const location = data.trackData[course.location]!;
    const detail = location.courses[course.course]!;
    const values: number[] = [];
    let unreached = 0;
    let races = 0;
    for (const style of options.styles) {
      // 逆算の土台は「普通」の骨格にする。求めるのはそのスタミナなので、
      // ここに入れた値は使われない（逆算がスタミナを振り直す）。
      const setting = buildRaceSetting(course, style, {
        id: 'calibration', label: '較正',
        speed: NORMAL_SKELETON.speed, stamina: from,
        power: NORMAL_SKELETON.power, guts: NORMAL_SKELETON.guts, wisdom: NORMAL_SKELETON.wisdom,
      }, options);
      const spec: CriticalSpec = {
        status: 'stamina', goalKind: 'maxSpurt', from, to, step, method: 'bisect',
      };
      const output = await pool.runCritical(toSerializableWithSkills(setting, []), system, spec, {
        count: options.trials,
        seed: options.seed,
      });
      races += output.races;
      for (const value of output.values) {
        if (Number.isFinite(value)) values.push(value);
        else unreached++;
      }
    }
    values.sort((a, b) => a - b);
    const row: CalibrationRow = {
      course,
      locationName: location.name,
      courseName: detail.name,
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      unreachedRate: unreached / Math.max(1, values.length + unreached),
      races,
    };
    rows.push(row);
    report(
      `${location.name} ${detail.name}: p50 ${row.p50} / p90 ${row.p90}` +
        ` ・ 届かなかった試行 ${(row.unreachedRate * 100).toFixed(1)} %` +
        ` ・ ${row.races} レース`,
    );
  }
  return rows;
}
