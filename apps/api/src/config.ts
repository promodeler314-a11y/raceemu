import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';

/**
 * 実行環境の読み取り。
 *
 * いちばん危ないのは並列数である。
 * `os.availableParallelism()` が見ているのは CPU アフィニティ
 * （`sched_getaffinity`）であって、Kubernetes の `resources.limits.cpu` が
 * 設定する CFS のクォータではない。
 * 16 コアのノードに `limits.cpu: 2` で置いたポッドは 16 と答えうる。
 * そのまま信じると Worker が 15 本立ち、2 コアぶんの枠を奪い合って遅くなる。
 *
 * そこで cgroup のクォータを直接読み、読めなければ従来の値に落とす。
 * [サーバ側で探索を回す設計](../../../docs/server-design.md)の 4.1 節を参照。
 */

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * cgroup が課している CPU の上限。単位はコア数。
 * 上限が無い（`max`）場合と、cgroup が読めない場合は null を返す。
 *
 * `read` を差し替えられるようにしてあるのは、この判定を試験するためである。
 * 実際の cgroup は走らせる環境によって形が違い、手元では再現できない。
 */
export function detectCpuQuota(read: (path: string) => string | null = readText): number | null {
  // cgroup v2。"<quota> <period>" か "max <period>"。
  const v2 = read('/sys/fs/cgroup/cpu.max');
  if (v2 !== null) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== undefined && quota !== 'max' && period !== undefined) {
      const q = Number(quota);
      const p = Number(period);
      if (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0) return q / p;
    }
    // "max" は上限なし。v1 を見に行っても仕方がないのでここで打ち切る。
    if (quota === 'max') return null;
  }

  // cgroup v1。クォータが -1 なら上限なし。
  const quota = read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quota !== null && period !== null) {
    const q = Number(quota);
    const p = Number(period);
    if (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0) return q / p;
  }
  return null;
}

export interface Config {
  readonly port: number;
  /** Worker の本数 */
  readonly concurrency: number;
  /** 並列数をどう決めたか。起動時のログに出して、実環境で確かめられるようにする。 */
  readonly concurrencySource: 'env' | 'cgroup' | 'availableParallelism';
  /** 同時に走らせるジョブの数 */
  readonly maxRunning: number;
  /** 待ち行列に積める数。超えたら受け付けを断る。 */
  readonly maxQueued: number;
  /** 1 ジョブが走らせてよいレースの数。超えたら打ち切る。 */
  readonly maxRacesPerJob: number;
  /** 終わったジョブを保持する時間 */
  readonly jobTtlMs: number;
  /** 静的ファイルの置き場。同一オリジンで配るために使う。 */
  readonly staticRoot: string | null;
  /**
   * `jpn.traineddata` の置き場。null なら画面の読み取りは受け付けない。
   * 35 MB あるのでリポジトリには置かず、イメージを組むときに取ってくる。
   */
  readonly tessdataPath: string | null;
  /** 読み取りに送れる画像の大きさ */
  readonly maxImageBytes: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} は正の数で指定する: ${raw}`);
  }
  return value;
}

export function loadConfig(): Config {
  const envConcurrency = process.env['RACEEMU_CONCURRENCY'];
  const quota = detectCpuQuota();

  let concurrency: number;
  let concurrencySource: Config['concurrencySource'];
  if (envConcurrency !== undefined) {
    concurrency = num('RACEEMU_CONCURRENCY', 1);
    concurrencySource = 'env';
  } else if (quota !== null) {
    // 専用のコンテナなので、枠をそのまま使う。
    // ブラウザ側が 1 引くのは UI を止めないためで、ここには当てはまらない。
    concurrency = Math.floor(quota);
    concurrencySource = 'cgroup';
  } else {
    concurrency = availableParallelism() - 1;
    concurrencySource = 'availableParallelism';
  }

  return {
    port: num('PORT', 8080),
    concurrency: Math.max(1, concurrency),
    concurrencySource,
    maxRunning: num('RACEEMU_MAX_RUNNING', 1),
    maxQueued: num('RACEEMU_MAX_QUEUED', 8),
    maxRacesPerJob: num('RACEEMU_MAX_RACES', 2_000_000),
    jobTtlMs: num('RACEEMU_JOB_TTL_MS', 30 * 60 * 1000),
    staticRoot: process.env['RACEEMU_STATIC_ROOT'] ?? null,
    tessdataPath: process.env['RACEEMU_TESSDATA'] ?? null,
    maxImageBytes: num('RACEEMU_MAX_IMAGE_BYTES', 8 * 1024 * 1024),
  };
}
