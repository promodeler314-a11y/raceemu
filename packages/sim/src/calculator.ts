import {
  forceInFixed,
  framePerSecond,
  gateNumberToPostNumber,
  horseLane,
  maxSpeed,
  secondPerFrame,
  spConsumptionCoef,
  type PositionKeepState,
  type Style,
} from './data/constants.ts';
import { ORDER_RATE_CONTINUE_TYPES, resolveOrderRateContinue } from './data/orderRate.ts';
import type { RaceTrack } from './data/track.ts';
import { RecordedField, type FieldBundle, type FieldView } from './field/field.ts';
import { RngSet } from './rng.ts';
import {
  DerivedSetting,
  emptyPassiveBonus,
  type DebuffType,
  type PassiveBonus,
  type RaceSetting,
  type SystemSetting,
  DEBUFF_TYPES,
} from './setting.ts';
import {
  InvokedSkill,
  RaceSimulationState,
  RaceState,
  type OperatingSkill,
  type RaceFrame,
  type RaceSimulationResult,
  type SpurtParameters,
  type TriggeredSkill,
} from './state.ts';
import { approximateConditions } from './skill/approximate.ts';
import { compileConditions, newSkillScratch } from './skill/condition.ts';
import type { SkillData } from './skill/types.ts';

export interface SimulateOptions {
  readonly seed: number;
  readonly trial: number;
  readonly recordFrames?: boolean;
  /**
   * 他のウマ娘の位置。渡すと順位条件を実際に判定する。
   * 渡さなければ本家と同じく、順位条件は満たしている前提になる。
   */
  readonly field?: FieldBundle | null;
}

export interface SimulateOutput {
  readonly result: RaceSimulationResult;
  readonly state: RaceState;
}

export class RaceCalculator {
  constructor(
    private readonly system: SystemSetting,
    private readonly trackData: Record<number, RaceTrack>,
  ) {}

  /**
   * 走らせずに初期状態だけを作る。
   * 全頭を同時に走らせる駆動側が、各頭ぶんの状態を先に揃えるために使う。
   */
  createState(
    setting: RaceSetting,
    options: { seed: number; trial: number; recordFrames?: boolean; field?: FieldView | null },
  ): RaceState {
    const rng = new RngSet(options.seed, options.trial);
    return this.initializeState(setting, rng, options.recordFrames ?? false, false, options.field ?? null);
  }

  simulate(setting: RaceSetting, options: SimulateOptions): SimulateOutput {
    const rng = new RngSet(options.seed, options.trial);
    const bundle = options.field ?? null;
    // 束の中から試行番号で 1 本選ぶ。同じ試行番号なら同じフィールドになるので、
    // 共通乱数によるペア比較がフィールドを含めて成立する。
    const field = bundle === null ? null : new RecordedField(bundle, options.trial);
    const state = this.initializeState(setting, rng, options.recordFrames ?? false, false, field);
    const result = progressRace(state);
    return { result, state };
  }

  private initializeState(
    setting: RaceSetting,
    rng: RngSet,
    recordFrames: boolean,
    isVirtualLeader: boolean,
    field: FieldView | null = null,
  ): RaceState {
    const emptyDerived = new DerivedSetting(setting, emptyPassiveBonus(), this.trackData);
    const invokedSkills = invokeSkills(setting, emptyDerived, rng);

    const gateCount = setting.track.gateCount;
    const gateRng = rng.stream('gate');
    let gateNumber: number;
    if (setting.uma.gateNumber === 0) {
      gateNumber = gateRng.nextIntRange(1, gateCount);
    } else if (setting.uma.gateNumber === -1) {
      let best = 3;
      for (let g = 3; g <= 6; g++) if (gateNumberToPostNumber[g]![gateCount]! <= 3) best = g;
      gateNumber = gateRng.nextIntRange(1, best);
    } else if (setting.uma.gateNumber === -2) {
      let best = 6;
      for (let g = 6; g <= 12; g++) if (gateNumberToPostNumber[g]![gateCount]! >= 6) best = g;
      gateNumber = gateRng.nextIntRange(best, gateCount);
    } else {
      gateNumber = setting.uma.gateNumber;
    }

    const initialLane = gateNumber * horseLane + initialLaneAdjuster(setting, gateCount);
    const simulation = new RaceSimulationState();
    simulation.currentLane = initialLane;
    simulation.targetLane = initialLane;
    simulation.invokedSkills = invokedSkills;
    simulation.postNumber = gateNumberToPostNumber[gateNumber]![gateCount]!;
    simulation.position = -emptyDerived.trackDetail.runUp;
    simulation.startTime = emptyDerived.trackDetail.runUp > 0 ? 100000.0 : 0.0;

    const passiveBonus = applyPassive(setting, emptyDerived, simulation, this.system, rng, this.trackData);
    const derived = new DerivedSetting(setting, passiveBonus, this.trackData);
    simulation.passiveTriggered = passiveBonus.skills.length;
    for (const skill of passiveBonus.skills) simulation.coolDownMap.set(skill.invoke.coolDownId, 0);

    let virtualLeader: RaceState | null = null;
    if (!isVirtualLeader && setting.positionKeepMode === 'VIRTUAL' && setting.virtualLeader !== undefined) {
      const leaderSetting: RaceSetting = {
        ...setting,
        uma: setting.virtualLeader,
        skills: setting.virtualLeaderSkills ?? [],
        positionKeepMode: 'SPEED_UP',
      };
      virtualLeader = this.initializeState(leaderSetting, new RngSet(rng.seed ^ 0x5bf03635, rng.trial), false, true);
    }

    const state = new RaceState(derived, simulation, this.system, rng, virtualLeader, recordFrames, field);

    if (!derived.fixRandom) {
      simulation.startDelay = rng.stream('startDelay').nextDouble() * 0.1;
    }

    triggerStartSkills(state);

    // 掛かりの抽選
    const temptationRng = rng.stream('temptation');
    if (temptationRng.nextDouble() * 100.0 < derived.temptationRate) {
      simulation.temptationSection = 1 + temptationRng.nextInt(8);
    }
    simulation.isStartDash = true;
    simulation.delayTime = simulation.startDelay;
    simulation.sp = derived.spMax;
    simulation.sectionTargetSpeedRandoms = initSectionTargetSpeedRandoms(state);

    for (const [key, condition] of Object.entries(approximateConditions)) {
      simulation.specialState[key] = condition.valueOnStart;
    }

    simulation.forceInSpeed =
      rng.stream('forceIn').nextDoubleMax(0.1) * forceInFixed[setting.uma.style];

    if (!isVirtualLeader) {
      const debuffRng = rng.stream('debuff');
      for (const type of DEBUFF_TYPES) {
        const count = setting.debuffCounts[type.id] ?? 0;
        if (count <= 0) continue;
        if (type.distanceType !== undefined && type.distanceType !== derived.trackDetail.distanceType) {
          continue;
        }
        let range: [number, number] | null = null;
        if (type.trigger.kind === 'phase') {
          range = derived.getPhaseStartEnd(type.trigger.phase);
        } else if (type.trigger.kind === 'laterHalf') {
          range = [derived.trackDetail.distance / 2.0, derived.trackDetail.distance];
        }
        if (range === null) continue;
        for (let i = 0; i < count; i++) {
          simulation.debuffTriggers.push([debuffRng.nextDoubleRange(range[0], range[1]), type]);
        }
      }
    }

    return state;
  }
}

function initialLaneAdjuster(setting: RaceSetting, gateCount: number): number {
  // 本家の Track.initialLaneAdjuster をそのまま移植する。
  // location と course を取り違えているように見えるが、挙動を合わせるため変更しない。
  const location = setting.track.location;
  if (location === 10101) return 0.0;
  if (gateCount >= 14) return 1.86;
  if (location < 10100 && gateCount >= 10) return 0.6;
  return 0.0;
}

function invokeSkills(setting: RaceSetting, derived: DerivedSetting, rng: RngSet): InvokedSkill[] {
  const invokeRate = setting.skillActivateAdjustment !== 'NONE' ? 100.0 : derived.skillActivateRate;
  const result: InvokedSkill[] = [];
  for (const rawSkill of setting.skills) {
    const skill = rawSkill.rarity === 'unique' ? rawSkill.applyLevel(setting.uma.uniqueLevel) : rawSkill;
    const scratch = newSkillScratch();
    const lot = rng.stream('skillLot', skill.id).nextDouble() * 100;
    if (skill.activateLot === 0 || lot < invokeRate) {
      for (const invoke of skill.invokes) {
        result.push(
          new InvokedSkill(
            skill,
            invoke,
            compileConditions(skill, invoke.preConditions, derived, rng, scratch),
            compileConditions(skill, invoke.conditions, derived, rng, scratch),
          ),
        );
      }
    }
  }
  return result;
}

function applyPassive(
  setting: RaceSetting,
  derived: DerivedSetting,
  simulation: RaceSimulationState,
  system: SystemSetting,
  rng: RngSet,
  trackData: Record<number, RaceTrack>,
): PassiveBonus {
  let bonus = emptyPassiveBonus();
  const stateForCheck = new RaceState(
    new DerivedSetting(setting, bonus, trackData),
    simulation,
    system,
    rng,
    null,
    false,
  );
  for (const skill of simulation.invokedSkills) {
    if (skill.invoke.isPassive && skill.check(stateForCheck)) {
      const invoke = skill.invoke;
      bonus = {
        skills: [...bonus.skills, skill],
        speed: bonus.speed + Math.trunc(invoke.passiveSpeed(stateForCheck)),
        stamina: bonus.stamina + Math.trunc(invoke.passiveStamina(stateForCheck)),
        power: bonus.power + Math.trunc(invoke.passivePower(stateForCheck)),
        guts: bonus.guts + Math.trunc(invoke.passiveGuts(stateForCheck)),
        wisdom: bonus.wisdom + Math.trunc(invoke.passiveWisdom(stateForCheck)),
        temptationRate: bonus.temptationRate + Math.trunc(invoke.temptationRate(stateForCheck)),
      };
    }
  }
  return bonus;
}

function newFrame(state: RaceState): RaceFrame {
  const s = state.simulation;
  return {
    speed: s.totalSpeed,
    sp: s.sp,
    startPosition: s.startPosition,
    targetSpeed: 0,
    acceleration: 0,
    movement: 0,
    consume: 0,
    currentLane: s.currentLane,
    triggeredSkills: [],
    endedSkills: [],
    operatingSkills: [],
    temptation: s.isInTemptation,
    spurting: false,
    positionKeepState: s.positionKeepState,
    downSlopeMode: s.isInDownSlopeMode,
    leadCompetition: state.inLeadCompetition,
    competeFight: s.competeFight,
    conservePower: state.isInConservePower,
    positionCompetition: s.positionCompetition,
    staminaKeep: s.staminaKeep,
    secureLead: s.secureLead,
    staminaLimitBreak: s.staminaLimitBreak,
    fullSpurt: s.fullSpurt,
    triggeredDebuffs: [],
  };
}

function pushFrame(state: RaceState, frame: RaceFrame): void {
  state.simulation.lastFrame = frame;
  if (state.recordFrames) state.simulation.frames.push(frame);
}

function triggerStartSkills(state: RaceState): void {
  const skills: TriggeredSkill[] = [];
  for (const skill of state.setting.passiveBonus.skills) {
    if (!skill.invoke.isStart) skills.push(...triggerSkill(state, skill as InvokedSkill));
  }
  for (const skill of state.simulation.invokedSkills) {
    if (skill.invoke.isStart) {
      state.simulation.startDelay *= skill.invoke.startMultiply(state);
      state.simulation.startDelay += skill.invoke.startAdd(state);
      skills.push(...triggerSkill(state, skill));
    }
  }
  const frame = newFrame(state);
  frame.speed = 0.0;
  frame.sp = state.setting.spMax;
  frame.triggeredSkills = skills;
  pushFrame(state, frame);
}

function initSectionTargetSpeedRandoms(state: RaceState): Record<number, number> {
  const result: Record<number, number> = {};
  const max =
    (state.setting.modifiedWisdom / 5500.0) * Math.log10(state.setting.modifiedWisdom * 0.1) * 0.01;
  for (let section = state.currentSection; section <= 24; section++) {
    if (state.setting.fixRandom) {
      result[section] = max - 0.00325;
    } else {
      result[section] = max + state.rng.stream('sectionSpeed', String(section)).nextDouble() * -0.0065;
    }
  }
  return result;
}

function progressRace(state: RaceState): RaceSimulationResult {
  while (state.simulation.position < state.setting.courseLength) {
    if (updateFrame(state)) break;
  }
  return goal(state);
}

/**
 * 「順位率の帯をずっと維持しているか」を落としていく。
 *
 * フィールドを持たない実行では順位が分からないので、本家と同じく
 * 満たしている前提のまま（1 のまま）にする。
 */
function updateOrderRateContinue(state: RaceState): void {
  const order = state.order;
  if (order === null) return;
  const specialState = state.simulation.specialState;
  const gateCount = state.setting.base.track.gateCount;
  for (const type of ORDER_RATE_CONTINUE_TYPES) {
    if ((specialState[type] ?? 1) === 0) continue;
    const boundary = resolveOrderRateContinue(type, gateCount);
    if (boundary === undefined) continue;
    const inside =
      boundary.atMost !== undefined ? order <= boundary.atMost : order >= boundary.atLeast!;
    if (!inside) specialState[type] = 0;
  }
}

export function updateFrame(state: RaceState): boolean {
  const simulation = state.simulation;
  const setting = state.setting;
  const system = state.system;

  if (simulation.frameElapsed > 5000 || simulation.position >= setting.courseLength) return true;
  // 自分で作った先頭馬だけを進める。外から与えられた相手は駆動側が進める。
  if (state.ownedPaceMaker !== null) updateFrame(state.ownedPaceMaker);

  simulation.startPosition = simulation.position;
  const startSp = simulation.sp;
  const frame = newFrame(state);

  // 1秒おき判定
  const changeSecond = simulation.frameElapsed % framePerSecond === framePerSecond - 1;
  const currentSection = state.currentSection;

  // 下り坂モード
  if (state.isInSlopeDown() && !setting.fixRandom) {
    if (changeSecond) {
      const rng = state.rng.stream('downSlope');
      if (simulation.downSlopeModeStart === null) {
        if (rng.nextDouble() < setting.modifiedWisdom * 0.0004) {
          simulation.downSlopeModeStart = simulation.frameElapsed;
        }
      } else if (rng.nextDouble() < 0.2) {
        simulation.downSlopeModeStart = null;
      }
    }
  } else {
    simulation.downSlopeModeStart = null;
  }

  // 掛かり終了判定
  if (simulation.isInTemptation) {
    const temptationDuration = (simulation.frameElapsed - simulation.temptationModeStart!) * secondPerFrame;
    const prevTemptationDuration =
      (simulation.frameElapsed - 1 - simulation.temptationModeStart!) * secondPerFrame;
    const rng = state.rng.stream('temptationEnd');
    for (let i = 0; i < 3; i++) {
      const j = i * 3 + 3;
      if (prevTemptationDuration < j && temptationDuration >= j) {
        if (rng.nextDouble() < 0.55) simulation.temptationModeEnd = simulation.frameElapsed;
      }
    }
    if (temptationDuration >= 12) simulation.temptationModeEnd = simulation.frameElapsed;
  }

  const triggeredDebuffs: DebuffType[] = [];

  // 掛かり開始
  if (simulation.temptationSection > 0 && currentSection === simulation.temptationSection) {
    simulation.temptationModeStart = simulation.frameElapsed;
    simulation.temptationSection = -1;
    for (const type of DEBUFF_TYPES) {
      const count = setting.base.debuffCounts[type.id] ?? 0;
      if (count <= 0) continue;
      if (type.trigger.kind === 'temptation' && type.trigger.phase === state.currentPhase) {
        for (let i = 0; i < count; i++) {
          simulation.sp -= (setting.spMax * type.value) / 10000.0;
          triggeredDebuffs.push(type);
        }
      }
    }
  }

  // ポジションキープ
  if (currentSection <= 10) {
    applyPositionKeep(state);
  } else if (currentSection === 11) {
    simulation.positionKeepState = 'NONE';
  }

  // デバフ
  if (simulation.debuffTriggers.length > 0) {
    const remaining: Array<[number, DebuffType]> = [];
    for (const entry of simulation.debuffTriggers) {
      if (entry[0] <= simulation.startPosition) {
        if (simulation.currentTime >= 5.0) {
          simulation.sp -= (setting.spMax * entry[1].value) / 10000.0;
          triggeredDebuffs.push(entry[1]);
        }
      } else {
        remaining.push(entry);
      }
    }
    simulation.debuffTriggers = remaining;
  }

  // 位置取り争い
  if (
    simulation.leadCompetitionStart === null &&
    setting.basicRunningStyle === 'NIGE' &&
    simulation.position >= system.leadCompetitionPosition
  ) {
    simulation.leadCompetitionStart = simulation.frameElapsed;
  }

  // 追い比べ
  if (simulation.competeFight) {
    if (simulation.sp <= 0.05 * setting.spMax) {
      simulation.competeFight = false;
      simulation.competeFightEnd = simulation.frameElapsed;
    }
  } else if (
    changeSecond &&
    simulation.frameElapsed >= framePerSecond * 2 - 1 &&
    state.isInFinalStraight() &&
    simulation.sp >= 0.15 * setting.spMax &&
    state.rng.stream('competeFight').nextDouble() < system.competeFightRate
  ) {
    simulation.competeFight = true;
    simulation.competeFightStart = simulation.frameElapsed;
  }

  if (currentSection >= 11 && currentSection <= 15) {
    // 位置取り調整と持久力温存
    if (simulation.frameElapsed >= simulation.positionCompetitionNextFrame) {
      if (simulation.positionCompetition) {
        simulation.positionCompetition = false;
        simulation.positionCompetitionNextFrame = simulation.frameElapsed + framePerSecond * 2;
      } else if (!simulation.staminaKeep) {
        applyPositionCompetition(state);
      }
    }
    // リード確保
    if (simulation.frameElapsed >= simulation.secureLeadNextFrame) {
      if (simulation.secureLead) {
        simulation.secureLead = false;
        simulation.secureLeadNextFrame = simulation.frameElapsed + framePerSecond * 2;
      } else if (setting.runningStyle !== 'OI') {
        if (state.rng.stream('secureLead').nextDouble() < system.secureLeadRate) {
          simulation.secureLead = true;
          simulation.secureLeadNextFrame = simulation.frameElapsed + framePerSecond * 2;
          simulation.sp -= setting.secureLeadStamina;
        } else {
          simulation.secureLeadNextFrame = simulation.frameElapsed + framePerSecond * 2;
        }
      }
    }
  } else if (currentSection === 16) {
    simulation.positionCompetition = false;
    if (simulation.staminaKeep) {
      simulation.staminaKeepDistance += simulation.position - simulation.staminaKeepStart;
      simulation.staminaKeep = false;
    }
    simulation.secureLead = false;
  }

  // スタミナ勝負
  if (setting.courseLength > 2100 && !simulation.staminaLimitBreak) {
    if (simulation.currentSpeed >= setting.maxSpurtSpeed) simulation.staminaLimitBreak = true;
  }

  // 全開スパート
  if (!simulation.fullSpurt && setting.base.uma.speed > 2000 && simulation.currentSpeed >= setting.maxSpurtSpeed) {
    simulation.fullSpurt = true;
    for (const skill of simulation.invokedSkills) {
      if (skill.invoke.isRunAtFullSpeedRandom) {
        simulation.fullSpurtRandomPosition.set(
          skill.skill.id,
          state.rng
            .stream('fullSpurt', skill.skill.id)
            .nextDoubleRange(simulation.position, setting.courseLength),
        );
      }
    }
  }

  const frameTargetSpeed = state.targetSpeed + state.fullSpurtTargetSpeed;
  const frameAcceleration = state.acceleration + state.fullSpurtAcceleration;
  move(state, secondPerFrame);
  frame.movement = simulation.position - simulation.startPosition;
  frame.consume = simulation.sp - startSp;
  frame.targetSpeed = frameTargetSpeed;
  frame.acceleration = frameAcceleration;
  frame.triggeredDebuffs = triggeredDebuffs;
  simulation.frameElapsed++;

  if (simulation.startPosition < 0.0 && simulation.position >= 0.0) {
    const excessTime = simulation.position / simulation.totalSpeed;
    simulation.startTime = simulation.frameElapsed * secondPerFrame - excessTime;
  }

  // 終盤入り
  if (state.currentPhase === 1 && state.getPhase(simulation.position) === 2) {
    simulation.spurtParameters = calcSpurtParameter(state);
    applyConservePower(state);
  }

  if (simulation.position >= setting.courseLength) return true;

  // 順位率の帯を維持できているかを更新する。
  // 一度でも外れたら戻らないので、外れた時点で 0 に落として以降は見ない。
  updateOrderRateContinue(state);

  // スキル条件の近似状態を更新
  if (changeSecond) {
    for (const [key, condition] of Object.entries(approximateConditions)) {
      simulation.specialState[key] = condition.update(state, simulation.specialState[key] ?? 0);
    }
  }

  const skillTriggered = checkSkillTrigger(state);
  const spurtParameters = simulation.spurtParameters;
  const spurting =
    spurtParameters !== null && simulation.position + spurtParameters.distance >= setting.courseLength;

  // 効果切れの回収
  const endedSkills: OperatingSkill[] = [];
  const stillOperating: OperatingSkill[] = [];
  for (const operating of simulation.operatingSkills) {
    if ((simulation.frameElapsed - operating.startFrame) * secondPerFrame > operating.duration) {
      endedSkills.push(operating);
    } else {
      stillOperating.push(operating);
    }
  }
  simulation.operatingSkills = stillOperating;

  applyMoveLane(state);

  frame.triggeredSkills = skillTriggered;
  frame.endedSkills = endedSkills;
  frame.operatingSkills = state.recordFrames ? simulation.operatingSkills.slice() : simulation.operatingSkills;
  frame.spurting = spurting;
  pushFrame(state, frame);
  return false;
}

function move(state: RaceState, elapsedTime: number): void {
  const simulation = state.simulation;
  if (simulation.delayTime > 0.0) simulation.delayTime -= elapsedTime;
  if (simulation.delayTime > 0.0) return;

  let timeAfterDelay = elapsedTime;
  if (simulation.delayTime < 0.0) {
    timeAfterDelay = Math.abs(simulation.delayTime);
    simulation.delayTime = 0.0;
  }

  updateSelfSpeed(state, elapsedTime);
  const moveLength = simulation.totalSpeed * timeAfterDelay;
  const corner = state.currentCorner;
  const cornerLoss =
    corner === null ? 0.0 : (moveLength / corner.length / 4) * 2 * Math.PI * simulation.currentLane;

  simulation.position += moveLength - cornerLoss;
  simulation.sp -= state.calcConsumePerSecond() * elapsedTime;

  if (simulation.isStartDash && simulation.totalSpeed >= state.setting.v0) {
    simulation.isStartDash = false;
  }
}

function updateSelfSpeed(state: RaceState, elapsedTime: number): void {
  const simulation = state.simulation;
  const targetSpeed = state.targetSpeed;
  const acceleration = state.acceleration;
  const deceleration = state.deceleration;

  let newSpeed =
    simulation.currentSpeed < targetSpeed
      ? Math.min(simulation.currentSpeed + elapsedTime * acceleration, targetSpeed)
      : Math.max(simulation.currentSpeed + elapsedTime * deceleration, targetSpeed);
  if (simulation.isStartDash && newSpeed > state.setting.v0) newSpeed = state.setting.v0;
  newSpeed = Math.max(Math.min(newSpeed, maxSpeed), state.vMin);

  // ブロックによる減速は未実装
  newSpeed -= simulation.speedDebuff;
  let speedModification = 0;
  for (const skill of simulation.operatingSkills) speedModification += skill.currentSpeed;
  simulation.speedDebuff = speedModification;
  newSpeed += speedModification;
  simulation.currentSpeed = newSpeed;

  if (simulation.fullSpurt) {
    const fullSpurtTargetSpeed = state.fullSpurtTargetSpeed;
    const fullSpurtAcceleration = state.fullSpurtAcceleration;
    let newFullSpurtSpeed =
      simulation.fullSpurtCurrentSpeed < fullSpurtTargetSpeed
        ? Math.min(simulation.fullSpurtCurrentSpeed + elapsedTime * fullSpurtAcceleration, fullSpurtTargetSpeed)
        : Math.max(simulation.fullSpurtCurrentSpeed + elapsedTime * deceleration, fullSpurtTargetSpeed);
    simulation.fullSpurtCurrentSpeed = Math.max(newFullSpurtSpeed, 0.0);
  }
}

export function calcSpurtParameter(state: RaceState): SpurtParameters {
  const setting = state.setting;
  const simulation = state.simulation;
  const maxDistance = setting.trackDetail.distance - simulation.position;
  const spurtDistance = calcSpurtDistance(state, setting.maxSpurtSpeed);
  const totalConsume = state.calcRequiredSp(setting.maxSpurtSpeed);

  if (spurtDistance >= maxDistance) {
    if (simulation.position <= (setting.courseLength * 2.0) / 3 + 5) {
      if (simulation.spurtParameters === null) simulation.maxSpurt = true;
    }
    return {
      distance: maxDistance,
      speed: setting.maxSpurtSpeed,
      spDiff: simulation.spurtParameters?.spDiff ?? simulation.sp - totalConsume,
      time: 0.0,
    };
  }

  const totalConsumeV3 = state.calcRequiredSp(setting.v3);
  const excessSp = simulation.sp - totalConsumeV3;
  if (excessSp < 0) {
    return {
      distance: 0.0,
      speed: setting.v3,
      spDiff: simulation.spurtParameters?.spDiff ?? simulation.sp - totalConsume,
      time: 0.0,
    };
  }

  const candidates: SpurtParameters[] = [];
  const from = Math.trunc(setting.v3 * 10);
  const to = Math.trunc(setting.maxSpurtSpeed * 10 - 1);
  for (let i = from; i <= to; i++) {
    const v = i * 0.1;
    const distanceV = Math.min(maxDistance, calcSpurtDistance(state, v));
    candidates.push({
      distance: distanceV,
      speed: v,
      spDiff: simulation.spurtParameters?.spDiff ?? simulation.sp - totalConsume,
      time: distanceV / v + (maxDistance - distanceV) / setting.v3,
    });
  }
  candidates.sort((a, b) => a.time - b.time);

  const rng = state.rng.stream('spurt');
  for (const candidate of candidates) {
    if (setting.fixRandom) return candidate;
    if (rng.nextDouble() * 100.0 < 15.0 + 0.05 * setting.modifiedWisdom) return candidate;
  }
  return candidates[candidates.length - 1] ?? {
    distance: maxDistance,
    speed: setting.v3,
    spDiff: simulation.sp - totalConsume,
    time: 0.0,
  };
}

export function calcSpurtDistance(state: RaceState, v: number): number {
  const setting = state.setting;
  const simulation = state.simulation;
  const groundCoef = spConsumptionCoef[setting.trackDetail.surface]![setting.base.track.condition]!;
  const numerator =
    simulation.sp -
    ((setting.courseLength - simulation.position - 60) *
      20 *
      groundCoef *
      setting.spurtSpCoef *
      Math.pow(setting.v3 - setting.baseSpeed + 12, 2)) /
      144 /
      setting.v3;
  const denominator =
    20 *
    groundCoef *
    setting.spurtSpCoef *
    (Math.pow(v - setting.baseSpeed + 12, 2) / 144 / v -
      Math.pow(setting.v3 - setting.baseSpeed + 12, 2) / 144 / setting.v3);
  return numerator / denominator + 60;
}

export function goal(state: RaceState): RaceSimulationResult {
  const simulation = state.simulation;
  const setting = state.setting;
  const excessTime = (simulation.position - setting.courseLength) / simulation.totalSpeed;
  const raceTime = simulation.frameElapsed * secondPerFrame - excessTime;
  const raceTimeWithoutRunUp = raceTime - simulation.startTime;
  const raceTimeDelta = raceTimeWithoutRunUp - setting.trackDetail.finishTimeMax / 1.18;
  const competeFightFrame =
    (simulation.competeFightEnd ?? simulation.frameElapsed) -
    (simulation.competeFightStart ?? simulation.frameElapsed);
  return {
    raceTime,
    raceTimeDelta,
    raceTimeWithoutRunUp,
    maxSpurt: simulation.maxSpurt,
    spDiff: simulation.spurtParameters?.spDiff ?? 0.0,
    positionCompetitionCount: simulation.positionCompetitionCount,
    staminaKeepDistance: simulation.staminaKeepDistance,
    competeFightFinished: simulation.competeFightEnd === null && simulation.competeFightStart !== null,
    competeFightTime: competeFightFrame * secondPerFrame,
    goalSp: simulation.sp,
  };
}

function applyConservePower(state: RaceState): void {
  const base = state.setting.conservePowerAccelerationBase;
  if (base === 0.0) return;
  const activityCoef = state.simulation.hasTemptation
    ? 0.8
    : state.simulation.hasLeadCompetition
      ? 0.98
      : 1.0;
  state.simulation.conservePowerAcceleration = base * activityCoef;
  state.simulation.conservePowerStart = state.simulation.frameElapsed;
}

export function applyPositionCompetition(state: RaceState): void {
  const simulation = state.simulation;
  const setting = state.setting;
  const requiredSp = state.calcRequiredSpInPhase2();
  const rng = state.rng.stream('positionCompetition');
  if (simulation.sp < requiredSp * rng.nextDoubleRange(1.035, 1.04) && rng.nextDouble() < state.system.staminaKeepRate) {
    simulation.staminaKeep = true;
    simulation.staminaKeepStart = simulation.position;
    simulation.positionCompetitionNextFrame = Number.MAX_SAFE_INTEGER;
    return;
  }
  if (simulation.staminaKeep) {
    simulation.staminaKeepDistance += simulation.position - simulation.staminaKeepStart;
    simulation.staminaKeep = false;
  }
  if (rng.nextDouble() < state.system.positionCompetitionRate) {
    simulation.positionCompetition = true;
    simulation.positionCompetitionNextFrame = simulation.frameElapsed + framePerSecond * 2;
    simulation.sp -= setting.positionCompetitionStamina;
    simulation.positionCompetitionCount++;
  } else {
    simulation.positionCompetition = false;
    simulation.positionCompetitionNextFrame = simulation.frameElapsed + framePerSecond * 2;
  }
}

function applyMoveLane(state: RaceState): void {
  const setting = state.setting;
  const simulation = state.simulation;
  if (setting.trackDetail.corners.length === 0) return;

  const currentLane = simulation.currentLane;

  if (simulation.extraMoveLane < 0.0 && state.isAfterFinalCornerOrInFinalStraight) {
    simulation.extraMoveLane =
      Math.min(currentLane / 0.1, setting.trackDetail.maxLaneDistance) * 0.5 +
      state.rng.stream('moveLane').nextDoubleMax(0.1);
  }

  const fixLane = simulation.operatingSkills.some((s) => s.fixLane);
  const overtake = (simulation.specialState['overtake'] ?? 0) > 0;
  const sideBlocked = (simulation.specialState['blocked_side'] ?? 0) > 0;

  if (fixLane) {
    simulation.targetLane = 9.5 * horseLane;
  } else if (overtake) {
    simulation.targetLane = Math.max(simulation.targetLane, horseLane, simulation.extraMoveLane);
  } else if (simulation.sp <= 0.0) {
    simulation.targetLane = currentLane;
  } else if (simulation.positionKeepState === 'PACE_DOWN') {
    simulation.targetLane = 0.18;
  } else if (simulation.extraMoveLane > currentLane) {
    simulation.targetLane = simulation.extraMoveLane;
  } else if (state.currentPhase <= 1 && !sideBlocked) {
    simulation.targetLane = Math.max(0.0, currentLane - 0.05);
  } else {
    simulation.targetLane = currentLane;
  }

  if (
    (sideBlocked && simulation.targetLane < currentLane) ||
    Math.abs(simulation.targetLane - currentLane) < 0.00001
  ) {
    simulation.laneChangeSpeed = 0.0;
    return;
  }

  const targetSpeed =
    simulation.position < setting.trackDetail.moveLanePoint
      ? setting.baseLaneChangeTargetSpeed * (1 + (currentLane / setting.trackDetail.maxLaneDistance) * 0.05)
      : setting.baseLaneChangeTargetSpeed;

  simulation.laneChangeSpeed = Math.min(
    simulation.laneChangeSpeed + laneChangeAccelerationPerFrame(),
    targetSpeed,
  );

  let skillLaneChange = 0;
  for (const skill of simulation.operatingSkills) skillLaneChange += skill.laneChangeSpeed;
  const actualSpeed = Math.min(simulation.laneChangeSpeed + skillLaneChange, 0.6);
  if (simulation.targetLane > currentLane) {
    simulation.currentLane = Math.min(simulation.targetLane, currentLane + actualSpeed);
  } else {
    simulation.currentLane = Math.max(
      simulation.targetLane,
      currentLane - actualSpeed * (1.0 + currentLane),
    );
  }
}

function laneChangeAccelerationPerFrame(): number {
  return (0.02 * 1.5) / framePerSecond;
}

function applyPositionKeep(state: RaceState): void {
  const setting = state.setting;
  const simulation = state.simulation;
  const rng = state.rng.stream('positionKeep');

  switch (setting.base.positionKeepMode) {
    case 'NONE':
      return;

    case 'APPROXIMATE': {
      if (simulation.positionKeepState === 'NONE') {
        if (simulation.frameElapsed < simulation.positionKeepNextFrame) return;
        if (state.paceDownModeSetting[state.currentSection] === true) {
          simulation.positionKeepState = 'PACE_DOWN';
          simulation.positionKeepExitPosition =
            simulation.position + Math.floor(setting.sectionLength) * (setting.oonige ? 3 : 1);
        } else {
          simulation.positionKeepNextFrame += framePerSecond * 2;
        }
      } else if (simulation.position >= simulation.positionKeepExitPosition) {
        simulation.positionKeepState = 'NONE';
        simulation.positionKeepNextFrame += framePerSecond * 3;
      }
      return;
    }

    case 'SPEED_UP': {
      if (simulation.positionKeepState === 'NONE') {
        if (simulation.frameElapsed < simulation.positionKeepNextFrame) return;
        if (
          rng.nextInt(100) < setting.base.positionKeepRate &&
          rng.nextDouble() < setting.positionKeepSpeedUpOvertakeRate
        ) {
          simulation.positionKeepState = 'SPEED_UP';
          simulation.positionKeepExitPosition =
            simulation.position + Math.floor(setting.sectionLength) * (setting.oonige ? 3 : 1);
        } else {
          simulation.positionKeepNextFrame = simulation.frameElapsed + framePerSecond * 3;
        }
      } else if (simulation.position >= simulation.positionKeepExitPosition) {
        simulation.positionKeepState = 'NONE';
        simulation.positionKeepNextFrame = simulation.frameElapsed + framePerSecond * 3;
      }
      return;
    }

    case 'VIRTUAL': {
      const paceMaker = state.paceMaker;
      if (paceMaker === null) return;
      const behind = paceMaker.simulation.startPosition - simulation.startPosition;
      const myStyle = setting.basicRunningStyle;
      const paceMakerIsSelf = behind <= 0 && (styleRank(myStyle) <= 2 || state.currentPhase >= 1);
      const paceMakerStyle = paceMaker.setting.basicRunningStyle;
      const reset = (frames: number) => {
        simulation.positionKeepState = 'NONE';
        simulation.positionKeepNextFrame = simulation.frameElapsed + framePerSecond * frames;
      };

      switch (simulation.positionKeepState) {
        case 'NONE': {
          if (simulation.frameElapsed < simulation.positionKeepNextFrame) return;
          if (behind > 0 && styleRank(paceMakerStyle) > styleRank(myStyle)) {
            simulation.positionKeepState = 'PACE_UP_EX';
          } else if (myStyle === 'NIGE') {
            if (behind <= 0) {
              const threshold = setting.oonige ? -17.5 : paceMakerStyle !== 'NIGE' ? -12.5 : -4.5;
              if (behind > threshold && rng.nextDouble() < setting.positionKeepSpeedUpOvertakeRate) {
                simulation.positionKeepState = 'SPEED_UP';
              }
            } else if (rng.nextDouble() < setting.positionKeepSpeedUpOvertakeRate) {
              simulation.positionKeepState = 'OVERTAKE';
            }
          } else if (behind > setting.positionKeepMaxDistance) {
            if (rng.nextDouble() < setting.positionKeepPaceUpRate) {
              simulation.positionKeepState = 'PACE_UP';
              simulation.positionKeepExitDistance = rng.nextDoubleRange(
                setting.positionKeepMinDistance,
                setting.positionKeepMaxDistance,
              );
            }
          } else if (!paceMakerIsSelf && behind < setting.positionKeepMinDistance) {
            if (simulation.operatingSkills.every((s) => s.totalSpeed <= 0)) {
              simulation.positionKeepState = 'PACE_DOWN';
              const max =
                state.currentPhase === 1
                  ? setting.positionKeepMinDistance +
                    0.5 * (setting.positionKeepMaxDistance - setting.positionKeepMinDistance)
                  : setting.positionKeepMaxDistance;
              simulation.positionKeepExitDistance = rng.nextDoubleRange(
                setting.positionKeepMinDistance,
                max,
              );
            }
          }
          if (simulation.positionKeepState === 'NONE') {
            simulation.positionKeepNextFrame = simulation.frameElapsed + framePerSecond * 3;
          } else {
            simulation.positionKeepExitPosition =
              simulation.position + Math.floor(setting.sectionLength) * (setting.oonige ? 3 : 1);
          }
          return;
        }
        case 'SPEED_UP': {
          if (simulation.position >= simulation.positionKeepExitPosition) return reset(3);
          const threshold = setting.oonige ? -17.5 : paceMakerStyle !== 'NIGE' ? -12.5 : -4.5;
          if (behind < threshold) reset(3);
          return;
        }
        case 'OVERTAKE': {
          if (simulation.position >= simulation.positionKeepExitPosition) return reset(3);
          const threshold = setting.oonige ? -27.5 : -10.0;
          if (behind < threshold) reset(3);
          return;
        }
        case 'PACE_UP': {
          if (simulation.position >= simulation.positionKeepExitPosition) return reset(3);
          if (behind < simulation.positionKeepExitDistance) reset(3);
          return;
        }
        case 'PACE_DOWN': {
          if (simulation.position >= simulation.positionKeepExitPosition) return reset(3);
          if (
            paceMakerIsSelf ||
            behind > simulation.positionKeepExitDistance ||
            simulation.operatingSkills.some((s) => s.totalSpeed > 0)
          ) {
            reset(3);
          }
          return;
        }
        case 'PACE_UP_EX': {
          if (simulation.position >= simulation.positionKeepExitPosition) return reset(3);
          if (behind <= 0) reset(3);
          return;
        }
      }
    }
  }
}

function styleRank(style: Style): number {
  switch (style) {
    case 'OONIGE':
    case 'NIGE':
      return 1;
    case 'SEN':
      return 2;
    case 'SASI':
      return 3;
    case 'OI':
      return 4;
  }
}

export function checkSkillTrigger(state: RaceState): TriggeredSkill[] {
  const triggered: TriggeredSkill[] = [];
  const coolDownMap = state.simulation.coolDownMap;
  for (const skill of state.simulation.invokedSkills) {
    if (!skill.preChecked) {
      skill.preChecked = skill.preCheck(state);
      if (!skill.preChecked) continue;
    }
    const coolDownStart = coolDownMap.get(skill.invoke.coolDownId);
    if (coolDownStart === undefined) {
      if (skill.check(state)) triggered.push(...triggerSkill(state, skill));
    } else if (skill.invoke.cd > 0.0) {
      if (state.simulation.frameElapsed - coolDownStart > skill.invoke.cd * state.setting.coolDownBaseFrames) {
        if (skill.check(state)) triggered.push(...triggerSkill(state, skill));
      }
    }
  }
  return triggered;
}

export function triggerSkill(state: RaceState, skill: InvokedSkill): TriggeredSkill[] {
  const simulation = state.simulation;
  let heal: number | null = null;
  let waste: number | null = null;
  if (skill.invoke.isHeal) {
    const healed = doHeal(state, skill.invoke.heal(state));
    heal = healed[0];
    waste = healed[1];
  }

  let operating: OperatingSkill | null = null;
  if (skill.invoke.duration > 0.0) {
    const targetSpeed = skill.targetSpeed(state);
    const speedWithDecel = skill.speedWithDecel(state);
    operating = {
      data: skill,
      startFrame: simulation.frameElapsed,
      targetSpeed,
      speedWithDecel,
      currentSpeed: skill.invoke.currentSpeed(state),
      acceleration: skill.invoke.acceleration(state),
      duration: skill.calcDuration(state) * state.setting.timeCoef,
      fixLane: skill.invoke.isFixLane,
      laneChangeSpeed: skill.invoke.laneChangeSpeed(state),
      fullSpurtAcceleration: skill.invoke.fullSpurtAcceleration(state),
      totalSpeed: targetSpeed + speedWithDecel,
    };
    simulation.operatingSkills.push(operating);
    if (
      operating.totalSpeed > 0.0 &&
      !state.isAfterFinalCornerOrInFinalStraight &&
      state.rng.stream('laneChange', skill.skill.id).nextDouble() < state.system.skillLaneChangeRate
    ) {
      simulation.targetLane += horseLane;
      simulation.specialState['overtake'] = Math.max(1, simulation.specialState['blocked_side'] ?? 0);
    }
  }

  if (skill.invoke.isSpeedWithDecel) {
    simulation.currentSpeed += skill.invoke.speedWithDecel(state);
  }
  if (skill.invoke.isEvoDurationUp) {
    simulation.evoDurationMultiplier = Math.max(
      simulation.evoDurationMultiplier,
      skill.invoke.evoDurationUp(state),
    );
  }
  simulation.skillTriggerCount.increment(state);
  simulation.coolDownMap.set(skill.invoke.coolDownId, simulation.frameElapsed);

  const traced = simulation.skillTrace.get(skill.skill.id);
  if (traced === undefined) {
    simulation.skillTrace.set(skill.skill.id, {
      count: 1,
      firstPosition: simulation.startPosition,
      secondPosition: Number.NaN,
      firstPhase: state.currentPhase,
    });
  } else {
    traced.count++;
    if (traced.count === 2) traced.secondPosition = simulation.startPosition;
  }

  const result: TriggeredSkill[] = [{ invoke: skill, operating, heal, waste }];
  for (const other of skill.invoke.invokeOtherSkill(state)) {
    const otherInvoke = other.invokes[0];
    if (otherInvoke === undefined) continue;
    result.push(
      ...triggerSkill(
        state,
        new InvokedSkill(
          other,
          otherInvoke,
          () => true,
          () => true,
        ),
      ),
    );
  }
  return result;
}

export function doHeal(state: RaceState, value: number): [number, number] {
  const simulation = state.simulation;
  const heal = (state.setting.spMax * value) / 10000.0;
  simulation.sp += heal;
  const waste = Math.max(0.0, simulation.sp - state.setting.spMax);
  simulation.sp -= waste;
  if (value > 0) simulation.healTriggerCount++;
  if (state.currentPhase >= 2) {
    simulation.spurtParameters = calcSpurtParameter(state);
  }
  if (simulation.staminaKeep) {
    applyPositionCompetition(state);
  }
  return [heal, waste];
}

export type { SkillData };
