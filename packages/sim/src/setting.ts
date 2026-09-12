import {
  condCoef,
  conservePowerAccelerationCoef,
  conservePowerBaseFrame,
  conservePowerTimeCoef,
  distanceFitAccelerateCoef,
  distanceFitSpeedCoef,
  framePerSecond,
  getWisdomSkillBuff,
  positionCompetitionDistanceCoef,
  positionCompetitionSpeedCoef,
  positionCompetitionStaminaCoef,
  secureLeadDistanceCoef,
  secureLeadNigeBoost,
  secureLeadSpeedCoef,
  secureLeadStaminaCoef,
  spConsumptionCoef,
  staminaLimitBreakDistanceCoef,
  styleAccelerateCoef,
  styleFitCoef,
  styleSpCoef,
  styleSpeedCoef,
  surfaceFitAccelerateCoef,
  surfacePowerModify,
  surfaceSpeedModify,
  type Condition,
  type FitRank,
  type Style,
} from './data/constants.ts';
import { type RaceTrack, type TrackDetail } from './data/track.ts';
import type { SkillData } from './skill/types.ts';

export type SkillActivateAdjustment = 'NONE' | 'YES' | 'ALL';
export type RandomPosition = 'RANDOM' | 'FASTEST' | 'FAST' | 'MIDDLE' | 'SLOW' | 'SLOWEST';
export type PositionKeepMode = 'APPROXIMATE' | 'VIRTUAL' | 'SPEED_UP' | 'NONE';

export interface UmaStatus {
  readonly charaName: string;
  readonly speed: number;
  readonly stamina: number;
  readonly power: number;
  readonly guts: number;
  readonly wisdom: number;
  readonly condition: Condition;
  readonly style: Style;
  readonly distanceFit: FitRank;
  readonly surfaceFit: FitRank;
  readonly styleFit: FitRank;
  readonly popularity: number;
  /** 0 でランダム、-1 で内寄りランダム、-2 で外寄りランダム */
  readonly gateNumber: number;
  readonly uniqueLevel: number;
}

export interface TrackRef {
  readonly location: number;
  readonly course: number;
  /** 1=良 2=稍重 3=重 4=不良 */
  readonly condition: number;
  /** 出走頭数。チャンピオンズミーティングは 9、リーグオブヒーローズは 12 */
  readonly gateCount: number;
  /**
   * 季節。1=春 2=夏 3=秋 4=冬。
   *
   * 本家はこの条件を「満たしている前提」で落としている。省くと本家と同じ扱いになり、
   * 春夏秋冬のスキルが同時に発動する。指定すると実際に判定する。
   * 育成計画から探索すると候補が数百になり、無視した条件を片端から拾ってしまうため、
   * 画面からは必ず指定する。docs/solver-design.md 8 節を参照。
   */
  readonly season?: number;
  /** 天候。1=晴 2=曇 3=雨 4=雪。省くと季節と同じく本家の扱いになる。 */
  readonly weather?: number;
  /** 時刻。4=ナイター。省くと季節と同じく本家の扱いになる。 */
  readonly time?: number;
}

export interface SystemSetting {
  readonly skillLaneChangeRate: number;
  readonly positionCompetitionRate: number;
  readonly competeFightRate: number;
  readonly secureLeadRate: number;
  readonly positionKeepSectionSen: readonly boolean[];
  readonly positionKeepSectionSasi: readonly boolean[];
  readonly positionKeepSectionOi: readonly boolean[];
  readonly leadCompetitionPosition: number;
  readonly staminaKeepRate: number;
}

export function defaultSystemSetting(): SystemSetting {
  return {
    skillLaneChangeRate: 0.4,
    positionCompetitionRate: 0.8,
    competeFightRate: 0.4,
    secureLeadRate: 0.3,
    positionKeepSectionSen: Array.from({ length: 10 }, (_, i) => i === 1),
    positionKeepSectionSasi: Array.from({ length: 10 }, (_, i) => i === 1 || i === 4),
    positionKeepSectionOi: Array.from({ length: 10 }, (_, i) => i === 1 || i === 3 || i === 8),
    leadCompetitionPosition: 200,
    staminaKeepRate: 0.9,
  };
}

export type DebuffTrigger =
  | { readonly kind: 'phase'; readonly phase: number }
  | { readonly kind: 'laterHalf' }
  | { readonly kind: 'temptation'; readonly phase: number };

export interface DebuffType {
  readonly id: string;
  readonly label: string;
  readonly trigger: DebuffTrigger;
  readonly value: number;
  readonly distanceType?: number;
}

export const DEBUFF_TYPES: readonly DebuffType[] = [
  { id: 'Kensei', label: 'けん制', trigger: { kind: 'phase', phase: 0 }, value: 100 },
  { id: 'Aseri', label: '焦り', trigger: { kind: 'phase', phase: 1 }, value: 100 },
  { id: 'NukegakeGold', label: '逃亡禁止令', trigger: { kind: 'phase', phase: 0 }, value: 300, distanceType: 1 },
  { id: 'Nukegake', label: '抜け駆け禁止', trigger: { kind: 'phase', phase: 0 }, value: 100, distanceType: 1 },
  { id: 'SasayakiGold', label: '魅惑のささやき', trigger: { kind: 'phase', phase: 1 }, value: 300, distanceType: 3 },
  { id: 'Sasayaki', label: 'ささやき', trigger: { kind: 'phase', phase: 1 }, value: 100, distanceType: 3 },
  { id: 'StaminaEaterGold', label: 'スタミナグリード', trigger: { kind: 'phase', phase: 1 }, value: 100, distanceType: 4 },
  { id: 'StaminaEater', label: 'スタミナイーター', trigger: { kind: 'phase', phase: 1 }, value: 50, distanceType: 4 },
  { id: 'GankouGold', label: '八方にらみ', trigger: { kind: 'phase', phase: 2 }, value: 300 },
  { id: 'Gankou', label: '鋭い眼光', trigger: { kind: 'phase', phase: 2 }, value: 100 },
  { id: 'TrickGold', label: '見惚れるトリック', trigger: { kind: 'temptation', phase: 1 }, value: 300 },
  { id: 'Trick', label: 'トリック', trigger: { kind: 'temptation', phase: 1 }, value: 100 },
  { id: 'DrainForRose', label: 'Drain for rose（本体）', trigger: { kind: 'phase', phase: 1 }, value: 50 },
  { id: 'DrainForRose2', label: 'Drain for rose（継承）', trigger: { kind: 'phase', phase: 1 }, value: 25 },
  { id: 'Gorushi', label: 'Adventure of 564+金スタデバ', trigger: { kind: 'laterHalf' }, value: 300 },
];

/** シミュレーションの入力。Worker へ構造化クローンで渡せるプレーンな値に保つ。 */
export interface RaceSetting {
  readonly uma: UmaStatus;
  readonly track: TrackRef;
  readonly skills: readonly SkillData[];
  readonly skillActivateAdjustment: SkillActivateAdjustment;
  readonly randomPosition: RandomPosition;
  readonly debuffCounts: Readonly<Record<string, number>>;
  readonly positionKeepMode: PositionKeepMode;
  readonly positionKeepRate: number;
  readonly virtualLeader?: UmaStatus;
  readonly virtualLeaderSkills?: readonly SkillData[];
}

export interface PassiveBonus {
  readonly skills: readonly InvokedSkillRef[];
  readonly speed: number;
  readonly stamina: number;
  readonly power: number;
  readonly guts: number;
  readonly wisdom: number;
  readonly temptationRate: number;
}

/** 循環参照を避けるための前方宣言 */
export interface InvokedSkillRef {
  readonly skill: SkillData;
  readonly invoke: import('./skill/types.ts').Invoke;
}

export function emptyPassiveBonus(): PassiveBonus {
  return { skills: [], speed: 0, stamina: 0, power: 0, guts: 0, wisdom: 0, temptationRate: 0 };
}

function calcExceedStatus(status: number): number {
  return status > 1200 ? 1200 + Math.floor((status - 1200) / 2) : status;
}

/**
 * 入力から一度だけ導出する値をまとめたもの。
 * Kotlin 版の RaceSettingWithPassive にあたる。
 */
export class DerivedSetting {
  readonly trackDetail: TrackDetail;
  readonly locationName: string;
  readonly courseLength: number;
  readonly sectionLength: number;
  readonly coolDownBaseFrames: number;
  readonly skillActivateRate: number;
  readonly timeCoef: number;
  readonly oonige: boolean;
  readonly runningStyle: Style;
  readonly basicRunningStyle: Style;
  readonly fixRandom: boolean;

  readonly phase0Half: number;
  readonly phase1Start: number;
  readonly phase1Half: number;
  readonly phase2Start: number;
  readonly phase2Half: number;
  readonly phase3Start: number;
  readonly phase3Half: number;

  readonly modifiedSpeed: number;
  readonly modifiedStamina: number;
  readonly modifiedPower: number;
  readonly modifiedGuts: number;
  readonly modifiedWisdom: number;

  readonly spMax: number;
  readonly spurtSpCoef: number;
  readonly temptationRate: number;
  readonly baseSpeed: number;
  readonly maxSpurtSpeed: number;
  readonly v0: number;
  readonly v1: number;
  readonly v2: number;
  readonly v3: number;
  readonly vMinBase: number;

  readonly leadCompetitionSpeed: number;
  readonly leadCompetitionFrame: number;
  readonly competeFightSpeed: number;
  readonly competeFightAcceleration: number;
  readonly conservePowerAccelerationBase: number;
  readonly conservePowerFrame: number;
  readonly positionCompetitionSpeed: number;
  readonly positionCompetitionStamina: number;
  readonly spConsumptionGroundCoef: number;
  readonly secureLeadSpeed: number;
  readonly secureLeadStamina: number;
  readonly staminaLimitBreakSpeed: number;
  readonly fullSpurtSpeed: number;
  readonly baseLaneChangeTargetSpeed: number;
  readonly positionKeepSpeedUpOvertakeRate: number;
  readonly positionKeepPaceUpRate: number;
  readonly positionKeepMinDistance: number;
  readonly positionKeepMaxDistance: number;
  readonly wisdomSkillBuff: Record<number, number>;

  constructor(
    readonly base: RaceSetting,
    readonly passiveBonus: PassiveBonus,
    trackData: Record<number, RaceTrack>,
  ) {
    const location = trackData[base.track.location] ?? trackData[Number(Object.keys(trackData)[0])]!;
    this.locationName = location.name;
    this.trackDetail =
      location.courses[base.track.course] ?? location.courses[Number(Object.keys(location.courses)[0])]!;
    const track = this.trackDetail;
    const uma = base.uma;
    const surfaceCondition = base.track.condition;

    this.courseLength = track.distance;
    this.sectionLength = this.courseLength / 24.0;
    this.coolDownBaseFrames = (this.courseLength / 1000.0) * 15.0;
    this.skillActivateRate = Math.max(100.0 - 9000.0 / uma.wisdom, 20.0);
    this.timeCoef = track.distance / 1000.0;
    this.fixRandom = base.skillActivateAdjustment === 'ALL';
    this.oonige =
      uma.style === 'NIGE' && base.skills.some((skill) => skill.invokes.some((inv) => inv.oonige));
    this.runningStyle = this.oonige ? 'OONIGE' : uma.style;
    this.basicRunningStyle = uma.style;

    this.phase1Start = this.courseLength / 6.0;
    this.phase2Start = (this.courseLength * 2.0) / 3.0;
    this.phase3Start = (this.courseLength * 5.0) / 6.0;
    this.phase0Half = this.phase1Start / 2.0;
    this.phase1Half = this.phase1Start + (this.phase2Start - this.phase1Start) / 2.0;
    this.phase2Half = this.phase2Start + (this.phase3Start - this.phase2Start) / 2.0;
    this.phase3Half = this.phase3Start + (this.courseLength - this.phase3Start) / 2.0;

    // 補正後ステータス
    let statusCheckModifier = 1.0;
    const check = track.courseSetStatus;
    for (const it of check) {
      const raw =
        it === 1 ? uma.speed
          : it === 2 ? uma.stamina
          : it === 3 ? uma.power
          : it === 4 ? uma.guts
          : it === 5 ? uma.wisdom
          : 0;
      const status = raw * condCoef[uma.condition];
      const add = status <= 300 ? 0.05 : status <= 600 ? 0.1 : status <= 900 ? 0.15 : 0.2;
      statusCheckModifier += add / check.length;
    }
    const baseStatus = Math.trunc(
      calcExceedStatus(uma.speed) * statusCheckModifier * condCoef[uma.condition],
    );
    this.modifiedSpeed =
      baseStatus + surfaceSpeedModify[track.surface]![surfaceCondition]! + passiveBonus.speed;
    this.modifiedStamina = Math.trunc(
      calcExceedStatus(uma.stamina) * condCoef[uma.condition] + passiveBonus.stamina,
    );
    this.modifiedPower = Math.trunc(
      calcExceedStatus(uma.power) * condCoef[uma.condition] +
        surfacePowerModify[track.surface]![surfaceCondition]! +
        passiveBonus.power,
    );
    this.modifiedGuts = Math.trunc(
      calcExceedStatus(uma.guts) * condCoef[uma.condition] + passiveBonus.guts,
    );
    this.modifiedWisdom = Math.trunc(
      calcExceedStatus(uma.wisdom) * condCoef[uma.condition] * styleFitCoef[uma.styleFit] +
        passiveBonus.wisdom,
    );

    this.spMax = track.distance + 0.8 * this.modifiedStamina * styleSpCoef[this.runningStyle];
    this.spurtSpCoef = 1 + 200 / Math.sqrt(600.0 * this.modifiedGuts);
    this.temptationRate = this.fixRandom
      ? 0.0
      : Math.pow(6.5 / Math.log10(0.1 * this.modifiedWisdom + 1), 2) + passiveBonus.temptationRate;
    this.baseSpeed = 20.0 - (this.courseLength - 2000) / 1000.0;

    const speedCoef = styleSpeedCoef[this.runningStyle];
    const accelCoef = styleAccelerateCoef[this.runningStyle];
    const distFitSpeed = distanceFitSpeedCoef[uma.distanceFit];

    this.maxSpurtSpeed =
      (this.baseSpeed * (speedCoef[2]! + 0.01) + Math.sqrt(this.modifiedSpeed / 500.0) * distFitSpeed) *
        1.05 +
      Math.sqrt(500.0 * this.modifiedSpeed) * distFitSpeed * 0.002 +
      Math.pow(450.0 * this.modifiedGuts, 0.597) * 0.0001;
    this.v0 = 0.85 * this.baseSpeed;
    const wisdomTerm =
      (this.modifiedWisdom * Math.log10(this.modifiedWisdom / 10.0)) / 550000.0 - 0.00325;
    this.v1 = this.baseSpeed * (speedCoef[0]! + wisdomTerm);
    this.v2 = this.baseSpeed * (speedCoef[1]! + wisdomTerm);
    this.v3 =
      this.baseSpeed * (speedCoef[2]! + wisdomTerm) +
      Math.sqrt(this.modifiedSpeed / 500.0) * distFitSpeed;
    this.vMinBase = 0.85 * this.baseSpeed + 0.001 * Math.sqrt(this.modifiedGuts * 200.0);

    this.leadCompetitionSpeed = Math.pow(500.0 * this.modifiedGuts, 0.6) * 0.0001;
    this.leadCompetitionFrame = Math.pow(700.0 * this.modifiedGuts, 0.5) * 0.012 * framePerSecond;
    this.competeFightSpeed = Math.pow(200.0 * this.modifiedGuts, 0.708) * 0.0001;
    this.competeFightAcceleration = Math.pow(160.0 * this.modifiedGuts, 0.59) * 0.0001;

    const powerStatus = uma.power + passiveBonus.power;
    this.conservePowerAccelerationBase =
      powerStatus <= 1200
        ? 0.0
        : Math.sqrt((powerStatus - 1200) * 130.0) *
          0.001 *
          conservePowerAccelerationCoef[this.basicRunningStyle]![track.distanceCategory];
    this.conservePowerFrame = conservePowerBaseFrame * conservePowerTimeCoef[track.distanceCategory];

    this.positionCompetitionSpeed =
      (Math.pow(this.modifiedPower / 1500.0, 0.5) * 2.0 + Math.pow(this.modifiedGuts / 3000.0, 0.2)) *
      0.1 *
      positionCompetitionSpeedCoef[this.runningStyle];
    this.positionCompetitionStamina =
      20 * positionCompetitionStaminaCoef[this.runningStyle] * positionCompetitionDistanceCoef(track.distance);

    this.spConsumptionGroundCoef = spConsumptionCoef[track.surface]![surfaceCondition]!;

    let secureLeadMultiplier = 1.0;
    const virtualLeader = base.virtualLeader;
    if (
      this.basicRunningStyle === 'NIGE' &&
      base.positionKeepMode === 'VIRTUAL' &&
      virtualLeader !== undefined &&
      virtualLeader.style === 'NIGE'
    ) {
      const virtualIsOonige = (base.virtualLeaderSkills ?? []).some((skill) =>
        skill.invokes.some((inv) => inv.oonige),
      );
      if (this.oonige !== virtualIsOonige) {
        secureLeadMultiplier = secureLeadNigeBoost[this.runningStyle] ?? 1.0;
      }
    }
    this.secureLeadSpeed =
      Math.pow(this.modifiedGuts / 2000.0, 0.5) *
      0.3 *
      secureLeadSpeedCoef[this.runningStyle] *
      secureLeadMultiplier;
    this.secureLeadStamina =
      20 * secureLeadStaminaCoef[this.runningStyle] * secureLeadDistanceCoef(track.distance);

    const staminaStatus = uma.stamina + passiveBonus.stamina;
    this.staminaLimitBreakSpeed =
      staminaStatus <= 1200
        ? 0.0
        : Math.sqrt(staminaStatus - 1200.0) * 0.0085 * staminaLimitBreakDistanceCoef(track.distance);

    const fullSpurtStatus = uma.speed * condCoef[uma.condition] + passiveBonus.speed;
    // 上限の計算方法が不明のため無制限とする
    this.fullSpurtSpeed = fullSpurtStatus <= 2000 ? 0.0 : Number.MAX_VALUE;

    this.baseLaneChangeTargetSpeed = 0.02 * (0.3 + 0.001 * this.modifiedPower);
    this.positionKeepSpeedUpOvertakeRate = 0.2 * Math.log10(this.modifiedWisdom * 0.1);
    this.positionKeepPaceUpRate = 0.15 * Math.log10(this.modifiedWisdom * 0.1);
    const courseFactor = 0.0008 * (this.courseLength - 1000) + 1.0;
    this.positionKeepMinDistance =
      this.basicRunningStyle === 'SEN' ? 3.0
        : this.basicRunningStyle === 'SASI' ? 6.5 * courseFactor
        : this.basicRunningStyle === 'OI' ? 7.5 * courseFactor
        : 0.0;
    this.positionKeepMaxDistance =
      this.basicRunningStyle === 'SEN' ? 5.0 * courseFactor
        : this.basicRunningStyle === 'SASI' ? 7.0 * courseFactor
        : this.basicRunningStyle === 'OI' ? 8.0 * courseFactor
        : 0.0;

    const calcWisdom = uma.wisdom * condCoef[uma.condition] + passiveBonus.wisdom;
    this.wisdomSkillBuff = getWisdomSkillBuff(Math.trunc(calcWisdom), this.basicRunningStyle);

    // 参照されるが未使用の警告を避ける
    void distanceFitAccelerateCoef;
    void surfaceFitAccelerateCoef;
    void accelCoef;
  }

  styleSpeedCoefFor(phase: number): number {
    return styleSpeedCoef[this.runningStyle][phase]!;
  }

  styleAccelerateCoefFor(phase: number): number {
    return styleAccelerateCoef[this.runningStyle][phase]!;
  }

  getPhaseStartEnd(phase: number): [number, number] {
    switch (phase) {
      case 0:
        return [0.0, this.phase1Start];
      case 1:
        return [this.phase1Start, this.phase2Start];
      case 2:
        return [this.phase2Start, this.phase3Start];
      case 3:
        return [this.phase3Start, this.courseLength];
      default:
        throw new Error(`invalid phase: ${phase}`);
    }
  }

  equalStamina(heal: number): number {
    return (this.spMax * heal) / 10000.0 / 0.8 / styleSpCoef[this.runningStyle];
  }
}
