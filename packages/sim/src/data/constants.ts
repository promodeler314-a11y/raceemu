/**
 * 係数表。mee1080/umasim の race モジュール constants.kt からの移植。
 * 元の実装は uma-clock-emu (Romulus Urakagi Tsai) からの移植である。
 */

export type Style = 'NIGE' | 'SEN' | 'SASI' | 'OI' | 'OONIGE';
export type Distance = 'SHORT' | 'MILE' | 'MIDDLE' | 'LONG';
export type FitRank = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type Condition = 'BEST' | 'GOOD' | 'NORMAL' | 'BAD' | 'WORST';

export const FIT_RANKS: readonly FitRank[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** スキル条件で使う脚質の番号。大逃げは逃げと同じ 1。 */
export const styleValue: Record<Style, number> = {
  NIGE: 1,
  SEN: 2,
  SASI: 3,
  OI: 4,
  OONIGE: 1,
};

export const styleLabel: Record<Style, string> = {
  NIGE: '逃げ',
  SEN: '先行',
  SASI: '差し',
  OI: '追込',
  OONIGE: '大逃げ',
};

/** 脚質の前後関係。ポジションキープの比較に使う（逃げ 1 が最も前）。 */
export const styleOrder: Record<Style, number> = {
  OONIGE: 1,
  NIGE: 1,
  SEN: 2,
  SASI: 3,
  OI: 4,
};

export const conditionValue: Record<Condition, number> = {
  BEST: 5,
  GOOD: 4,
  NORMAL: 3,
  BAD: 2,
  WORST: 1,
};

/** バ場状態。1=良 2=稍重 3=重 4=不良 */
export type SurfaceCondition = 1 | 2 | 3 | 4;

export const framePerSecond = 15;
export const secondPerFrame = 1 / framePerSecond;
export const startSpeed = 3.0;
export const maxSpeed = 30.0;
export const courseWidth = 11.25;
export const horseLane = courseWidth / 18.0;
export const laneChangeAcceleration = 0.02 * 1.5;
export const laneChangeAccelerationPerFrame = laneChangeAcceleration / framePerSecond;

export const defaultPositionCompetitionRate = 0.8;
export const defaultCompeteFightRate = 0.4;
export const defaultSecureLeadRate = 0.3;

/** やる気からステータス補正倍率 */
export const condCoef: Record<Condition, number> = {
  BEST: 1.04,
  GOOD: 1.02,
  NORMAL: 1.0,
  BAD: 0.98,
  WORST: 0.96,
};

/** バ場（1=芝 2=ダート）からバ場状態ごとのスピード補正値 */
export const surfaceSpeedModify: Record<number, Record<number, number>> = {
  1: { 1: 0, 2: 0, 3: 0, 4: -50 },
  2: { 1: 0, 2: 0, 3: 0, 4: -50 },
};

/** バ場からバ場状態ごとのパワー補正値 */
export const surfacePowerModify: Record<number, Record<number, number>> = {
  1: { 1: 0, 2: -50, 3: -50, 4: -50 },
  2: { 1: -100, 2: -50, 3: -100, 4: -100 },
};

/** 脚質適性から賢さ補正倍率 */
export const styleFitCoef: Record<FitRank, number> = {
  S: 1.1,
  A: 1.0,
  B: 0.85,
  C: 0.75,
  D: 0.6,
  E: 0.4,
  F: 0.2,
  G: 0.1,
};

/** 距離適性からスパート速度補正倍率 */
export const distanceFitSpeedCoef: Record<FitRank, number> = {
  S: 1.05,
  A: 1.0,
  B: 0.9,
  C: 0.8,
  D: 0.6,
  E: 0.4,
  F: 0.2,
  G: 0.1,
};

/** 距離適性から加速度補正倍率 */
export const distanceFitAccelerateCoef: Record<FitRank, number> = {
  S: 1.0,
  A: 1.0,
  B: 1.0,
  C: 1.0,
  D: 1.0,
  E: 0.6,
  F: 0.5,
  G: 0.4,
};

/** バ場適性から加速度補正倍率 */
export const surfaceFitAccelerateCoef: Record<FitRank, number> = {
  S: 1.05,
  A: 1.0,
  B: 0.9,
  C: 0.8,
  D: 0.7,
  E: 0.5,
  F: 0.3,
  G: 0.1,
};

/** 脚質から最大体力補正倍率 */
export const styleSpCoef: Record<Style, number> = {
  NIGE: 0.95,
  SEN: 0.89,
  SASI: 1.0,
  OI: 0.995,
  OONIGE: 0.86,
};

/** 脚質とフェーズから目標速度補正倍率。フェーズ -1 は助走区間。 */
export const styleSpeedCoef: Record<Style, Record<number, number>> = {
  NIGE: { '-1': 1.0, 0: 1.0, 1: 0.98, 2: 0.962, 3: 0.962 },
  SEN: { '-1': 0.978, 0: 0.978, 1: 0.991, 2: 0.975, 3: 0.975 },
  SASI: { '-1': 0.938, 0: 0.938, 1: 0.998, 2: 0.994, 3: 0.994 },
  OI: { '-1': 0.931, 0: 0.931, 1: 1.0, 2: 1.0, 3: 1.0 },
  OONIGE: { '-1': 1.063, 0: 1.063, 1: 0.962, 2: 0.95, 3: 0.95 },
};

/** 脚質とフェーズから加速度補正倍率 */
export const styleAccelerateCoef: Record<Style, Record<number, number>> = {
  NIGE: { '-1': 1.0, 0: 1.0, 1: 1.0, 2: 0.996, 3: 0.996 },
  SEN: { '-1': 0.985, 0: 0.985, 1: 1.0, 2: 0.996, 3: 0.996 },
  SASI: { '-1': 0.975, 0: 0.975, 1: 1.0, 2: 1.0, 3: 1.0 },
  OI: { '-1': 0.945, 0: 0.945, 1: 1.0, 2: 0.997, 3: 0.997 },
  OONIGE: { '-1': 1.17, 0: 1.17, 1: 0.94, 2: 0.956, 3: 0.956 },
};

/** バ場とバ場状態から体力消費補正値 */
export const spConsumptionCoef: Record<number, Record<number, number>> = {
  1: { 1: 1.0, 2: 1.0, 3: 1.02, 4: 1.02 },
  2: { 1: 1.0, 2: 1.0, 3: 1.01, 4: 1.02 },
};

export const skillLevelValueDefault = [1.0, 1.0, 1.02, 1.04, 1.06, 1.08, 1.1];
export const skillLevelValueSpeed = [1.0, 1.0, 1.01, 1.04, 1.07, 1.1, 1.13];
export const skillLevelValueFixed = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

/** ベース脚質と距離から脚色十分の加速度補正倍率 */
export const conservePowerAccelerationCoef: Record<string, Record<Distance, number>> = {
  NIGE: { SHORT: 1.0, MILE: 1.0, MIDDLE: 1.0, LONG: 1.0 },
  SEN: { SHORT: 0.7, MILE: 0.8, MIDDLE: 0.9, LONG: 0.9 },
  SASI: { SHORT: 0.75, MILE: 0.7, MIDDLE: 0.875, LONG: 1.0 },
  OI: { SHORT: 0.7, MILE: 0.75, MIDDLE: 0.86, LONG: 0.9 },
};

/** 脚色十分の基本持続フレーム */
export const conservePowerBaseFrame = framePerSecond * 3;

/** 距離から脚色十分の時間補正倍率 */
export const conservePowerTimeCoef: Record<Distance, number> = {
  SHORT: 0.45,
  MILE: 1.0,
  MIDDLE: 0.875,
  LONG: 0.8,
};

/** 脚質から位置取り調整の速度補正倍率 */
export const positionCompetitionSpeedCoef: Record<Style, number> = {
  OONIGE: 0.2,
  NIGE: 0.8,
  SEN: 1.0,
  SASI: 1.0,
  OI: 1.0,
};

/** 脚質から位置取り調整の体力消費補正倍率 */
export const positionCompetitionStaminaCoef: Record<Style, number> = {
  OONIGE: 1.5,
  NIGE: 1.2,
  SEN: 1.0,
  SASI: 1.0,
  OI: 1.0,
};

/** 距離から位置取り調整の体力消費補正倍率 */
export function positionCompetitionDistanceCoef(distance: number): number {
  if (distance < 1401) return 0.3;
  if (distance < 1801) return 0.3;
  if (distance < 2101) return 0.5;
  if (distance < 2201) return 0.8;
  if (distance < 2401) return 1.0;
  if (distance < 2601) return 1.1;
  return 1.2;
}

/** 脚質からリード確保の速度補正倍率 */
export const secureLeadSpeedCoef: Record<Style, number> = {
  OONIGE: 0.2,
  NIGE: 1.0,
  SEN: 1.0,
  SASI: 0.8,
  OI: 0.0,
};

/** 脚質から逃げリード確保の追加係数 */
export const secureLeadNigeBoost: Partial<Record<Style, number>> = {
  OONIGE: 7.0,
  NIGE: 4.0,
};

/** 脚質からリード確保の体力消費補正倍率 */
export const secureLeadStaminaCoef: Record<Style, number> = {
  OONIGE: 1.2,
  NIGE: 1.0,
  SEN: 0.8,
  SASI: 0.8,
  OI: 0.0,
};

/** 距離からリード確保の体力消費補正倍率 */
export function secureLeadDistanceCoef(distance: number): number {
  if (distance < 1401) return 0.3;
  if (distance < 1801) return 0.3;
  if (distance < 2101) return 0.5;
  if (distance < 2201) return 0.8;
  if (distance < 2401) return 1.0;
  if (distance < 2601) return 1.1;
  return 1.2;
}

/** 距離からスタミナ勝負の補正倍率 */
export function staminaLimitBreakDistanceCoef(distance: number): number {
  if (distance < 2101) return 0.0;
  if (distance < 2201) return 0.5;
  if (distance < 2401) return 1.0;
  if (distance < 2601) return 1.5;
  return 1.8;
}

/** 脚質から ForceIn の加算値 */
export const forceInFixed: Record<Style, number> = {
  OONIGE: 0.02,
  NIGE: 0.02,
  SEN: 0.01,
  SASI: 0.01,
  OI: 0.03,
};

/** 枠番と出走頭数から枠順 */
export const gateNumberToPostNumber: number[][] = Array.from({ length: 19 }, (_, gateNumber) =>
  Array.from({ length: 19 }, (_, gateCount) =>
    gateCount > 16
      ? Math.min(
          Math.floor((gateNumber + 1) / 2),
          Math.floor((gateNumber - gateCount + 26) / 3),
        )
      : Math.min(gateNumber, Math.floor((gateNumber - gateCount + 17) / 2)),
  ),
);

export type PositionKeepState =
  | 'NONE'
  | 'SPEED_UP'
  | 'OVERTAKE'
  | 'PACE_UP'
  | 'PACE_DOWN'
  | 'PACE_UP_EX';

/** 脚質とフェーズから賢さスキル強化倍率 */
export const styleWisdomSkillBuffData: Record<string, number[]> = {
  NIGE: [0.26, 0.23, 0.19, 0.16],
  SEN: [0.21, 0.21, 0.21, 0.21],
  SASI: [0.19, 0.18, 0.23, 0.24],
  OI: [0.15, 0.17, 0.25, 0.27],
};

export function calcBaseWisdomSkillBuff(wisdom: number): number {
  let result = 0.0;
  if (wisdom <= 1220) return result;
  result += (Math.floor((Math.min(wisdom, 1401) - 1201) / 20) * 0.02);
  if (wisdom <= 1420) return result;
  result += (Math.floor((Math.min(wisdom, 1601) - 1401) / 20) * 0.06);
  if (wisdom <= 1620) return result;
  result += (Math.floor((Math.min(wisdom, 2001) - 1601) / 20) * 0.01);
  if (wisdom <= 2100) return result;
  result += (Math.floor((Math.min(wisdom, 3101) - 2001) / 100) * 0.01);
  return result;
}

/** フェーズ -1 は 0 と同じ値を使う */
export function getWisdomSkillBuff(wisdom: number, baseStyle: Style): Record<number, number> {
  const base = calcBaseWisdomSkillBuff(wisdom);
  const rates = styleWisdomSkillBuffData[baseStyle === 'OONIGE' ? 'NIGE' : baseStyle]!;
  const result: Record<number, number> = {};
  rates.forEach((rate, phase) => {
    result[phase] = base * rate;
  });
  result[-1] = result[0]!;
  return result;
}

/** ヒントレベルからスキルポイント割引率 */
export const skillLvToFactor = [1.0, 0.9, 0.8, 0.7, 0.65, 0.6];
