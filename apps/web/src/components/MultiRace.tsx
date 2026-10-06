import { useMemo } from 'react';
import { framePerSecond } from '../../../../packages/sim/src/data/constants.ts';
import type { HorseTrace, MultiReplay } from '../../../../packages/sim/src/multi/replay.ts';
import { useStore } from '../store.ts';
import { entryLabel, NO_CHARA } from '../skills.ts';
import { Chart, type ChartSlot, type CourseBands, type SkillMarker } from './Charts.tsx';
import { HorizontalScroll, Panel } from './Inputs.tsx';

/**
 * 勝率の面から 1 レースを開く。
 *
 * 勝率を見た人が次に持つ問いは「なぜこの試行で負けたのか」である。
 * 着順の分布だけでは答えられないので、着順を選んで 1 本の中身を開く
 * （[#57](https://github.com/promodeler314-a11y/raceemu/issues/57)）。
 *
 * フレーム列は**保持していない**。押されたときに同じ種と試行番号で
 * 走らせ直している。理由は docs/multi-horse-design.md 7 節。
 */

const STYLE_LABEL: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };

/**
 * 着順の表と 1 本の表の「出走」の欄。出走の番号と、走らせたときの呼び名を並べる。
 *
 * 呼び名は結果が持つもの（`MultiResult.names`）を渡すこと。いまの相手から引くと、
 * 走らせたあとにキャラを変えたときに結果の行の名前がずれる。
 * キャラを選んでいない相手の呼び名は「N 番」で、横の番号と同じことを言うので
 * 番号だけにする。同じキャラが 2 頭いても、番号で見分けられる。
 *
 * 名前は長いと 9 字あり、幅 390 では 1 本の表が入れ物に収まらなくなる。
 * 狭い幅（sm 未満）では名前を `max-w` で切り、全名は title に持たせる（全名は出走表でも読める）。
 * sm 以上では切らない。いちばん狭い 768px（左に要約の列が入る）でも、
 * 「自分（9 字の名前）」を入れて 1 本の表が収まる。
 * 番号は切らない。番号と名前の間の空白は、文字として読むときの区切りに残す。
 */
export function EntryName({ index, names }: { index: number; names: readonly string[] }) {
  const fallback = entryLabel(index, NO_CHARA);
  const label = names[index] ?? fallback;
  const nameless = index > 0 && label === fallback;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="num inline-block min-w-[2ch] flex-none text-right">{index + 1}</span>
      {nameless ? null : (
        <>
          {' '}
          <span className="min-w-0 max-w-[7em] truncate sm:max-w-none" title={label}>
            {label}
          </span>
        </>
      )}
    </span>
  );
}

/** 位置が target を超えた最初の時刻。届かないまま終われば最後の時刻。 */
function timeAt(trace: HorseTrace, times: Float64Array, target: number): number {
  for (let i = 0; i < trace.positions.length; i++) {
    if (trace.positions[i]! >= target) return times[i] ?? 0;
  }
  return times[times.length - 1] ?? 0;
}

/**
 * 着順の分布から 1 本を選ぶ。
 *
 * 単騎の結果にある「分布の外れ値を押して中身を開く」（Summary.tsx の
 * 「この 1 本を見る」）と同じ操作感にする。あちらはタイムの端、
 * こちらは着順ごとの代表である。代表はその着順の中でタイムが中央の試行。
 */
export function MultiTrialPicker() {
  const result = useStore((s) => s.multiResult);
  const detail = useStore((s) => s.multiDetail);
  const showMultiTrial = useStore((s) => s.showMultiTrial);

  const picks = useMemo(() => {
    if (result === null) return [];
    const byOrder = new Map<number, { trial: number; raceTime: number }[]>();
    for (const record of result.selfTrials) {
      const list = byOrder.get(record.order);
      if (list === undefined) byOrder.set(record.order, [record]);
      else list.push(record);
    }
    return [...byOrder.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([order, list]) => {
        const sorted = [...list].sort((a, b) => a.raceTime - b.raceTime);
        return {
          order,
          count: list.length,
          share: list.length / Math.max(1, result.selfTrials.length),
          trial: sorted[Math.floor(sorted.length / 2)]!.trial,
        };
      });
  }, [result]);

  if (result === null || picks.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink3">自分がこの着順だった 1 本を開く:</span>
        {picks.map((pick) => (
          <button
            key={pick.order}
            type="button"
            data-testid={`open-order-${pick.order}`}
            className={`rounded-sm border px-2 py-0.5 text-xs ${
              detail?.trial === pick.trial ? 'border-ink bg-sunken' : 'border-rule2'
            }`}
            onClick={() => showMultiTrial(pick.trial)}
            title={`${pick.count} 試行のうち、タイムが中央の 1 本（試行 ${pick.trial}）を開きます。`}
          >
            {pick.order} 着（{(100 * pick.share).toFixed(1)} %）
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink3">押すと、その試行だけを同じ条件で走らせ直して中身を出します。</p>
    </div>
  );
}

/** 開いている 1 本。全頭の位置と速度、自分のスキルの発動位置を重ねる。 */
export function MultiRaceDetail() {
  const detail = useStore((s) => s.multiDetail);
  const result = useStore((s) => s.multiResult);
  const showMultiTrial = useStore((s) => s.showMultiTrial);

  // 図の材料はセレクタの外で組み立てる。中で組み立てると毎回新しい参照が返り、
  // 描画が止まる（CLAUDE.md の apps/web の節）。
  // 呼び名は走らせたときのもの（結果が持つ）を使う。
  const prepared = useMemo(
    () => (detail === null || result === null ? null : prepare(detail.replay, result.names)),
    [detail, result],
  );

  // 前後の試行へ移る。集計に入っている試行の並びをそのままたどる。
  const neighbours = useMemo(() => {
    if (detail === null || result === null) return { previous: null, next: null };
    const trials = result.selfTrials;
    const at = trials.findIndex((record) => record.trial === detail.trial);
    return {
      previous: at > 0 ? trials[at - 1]!.trial : null,
      next: at >= 0 && at < trials.length - 1 ? trials[at + 1]!.trial : null,
    };
  }, [detail, result]);

  if (detail === null || prepared === null || result === null) return null;
  const self = prepared.horses.find((horse) => horse.index === detail.replay.focus);

  return (
    <Panel title={`この 1 本（試行 ${detail.trial}）`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="multi-detail-head">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-sm border border-rule2 px-2 py-0.5 disabled:opacity-40"
            onClick={() => showMultiTrial(neighbours.previous)}
            disabled={neighbours.previous === null}
            aria-label="前の試行"
          >
            ← 前
          </button>
          <button
            type="button"
            className="rounded-sm border border-rule2 px-2 py-0.5 disabled:opacity-40"
            onClick={() => showMultiTrial(neighbours.next)}
            disabled={neighbours.next === null}
            aria-label="次の試行"
          >
            次 →
          </button>
        </div>
        <span className="text-ink2">
          試行 <span className="num">{detail.trial}</span> ・ シード <span className="num">{result.seed}</span>
        </span>
        {self !== undefined && (
          <span className="text-ink2">
            自分は <span className="num font-bold">{self.order}</span> 着 ・{' '}
            <span className="num">{self.raceTime.toFixed(3)}</span> 秒
          </span>
        )}
        {/*
          走らせ直しに掛かった時間（数十 ms）は読む人の判断に使わないので出さない
          （docs/ui-audit-race-emulator.md 第1節「内部の値」）。値は store の multiDetail に残る。
        */}
        <button
          type="button"
          className="ml-auto rounded-sm border border-rule2 px-2 py-0.5"
          onClick={() => showMultiTrial(null)}
        >
          閉じる
        </button>
      </div>

      <div className="mt-4 space-y-4">
        <Chart
          title="位置（自分との差）"
          subtitle="0 の線が自分です。上にいるほど前を走っています。灰色の帯はコーナー、破線はフェーズの境界です（どちらも自分が通った時刻）。自分がゴールしたあとは、自分のゴール地点との差になります。"
          x={prepared.times}
          height={220}
          xLabel="時刻 (秒)"
          syncKey="multi-race"
          bands={prepared.bands}
          series={prepared.gapSeries}
        />
        <Chart
          title="速度"
          subtitle="自分と、相手のうち最も先に入った 1 頭だけを描きます。"
          // 印の説明は上の図と同じなので繰り返さない。凡例は 2 頭ぶんなので出す
          skillHint={false}
          x={prepared.times}
          height={200}
          includeZero={false}
          xLabel="時刻 (秒)"
          syncKey="multi-race"
          bands={prepared.bands}
          series={prepared.speedSeries}
        />
      </div>

      {/*
        この表は幅 390 でも入れ物に収める（横に送らせない）。欄は折り返さず、長い名前は
        EntryName が切る。折り返しを許すと、名前の欄に幅を取られて脚質や見出しが
        1 字ずつ縦に割れる。収まらない幅に備えて横スクロールの入れ物には入れておく。
      */}
      <HorizontalScroll className="mt-4">
        <table className="w-full whitespace-nowrap text-xs" data-testid="multi-detail-table">
          <thead className="text-ink3">
            <tr>
              <th className="pb-1 pr-2 text-left">着順</th>
              <th className="pb-1 pr-2 text-left">出走</th>
              <th className="pb-1 pr-2 text-left">脚質</th>
              <th className="pb-1 pr-2 text-right">枠番</th>
              <th className="pb-1 pr-2 text-right">タイム</th>
              <th className="pb-1 text-right">自分との差</th>
            </tr>
          </thead>
          <tbody>
            {prepared.byOrder.map((horse) => {
              const mine = horse.index === detail.replay.focus;
              const gap = self === undefined ? Number.NaN : horse.raceTime - self.raceTime;
              return (
                <tr key={horse.index} className={`border-t border-rule2 ${mine ? 'font-bold' : ''}`}>
                  <td className="num py-1 pr-2">{horse.order}</td>
                  <td className="py-1 pr-2">
                    <EntryName index={horse.index} names={result.names} />
                  </td>
                  <td className="py-1 pr-2">{STYLE_LABEL[horse.style] ?? horse.style}</td>
                  <td className="num py-1 pr-2 text-right">{horse.gateNumber}</td>
                  <td className="num py-1 pr-2 text-right">{horse.raceTime.toFixed(3)}</td>
                  <td className="num py-1 text-right">
                    {mine || !Number.isFinite(gap) ? '—' : `${gap >= 0 ? '+' : ''}${gap.toFixed(3)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </HorizontalScroll>
    </Panel>
  );
}

/**
 * 走らせ直した 1 本を、図に載せられる形にする。
 *
 * `names` は出走の並びごとの呼び名（`MultiResult.names`）。凡例に使う。
 */
function prepare(replay: MultiReplay, names: readonly string[]) {
  const times = replay.times;
  const frames = replay.frames;
  const self = replay.horses.find((horse) => horse.index === replay.focus) ?? replay.horses[0]!;
  // 自分がゴールしたあとは、ゴール地点を基準にする。相手だけが走っている
  // 区間でも差が読めるようにするためで、値は「自分のゴールまでの残り」になる。
  const selfPosition = (i: number) =>
    i < self.positions.length ? self.positions[i]! : self.positions[self.positions.length - 1]!;

  // 自分と、相手のうち最先着の 1 頭だけを立たせる。以前は「1 着」を立たせていたので、
  // 自分が 1 着のときは比べる相手の線が出なかった（#102、UI 診断 第3節 A-6）。
  // 残りは数が多いので地の色に寄せる。色そのものではなく役割を渡す（テーマの切り替えに追従させるため）。
  const rival = replay.horses
    .filter((horse) => horse.index !== replay.focus)
    .reduce<HorseTrace | undefined>((best, horse) => (best === undefined || horse.order < best.order ? horse : best), undefined);
  const slotOf = (horse: HorseTrace): ChartSlot =>
    horse.index === replay.focus ? 'speed' : horse.index === rival?.index ? 'sp' : 'other';
  const widthOf = (horse: HorseTrace) =>
    horse.index === replay.focus ? 2.5 : horse.index === rival?.index ? 2 : 1;
  // 凡例には番号の欄が無いので、呼び名をそのまま使う（名前の無い相手は「N 番」）。
  const labelOf = (horse: HorseTrace) =>
    `${names[horse.index] ?? entryLabel(horse.index, NO_CHARA)} ${STYLE_LABEL[horse.style] ?? horse.style} ${
      horse.order
    } 着`;

  // 自分を先に、あとは着順で並べる。最先着の相手は相手の先頭に来るので、
  // 凡例は「自分、最先着、ほかの相手（まとめた 1 項目）」の順になる。
  const horses = [...replay.horses].sort((a, b) => {
    if (a.index === replay.focus) return -1;
    if (b.index === replay.focus) return 1;
    return a.order - b.order;
  });

  // 自分と最先着以外の線は同じ灰色で、凡例に 1 頭ずつ並べても見分けられない。
  // 18 頭では凡例だけで半画面になるので、凡例では 1 項目にまとめる。個々の馬は下の表で読む。
  const othersCount = horses.filter((horse) => slotOf(horse) === 'other').length;
  const othersGroup = `ほかの相手（${othersCount} 頭）`;
  const gapSeries = horses.map((horse) => {
    const values: (number | null)[] = new Array(frames).fill(null);
    for (let i = 0; i < horse.positions.length; i++) values[i] = horse.positions[i]! - selfPosition(i);
    const slot = slotOf(horse);
    return {
      label: labelOf(horse),
      values,
      slot,
      width: widthOf(horse),
      ...(slot === 'other' ? { legendGroup: othersGroup } : {}),
    };
  });
  // 速度は全頭ぶん描くとほぼ重なって見分けられない。自分と最先着の相手だけにする
  const speedSeries = horses.filter((horse) => horse.index === replay.focus || horse.index === rival?.index).map((horse) => {
    const values: (number | null)[] = new Array(frames).fill(null);
    for (let i = 0; i < horse.speeds.length; i++) values[i] = horse.speeds[i]!;
    return { label: labelOf(horse), values, slot: slotOf(horse), width: widthOf(horse) };
  });

  // コーナーとフェーズは、自分が通った時刻に置く。頭ごとに通過時刻が違うので、
  // 「自分から見た場面」に揃えるのが読みやすい。
  const length = replay.courseLength;
  const bands: CourseBands = {
    corners: replay.trackDetail.corners.map(
      (corner) => [timeAt(self, times, corner.start), timeAt(self, times, corner.end)] as [number, number],
    ),
    phases: [length / 6, (length * 2) / 3, (length * 5) / 6].map((position) =>
      timeAt(self, times, position),
    ),
    skills: skillMarkers(replay),
  };

  // 表は着順で並べる。図と凡例は自分を先頭に置くので、並びが違う。
  const byOrder = [...replay.horses].sort((a, b) => a.order - b.order);
  return { times, horses, byOrder, gapSeries, speedSeries, bands };
}

/**
 * 自分のスキルが発動した時刻。
 *
 * 先頭のフレームはスタート前で、発動位置を持たないスキル（継承や
 * スタート系）がまとまって出るので外す。単騎の詳細と同じ扱いである。
 */
function skillMarkers(replay: MultiReplay): SkillMarker[] {
  const byTime = new Map<number, SkillMarker>();
  for (let i = 1; i < replay.focusFrames.length; i++) {
    const frame = replay.focusFrames[i]!;
    if (frame.triggeredSkills.length === 0) continue;
    const time = i / framePerSecond;
    const names = frame.triggeredSkills.map((triggered) => triggered.invoke.skill.name);
    const existing = byTime.get(time);
    if (existing === undefined) {
      byTime.set(time, {
        position: time,
        labels: names,
        caption: `${time.toFixed(1)} 秒 ・ ${frame.startPosition.toFixed(0)} m`,
      });
    } else {
      byTime.set(time, { ...existing, labels: [...existing.labels, ...names] });
    }
  }
  return [...byTime.values()];
}
