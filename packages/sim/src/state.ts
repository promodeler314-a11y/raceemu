import {
  distanceFitAccelerateCoef,
  distanceFitSpeedCoef,
  framePerSecond,
  maxSpeed,
  secondPerFrame,
  spConsumptionCoef,
  startSpeed,
  surfaceFitAccelerateCoef,
  type PositionKeepState,
} from './data/constants.ts';
import { getSlope, type Corner } from './data/track.ts';
import type { RngSet } from './rng.ts';
import type { DerivedSetting, DebuffType, SystemSetting } from './setting.ts';
import type { FieldView } from './field/field.ts';
import { approximateConditions } from './skill/approximate.ts';
import type { Invoke, SkillData } from './skill/types.ts';

/** スキルごとの発動記録。フレーム列を残さずに集計するために持つ。 */
export interface SkillTraceEntry {
  count: number;
  firstPosition: number;
  secondPosition: number;
  firstPhase: number;
}

export interface SpurtParameters {
  readonly distance: number;
  readonly speed: number;
  readonly spDiff: number;
  readonly time: number;
}

export class InvokedSkill {
  preChecked = false;

  constructor(
    readonly skill: SkillData,
    readonly invoke: Invoke,
    readonly preCheck: (state: RaceState) => boolean,
    readonly check: (state: RaceState) => boolean,
  ) {}

  private get isUniqueOrEvoOrRare(): boolean {
    const r = this.skill.rarity;
    return r === 'unique' || r === 'evo' || r === 'rare';
  }

  calcDuration(state: RaceState): number {
    const multiplier = this.skill.rarity === 'evo' ? state.simulation.evoDurationMultiplier : 1.0;
    return this.invoke.calcDuration(state) * multiplier;
  }

  speedWithDecel(state: RaceState): number {
    const value = this.invoke.speedWithDecel(state);
    return this.isUniqueOrEvoOrRare ? value * (1.0 + state.wisdomSkillBuff) : value;
  }

  targetSpeed(state: RaceState): number {
    const value = this.invoke.targetSpeed(state);
    return this.isUniqueOrEvoOrRare ? value * (1.0 + state.wisdomSkillBuff) : value;
  }
}

export interface OperatingSkill {
  readonly data: InvokedSkill;
  readonly startFrame: number;
  readonly targetSpeed: number;
  readonly speedWithDecel: number;
  readonly currentSpeed: number;
  readonly acceleration: number;
  readonly duration: number;
  readonly fixLane: boolean;
  readonly laneChangeSpeed: number;
  readonly fullSpurtAcceleration: number;
  readonly totalSpeed: number;
}

export interface TriggeredSkill {
  readonly invoke: InvokedSkill;
  readonly operating: OperatingSkill | null;
  readonly heal: number | null;
  readonly waste: number | null;
}

export interface RaceFrame {
  speed: number;
  sp: number;
  startPosition: number;
  targetSpeed: number;
  acceleration: number;
  movement: number;
  consume: number;
  currentLane: number;
  triggeredSkills: TriggeredSkill[];
  endedSkills: OperatingSkill[];
  operatingSkills: OperatingSkill[];
  temptation: boolean;
  spurting: boolean;
  positionKeepState: PositionKeepState;
  downSlopeMode: boolean;
  leadCompetition: boolean;
  competeFight: boolean;
  conservePower: boolean;
  positionCompetition: boolean;
  staminaKeep: boolean;
  secureLead: boolean;
  staminaLimitBreak: boolean;
  fullSpurt: boolean;
  triggeredDebuffs: DebuffType[];
}

export interface RaceSimulationResult {
  readonly raceTime: number;
  readonly raceTimeDelta: number;
  readonly raceTimeWithoutRunUp: number;
  readonly maxSpurt: boolean;
  readonly spDiff: number;
  readonly positionCompetitionCount: number;
  readonly staminaKeepDistance: number;
  readonly competeFightFinished: boolean;
  readonly competeFightTime: number;
  readonly goalSp: number;
}

export class SkillTriggerCount {
  readonly inPhase: Record<number, number> = { '-1': 0, 0: 0, 1: 0, 2: 0, 3: 0 };
  inLaterHalf = 0;

  get total(): number {
    return Object.values(this.inPhase).reduce((a, b) => a + b, 0);
  }

  get inAfterPhase2(): number {
    return this.inPhase[2]! + this.inPhase[3]!;
  }

  increment(state: RaceState): void {
    const phase = state.currentPhase;
    this.inPhase[phase] = (this.inPhase[phase] ?? 0) + 1;
    if (state.isLaterHalf) this.inLaterHalf++;
  }
}

export class RaceSimulationState {
  frameElapsed = 0;
  startTime = 0.0;
  position = 0.0;
  startPosition = 0.0;
  currentSpeed = startSpeed;
  fullSpurtCurrentSpeed = 0.0;
  sp = 0.0;
  currentLane = 0.0;
  targetLane = 0.0;
  laneChangeSpeed = 0.0;
  extraMoveLane = -1.0;
  forceInSpeed = 0.0;
  operatingSkills: OperatingSkill[] = [];
  postNumber = 0;
  startDelay = 0.0;
  isStartDash = false;
  delayTime = 0.0;
  spurtParameters: SpurtParameters | null = null;
  maxSpurt = false;
  downSlopeModeStart: number | null = null;
  temptationSection = -1;
  temptationModeStart: number | null = null;
  temptationModeEnd: number | null = null;
  temptationWaste = 0.0;
  speedDebuff = 0.0;
  specialState: Record<string, number> = {};
  leadCompetitionStart: number | null = null;
  competeFight = false;
  competeFightStart: number | null = null;
  competeFightEnd: number | null = null;
  conservePowerStart: number | null = null;
  conservePowerAcceleration: number | null = null;
  positionCompetition = false;
  staminaKeep = false;
  positionCompetitionNextFrame = 0;
  secureLead = false;
  secureLeadNextFrame = 0;
  staminaLimitBreak = false;
  fullSpurt = false;
  fullSpurtRandomPosition = new Map<string, number>();

  invokedSkills: InvokedSkill[] = [];
  /** スキル ID から発動記録へ。発動は稀なので、記録の費用は無視できる。 */
  skillTrace = new Map<string, SkillTraceEntry>();
  coolDownMap = new Map<string, number>();
  skillTriggerCount = new SkillTriggerCount();
  passiveTriggered = 0;
  healTriggerCount = 0;
  sectionTargetSpeedRandoms: Record<number, number> = {};
  evoDurationMultiplier = 1.0;

  positionCompetitionCount = 0;
  staminaKeepStart = 0.0;
  staminaKeepDistance = 0.0;

  debuffTriggers: Array<[number, DebuffType]> = [];

  positionKeepState: PositionKeepState = 'NONE';
  positionKeepNextFrame = framePerSecond * 2;
  positionKeepExitPosition = 0.0;
  positionKeepExitDistance = 0.0;

  frames: RaceFrame[] = [];
  /** 直前のフレーム。フレーム列を記録しない場合でも条件判定に使う。 */
  lastFrame: RaceFrame | null = null;

  constructor() {
    for (const key of Object.keys(approximateConditions)) this.specialState[key] = 0;
  }

  get totalSpeed(): number {
    return this.currentSpeed + this.fullSpurtCurrentSpeed;
  }

  get isInTemptation(): boolean {
    const start = this.temptationModeStart;
    if (start === null) return false;
    if (this.frameElapsed < start) return false;
    const end = this.temptationModeEnd;
    if (end === null) return true;
    return this.frameElapsed <= end;
  }

  get isInDownSlopeMode(): boolean {
    return this.downSlopeModeStart !== null;
  }

  get hasTemptation(): boolean {
    return this.temptationModeStart !== null;
  }

  get hasLeadCompetition(): boolean {
    return this.leadCompetitionStart !== null;
  }

  get currentTime(): number {
    return this.frameElapsed * secondPerFrame - this.startTime;
  }
}

export class RaceState {
  constructor(
    readonly setting: DerivedSetting,
    readonly simulation: RaceSimulationState,
    readonly system: SystemSetting,
    readonly rng: RngSet,
    readonly paceMaker: RaceState | null,
    /** フレーム列を記録するか。統計だけが要る試行では false にして割り当てを減らす。 */
    readonly recordFrames: boolean,
    /**
     * 他のウマ娘の位置。無ければ順位条件は満たしている前提のままになる。
     * docs/order-condition.md を参照。
     */
    readonly field: FieldView | null = null,
  ) {}

  /** 1 位を 1 とする順位。フィールドが無ければ null。 */
  get order(): number | null {
    if (this.field === null) return null;
    return this.field.order(this.simulation.frameElapsed, this.simulation.startPosition);
  }

  getPhase(position: number): number {
    if (position < 0) return -1;
    if (position < this.setting.phase1Start) return 0;
    if (position < this.setting.phase2Start) return 1;
    if (position < this.setting.phase3Start) return 2;
    return 3;
  }

  get currentPhase(): number {
    return this.getPhase(this.simulation.startPosition);
  }

  get isLaterHalf(): boolean {
    return this.simulation.position > this.setting.trackDetail.distance / 2;
  }

  get isPhaseLaterHalf(): boolean {
    const position = this.simulation.startPosition;
    const phase = this.getPhase(position);
    const threshold =
      phase === 0 ? this.setting.phase0Half
        : phase === 1 ? this.setting.phase1Half
        : phase === 2 ? this.setting.phase2Half
        : this.setting.phase3Half;
    return position >= threshold;
  }

  get finalCorner(): Corner | null {
    const corners = this.setting.trackDetail.corners;
    return corners.length > 0 ? corners[corners.length - 1]! : null;
  }

  isInFinalCorner(startRate = 0.0, endRate = 1.0): boolean {
    const finalCorner = this.finalCorner;
    if (finalCorner === null) return false;
    const start = finalCorner.start + startRate * finalCorner.length;
    const end = finalCorner.start + endRate * finalCorner.length;
    const position = this.simulation.position;
    return position >= start && position <= end;
  }

  get isAfterFinalCorner(): boolean {
    const finalCorner = this.finalCorner;
    return this.simulation.position >= (finalCorner === null ? Number.MAX_VALUE : finalCorner.start);
  }

  isInFinalStraight(position = this.simulation.position): boolean {
    const straights = this.setting.trackDetail.straights;
    if (straights.length === 0) return false;
    return position >= straights[straights.length - 1]!.start;
  }

  get isAfterFinalCornerOrInFinalStraight(): boolean {
    return this.isAfterFinalCorner || this.isInFinalStraight();
  }

  getSection(position: number): number {
    return Math.floor((position * 24.0) / this.setting.courseLength) + 1;
  }

  get currentSection(): number {
    return this.getSection(this.simulation.position);
  }

  get currentSlope(): number {
    return getSlope(this.setting.trackDetail, this.simulation.position);
  }

  get paceDownModeSetting(): readonly boolean[] {
    switch (this.setting.runningStyle) {
      case 'SEN':
        return this.system.positionKeepSectionSen;
      case 'SASI':
        return this.system.positionKeepSectionSasi;
      case 'OI':
        return this.system.positionKeepSectionOi;
      default:
        return [];
    }
  }

  get inLeadCompetition(): boolean {
    const start = this.simulation.leadCompetitionStart;
    if (start === null) return false;
    return this.simulation.frameElapsed < start + this.setting.leadCompetitionFrame;
  }

  get targetSpeed(): number {
    const simulation = this.simulation;
    const setting = this.setting;
    if (simulation.sp <= 0) return this.vMin;
    if (simulation.currentSpeed < setting.v0) return setting.v0;

    const spurtParameters = simulation.spurtParameters;
    let result: number;
    if (spurtParameters !== null && simulation.position + spurtParameters.distance > setting.courseLength) {
      result = spurtParameters.speed;
    } else {
      const currentPhase = this.currentPhase;
      let base: number;
      if (currentPhase === 0 || currentPhase === 1) {
        base = setting.baseSpeed * setting.styleSpeedCoefFor(currentPhase);
      } else {
        base =
          setting.baseSpeed * setting.styleSpeedCoefFor(currentPhase) +
          Math.sqrt(setting.modifiedSpeed / 500.0) * distanceFitSpeedCoef[setting.base.uma.distanceFit] +
          Math.pow(setting.modifiedGuts * 450.0, 0.597) * 0.0001;
      }
      result = base + setting.baseSpeed * (simulation.sectionTargetSpeedRandoms[this.currentSection] ?? 0);
    }

    switch (simulation.positionKeepState) {
      case 'NONE':
        break;
      case 'SPEED_UP':
        result *= 1.04;
        break;
      case 'OVERTAKE':
        result *= 1.05;
        break;
      case 'PACE_UP':
        result *= 1.04;
        break;
      case 'PACE_DOWN':
        result *= this.currentPhase === 1 ? 0.945 : 0.915;
        break;
      case 'PACE_UP_EX':
        result *= 2.0;
        break;
    }

    for (const skill of simulation.operatingSkills) result += skill.totalSpeed;

    // 序盤で内が空いている場合の速度上昇
    if (
      this.currentPhase <= 0 &&
      simulation.targetLane < simulation.currentLane &&
      simulation.laneChangeSpeed > 0.0
    ) {
      result += simulation.forceInSpeed;
    }

    if (this.isInSlopeUp()) {
      result -= (Math.abs(this.currentSlope) * 200.0) / setting.modifiedPower;
    } else if (simulation.isInDownSlopeMode) {
      result += Math.abs(this.currentSlope) / 10.0 + 0.3;
    }

    if (simulation.laneChangeSpeed > 0.0 && simulation.operatingSkills.some((s) => s.laneChangeSpeed > 0.0)) {
      result += Math.pow(0.0002 * setting.modifiedPower, 0.5);
    }

    if (this.inLeadCompetition) result += setting.leadCompetitionSpeed;
    if (simulation.competeFight) result += setting.competeFightSpeed;
    if (simulation.positionCompetition) result += setting.positionCompetitionSpeed;
    if (simulation.secureLead) result += setting.secureLeadSpeed;
    if (simulation.staminaLimitBreak) result += setting.staminaLimitBreakSpeed;

    return result;
  }

  get fullSpurtTargetSpeed(): number {
    return this.simulation.fullSpurt ? this.setting.fullSpurtSpeed : 0.0;
  }

  get vMin(): number {
    return this.simulation.isStartDash ? startSpeed : this.setting.vMinBase;
  }

  private baseAcceleration(): number {
    const setting = this.setting;
    const uma = setting.base.uma;
    const c = this.isInSlopeUp() ? 0.0004 : 0.0006;
    return (
      c *
      Math.sqrt(500.0 * setting.modifiedPower) *
      setting.styleAccelerateCoefFor(this.currentPhase) *
      surfaceFitAccelerateCoef[uma.surfaceFit] *
      distanceFitAccelerateCoef[uma.distanceFit]
    );
  }

  get acceleration(): number {
    let acceleration = this.baseAcceleration();
    if (this.simulation.isStartDash) acceleration += 24.0;
    for (const skill of this.simulation.operatingSkills) acceleration += skill.acceleration;
    if (this.simulation.competeFight) acceleration += this.setting.competeFightAcceleration;
    if (this.isInConservePower) acceleration += this.simulation.conservePowerAcceleration ?? 0.0;
    return Math.max(acceleration, 0.0);
  }

  get fullSpurtAcceleration(): number {
    if (!this.simulation.fullSpurt) return 0.0;
    let acceleration =
      (0.068 * this.baseAcceleration()) / Math.pow(this.setting.trackDetail.distance / 1000.0, 1.5);
    for (const skill of this.simulation.operatingSkills) acceleration += skill.fullSpurtAcceleration / 10.0;
    return Math.max(acceleration, 0.0);
  }

  get deceleration(): number {
    if (this.simulation.sp <= 0) return -1.2;
    if (this.simulation.positionKeepState === 'PACE_DOWN') return -0.5;
    const phase = this.currentPhase;
    if (phase === -1 || phase === 0) return -1.2;
    if (phase === 1) return -0.8;
    return -1.0;
  }

  get maxSpeedLimit(): number {
    return maxSpeed;
  }

  getSlopeAt(position = this.simulation.position): number {
    return getSlope(this.setting.trackDetail, position);
  }

  getSlopeInt(): number {
    const slope = this.getSlopeAt();
    if (slope >= 0.1) return 1;
    if (slope <= -0.1) return 2;
    return 0;
  }

  isInSlopeUp(position = this.simulation.position): boolean {
    return this.getSlopeAt(position) >= 1.0;
  }

  isInSlopeDown(position = this.simulation.position): boolean {
    return this.getSlopeAt(position) <= -1.0;
  }

  get currentCorner(): Corner | null {
    for (const corner of this.setting.trackDetail.corners) {
      if (this.simulation.position >= corner.start && this.simulation.position <= corner.end) return corner;
    }
    return null;
  }

  get cornerNumber(): number {
    const corners = this.setting.trackDetail.corners;
    const index = corners.findIndex(
      (c) => this.simulation.position >= c.start && this.simulation.position <= c.end,
    );
    if (index < 0) return 0;
    return ((16 + index - corners.length) % 4) + 1;
  }

  get isInConservePower(): boolean {
    const start = this.simulation.conservePowerStart;
    if (start === null) return false;
    return this.simulation.frameElapsed < start + this.setting.conservePowerFrame;
  }

  calcConsumePerSecond(
    currentSpeed = this.simulation.totalSpeed,
    spurtPhase = this.currentPhase >= 2,
    applyStatusModifier = true,
  ): number {
    const setting = this.setting;
    const baseSpeed = this.simulation.isStartDash ? this.simulation.currentSpeed : setting.baseSpeed;
    let consume =
      (20.0 * Math.pow(currentSpeed - baseSpeed + 12.0, 2) * setting.spConsumptionGroundCoef) / 144.0;
    if (spurtPhase) consume *= setting.spurtSpCoef;
    if (applyStatusModifier) {
      if (this.simulation.isInDownSlopeMode) consume *= 0.4;
      if (this.inLeadCompetition) {
        if (this.simulation.isInTemptation) {
          consume *= setting.oonige ? 7.7 : 3.6;
        } else {
          consume *= setting.oonige ? 3.5 : 1.4;
        }
      } else if (this.simulation.isInTemptation) {
        this.simulation.temptationWaste += consume * 0.6;
        consume *= 1.6;
      }
      if (this.simulation.positionKeepState === 'PACE_DOWN') consume *= 0.6;
    }
    return consume;
  }

  calcRequiredSp(
    v: number,
    length = this.setting.courseLength - this.simulation.position - 60,
    spurtPhase = true,
  ): number {
    return (length / v) * this.calcConsumePerSecond(v, spurtPhase, false);
  }

  calcRequiredSpInPhase2(): number {
    const phase2Length = (this.setting.courseLength * 2.0) / 3.0 - this.simulation.position;
    const phase3Length = this.setting.courseLength / 3.0;
    return (
      this.calcRequiredSp(this.setting.v2, phase2Length, false) +
      this.calcRequiredSp(this.setting.maxSpurtSpeed, phase3Length)
    );
  }

  get wisdomSkillBuff(): number {
    return this.setting.wisdomSkillBuff[this.currentPhase] ?? 0;
  }

  get spConsumptionGroundCoefRef(): number {
    return spConsumptionCoef[this.setting.trackDetail.surface]![this.setting.base.track.condition]!;
  }
}
