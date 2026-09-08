import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { getSlope } from '../../../../packages/sim/src/data/track.ts';
import { currentTrackDetail, useStore } from '../store.ts';
import { formatTime, percentile } from '../format.ts';
import { Panel } from './Inputs.tsx';

/**
 * 系列の色は dataviz の既定パレットの 1 から 3 番目。
 * 明色面での aqua は 3:1 を下回るため、体力の図は単系列にして見出しで名前を出す。
 */
const SERIES = {
  speed: { light: '#2a78d6', dark: '#3987e5' },
  target: { light: '#eb6834', dark: '#d95926' },
  sp: { light: '#1baf7a', dark: '#199e70' },
  // 勾配はコースの文脈であって系列ではない。カテゴリ色を使わず地の色で描く。
  context: { light: '#52514e', dark: '#c3c2b7' },
};

function isDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function color(slot: keyof typeof SERIES): string {
  return isDark() ? SERIES[slot].dark : SERIES[slot].light;
}

const cursorSync = uPlot.sync('race');

interface CourseBands {
  readonly corners: readonly [number, number][];
  readonly phases: readonly number[];
}

/** コーナーを薄い帯で、フェーズ境界を破線で背景に描く。 */
function coursePlugin(bands: CourseBands): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx } = u;
        const top = u.bbox.top;
        const height = u.bbox.height;
        ctx.save();
        ctx.fillStyle = isDark() ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.045)';
        for (const [start, end] of bands.corners) {
          const x0 = u.valToPos(start, 'x', true);
          const x1 = u.valToPos(end, 'x', true);
          ctx.fillRect(x0, top, x1 - x0, height);
        }
        ctx.strokeStyle = isDark() ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        for (const position of bands.phases) {
          const x = Math.round(u.valToPos(position, 'x', true)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
        }
        ctx.restore();
      },
    },
  };
}

interface ChartProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly x: Float64Array;
  readonly series: readonly { label: string; values: Float64Array; slot: keyof typeof SERIES }[];
  readonly bands: CourseBands;
  readonly height: number;
  /** true なら 0 を含めた範囲にする。速度のように 0 付近を使わない図では false。 */
  readonly includeZero?: boolean;
}

function Chart({ title, subtitle, x, series, bands, height, includeZero = true }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const options: uPlot.Options = {
      title,
      width: element.clientWidth,
      height,
      cursor: { sync: { key: cursorSync.key }, drag: { x: true, y: false } },
      legend: { live: true },
      scales: {
        x: { time: false },
        y: includeZero
          ? {}
          : {
              // 0 に引き寄せると関心のある帯が潰れるので、データの幅に合わせる。
              range: (_u, min, max) => {
                const pad = (max - min) * 0.08 || 1;
                return [min - pad, max + pad];
              },
            },
      },
      axes: [
        { label: '距離 (m)', stroke: isDark() ? '#c3c2b7' : '#52514e', grid: { stroke: isDark() ? '#2a2a28' : '#eceae4' } },
        { stroke: isDark() ? '#c3c2b7' : '#52514e', grid: { stroke: isDark() ? '#2a2a28' : '#eceae4' } },
      ],
      series: [
        { label: '距離' },
        ...series.map((s) => ({ label: s.label, stroke: color(s.slot), width: 2, points: { show: false } })),
      ],
      plugins: [coursePlugin(bands)],
    };
    const data: uPlot.AlignedData = [x, ...series.map((s) => s.values)];
    plot.current = new uPlot(options, data, element);
    const onResize = () => plot.current?.setSize({ width: element.clientWidth, height });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.current?.destroy();
      plot.current = null;
    };
  }, [title, height, x, series, bands, includeZero]);

  return (
    <div>
      <div ref={ref} className="w-full" />
      {subtitle !== undefined && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</p>
      )}
    </div>
  );
}

export function FrameCharts() {
  const detail = useStore((s) => s.detail);
  const track = useStore((s) => s.track);
  const trackDetail = currentTrackDetail(track);

  const prepared = useMemo(() => {
    if (detail === null || trackDetail === undefined) return null;
    // 先頭はスタート前の記録用フレームで速度 0 なので、図からは外す。
    const frames = detail.frames.slice(1);
    const n = frames.length;
    const x = new Float64Array(n);
    const speed = new Float64Array(n);
    const target = new Float64Array(n);
    const sp = new Float64Array(n);
    const slope = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const frame = frames[i]!;
      x[i] = frame.startPosition;
      speed[i] = frame.speed;
      target[i] = frame.targetSpeed;
      sp[i] = frame.sp;
      slope[i] = getSlope(trackDetail, frame.startPosition);
    }
    const bands: CourseBands = {
      corners: trackDetail.corners.map((c) => [c.start, c.end] as [number, number]),
      phases: [
        trackDetail.distance / 6,
        (trackDetail.distance * 2) / 3,
        (trackDetail.distance * 5) / 6,
      ],
    };
    return { x, speed, target, sp, slope, bands };
  }, [detail, trackDetail]);

  if (prepared === null) {
    return (
      <Panel title="レースの詳細">
        <p className="text-sm text-neutral-500">実行すると 1 本目のレースを表示する。</p>
      </Panel>
    );
  }

  return (
    <Panel title={`レースの詳細（試行 ${detail!.trial}）`}>
      <div className="space-y-4">
        <Chart
          title="速度"
          subtitle="灰色の帯はコーナー、破線は序盤と中盤と終盤とラストの境界。"
          x={prepared.x}
          height={220}
          includeZero={false}
          bands={prepared.bands}
          series={[
            { label: '現在速度 (m/s)', values: prepared.speed, slot: 'speed' },
            { label: '目標速度 (m/s)', values: prepared.target, slot: 'target' },
          ]}
        />
        <Chart
          title="残り体力"
          x={prepared.x}
          height={160}
          bands={prepared.bands}
          series={[{ label: '残り体力', values: prepared.sp, slot: 'sp' }]}
        />
        <Chart
          title="勾配"
          subtitle="エミュレータ内部の勾配値。1.0 以上を上り坂、-1.0 以下を下り坂として扱う。"
          x={prepared.x}
          height={120}
          bands={prepared.bands}
          series={[{ label: '勾配', values: prepared.slope, slot: 'context' }]}
        />
      </div>
    </Panel>
  );
}

/** タイムの分布。単系列なので凡例は置かず、見出しで何かを示す。 */
export function TimeHistogram() {
  const results = useStore((s) => s.results);
  const [hover, setHover] = useState<number | null>(null);

  const bins = useMemo(() => {
    if (results.length === 0) return null;
    const times = results.map((r) => r.raceTime).sort((a, b) => a - b);
    const min = times[0]!;
    const max = times[times.length - 1]!;
    if (!Number.isFinite(min) || max === min) return null;
    const binCount = 40;
    const width = (max - min) / binCount;
    const counts = new Array<number>(binCount).fill(0);
    for (const time of times) {
      const index = Math.min(binCount - 1, Math.floor((time - min) / width));
      counts[index]! += 1;
    }
    return {
      min,
      max,
      width,
      counts,
      peak: Math.max(...counts),
      total: times.length,
      p5: percentile(times, 0.05),
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
    };
  }, [results]);

  if (bins === null) return null;

  const W = 1000;
  const H = 220;
  const padTop = 8;
  const padBottom = 20;
  const plotW = W;
  const plotH = H - padTop - padBottom;
  const barGap = 0.6;
  const barWidth = plotW / bins.counts.length - barGap;
  const xOf = (time: number) => ((time - bins.min) / (bins.max - bins.min)) * plotW;
  const peakIndex = bins.counts.indexOf(bins.peak);
  const peakFrom = bins.min + peakIndex * bins.width;
  // 図を見られない場合に、形の要点だけでも伝える。
  const description =
    `${bins.total} 試行のタイムの分布。` +
    `${formatTime(bins.min)} から ${formatTime(bins.max)} に広がり、` +
    `最も多いのは ${formatTime(peakFrom)} あたりで ${bins.peak} 件。` +
    `p5 は ${formatTime(bins.p5)}、p50 は ${formatTime(bins.p50)}、p95 は ${formatTime(bins.p95)}。`;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-medium">タイムの分布</h3>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {bins.total.toLocaleString('ja-JP')} 試行 ・ ビン幅 {bins.width.toFixed(2)} 秒
        </span>
        <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
          p5 {formatTime(bins.p5)} ・ p50 {formatTime(bins.p50)} ・ p95 {formatTime(bins.p95)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="mt-2 h-56 w-full"
        role="img"
        aria-label={description}
      >
        {bins.counts.map((count, i) => {
          const x = i * (plotW / bins.counts.length);
          const height = bins.peak === 0 ? 0 : (count / bins.peak) * plotH;
          return (
            <rect
              key={i}
              x={x}
              y={padTop + plotH - height}
              width={Math.max(barWidth, 0)}
              height={height}
              rx={0.6}
              fill={color('speed')}
              opacity={hover === null || hover === i ? 1 : 0.45}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            />
          );
        })}
        {(
          [
            { label: 'p5', value: bins.p5 },
            { label: 'p50', value: bins.p50 },
            { label: 'p95', value: bins.p95 },
          ] as const
        ).map(({ label, value }) => (
          <line
            key={label}
            x1={xOf(value)}
            x2={xOf(value)}
            y1={padTop}
            y2={padTop + plotH}
            stroke={isDark() ? '#77746e' : '#8a877e'}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ))}
        <line
          x1={0}
          x2={plotW}
          y1={padTop + plotH}
          y2={padTop + plotH}
          stroke={isDark() ? '#46494e' : '#c6c2b8'}
          strokeWidth={1}
        />
      </svg>
      <div className="flex justify-between text-xs text-neutral-500 dark:text-neutral-400">
        <span>{formatTime(bins.min)}</span>
        {hover !== null ? (
          <span className="font-medium text-neutral-700 dark:text-neutral-200">
            {formatTime(bins.min + hover * bins.width)} – {formatTime(bins.min + (hover + 1) * bins.width)} ・{' '}
            {bins.counts[hover]!.toLocaleString('ja-JP')} 試行 ・{' '}
            {((bins.counts[hover]! / bins.total) * 100).toFixed(1)}%
          </span>
        ) : (
          <span>バーにカーソルを合わせると帯の内訳を表示</span>
        )}
        <span>{formatTime(bins.max)}</span>
      </div>
    </div>
  );
}
