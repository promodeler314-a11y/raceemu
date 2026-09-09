import { framePerSecond } from '../../../packages/sim/src/data/constants.ts';
import type { TrackDetail } from '../../../packages/sim/src/data/track.ts';
import type { RaceFrame } from '../../../packages/sim/src/state.ts';

/**
 * 1 レースの出来事を時刻順に並べる。
 *
 * [モック](../../../design/Detail.dc.html)の「イベント」の表にあたる。
 * フレーム列は前から持っていたが、画面には図しか出していなかった。
 * 図は「どう動いたか」は見せるが「なぜそこで変わったのか」は見せない。
 *
 * 状態の変化は立ち上がりだけを拾う。毎フレーム真であり続けるものを
 * そのまま並べると、数百行のうち大半が同じ行になる。
 */

export type EventKind = 'skill' | 'phase' | 'corner' | 'state' | 'end';

export interface RaceEvent {
  /** 秒。フレーム番号を framePerSecond で割ったもの。 */
  readonly time: number;
  readonly position: number;
  readonly kind: EventKind;
  readonly label: string;
  readonly detail: string;
}

const KIND_LABEL: Record<EventKind, string> = {
  skill: 'スキル',
  phase: 'フェーズ',
  corner: 'コーナー',
  state: 'イベント',
  end: '終了',
};

export function kindLabel(kind: EventKind): string {
  return KIND_LABEL[kind];
}

/** 立ち上がりを拾う状態。名前は画面に出る文言。 */
const STATES: readonly {
  readonly key: keyof RaceFrame;
  readonly label: string;
}[] = [
  { key: 'temptation', label: '掛かり' },
  { key: 'positionCompetition', label: '位置取り調整' },
  { key: 'conservePower', label: '持久力温存' },
  { key: 'staminaKeep', label: 'スタミナ温存' },
  { key: 'leadCompetition', label: '先頭争い' },
  { key: 'competeFight', label: '追い比べ' },
  { key: 'secureLead', label: 'リード確保' },
  { key: 'downSlopeMode', label: '下り坂加速' },
  { key: 'spurting', label: 'スパート' },
  { key: 'staminaLimitBreak', label: '限界突破' },
  { key: 'fullSpurt', label: '全力スパート' },
];

function speedText(operating: {
  targetSpeed: number;
  acceleration: number;
  duration: number;
} | null): string {
  if (operating === null) return '';
  const parts: string[] = [];
  if (operating.targetSpeed !== 0) parts.push(`速度 ${signed(operating.targetSpeed, 2)} m/s`);
  if (operating.acceleration !== 0) parts.push(`加速 ${signed(operating.acceleration, 2)} m/s²`);
  if (operating.duration > 0) parts.push(`${operating.duration.toFixed(1)} 秒`);
  return parts.join(' ・ ');
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function buildEvents(
  frames: readonly RaceFrame[],
  track: TrackDetail,
  finish: { raceTime: number; goalSp: number; spMax: number },
): RaceEvent[] {
  const events: RaceEvent[] = [];
  const at = (i: number) => ({ time: i / framePerSecond, position: frames[i]!.startPosition });

  // フェーズ境界。本家と同じく 1/6、2/3、5/6 で切り替わる。
  const phases: readonly [number, string][] = [
    [track.distance / 6, '中盤へ'],
    [(track.distance * 2) / 3, '終盤へ'],
    [(track.distance * 5) / 6, 'ラストへ'],
  ];
  const cornerEdges: readonly [number, string][] = track.corners.map((corner, i) => [
    corner.start,
    `コーナー ${i + 1} に入る`,
  ]);

  const seenPhase = new Set<number>();
  const seenCorner = new Set<number>();
  const active = new Set<string>();

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i]!;
    const previous = frames[i - 1]!;

    for (const [position, label] of phases) {
      if (!seenPhase.has(position) && frame.startPosition >= position) {
        seenPhase.add(position);
        events.push({ ...at(i), kind: 'phase', label, detail: '' });
      }
    }
    for (const [position, label] of cornerEdges) {
      if (!seenCorner.has(position) && frame.startPosition >= position) {
        seenCorner.add(position);
        events.push({ ...at(i), kind: 'corner', label, detail: '' });
      }
    }

    for (const triggered of frame.triggeredSkills) {
      const name = triggered.invoke.skill.name;
      const parts: string[] = [];
      const speed = speedText(triggered.operating);
      if (speed !== '') parts.push(speed);
      if (triggered.heal !== null && triggered.heal !== 0) {
        parts.push(`体力 ${signed(triggered.heal, 0)}`);
      }
      // 回復しきれずに捨てた量。上限に当たっていることが読み取れる。
      if (triggered.waste !== null && triggered.waste > 0) {
        parts.push(`うち ${triggered.waste.toFixed(0)} は上限で捨てた`);
      }
      events.push({ ...at(i), kind: 'skill', label: name, detail: parts.join(' ・ ') });
    }

    for (const { key, label } of STATES) {
      const now = frame[key] === true;
      const before = previous[key] === true;
      if (now && !before) {
        active.add(label);
        events.push({ ...at(i), kind: 'state', label, detail: '始まり' });
      } else if (!now && before && active.has(label)) {
        active.delete(label);
        events.push({ ...at(i), kind: 'state', label, detail: '終わり' });
      }
    }
  }

  const remaining = finish.spMax === 0 ? 0 : (finish.goalSp / finish.spMax) * 100;
  events.push({
    time: finish.raceTime,
    position: track.distance,
    kind: 'end',
    label: 'ゴール',
    detail: `残り体力 ${remaining.toFixed(1)} %`,
  });

  return events;
}
