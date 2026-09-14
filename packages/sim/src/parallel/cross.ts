import type { CourseMatch } from '../data/track.ts';
import type { SystemSetting } from '../setting.ts';
import { summarize, type SimulationSummary } from '../summary.ts';
import { SimulationCancelled, type WorkerPool } from './pool.ts';
import type { FieldSpec, SerializableRaceSetting } from './protocol.ts';

/**
 * コース横断の評価。
 *
 * 同じ個体を、条件に当たる全コースで走らせて並べる。
 * 距離とバ場だけを決めてコースが決まっていないとき（チャンピオンズミーティング）と、
 * 育成中に「この個体はどのコースなら走れるか」を見るときに使う。
 * docs/roadmap.md 3.3 節を参照。
 *
 * **コースは順に走らせる。** 1 コースぶんの試行はもうプール全体に配られるので、
 * コースを並べて投げても速くはならない。順に走らせれば、途中で止めたときに
 * 「ここまでのコースは出そろっている」という読み方ができる。
 */
export interface CrossCourseRow {
  readonly location: number;
  readonly course: number;
  /** レース場の名前（「東京」など） */
  readonly locationName: string;
  /** コースの名前（「芝2400m（内）」など） */
  readonly courseName: string;
  readonly distance: number;
  /** 1=芝 2=ダート */
  readonly surface: number;
  readonly summary: SimulationSummary;
  /**
   * タイムの標準偏差。
   *
   * 同じ距離のコースを並べたときに、平均タイムの差が揺らぎで説明できるかを
   * 見るために持たせる。距離が違う行のあいだでは比べても意味が無い。
   */
  readonly sd: number;
}

export interface CrossCourseOptions {
  readonly count: number;
  readonly seed?: number;
  readonly signal?: AbortSignal;
  /** 1 コース終わるたびに呼ぶ。 */
  readonly onCourse?: (done: number, total: number, row: CrossCourseRow) => void;
  /**
   * 順位条件を判定するときの相手の想定。コースは指定しない。
   *
   * 束はコースごとに作り直す（相手の走りがコースに依る）。鍵から決まるので、
   * 同じ指定なら同じ束になり、走らせ直しても行は動かない。
   */
  readonly field?: Omit<FieldSpec, 'track'> | null;
}

export interface CrossCourseOutput {
  readonly rows: CrossCourseRow[];
  /** 途中で止めたか。止めたときは走り終えたコースまでしか `rows` に入らない。 */
  readonly cancelled: boolean;
}

function standardDeviation(times: readonly number[]): number {
  if (times.length < 2) return Number.NaN;
  let sum = 0;
  for (const time of times) sum += time;
  const mean = sum / times.length;
  let variance = 0;
  for (const time of times) variance += (time - mean) ** 2;
  return Math.sqrt(variance / (times.length - 1));
}

/**
 * 条件に当たる全コースを順に走らせる。
 *
 * どのコースも同じシードを使う。コースが違えば乱数の使われ方も違うので
 * 共通乱数によるペア比較は成り立たないが、走らせ直したときに同じ値が出る。
 */
export async function runCrossCourse(
  pool: WorkerPool,
  setting: SerializableRaceSetting,
  system: SystemSetting,
  courses: readonly CourseMatch[],
  options: CrossCourseOptions,
): Promise<CrossCourseOutput> {
  const rows: CrossCourseRow[] = [];
  for (const [index, match] of courses.entries()) {
    if (options.signal?.aborted === true) return { rows, cancelled: true };
    const track = { ...setting.track, location: match.location, course: match.course };
    const started = performance.now();
    let results;
    try {
      ({ results } = await pool.run({ ...setting, track }, system, {
        count: options.count,
        seed: options.seed,
        signal: options.signal,
        field: options.field == null ? null : { ...options.field, track },
      }));
    } catch (error) {
      // 止めたときは、走り終えたコースまでを返す。1 コースぶんを捨てるだけで
      // 済むのに全部やり直させると、数十コースを回した意味が無くなる。
      if (error instanceof SimulationCancelled) return { rows, cancelled: true };
      throw error;
    }
    const row: CrossCourseRow = {
      location: match.location,
      course: match.course,
      locationName: match.locationName,
      courseName: match.detail.name,
      distance: match.detail.distance,
      surface: match.detail.surface,
      summary: summarize(results, performance.now() - started),
      sd: standardDeviation(results.map((result) => result.raceTime)),
    };
    rows.push(row);
    options.onCourse?.(index + 1, courses.length, row);
  }
  return { rows, cancelled: false };
}
