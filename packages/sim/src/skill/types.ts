import {
  skillLevelValueDefault,
  skillLevelValueFixed,
  skillLevelValueSpeed,
} from '../data/constants.ts';
import type { RaceState } from '../state.ts';

export interface RawSkillCondition {
  readonly type: string;
  readonly operator: string;
  readonly value: number;
}

export interface RawSkillEffect {
  readonly type: string;
  readonly value: number;
  readonly special?: number;
  readonly additional?: number;
}

export interface RawInvoke {
  readonly skillId: string;
  readonly index: number;
  readonly conditions?: RawSkillCondition[][];
  readonly preConditions?: RawSkillCondition[][];
  readonly effects?: RawSkillEffect[];
  readonly cd?: number;
  readonly duration?: number;
  readonly durationSpecial?: number;
}

export interface RawSkillData {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly group: number;
  readonly type: string;
  readonly sp?: number;
  readonly activateLot?: number;
  readonly holder?: string | null;
  readonly invokes?: RawInvoke[];
  readonly info?: string[];
  readonly description?: string[];
}

const OPERATORS: Record<string, (target: number, value: number) => boolean> = {
  '==': (t, v) => t === v,
  '!=': (t, v) => t !== v,
  '>=': (t, v) => t >= v,
  '<=': (t, v) => t <= v,
  '>': (t, v) => t > v,
  '<': (t, v) => t < v,
};

export class SkillCondition {
  readonly check: (target: number) => boolean;

  constructor(
    readonly type: string,
    readonly operator: string,
    readonly value: number,
  ) {
    const op = OPERATORS[operator];
    this.check = op === undefined ? () => false : (target: number) => op(target, this.value);
  }
}

export class SkillEffect {
  constructor(
    readonly type: string,
    readonly value: number,
    readonly special: number = 1,
    readonly additional: number = 0,
  ) {}

  applyLevel(level: number): SkillEffect {
    const values =
      this.type === 'targetSpeed'
        ? skillLevelValueSpeed
        : this.type === 'evoDurationUp'
          ? skillLevelValueFixed
          : skillLevelValueDefault;
    const factor = values[level] ?? 1.0;
    return new SkillEffect(this.type, Math.trunc(this.value * factor), this.special, this.additional);
  }

  calcValue(state: RaceState): number {
    const value = this.value;
    let specialValue: number;
    switch (this.special) {
      case 1:
        specialValue = value;
        break;
      case 2:
        // 獲得したスキルの数に応じて効果が高まる
        specialValue = value * Math.min(1.2, 1 + 0.01 * state.setting.base.skills.length);
        break;
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
        // チームメンバーの合計条件は最大値前提
        specialValue = value * 1.2;
        break;
      case 8:
      case 9: {
        // ランダム（あやしげな作戦）
        const random = state.rng.stream('effectRandom', this.type).nextDouble();
        specialValue = value * (random < 0.6 ? 0.0 : random < 0.9 ? 0.02 : 0.04);
        break;
      }
      case 10:
        specialValue = value * 1.2;
        break;
      case 11:
        // 終盤コーナーでの追い抜き回数は2回（1.1倍）固定
        specialValue = value * 1.1;
        break;
      case 12:
        specialValue = value * 1.2;
        break;
      case 13: {
        // 基礎能力の高さに応じて効果が高まる
        const uma = state.setting.base.uma;
        const maxStatus = Math.max(uma.speed, uma.stamina, uma.power, uma.guts, uma.wisdom);
        specialValue =
          value *
          (maxStatus < 600 ? 0.8 : maxStatus < 800 ? 0.9 : maxStatus < 1000 ? 1.0 : maxStatus < 1100 ? 1.1 : 1.2);
        break;
      }
      case 14: {
        // 能力を引き出すスキルの発動数に応じて
        const count = state.simulation.passiveTriggered;
        specialValue = value * (count <= 2 ? 0.0 : count <= 4 ? 1.0 : count <= 5 ? 2.0 : 3.0);
        break;
      }
      case 19:
        // 先頭から離れていると効果が増える
        specialValue = value + 1000.0;
        break;
      case 20:
        // 中盤の連続競り合いは4から6秒（3.0倍）固定
        specialValue = value * 3.0;
        break;
      case 22: {
        const status = state.setting.modifiedSpeed;
        specialValue =
          value * (status < 1700 ? 0.0 : status < 1800 ? 1.0 : status < 1900 ? 2.0 : status < 2000 ? 3.0 : 4.0);
        break;
      }
      case 23: {
        const status = state.setting.modifiedSpeed;
        specialValue = value * (status < 1400 ? 1.0 : status < 1600 ? 2.0 : 3.0);
        break;
      }
      case 24:
        specialValue = value * 1.2;
        break;
      case 25:
        // 終盤開始までに取ったリードの距離は最大（1.8倍）固定
        specialValue = value * 1.8;
        break;
      case 26:
      case 27:
      case 28:
        specialValue = value * 1.2;
        break;
      case 30:
        specialValue = value * 3.0;
        break;
      case 31:
      case 32:
        specialValue = value * 1.2;
        break;
      case 34:
        specialValue = value + 2000.0;
        break;
      case 35: {
        const track = state.setting.trackDetail;
        if (track.distanceType === 2) specialValue = value + 1000.0;
        else if (track.distance === 2500 && state.setting.base.track.location === 10005)
          specialValue = value + 2000.0;
        else specialValue = value;
        break;
      }
      case 36:
        specialValue = state.setting.trackDetail.distanceType === 3 ? 6500.0 : value;
        break;
      case 37:
        specialValue = value * 1.2;
        break;
      default:
        specialValue = value;
        break;
    }
    // 最速発動で近似している。本来はスキル効果中に計算が必要。
    switch (this.additional) {
      case 1:
      case 2:
        return specialValue * 2.0;
      case 3:
        return specialValue * 1.0;
      default:
        return specialValue;
    }
  }
}

const CORNER_CONDITIONS = new Set([
  'corner_random',
  'all_corner_random',
  'phase_corner_random',
  'is_finalcorner_random',
  'is_finalcorner',
  'is_finalcorner_laterhalf',
  'change_order_up_finalcorner_after',
]);

export class Invoke {
  readonly conditions: SkillCondition[][];
  readonly preConditions: SkillCondition[][];
  readonly effects: SkillEffect[];
  readonly cd: number;
  readonly duration: number;
  readonly durationSpecial: number;
  private readonly effectsByType: Map<string, SkillEffect[]>;

  readonly isPassive: boolean;
  readonly isStart: boolean;
  readonly isHeal: boolean;
  readonly isSpeedWithDecel: boolean;
  readonly isFixLane: boolean;
  readonly isEvoDurationUp: boolean;
  readonly oonige: boolean;
  readonly isRunAtFullSpeedRandom: boolean;
  readonly coolDownId: string;

  constructor(
    readonly skillId: string,
    readonly index: number,
    conditions: SkillCondition[][],
    preConditions: SkillCondition[][],
    effects: SkillEffect[],
    cd: number,
    duration: number,
    durationSpecial: number,
  ) {
    this.conditions = conditions;
    this.preConditions = preConditions;
    this.effects = effects;
    this.cd = cd;
    this.duration = duration;
    this.durationSpecial = durationSpecial;

    this.effectsByType = new Map();
    for (const effect of effects) {
      const list = this.effectsByType.get(effect.type);
      if (list === undefined) this.effectsByType.set(effect.type, [effect]);
      else list.push(effect);
    }

    const has = (type: string) => this.effectsByType.has(type);
    this.isPassive =
      has('passiveAll') ||
      has('passiveSpeed') ||
      has('passiveStamina') ||
      has('passivePower') ||
      has('passiveGuts') ||
      has('passiveWisdom') ||
      has('temptationRate');
    this.isStart = has('startAdd') || has('startMultiply');
    this.isHeal = has('heal');
    this.isSpeedWithDecel = has('speedWithDecel');
    this.isFixLane = has('fixLane');
    this.isEvoDurationUp = has('evoDurationUp');
    this.oonige = has('oonige');
    this.isRunAtFullSpeedRandom = conditions.some((list) =>
      list.some((c) => c.type === 'run_at_full_speed_random'),
    );
    this.coolDownId = conditions.some((list) =>
      list.some((c) => c.type === 'is_activate_other_skill_detail'),
    )
      ? `${skillId}-${index}`
      : skillId;
  }

  static fromRaw(raw: RawInvoke): Invoke {
    const toConditions = (groups: RawSkillCondition[][] | undefined): SkillCondition[][] =>
      (groups ?? []).map((group) => group.map((c) => new SkillCondition(c.type, c.operator, c.value)));
    return new Invoke(
      raw.skillId,
      raw.index,
      toConditions(raw.conditions),
      toConditions(raw.preConditions),
      (raw.effects ?? []).map((e) => new SkillEffect(e.type, e.value, e.special ?? 1, e.additional ?? 0)),
      raw.cd ?? 500.0,
      raw.duration ?? 0.0,
      raw.durationSpecial ?? 1,
    );
  }

  applyLevel(level: number): Invoke {
    return new Invoke(
      this.skillId,
      this.index,
      this.conditions,
      this.preConditions,
      this.effects.map((e) => e.applyLevel(level)),
      this.cd,
      this.duration,
      this.durationSpecial,
    );
  }

  needCorner(): boolean {
    return this.conditions.some((list) =>
      list.some((c) => (c.type === 'corner' ? !c.check(0) : CORNER_CONDITIONS.has(c.type))),
    );
  }

  private totalEffect(state: RaceState, type: string): number {
    const list = this.effectsByType.get(type);
    if (list === undefined) return 0;
    let sum = 0;
    for (const effect of list) sum += effect.calcValue(state);
    return sum;
  }

  private passiveAll(state: RaceState): number {
    return this.totalEffect(state, 'passiveAll') / 10000.0;
  }

  passiveSpeed(state: RaceState): number {
    return this.passiveAll(state) + this.totalEffect(state, 'passiveSpeed') / 10000.0;
  }
  passiveStamina(state: RaceState): number {
    return this.passiveAll(state) + this.totalEffect(state, 'passiveStamina') / 10000.0;
  }
  passivePower(state: RaceState): number {
    return this.passiveAll(state) + this.totalEffect(state, 'passivePower') / 10000.0;
  }
  passiveGuts(state: RaceState): number {
    return this.passiveAll(state) + this.totalEffect(state, 'passiveGuts') / 10000.0;
  }
  passiveWisdom(state: RaceState): number {
    return this.passiveAll(state) + this.totalEffect(state, 'passiveWisdom') / 10000.0;
  }
  temptationRate(state: RaceState): number {
    return this.totalEffect(state, 'temptationRate') / 10000.0;
  }
  heal(state: RaceState): number {
    return this.totalEffect(state, 'heal');
  }
  startMultiply(state: RaceState): number {
    return this.totalEffect(state, 'startMultiply') / 10000.0;
  }
  startAdd(state: RaceState): number {
    return this.totalEffect(state, 'startAdd') / 10000.0;
  }
  currentSpeed(state: RaceState): number {
    return this.totalEffect(state, 'currentSpeed') / 10000.0;
  }
  speedWithDecel(state: RaceState): number {
    return this.totalEffect(state, 'speedWithDecel') / 10000.0;
  }
  targetSpeed(state: RaceState): number {
    return this.totalEffect(state, 'targetSpeed') / 10000.0;
  }
  acceleration(state: RaceState): number {
    return this.totalEffect(state, 'acceleration') / 10000.0;
  }
  laneChangeSpeed(state: RaceState): number {
    return this.totalEffect(state, 'laneChangeSpeed') / 10000.0;
  }
  fullSpurtAcceleration(state: RaceState): number {
    return this.totalEffect(state, 'fullSpurtAcceleration') / 10000.0;
  }
  evoDurationUp(state: RaceState): number {
    return this.totalEffect(state, 'evoDurationUp') / 10000.0;
  }

  invokeOtherSkill(state: RaceState): SkillData[] {
    const result: SkillData[] = [];
    const coolDownMap = state.simulation.coolDownMap;
    const rareCount = Math.trunc(Math.trunc(this.totalEffect(state, 'invokeRare')) / 10000);
    if (rareCount > 0) {
      const candidates = state.setting.base.skills.filter(
        (skill) =>
          (skill.rarity === 'rare' || skill.rarity === 'evo') &&
          skill.invokes.every((inv) => !coolDownMap.has(inv.coolDownId)),
      );
      const rng = state.rng.stream('invokeOther', this.skillId);
      for (const skill of rng.shuffled(candidates).slice(0, rareCount)) result.push(skill);
    }
    const unique = Math.trunc(Math.trunc(this.totalEffect(state, 'invokeUnique')) / 10000);
    if (unique > 0) {
      const candidates = state.setting.base.skills.filter((skill) => skill.rarity === 'unique');
      const rng = state.rng.stream('invokeOtherUnique', this.skillId);
      for (const skill of rng.shuffled(candidates).slice(0, unique)) result.push(skill);
    }
    return result;
  }

  calcDuration(state: RaceState): number {
    switch (this.durationSpecial) {
      case 1:
        return this.duration;
      case 2:
        // 先頭との距離は最大（1.6倍）固定
        return this.duration * 1.6;
      case 3: {
        const sp = state.simulation.sp;
        const factor =
          sp < 2000 ? 1.0
            : sp < 2400 ? 1.5
            : sp < 2600 ? 2.0
            : sp < 2800 ? 2.2
            : sp < 3000 ? 2.5
            : sp < 3200 ? 3.0
            : sp < 3500 ? 3.5
            : 4.0;
        return this.duration * factor;
      }
      case 4:
        // 発動直後に2回追い抜く条件で近似
        return this.duration + 2.0;
      case 5:
        return this.duration * 3.0;
      case 7: {
        const sp = state.simulation.sp;
        const factor = sp < 1500 ? 1.0 : sp < 1800 ? 1.5 : sp < 2000 ? 2.0 : sp < 2100 ? 2.5 : 3.0;
        return this.duration * factor;
      }
      case 8: {
        const track = state.setting.trackDetail;
        const finalCornerStart =
          track.corners.length > 0 ? track.corners[track.corners.length - 1]!.start : Number.MAX_VALUE;
        const count = Math.min(
          4,
          track.slopes.filter((s) => s.slope > 0 && s.end < finalCornerStart).length,
        );
        return this.duration + count * 0.5;
      }
      default:
        return this.duration;
    }
  }
}

export class SkillData {
  readonly invokes: Invoke[];

  constructor(
    readonly id: string,
    readonly name: string,
    readonly rarity: string,
    readonly group: number,
    readonly type: string,
    readonly sp: number,
    readonly activateLot: number,
    invokes: Invoke[],
    /**
     * 条件と効果を日本語で書いた説明。
     * ブラウザ向けのバンドルでは容量のため落としてあり、空になる
     * （apps/web/vite.config.ts の trimSkillData）。
     */
    readonly info: readonly string[],
  ) {
    this.invokes = invokes;
  }

  static fromRaw(raw: RawSkillData): SkillData {
    return new SkillData(
      raw.id,
      raw.name,
      raw.rarity,
      raw.group,
      raw.type,
      raw.sp ?? 0,
      raw.activateLot ?? 1,
      (raw.invokes ?? []).map((inv) => Invoke.fromRaw(inv)),
      raw.info ?? [],
    );
  }

  applyLevel(level: number): SkillData {
    return new SkillData(
      this.id,
      this.name,
      this.rarity,
      this.group,
      this.type,
      this.sp,
      this.activateLot,
      this.invokes.map((inv) => inv.applyLevel(level)),
      this.info,
    );
  }
}
