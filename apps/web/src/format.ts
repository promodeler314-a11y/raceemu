/** レースタイムを分:秒.ミリ秒で出す。設定画面の生の秒数表示とは別に、結果画面はこちらへ寄せる。 */
export function formatTime(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const totalMs = Math.round(value * 1000);
  const sign = totalMs < 0 ? '-' : '';
  const abs = Math.abs(totalMs);
  const minutes = Math.floor(abs / 60000);
  const secondsPart = (abs % 60000) / 1000;
  return `${sign}${minutes}:${secondsPart.toFixed(3).padStart(6, '0')}`;
}

/** 値の集合から p 分位点を線形補間で求める。sorted は昇順であること。 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo]!;
  const weight = index - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

/** 平均の標準誤差。試行が 2 未満なら求まらない。 */
export function standardError(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance / n);
}
