import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { getSlope } from '../../../../packages/sim/src/data/track.ts';
import { currentTrackDetail, useStore } from '../store.ts';
import { buildEvents, kindLabel, type EventKind, type RaceEvent } from '../events.ts';
import { formatTime, percentile } from '../format.ts';
import { Panel } from './Inputs.tsx';

/**
 * 図の色は共有のトークン（design-system/tokens.css の --uma-chart-*）から読む。
 *
 * uPlot は canvas に描くので、CSS の変数をそのまま渡せない。図を作るときに
 * getComputedStyle で値を読み、テーマが変わったら図を作り直す（Chart の
 * useEffect が theme に依存している）。以前は明暗の値をここに直書きしていて、
 * トークンと二重になっていたうえ、切り替えても表示中の図は前の色のままだった
 * （docs/ui-audit-race-emulator.md 第3節 A-1・A-3）。
 *
 * 系列の割り当てはモックに合わせてある。目標速度は速度と同じ量の参照線であって
 * 別の系列ではないので、カテゴリ色を 1 枠使わず、破線の文脈色で描く。
 * 空いた橙は体力に回した。
 *
 * - speed / sp：系列（速度、体力）
 * - context：目標速度と勾配。コースと設定の文脈であって系列ではないので、地の文字色に寄せる
 * - other：全頭同時の図の、自分と 1 着以外の線
 */
export type ChartSlot = 'speed' | 'sp' | 'context' | 'other';

interface ChartPalette extends Record<ChartSlot, string> {
  readonly grid: string;
  /** コーナーの帯 */
  readonly band: string;
  /** フェーズの境の破線 */
  readonly phase: string;
  /** スキルの印。イベント表の色分け（border-s1 text-s1）と揃える */
  readonly skill: string;
  readonly fontSans: string;
}

/**
 * 縦軸の幅を目盛りの文字から決める。uPlot の既定は固定の幅で、書体を
 * BIZ UDPゴシックにしてから「2,000」のような目盛りが左で切れていた。
 * uPlot の軸の自動調整の例（axis-autosize）と同じ考え方で、いちばん長い目盛りを測る。
 */
function fitAxisSize(self: uPlot, values: string[] | null, axisIdx: number, cycleNum: number): number {
  const axis = self.axes[axisIdx]! as uPlot.Axis & { _size?: number; font?: unknown };
  // 2 巡目以降は前の値を使う。測り直すと大きさが揺れて止まらないことがある
  if (cycleNum > 1 && axis._size !== undefined) return axis._size;
  let size = (axis.ticks?.size ?? 10) + (axis.gap ?? 5);
  const longest = (values ?? []).reduce((acc, value) => (value.length > acc.length ? value : acc), '');
  if (longest !== '') {
    const font = Array.isArray(axis.font) ? String(axis.font[0]) : String(axis.font ?? '');
    if (font !== '') self.ctx.font = font;
    size += self.ctx.measureText(longest).width / devicePixelRatio;
  }
  return Math.ceil(size);
}

/** 凡例に出す値。カーソルが無いとき（値が null）は空にする。 */
function legendValue(_u: uPlot, value: number | null): string {
  return value === null ? '' : value.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

function readPalette(): ChartPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(`--uma-${name}`).trim();
  return {
    speed: read('chart-speed'),
    sp: read('chart-sp'),
    context: read('chart-context'),
    other: read('chart-other'),
    grid: read('chart-grid'),
    band: read('chart-band'),
    phase: read('chart-phase'),
    skill: read('s1'),
    fontSans: read('font-sans'),
  };
}

/**
 * カーソルの同期は図の組ごとに分ける。
 *
 * 単騎の詳細は横軸が距離、全頭同時の 1 本は横軸が時刻である。
 * 同じ鍵にすると、軸の意味が違うものどうしで位置を合わせてしまう。
 */
const cursorSyncs = new Map<string, uPlot.SyncPubSub>();
function cursorSync(key: string): uPlot.SyncPubSub {
  let sync = cursorSyncs.get(key);
  if (sync === undefined) {
    sync = uPlot.sync(key);
    cursorSyncs.set(key, sync);
  }
  return sync;
}

/** 同じ位置（フレーム）で複数発動した場合はまとめる。 */
export interface SkillMarker {
  /** 横軸の値。距離の図では m、時刻の図では秒。 */
  readonly position: number;
  readonly labels: readonly string[];
  /** 図の下に出す見出し。省くと横軸の値を距離として出す。 */
  readonly caption?: string;
}

/**
 * 図の背景に敷くコースの目印。
 *
 * 値の単位は横軸に合わせる。単騎の詳細では距離 (m)、
 * 全頭同時の 1 本では時刻 (秒) を入れる。
 */
export interface CourseBands {
  readonly corners: readonly [number, number][];
  readonly phases: readonly number[];
  readonly skills: readonly SkillMarker[];
}

/** カーソルに最も近いスキル発動位置。閾値外なら null。 */
function nearestSkill(u: uPlot, skills: readonly SkillMarker[]): SkillMarker | null {
  const left = u.cursor.left;
  if (left === undefined || left < 0) return null;
  let nearest: SkillMarker | null = null;
  let nearestDist = 6;
  for (const marker of skills) {
    // cursor.left は CSS px、valToPos の第 3 引数を false にすると同じ単位で返る
    // （draw フックの ctx 描画は canvas px なので、そちらは true のままにする）。
    const distance = Math.abs(u.valToPos(marker.position, 'x', false) - left);
    if (distance < nearestDist) {
      nearestDist = distance;
      nearest = marker;
    }
  }
  return nearest;
}

/**
 * コーナーを薄い帯で、フェーズ境界を破線で背景に描く。
 * スキル発動位置は縦線と上端の三角印で示し、カーソルが近づくと onHoverSkill で名前を伝える。
 */
function coursePlugin(
  bands: CourseBands,
  palette: ChartPalette,
  onHoverSkill: (marker: SkillMarker | null) => void,
): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx } = u;
        const top = u.bbox.top;
        const height = u.bbox.height;
        ctx.save();
        ctx.fillStyle = palette.band;
        for (const [start, end] of bands.corners) {
          const x0 = u.valToPos(start, 'x', true);
          const x1 = u.valToPos(end, 'x', true);
          ctx.fillRect(x0, top, x1 - x0, height);
        }
        ctx.strokeStyle = palette.phase;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        for (const position of bands.phases) {
          const x = Math.round(u.valToPos(position, 'x', true)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
        }
        const skillColor = palette.skill;
        ctx.setLineDash([]);
        for (const marker of bands.skills) {
          const x = Math.round(u.valToPos(marker.position, 'x', true)) + 0.5;
          ctx.strokeStyle = skillColor;
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = skillColor;
          ctx.beginPath();
          ctx.moveTo(x - 3.5, top);
          ctx.lineTo(x + 3.5, top);
          ctx.lineTo(x, top + 6);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      },
      setCursor: (u) => {
        onHoverSkill(nearestSkill(u, bands.skills));
      },
    },
  };
}

export interface ChartProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly x: Float64Array;
  readonly series: readonly {
    label: string;
    /**
     * 系列の値。途中で終わる系列（ゴールした頭）は null を置くと線が切れる。
     */
    values: Float64Array | readonly (number | null)[];
    /**
     * 線の色の役割。省くと context。色そのものは渡さない。
     * 渡すと図を作った時点の色で固まり、テーマを切り替えても変わらなくなる。
     */
    slot?: ChartSlot;
    /** 参照線として破線で描く。系列そのものではないもの。 */
    dashed?: boolean;
    /** 線の太さ。省くと 2（破線は 1.5）。 */
    width?: number;
  }[];
  readonly bands: CourseBands;
  readonly height: number;
  /** true なら 0 を含めた範囲にする。速度のように 0 付近を使わない図では false。 */
  readonly includeZero?: boolean;
  /** 横軸の見出し。省くと距離。 */
  readonly xLabel?: string;
  /** カーソルを同期する相手の組。横軸の意味が違う図は別の鍵にする。 */
  readonly syncKey?: string;
  /** 凡例を出すか。系列が多いときに畳める。 */
  readonly legend?: boolean;
  /**
   * 縦軸のグリッドを引くか。値の段差が小さい図（勾配）では、線がグリッドに
   * 埋もれるので消す（#102、UI 診断 第3節 A-5）。
   */
  readonly yGrid?: boolean;
  /**
   * スキルの印の読み方を図の下に書くか。図を縦に並べるときは最初の 1 枚だけにする。
   * 同じ説明を図ごとに繰り返さない（docs/ui-audit-race-emulator.md 第1節「操作説明の繰り返し」）。
   */
  readonly skillHint?: boolean;
}

export function Chart({
  title,
  subtitle,
  x,
  series,
  bands,
  height,
  includeZero = true,
  xLabel = '距離 (m)',
  syncKey = 'race',
  legend = true,
  skillHint: showSkillHint = true,
  yGrid = true,
}: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [hoverSkill, setHoverSkill] = useState<SkillMarker | null>(null);
  // 色は作るときに読むので、テーマが変わったら作り直す。
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    setHoverSkill(null);
  }, [bands]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const palette = readPalette();
    // 軸の文字は canvas に描くので、uPlot の既定（system-ui のスタック）のままだと
    // 画面の書体と揃わない。大きさと太さは既定のままにする。
    const axis = {
      stroke: palette.context,
      grid: { stroke: palette.grid },
      font: `12px ${palette.fontSans}`,
      labelFont: `bold 12px ${palette.fontSans}`,
    };
    const options: uPlot.Options = {
      title,
      width: element.clientWidth,
      height,
      cursor: { sync: { key: cursorSync(syncKey).key }, drag: { x: true, y: false } },
      legend: { show: legend, live: true },
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
        { label: xLabel, ...axis },
        { ...axis, grid: { ...axis.grid, show: yGrid }, size: fitAxisSize },
      ],
      // カーソルが無いとき、凡例の値の欄は既定で「--」になる。空にする（#102、A-7）
      series: [
        { label: xLabel, value: legendValue },
        ...series.map((s) => ({
          label: s.label,
          value: legendValue,
          stroke: palette[s.slot ?? 'context'],
          width: s.width ?? (s.dashed === true ? 1.5 : 2),
          ...(s.dashed === true ? { dash: [4, 3] } : {}),
          points: { show: false },
        })),
      ],
      plugins: [coursePlugin(bands, palette, setHoverSkill)],
    };
    // 横軸のあとに系列が並ぶ。値は Float64Array と (number | null)[] を混ぜられる。
    const data = [x, ...series.map((s) => s.values)] as uPlot.AlignedData;
    plot.current = new uPlot(options, data, element);
    const onResize = () => plot.current?.setSize({ width: element.clientWidth, height });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.current?.destroy();
      plot.current = null;
    };
  }, [title, height, x, series, bands, includeZero, xLabel, syncKey, legend, yGrid, theme]);

  const skillHint =
    !showSkillHint || bands.skills.length === 0
      ? undefined
      : '薄い縦線と三角の印はスキル発動位置です。カーソルを合わせると名前を表示します。';
  const caption =
    hoverSkill !== null
      ? `${hoverSkill.caption ?? `${hoverSkill.position.toFixed(0)} m`} ・ ${hoverSkill.labels.join('、')}`
      : [subtitle, skillHint].filter((s) => s !== undefined).join(' ');

  return (
    <div>
      <div ref={ref} className="w-full" />
      {caption !== '' && (
        <p className={`mt-1 text-xs ${hoverSkill !== null ? 'text-s1' : 'text-ink3'}`}>{caption}</p>
      )}
    </div>
  );
}

export function FrameCharts() {
  const detail = useStore((s) => s.detail);
  const track = useStore((s) => s.track);
  const results = useStore((s) => s.results);
  const trackDetail = currentTrackDetail(track);

  const events = useMemo(() => {
    if (detail === null || trackDetail === undefined) return [];
    // タイムと残り体力は結果の側から取る。シミュレーション状態は終端の値を
    // 持たない（フレームを回し終えた時点の内部状態である）。
    const result = results[detail.trial];
    if (result === undefined) return [];
    return buildEvents(detail.frames, trackDetail, {
      raceTime: result.raceTime,
      goalSp: result.goalSp,
      spMax: detail.state.setting.spMax,
    });
  }, [detail, trackDetail, results]);

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
    const skillPositions = new Map<number, string[]>();
    for (const event of events) {
      if (event.kind !== 'skill') continue;
      const labels = skillPositions.get(event.position);
      if (labels === undefined) skillPositions.set(event.position, [event.label]);
      else labels.push(event.label);
    }
    const bands: CourseBands = {
      corners: trackDetail.corners.map((c) => [c.start, c.end] as [number, number]),
      phases: [
        trackDetail.distance / 6,
        (trackDetail.distance * 2) / 3,
        (trackDetail.distance * 5) / 6,
      ],
      skills: Array.from(skillPositions, ([position, labels]) => ({ position, labels })),
    };
    return { x, speed, target, sp, slope, bands };
  }, [detail, trackDetail, events]);

  if (prepared === null) {
    return (
      <Panel title="レースの詳細">
        <p className="text-sm text-ink3">実行すると 1 本目のレースを表示します。</p>
      </Panel>
    );
  }

  return (
    <Panel title={`レースの詳細（試行 ${detail!.trial}）`}>
      <div className="space-y-4">
        <TrialNavigation />
        <Chart
          title="速度"
          subtitle="灰色の帯はコーナー、破線は序盤と中盤と終盤とラストの境界です。"
          x={prepared.x}
          height={220}
          includeZero={false}
          bands={prepared.bands}
          series={[
            { label: '現在速度 (m/s)', values: prepared.speed, slot: 'speed' },
            { label: '目標速度 (m/s)', values: prepared.target, slot: 'context', dashed: true },
          ]}
        />
        <Chart
          title="残り体力"
          skillHint={false}
          x={prepared.x}
          height={160}
          bands={prepared.bands}
          series={[{ label: '残り体力', values: prepared.sp, slot: 'sp' }]}
        />
        <Chart
          title="勾配"
          skillHint={false}
          subtitle="エミュレータ内部の勾配値です。1.0 以上を上り坂、-1.0 以下を下り坂として扱います。"
          x={prepared.x}
          height={120}
          bands={prepared.bands}
          yGrid={false}
          series={[{ label: '勾配', values: prepared.slope, slot: 'context', width: 2.5 }]}
        />
        <EventList events={events} />
      </div>
    </Panel>
  );
}

/**
 * どの試行を開いているか、と前後への移動。
 *
 * 「試行 0」とだけ出ていても、それが速いほうなのか遅いほうなのかが
 * 分からない。分布のどこにいるかを併せて出す。
 */
function TrialNavigation() {
  const detail = useStore((s) => s.detail);
  const results = useStore((s) => s.results);
  const seed = useStore((s) => s.seed);
  const showTrial = useStore((s) => s.showTrial);
  if (detail === null || results.length === 0) return null;

  const time = results[detail.trial]?.raceTime;
  const rank =
    time === undefined ? null : results.filter((r) => r.raceTime < time).length;
  const percentile = rank === null ? null : (rank / results.length) * 100;

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="rounded-sm border border-rule2 px-2 py-0.5 disabled:opacity-40"
          onClick={() => showTrial(detail.trial - 1)}
          disabled={detail.trial <= 0}
          aria-label="前の試行"
        >
          ← 前
        </button>
        <button
          type="button"
          className="rounded-sm border border-rule2 px-2 py-0.5 disabled:opacity-40"
          onClick={() => showTrial(detail.trial + 1)}
          disabled={detail.trial >= results.length - 1}
          aria-label="次の試行"
        >
          次 →
        </button>
      </div>
      <span className="text-ink2">
        試行 <span className="num">{detail.trial}</span> / <span className="num">{results.length - 1}</span> ・ シード{' '}
        <span className="num">{seed}</span>
      </span>
      {time !== undefined && percentile !== null && (
        <span className="text-ink3">
          この 1 本は <span className="num">{formatTime(time)}</span>
          ・ 速いほうから <span className="num">{percentile.toFixed(0)}</span> %
        </span>
      )}
    </div>
  );
}

/**
 * 1 レースの出来事。
 *
 * 図は「どう動いたか」は見せるが「なぜそこで変わったのか」は見せない。
 * 速度が落ちた場所にコーナーがあったのか、スキルが切れたのか、掛かったのかは、
 * 並べて初めて読める。
 */
const KIND_STYLE: Record<EventKind, string> = {
  skill: 'border-s1 text-s1',
  phase: 'border-rule2 text-ink2',
  corner: 'border-rule2 text-ink3',
  state: 'border-rule2 text-ink2',
  end: 'border-ink2 text-ink',
};

function EventList({ events }: { events: readonly RaceEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-sm font-bold">イベント</h3>
        <span className="text-xs text-ink3">{events.length} 件</span>
      </div>
      <div className="mt-2 max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-rule text-ink3">
              <th scope="col" className="py-1 pr-3 text-right font-normal">時刻</th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">位置</th>
              <th scope="col" className="py-1 pr-3 text-left font-normal">種別</th>
              <th scope="col" className="py-1 text-left font-normal">内容</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, i) => (
              <tr key={i} className="border-b border-rule last:border-0">
                <td className="num py-1 pr-3 text-right text-ink2">{event.time.toFixed(1)}</td>
                <td className="num py-1 pr-3 text-right text-ink2">
                  {event.position.toFixed(0)} m
                </td>
                <td className="py-1 pr-3">
                  <span className={`whitespace-nowrap rounded-sm border px-1 text-[11px] ${KIND_STYLE[event.kind]}`}>
                    {kindLabel(event.kind)}
                  </span>
                </td>
                <td className="py-1">
                  {event.label}
                  {event.detail !== '' && <span className="text-ink3"> ／ {event.detail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** タイムの分布。単系列なので凡例は置かず、見出しで何かを示す。 */
export function TimeHistogram() {
  const results = useStore((s) => s.results);
  const [hover, setHover] = useState<number | null>(null);

  const bins = useMemo(() => {
    if (results.length === 0) return null;
    const times = results.map((r) => r.raceTime).sort((a, b) => a - b);
    const fastest = times[0]!;
    const slowest = times[times.length - 1]!;
    if (!Number.isFinite(fastest) || slowest === fastest) return null;
    // 横軸は外れ値を除いた範囲に取る。スタミナが持たない試行のような遅い裾が
    // 数 % あると、最速〜最遅で取ったときに本体が左の数割に押し込まれて形が
    // 読めない（docs/ui-audit-race-emulator.md 第3節 A-4）。四分位範囲の 3 倍より
    // 外は図に入れず、何試行あったかを軸の端に書く。
    const q1 = percentile(times, 0.25);
    const q3 = percentile(times, 0.75);
    const iqr = q3 - q1;
    let min = iqr > 0 ? Math.max(fastest, q1 - 3 * iqr) : fastest;
    let max = iqr > 0 ? Math.min(slowest, q3 + 3 * iqr) : slowest;
    if (!(max > min)) {
      min = fastest;
      max = slowest;
    }
    const binCount = 40;
    const width = (max - min) / binCount;
    const counts = new Array<number>(binCount).fill(0);
    let below = 0;
    let above = 0;
    for (const time of times) {
      if (time < min) below += 1;
      else if (time > max) above += 1;
      else counts[Math.min(binCount - 1, Math.floor((time - min) / width))]! += 1;
    }
    return {
      min,
      max,
      fastest,
      slowest,
      below,
      above,
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
    `${bins.total} 試行のタイムの分布です。` +
    `${formatTime(bins.fastest)} から ${formatTime(bins.slowest)} に広がり、` +
    (bins.below + bins.above > 0
      ? `図は ${formatTime(bins.min)} から ${formatTime(bins.max)} の範囲を描いています（外れた ${bins.below + bins.above} 試行を除く）。`
      : '') +
    `最も多いのは ${formatTime(peakFrom)} あたりで ${bins.peak} 件です。` +
    `p5 は ${formatTime(bins.p5)}、p50 は ${formatTime(bins.p50)}、p95 は ${formatTime(bins.p95)} です。`;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-bold">タイムの分布</h3>
        <span className="text-xs text-ink3">
          {/* 試行数は結果の見出しにある。ここでは繰り返さない */}
          ビン幅 {bins.width.toFixed(2)} 秒
        </span>
        {/* 統計の記法（p5 / p50 / p95）ではなく言葉で書く。破線 3 本はこの 3 つの位置 */}
        <span className="text-xs text-ink3">
          中央 <span className="num">{formatTime(bins.p50)}</span> ・ 9 割が{' '}
          <span className="num">{formatTime(bins.p5)}</span> 〜 <span className="num">{formatTime(bins.p95)}</span>
          （破線）
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
              // SVG は CSS の変数をそのまま使えるので、テーマを切り替えるとその場で変わる。
              style={{ fill: 'var(--uma-chart-speed)' }}
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
            className="stroke-ink3"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ))}
        <line
          x1={0}
          x2={plotW}
          y1={padTop + plotH}
          y2={padTop + plotH}
          className="stroke-rule2"
          strokeWidth={1}
        />
      </svg>
      <div className="flex justify-between gap-3 text-xs text-ink3">
        <span>
          {formatTime(bins.min)}
          {bins.below > 0 && <span className="block">これより速い {bins.below.toLocaleString('ja-JP')} 試行は図の外</span>}
        </span>
        {hover !== null ? (
          <span className="font-bold text-ink2">
            {formatTime(bins.min + hover * bins.width)} – {formatTime(bins.min + (hover + 1) * bins.width)} ・{' '}
            {bins.counts[hover]!.toLocaleString('ja-JP')} 試行 ・{' '}
            {((bins.counts[hover]! / bins.total) * 100).toFixed(1)}%
          </span>
        ) : (
          <span>バーにカーソルを合わせると帯の内訳を表示します</span>
        )}
        <span className="text-right">
          {formatTime(bins.max)}
          {bins.above > 0 && (
            <span className="block">
              これより遅い {bins.above.toLocaleString('ja-JP')} 試行（最遅 {formatTime(bins.slowest)}）は図の外
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
