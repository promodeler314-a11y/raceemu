import type { RaceSetting, UmaStatus } from '../../sim/src/setting.ts';
import type { RaceSimulationResult } from '../../sim/src/state.ts';

/** 逆算で動かすステータス */
export type TargetStatus = 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom';

/** 逆算の目標 */
export type Goal =
  | { readonly kind: 'maxSpurt' }
  | { readonly kind: 'finish' }
  | { readonly kind: 'goalSp'; readonly atLeast: number };

export function achieved(goal: Goal, result: RaceSimulationResult): boolean {
  switch (goal.kind) {
    case 'maxSpurt':
      return result.maxSpurt;
    case 'finish':
      return result.goalSp >= 0;
    case 'goalSp':
      return result.goalSp >= goal.atLeast;
  }
}

export const GOAL_LABEL: Record<Goal['kind'], string> = {
  maxSpurt: '最大スパート',
  finish: '完走',
  goalSp: '残り体力',
};

export const STATUS_LABEL: Record<TargetStatus, string> = {
  speed: 'スピード',
  stamina: 'スタミナ',
  power: 'パワー',
  guts: '根性',
  wisdom: '賢さ',
};

export function withStatus(setting: RaceSetting, status: TargetStatus, value: number): RaceSetting {
  const uma: UmaStatus = { ...setting.uma, [status]: value };
  return { ...setting, uma };
}
