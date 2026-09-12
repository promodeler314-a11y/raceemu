import type { FieldView } from '../field/field.ts';
import type { RaceState } from '../state.ts';

/**
 * 同時に走っている他頭の位置をその場で読む問い合わせ口。
 *
 * 読むのは position ではなく startPosition である。
 * 駆動側がフレームの頭で全頭ぶんの startPosition を置くので、
 * 頭数の並び順によらず全員が同じ時刻の位置を見る。
 * docs/multi-horse-design.md 3.1 節を参照。
 */
export class LiveField implements FieldView {
  constructor(
    /** 全頭の状態。駆動側が埋めていく配列をそのまま持つ。 */
    private readonly states: readonly RaceState[],
    private readonly selfIndex: number,
    readonly gateCount: number,
  ) {}

  get opponents(): number {
    return this.gateCount - 1;
  }

  order(_frameElapsed: number, position: number): number {
    let ahead = 0;
    for (let i = 0; i < this.states.length; i++) {
      if (i === this.selfIndex) continue;
      if (this.states[i]!.simulation.startPosition > position) ahead++;
    }
    return ahead + 1;
  }

  distanceFromTop(_frameElapsed: number, position: number): number {
    let top = position;
    for (let i = 0; i < this.states.length; i++) {
      if (i === this.selfIndex) continue;
      const other = this.states[i]!.simulation.startPosition;
      if (other > top) top = other;
    }
    return top - position;
  }

  distanceToFront(_frameElapsed: number, position: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.states.length; i++) {
      if (i === this.selfIndex) continue;
      const gap = this.states[i]!.simulation.startPosition - position;
      if (gap > 0 && gap < best) best = gap;
    }
    return best;
  }

  distanceToBehind(_frameElapsed: number, position: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.states.length; i++) {
      if (i === this.selfIndex) continue;
      const gap = position - this.states[i]!.simulation.startPosition;
      if (gap > 0 && gap < best) best = gap;
    }
    return best;
  }

  spread(_frameElapsed: number, position: number): number {
    let top = position;
    let last = position;
    for (let i = 0; i < this.states.length; i++) {
      if (i === this.selfIndex) continue;
      const other = this.states[i]!.simulation.startPosition;
      if (other > top) top = other;
      if (other < last) last = other;
    }
    return top - last;
  }

  /** そのフレームで最も前にいる他頭。位置取りの判定が見る相手になる。 */
  /** `FieldView` の口。同時に走っているので、フレーム番号は使わない。 */
  paceMaker(_frameElapsed: number): RaceState | null {
    return this.leader();
  }

  leader(): RaceState | null {
    let best: RaceState | null = null;
    let bestPosition = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.states.length; i++) {
      if (i === this.selfIndex) continue;
      const state = this.states[i]!;
      if (state.simulation.startPosition > bestPosition) {
        bestPosition = state.simulation.startPosition;
        best = state;
      }
    }
    return best;
  }
}
