/**
 * スキル一覧の事前計算。
 *
 * 全スキルを「1 つだけ足したときの短縮量」で測り、**コースごとに** 1 枚にまとめて配る。
 * 配る形は `skill-list.ts`、基準個体のスタミナは `skill-list-stamina.ts`、
 * 回すのは `skill-list-cli.ts` にある。
 *
 * ここが持つのは次の 3 つである。
 *
 * 1. **対象のコース**。全 137 コースを数え上げ、絞り込みと分割で選ぶ。
 * 2. **測り方**。組ごとに基準を 1 回だけ走らせ、候補はそこからの共通乱数のペア比較で測る。
 * 3. **列への詰め方**。行を素直に並べると 1 コースで数 MB になるので、列ごとの配列にする。
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
import {
  NORMAL_SKELETON,
  baselinesFor,
  type StaminaTable,
} from './skill-list-stamina.ts';
import {
  SKILL_LIST_FORMAT,
  skillListCourseKey,
  type SkillListBaseline,
  type SkillListCategory,
  type SkillListColumns,
  type SkillListCourse,
  type SkillListCourseFile,
  type SkillListSettings,
} from './skill-list.ts';

/** 表に載せる脚質。並びは `constants.ts` の Style と同じにする。 */
export const SKILL_LIST_STYLES: readonly Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];

export const SKILL_LIST_CATEGORIES: readonly SkillListCategory[] = ['SHORT', 'MILE', 'MIDDLE', 'LONG'];

/**
 * 表に載せられる全コース。**距離帯の代表は選ばない。**
 *
 * 芝 77 本とダート 60 本の 137 本がある。1 本ずつ測って 1 枚ずつ配るので、
 * 全部が揃っていなくても、揃ったところまでが表になる（`SkillListIndex`）。
 *
 * 並びは 場 → バ場 → 距離 に固定する。選択欄の並びがここで決まるうえ、
 * 分割（`shardCourses`）がこの並びに乗るので、実行のたびに変わってはならない。
 */
export function allSkillListCourses(data: GameData): SkillListCourse[] {
  const out: SkillListCourse[] = [];
  for (const [locationId, location] of Object.entries(data.trackData)) {
    for (const [courseId, detail] of Object.entries(location.courses)) {
      out.push({
        location: Number(locationId),
        course: Number(courseId),
        locationName: location.name,
        courseName: detail.name,
        distance: detail.distance,
        surface: detail.surface,
        category: detail.distanceCategory,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.location - b.location ||
      a.surface - b.surface ||
      a.distance - b.distance ||
      a.course - b.course,
  );
  return out;
}

/** コースの絞り込み。CLI の引数がそのまま入る。 */
export interface CourseSelection {
  /** 1=芝 2=ダート。空なら両方。 */
  readonly surfaces?: readonly number[];
  readonly categories?: readonly SkillListCategory[];
  /** レース場の番号（10006 など） */
  readonly locations?: readonly number[];
  /** ぴったりの距離 */
  readonly distances?: readonly number[];
  /** `<場>-<コース>` の鍵で直に指す */
  readonly keys?: readonly string[];
}

export function selectCourses(
  courses: readonly SkillListCourse[],
  selection: CourseSelection,
): SkillListCourse[] {
  const has = <T>(list: readonly T[] | undefined, value: T) =>
    list === undefined || list.length === 0 || list.includes(value);
  return courses.filter(
    (course) =>
      has(selection.surfaces, course.surface) &&
      has(selection.categories, course.category) &&
      has(selection.locations, course.location) &&
      has(selection.distances, course.distance) &&
      has(selection.keys, skillListCourseKey(course.location, course.course)),
  );
}

/**
 * コースを n 等分した i 番目を取る。**全 137 コースは 1 回では回りきらない。**
 *
 * 1 コースにつき 10 分前後かかるので、全部で 20 時間を超える。GitHub Actions の
 * 1 ジョブは 6 時間で切られるから、matrix で分けて回す（docs/deploy.md 6.5 節）。
 *
 * 飛ばし飛ばしに取る（i, i+n, i+2n, ...）。先頭から切り分けると、
 * 長距離ばかりを引いた分片だけが極端に遅くなる。
 */
export function shardCourses(
  courses: readonly SkillListCourse[],
  index: number,
  count: number,
): SkillListCourse[] {
  if (count <= 1) return [...courses];
  return courses.filter((_, i) => i % count === index);
}

/** 表に載せられる候補。買えるものだけを見る（固有そのものは買えない）。 */
const PURCHASABLE_RARITIES = new Set(['normal', 'rare', 'inherit']);

export function purchasableSkills(data: GameData): SkillData[] {
  return data.skills
    .filter((skill) => skill.sp > 0 && PURCHASABLE_RARITIES.has(skill.rarity))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  readonly styles: readonly Style[];
  /** 基準個体の段を絞る。省くと 2 段とも回す。 */
  readonly baselineIds?: readonly string[];
  /** 候補をこの数で打ち切る。動作の確認用で、表を配るときは使わない。 */
  readonly maxSkills?: number;
  /** 基準個体のスタミナ。無ければ距離からの当て推量になる。 */
  readonly stamina: StaminaTable | null;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
}

/** 1 組（脚質 × 基準個体）の見積もりと実測に使う数。 */
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
  course: SkillListCourse,
  style: Style,
  baseline: Pick<SkillListBaseline, 'label' | 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom'>,
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

const wantedBaselineTier = (id: string, wanted: readonly string[] | undefined): boolean =>
  wanted === undefined || wanted.length === 0 || wanted.includes(id);

/**
 * 1 コースぶんの組を数え上げる。走らせる前に規模を出すために使う。
 *
 * 候補を絞るのは `screen.ts` なので、数えるには各組の `DerivedSetting` が要る。
 * レースは 1 本も走らせない。
 */
export function planSkillListCourse(
  data: GameData,
  course: SkillListCourse,
  options: SkillListOptions,
): SkillListPlan {
  const skills = purchasableSkills(data);
  let groups = 0;
  let rows = 0;
  let screenedOut = 0;
  for (const baseline of baselinesFor(course, options.stamina)) {
    if (!wantedBaselineTier(baseline.id, options.baselineIds)) continue;
    for (const style of options.styles) {
      const setting = buildRaceSetting(course, style, baseline, options);
      const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
      const screened = screenFor(skills, derived, options.maxSkills);
      groups++;
      rows += screened.kept.length;
      screenedOut += screened.screenedOut;
    }
  }
  return { groups, rows, screenedOut, races: (rows + groups) * options.trials };
}

/** 複数コースぶんをまとめて数える。 */
export function planSkillList(
  data: GameData,
  courses: readonly SkillListCourse[],
  options: SkillListOptions,
): SkillListPlan {
  let groups = 0;
  let rows = 0;
  let screenedOut = 0;
  let races = 0;
  for (const course of courses) {
    const plan = planSkillListCourse(data, course, options);
    groups += plan.groups;
    rows += plan.rows;
    screenedOut += plan.screenedOut;
    races += plan.races;
  }
  return { groups, rows, screenedOut, races };
}

/** 列に詰めるための、書き換えられる入れ物。 */
interface MutableColumns {
  skill: number[];
  baseline: number[];
  style: number[];
  mean: number[];
  stdError: number[];
  triggerRate: number[];
  meanWhenTriggered: number[];
  cost: number[];
  fidelity: number[];
}

/** 小数を短く切る。JSON の大きさは桁数でそのまま効く。 */
function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 中断されたことを呼び出し側に伝えるための印。 */
export class SkillListInterrupted extends Error {}

/**
 * **1 コースぶん**の全スキルの単体評価を回して、配る形にまとめる。
 *
 * 1 組（脚質 × 基準個体）につき、基準を 1 回だけ走らせて使い回す。
 * 候補はそこからの試行ごとの引き算で測る（共通乱数のペア比較）。
 *
 * **発動率は差分からではなく `skillStats` から取る。** 差が 0 の試行を数えても
 * 「発動したが効かなかった」を発動しなかった側に数えてしまう。Worker は
 * スキルごとに発動回数を集計して返しているので、そちらを使う。
 *
 * 中断されたら `SkillListInterrupted` を投げる。**途中までのコースは配らない。**
 * 1 枚が 1 コースなので、中途半端な 1 枚を混ぜるより、そのコースを載せないほうが
 * 読み手を欺かない（「無い」は「測っていない」と読める）。
 */
export async function runSkillListCourse(
  pool: WorkerPool,
  data: GameData,
  system: SystemSetting,
  course: SkillListCourse,
  options: SkillListOptions,
): Promise<Omit<SkillListCourseFile, 'format' | 'version' | 'dataset' | 'generatedAt'>> {
  const started = performance.now();
  const report = options.onProgress ?? (() => {});
  const skills = purchasableSkills(data);
  const cost = createCostModel(data.skillsById);

  const skillIndex = new Map<string, number>();
  const skillIds: string[] = [];
  const fidelities: Fidelity[] = ['exact', 'approximate', 'dropped'];
  const styles = [...options.styles];
  const baselines: SkillListBaseline[] = [];
  const columns: MutableColumns = {
    skill: [], baseline: [], style: [],
    mean: [], stdError: [], triggerRate: [], meanWhenTriggered: [], cost: [], fidelity: [],
  };

  let screenedOut = 0;
  let races = 0;

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

  const plan = planSkillListCourse(data, course, options);
  let doneGroups = 0;

  for (const baseline of baselinesFor(course, options.stamina)) {
    if (!wantedBaselineTier(baseline.id, options.baselineIds)) continue;
    const baselineIdx = baselines.length;
    baselines.push(baseline);

    for (const [styleIdx, style] of styles.entries()) {
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
        `  [${doneGroups}/${plan.groups}] ${style} ・ ${baseline.label}` +
          `（スタミナ ${baseline.stamina}）` +
          ` ・ 候補 ${screened.kept.length} 個（${screened.screenedOut} 個は走らせずに落とした）`,
      );

      let base;
      try {
        base = await runOne(setting, [], field);
      } catch (error) {
        if (error instanceof SimulationCancelled) throw new SkillListInterrupted();
        throw error;
      }

      for (const [index, skill] of screened.kept.entries()) {
        let measured;
        try {
          measured = await runOne(setting, [skill.id], field);
        } catch (error) {
          if (error instanceof SimulationCancelled) throw new SkillListInterrupted();
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

        if ((index + 1) % 100 === 0) {
          const rate = races / Math.max(1, performance.now() - started);
          const left = Math.max(0, plan.races - races) / Math.max(0.001, rate) / 1000;
          report(
            `      ${index + 1} / ${screened.kept.length}` +
              `（このコースの残り約 ${(left / 60).toFixed(1)} 分）`,
          );
        }
        if (options.signal?.aborted === true) throw new SkillListInterrupted();
      }
    }
  }

  const settings: SkillListSettings = {
    trials: options.trials,
    useField: options.useField,
    gateCount: options.gateCount,
    seed: options.seed,
    trackCondition: options.trackCondition,
  };
  return {
    settings,
    course,
    baselines,
    skillIds,
    styles,
    fidelities,
    columns: { length: columns.skill.length, ...columns },
    screenedOut,
    races,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** 見積もりを人に読める形にする。CLI が走らせる前に出す。 */
export function describePlan(
  plan: SkillListPlan,
  courses: number,
  racesPerSecond: number,
): string {
  const minutes = plan.races / Math.max(1, racesPerSecond) / 60;
  return (
    `${courses} コース / ${plan.groups} 組 / 約 ${(plan.races / 1_000_000).toFixed(2)}M レース` +
    `（行 ${plan.rows}、走らせずに落とす組み合わせ ${plan.screenedOut}）` +
    ` / 見込み ${minutes < 120 ? `${minutes.toFixed(1)} 分` : `${(minutes / 60).toFixed(1)} 時間`}`
  );
}

/**
 * 基準個体のスタミナを実測で決める。
 *
 * コースごとに「最大スパートを出せる最小のスタミナ」を試行ごとに逆算し
 * （`critical.ts` の考え方。目標が最大スパートなら 1 試行の中で単調なので二分探索でよい）、
 * その分布の分位点を採る。脚質でスタミナの要りようが違うので、**4 脚質ぶんをまとめて**
 * 1 つの分布にする。基準個体は脚質をまたいで同じものを使うからである。
 *
 * 相手（フィールド）は渡さない。ここで測るのは自分の体力の収支であって順位ではなく、
 * 候補を 1 つも持たない裸の個体には順位条件のスキルも無い。
 *
 * 表の測定に比べればずっと安い（1 コース 10 秒ほど）ので、全 137 コースを一度に回せる。
 */
export interface CalibrationRow {
  readonly course: SkillListCourse;
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
  readonly from?: number;
  readonly to?: number;
  readonly step?: number;
  readonly onProgress?: (row: CalibrationRow, done: number, total: number) => void;
  readonly signal?: AbortSignal;
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
  courses: readonly SkillListCourse[],
  options: CalibrateOptions,
): Promise<CalibrationRow[]> {
  const report = options.onProgress ?? (() => {});
  const from = options.from ?? 200;
  const to = options.to ?? 1600;
  const step = options.step ?? 5;
  const rows: CalibrationRow[] = [];

  for (const course of courses) {
    const values: number[] = [];
    let unreached = 0;
    let races = 0;
    for (const style of options.styles) {
      // 逆算の土台は「普通」の骨格にする。求めるのはそのスタミナなので、
      // ここに入れた値は使われない（逆算がスタミナを振り直す）。
      const setting = buildRaceSetting(course, style, {
        label: '較正',
        speed: NORMAL_SKELETON.speed, stamina: from,
        power: NORMAL_SKELETON.power, guts: NORMAL_SKELETON.guts, wisdom: NORMAL_SKELETON.wisdom,
      }, options);
      const spec: CriticalSpec = {
        status: 'stamina', goalKind: 'maxSpurt', from, to, step, method: 'bisect',
      };
      const output = await pool.runCritical(toSerializableWithSkills(setting, []), system, spec, {
        count: options.trials,
        seed: options.seed,
        signal: options.signal,
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
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      unreachedRate: unreached / Math.max(1, values.length + unreached),
      races,
    };
    rows.push(row);
    report(row, rows.length, courses.length);
  }
  return rows;
}

/** 形の版を版の文字列に載せるための再輸出。CLI が読む。 */
export { SKILL_LIST_FORMAT };
