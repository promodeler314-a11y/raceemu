import { horseLane, styleValue, conditionValue } from '../data/constants.ts';
import type { Corner, Straight } from '../data/track.ts';
import type { Rng, RngSet } from '../rng.ts';
import type { DerivedSetting, RandomPosition } from '../setting.ts';
import type { RaceState } from '../state.ts';
import { approximateTypeToState, ignoreConditions } from './approximate.ts';
import type { SkillCondition, SkillData } from './types.ts';

export interface RandomEntry {
  readonly start: number;
  readonly end: number;
}

function contains(entry: RandomEntry, position: number): boolean {
  return position >= entry.start && position <= entry.end;
}

export type Predicate = (state: RaceState) => boolean;

const ALWAYS: Predicate = () => true;

/** 未対応の条件を記録する。実装漏れの発見に使う。 */
export const unsupportedConditions = new Set<string>();

export function compileConditions(
  skill: SkillData,
  groups: readonly SkillCondition[][],
  setting: DerivedSetting,
  rng: RngSet,
  calculatedAreas: Map<string, RandomEntry[]>,
): Predicate {
  if (groups.length === 0) return ALWAYS;
  const compiled = groups.map((group) =>
    group
      .map((condition) => compileCondition(skill, condition, setting, rng, calculatedAreas))
      .filter((p): p is Predicate => p !== null),
  );
  return (state: RaceState) => compiled.some((group) => group.every((p) => p(state)));
}

function preChecked(condition: SkillCondition, target: number): Predicate {
  const result = condition.check(target);
  return () => result;
}

function checkInRace(condition: SkillCondition, target: (state: RaceState) => number): Predicate {
  return (state) => condition.check(target(state));
}

function checkInRaceBool(condition: SkillCondition, target: (state: RaceState) => boolean): Predicate {
  return (state) => condition.check(target(state) ? 1 : 0);
}

function checkSpecialState(condition: SkillCondition, adjust = 0): Predicate {
  const key = approximateTypeToState[condition.type]!;
  return (state) => condition.check((state.simulation.specialState[key] ?? 0) + adjust);
}

function withAssert(
  condition: SkillCondition,
  operator: string,
  value: number | null,
  build: () => Predicate,
): Predicate {
  if (condition.operator !== operator || (value !== null && condition.value !== value)) {
    unsupportedConditions.add(`${condition.type} ${condition.operator} ${condition.value}`);
    return ALWAYS;
  }
  return build();
}

function checkInRandom(
  calculated: Map<string, RandomEntry[]>,
  key: string,
  calcAreas: () => RandomEntry[],
): Predicate {
  let areas = calculated.get(key);
  if (areas === undefined) {
    areas = calcAreas();
    calculated.set(key, areas);
  }
  const fixed = areas;
  return (state) => fixed.some((area) => contains(area, state.simulation.position));
}

function compileCondition(
  skill: SkillData,
  condition: SkillCondition,
  setting: DerivedSetting,
  rng: RngSet,
  calculatedAreas: Map<string, RandomEntry[]>,
): Predicate | null {
  const base = setting.base;
  const track = setting.trackDetail;
  const areaRng = rng.stream('randomArea', skill.id);

  switch (condition.type) {
    case 'motivation':
      return preChecked(condition, conditionValue[base.uma.condition]);
    case 'hp_per':
      return checkInRace(condition, (s) => Math.trunc((s.simulation.sp / s.setting.spMax) * 100));
    case 'activate_count_heal':
      return checkInRace(condition, (s) => s.simulation.healTriggerCount);
    case 'activate_count_all':
      return checkInRace(condition, (s) => s.simulation.skillTriggerCount.total);
    case 'activate_count_start':
      return checkInRace(condition, (s) => s.simulation.skillTriggerCount.inPhase[0]!);
    case 'activate_count_later_half':
      return checkInRace(condition, (s) => s.simulation.skillTriggerCount.inLaterHalf);
    case 'activate_count_middle':
      return checkInRace(condition, (s) => s.simulation.skillTriggerCount.inPhase[1]!);
    case 'activate_count_end_after':
      return checkInRace(condition, (s) => s.simulation.skillTriggerCount.inAfterPhase2);
    case 'accumulatetime':
      return checkInRace(condition, (s) => Math.trunc(s.simulation.currentTime));
    case 'straight_front_type':
      return checkInRace(condition, (s) => getStraightFrontType(s));
    case 'is_goodstart':
      return checkInRace(condition, (s) => (s.simulation.startDelay <= 0.05 ? 1 : 0));
    case 'is_badstart':
      return checkInRace(condition, (s) => (s.simulation.startDelay >= 0.08 ? 1 : 0));
    case 'temptation_count':
      return checkInRace(condition, (s) => (s.simulation.hasTemptation ? 1 : 0));
    case 'remain_distance':
      return checkInRace(condition, (s) => Math.trunc(setting.courseLength - s.simulation.startPosition));

    case 'distance_rate_after_random':
      return withAssert(condition, '==', null, () =>
        checkInRandom(calculatedAreas, condition.type + condition.value, () =>
          chooseRandom(setting, areaRng, setting.courseLength * condition.value * 0.01, setting.courseLength),
        ),
      );
    case 'corner_random':
      return withAssert(condition, '==', null, () =>
        checkInRandom(calculatedAreas, condition.type + condition.value, () =>
          initCornerRandom(setting, areaRng, condition.value),
        ),
      );
    case 'all_corner_random':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () => initAllCornerRandom(setting, areaRng)),
      );
    case 'slope':
      return checkInRace(condition, (s) => s.getSlopeInt());
    case 'up_slope_random':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () => initSlopeRandom(setting, areaRng, true)),
      );
    case 'up_slope_random_later_half':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () =>
          initSlopeRandomLaterHalf(setting, areaRng, true),
        ),
      );
    case 'down_slope_random':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () => initSlopeRandom(setting, areaRng, false)),
      );
    case 'down_slope_random_later_half':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () =>
          initSlopeRandomLaterHalf(setting, areaRng, false),
        ),
      );

    case 'running_style':
      return preChecked(condition, styleValue[setting.basicRunningStyle]);
    case 'rotation':
      return preChecked(condition, track.turn);
    case 'ground_type':
      return preChecked(condition, track.surface);
    case 'ground_condition':
      return preChecked(condition, base.track.condition);
    case 'distance_type':
      return preChecked(condition, track.distanceType);
    case 'track_id':
      return preChecked(condition, track.raceTrackId);
    case 'is_dirtgrade':
      return preChecked(condition, track.isDirtGrade ? 1 : 0);
    case 'is_basis_distance':
      return preChecked(condition, track.isBasisDistance);
    case 'distance_rate':
      return checkInRace(condition, (s) =>
        Math.trunc((s.simulation.position * 100.0) / setting.courseLength),
      );
    case 'is_abroad':
      return preChecked(condition, base.track.location >= 10200 ? 1 : 0);

    case 'phase_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseRandom(setting, areaRng, condition.value, 0.0, 1.0),
      );
    case 'phase_firsthalf':
      return checkInRace(condition, (s) => {
        const [start, end] = setting.getPhaseStartEnd(s.currentPhase);
        return s.simulation.startPosition < (start + end) / 2 ? s.currentPhase : -1;
      });
    case 'phase_firsthalf_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseRandom(setting, areaRng, condition.value, 0.0, 0.5),
      );
    case 'phase_firstquarter_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseRandom(setting, areaRng, condition.value, 0.0, 0.25),
      );
    case 'phase_laterhalf':
      return checkInRace(condition, (s) => {
        const [start, end] = setting.getPhaseStartEnd(s.currentPhase);
        return s.simulation.startPosition >= (start + end) / 2 ? s.currentPhase : -1;
      });
    case 'phase_laterhalf_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseRandom(setting, areaRng, condition.value, 0.5, 1.0),
      );
    case 'phase_straight_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseStraightRandom(setting, areaRng, condition.value, 0.0, 1.0),
      );
    case 'phase_first_half_straight_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseStraightRandom(setting, areaRng, condition.value, 0.0, 0.5),
      );
    case 'phase_latter_half_straight_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseStraightRandom(setting, areaRng, condition.value, 0.5, 1.0),
      );
    case 'phase_corner_random':
      return checkInRandom(calculatedAreas, condition.type + condition.value, () =>
        initPhaseCornerRandom(setting, areaRng, condition.value),
      );
    case 'is_finalcorner_random':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () => initFinalCornerRandom(setting, areaRng)),
      );
    case 'is_finalstraight_random':
    case 'last_straight_random':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () => initFinalStraightRandom(setting, areaRng)),
      );
    case 'straight_random':
      return withAssert(condition, '==', 1, () =>
        checkInRandom(calculatedAreas, condition.type, () => initStraightRandom(setting, areaRng)),
      );
    case 'is_last_straight':
      return withAssert(condition, '==', 1, () => (s) => s.isInFinalStraight());

    case 'phase':
      return checkInRace(condition, (s) => s.currentPhase);
    case 'phase_firstquarter': {
      const [start, end] = setting.getPhaseStartEnd(condition.value);
      const rangeEnd = start + (end - start) / 4.0;
      return checkInRaceBool(
        condition,
        (s) => s.simulation.position >= start && s.simulation.position <= rangeEnd,
      );
    }
    case 'is_finalcorner':
      return checkInRaceBool(condition, (s) => s.isAfterFinalCorner);
    case 'is_finalcorner_laterhalf':
      return withAssert(
        condition,
        '==',
        1,
        () => (s) => s.isInFinalStraight() || s.isInFinalCorner(0.5, 1.0),
      );
    case 'corner':
      return checkInRace(condition, (s) => s.cornerNumber);

    case 'is_activate_heal_skill':
      return withAssert(condition, '==', 1, () =>
        checkInRaceBool(condition, (s) => {
          const last = s.simulation.lastFrame;
          if (last === null) return false;
          return last.triggeredSkills.some((t) => t.heal !== null && t.heal > 0.0);
        }),
      );
    case 'is_activate_any_skill':
      return withAssert(condition, '==', 1, () =>
        checkInRaceBool(condition, (s) => {
          const last = s.simulation.lastFrame;
          if (last === null) return false;
          return last.triggeredSkills.length > 0;
        }),
      );

    case 'is_lastspurt':
      return checkInRaceBool(condition, (s) => isInSpurt(s));
    case 'lastspurt':
      return withAssert(
        condition,
        '==',
        2,
        () => (s) => isInSpurt(s) && s.simulation.spurtParameters!.speed === s.setting.maxSpurtSpeed,
      );

    case 'base_speed':
      return preChecked(condition, base.uma.speed);
    case 'base_stamina':
      return preChecked(condition, base.uma.stamina);
    case 'base_power':
      return preChecked(condition, base.uma.power);
    case 'base_guts':
      return preChecked(condition, base.uma.guts);
    case 'base_wiz':
      return preChecked(condition, base.uma.wisdom);
    case 'course_distance':
      return preChecked(condition, setting.courseLength);

    case 'random_lot':
      return withAssert(condition, '==', null, () => {
        const result = setting.fixRandom
          ? true
          : condition.value > rng.stream('randomLot', skill.id).nextInt(100);
        return () => result;
      });

    case 'always':
      return withAssert(condition, '==', 1, () => ALWAYS);

    case 'is_last_straight_onetime':
      return withAssert(
        condition,
        '==',
        1,
        () => (s) => s.isInFinalStraight() && !s.isInFinalStraight(s.simulation.startPosition),
      );

    case 'is_move_lane':
    case 'change_order_onetime':
    case 'is_overtake':
    case 'blocked_front':
    case 'near_count':
    case 'near_infront_count':
    case 'is_surrounded':
    case 'temptation_opponent_count_behind':
    case 'change_order_up_middle':
    case 'change_order_up_end_after':
    case 'change_order_up_finalcorner_after':
    case 'overtake_target_no_order_up_time':
      return checkSpecialState(condition);

    case 'overtake_target_time':
    case 'blocked_front_continuetime':
    case 'blocked_side_continuetime':
    case 'infront_near_lane_time':
    case 'behind_near_lane_time':
    case 'behind_near_lane_time_set1':
      return checkSpecialState(condition, -1);

    case 'compete_fight_count':
      return checkInRaceBool(condition, (s) => s.simulation.competeFight);

    case 'is_other_character_activate_advantage_skill':
    case 'is_popularity_top_character_activate_advantage_skill':
      return withAssert(condition, '==', null, () => {
        const key = `is_other_character_activate_advantage_skill${condition.value}`;
        return (s) => (s.simulation.specialState[key] ?? 0) > 0;
      });

    case 'is_activate_other_skill_detail':
      return withAssert(condition, '==', 1, () => (s) => s.simulation.coolDownMap.has(skill.id));

    case 'popularity':
      return preChecked(condition, base.uma.popularity);
    case 'post_number':
      return checkInRace(condition, (s) => s.simulation.postNumber);
    case 'corner_count':
      return preChecked(condition, track.corners.length);
    case 'furlong':
      return checkInRace(condition, (s) => Math.trunc(s.simulation.startPosition / 200.0));

    case 'is_used_skill_id':
    case 'is_used_skill_id_with_detail_one':
      return (s) => s.simulation.coolDownMap.has(String(condition.value));

    case 'is_tight_track':
      return preChecked(condition, track.tightTrack);

    case 'run_at_full_speed_random':
      return checkInRaceBool(condition, (s) => {
        const position = s.simulation.fullSpurtRandomPosition.get(skill.id);
        if (position === undefined) return false;
        return s.simulation.startPosition >= position;
      });

    default:
      if (!(condition.type in ignoreConditions)) {
        unsupportedConditions.add(condition.type);
      }
      return null;
  }
}

/** 0: 直線でない 1: スタンド前 2: スタンドの向こう */
function getStraightFrontType(state: RaceState, position = state.simulation.position): number {
  const straights = state.setting.trackDetail.straights;
  for (let i = 0; i < straights.length; i++) {
    const straight = straights[straights.length - 1 - i]!;
    if (position >= straight.start && position <= straight.end) {
      return i % 2 === 0 ? 1 : 2;
    }
  }
  return 0;
}

function isInSpurt(state: RaceState): boolean {
  const spurtParameters = state.simulation.spurtParameters;
  if (spurtParameters === null) return false;
  return spurtParameters.distance + state.simulation.position >= state.setting.courseLength;
}

function randomRate(randomPosition: RandomPosition, rng: Rng): number {
  switch (randomPosition) {
    case 'RANDOM':
      return rng.nextDouble();
    case 'FASTEST':
      return 0.0;
    case 'FAST':
      return 0.25;
    case 'MIDDLE':
      return 0.5;
    case 'SLOW':
      return 0.75;
    case 'SLOWEST':
      return 0.98;
  }
}

function chooseRandom(
  setting: DerivedSetting,
  rng: Rng,
  zoneStart: number,
  zoneEnd: number,
): RandomEntry[] {
  const rate = randomRate(setting.base.randomPosition, rng);
  const start = Math.min(rate * (zoneEnd - zoneStart) + zoneStart, zoneEnd - 2.0);
  const end = Math.min(start + 10.0, zoneEnd);
  return [{ start, end }];
}

function chooseRandomFromEntries(
  setting: DerivedSetting,
  rng: Rng,
  entries: readonly (readonly [number, number])[],
): RandomEntry[] {
  if (entries.length === 0) return [];
  const total = entries.reduce((sum, [s, e]) => sum + (e - s), 0);
  const rate = randomRate(setting.base.randomPosition, rng);
  let startInArea = rate * total;
  for (const [entryStart, entryEnd] of entries) {
    if (startInArea < entryEnd - entryStart) {
      const start = Math.min(entryStart + startInArea, entryEnd - 2.0);
      const end = Math.min(start + 10.0, entryEnd);
      return [{ start, end }];
    }
    startInArea -= entryEnd - entryStart;
  }
  return [];
}

function initCornerRandom(setting: DerivedSetting, rng: Rng, value: number): RandomEntry[] {
  const all = setting.trackDetail.corners;
  const corners: (Corner | null)[] = all.slice(Math.max(0, all.length - 4));
  while (corners.length < 4) corners.unshift(null);
  const corner = corners[value - 1];
  if (corner === null || corner === undefined) return [];
  return chooseRandom(setting, rng, corner.start, corner.end);
}

function initAllCornerRandom(setting: DerivedSetting, rng: Rng): RandomEntry[] {
  const corners = setting.trackDetail.corners;
  const triggers: RandomEntry[] = [];
  for (let i = 0; i < 2; i++) {
    if (corners.length === 0) break;
    const corner = corners[rng.nextInt(corners.length)]!;
    triggers.push(logTrigger(rng, corner.start, corner.start + corner.length));
  }
  triggers.sort((a, b) => a.start - b.start);
  return triggers;
}

function logTrigger(rng: Rng, min: number, max: number): RandomEntry {
  const actualMax = Math.max(min, max - 10.0);
  const start = min + rng.nextDouble() * (actualMax - min);
  return { start, end: start + 10.0 };
}

function initStraightRandom(setting: DerivedSetting, rng: Rng): RandomEntry[] {
  const straights = setting.trackDetail.straights;
  if (straights.length === 0) return [];
  const straight = straights[rng.nextInt(straights.length)]!;
  return chooseRandom(setting, rng, straight.start, straight.end);
}

function initSlopeRandom(setting: DerivedSetting, rng: Rng, up: boolean): RandomEntry[] {
  const slopes = setting.trackDetail.slopes.filter((s) => (s.slope > 0 && up) || (s.slope < 0 && !up));
  const slope = rng.pick(slopes);
  if (slope === undefined) return [];
  return chooseRandom(setting, rng, slope.start, slope.end);
}

function initSlopeRandomLaterHalf(setting: DerivedSetting, rng: Rng, up: boolean): RandomEntry[] {
  const half = setting.courseLength / 2.0;
  const slopes = setting.trackDetail.slopes.filter(
    (s) => s.end > half && ((s.slope > 0 && up) || (s.slope < 0 && !up)),
  );
  const slope = rng.pick(slopes);
  if (slope === undefined) return [];
  return chooseRandom(setting, rng, Math.max(slope.start, half), slope.end);
}

function initPhaseRandom(
  setting: DerivedSetting,
  rng: Rng,
  phase: number,
  startRate: number,
  endRate: number,
): RandomEntry[] {
  const [zoneStart, zoneEnd] = setting.getPhaseStartEnd(phase);
  const zoneLength = zoneEnd - zoneStart;
  return chooseRandom(
    setting,
    rng,
    zoneStart + zoneLength * startRate,
    zoneEnd - zoneLength * (1 - endRate),
  );
}

function initFinalCornerRandom(setting: DerivedSetting, rng: Rng): RandomEntry[] {
  const corners = setting.trackDetail.corners;
  if (corners.length === 0) return [];
  const finalCorner = corners[corners.length - 1]!;
  return chooseRandom(setting, rng, finalCorner.start, finalCorner.end);
}

function initPhaseStraightRandom(
  setting: DerivedSetting,
  rng: Rng,
  phase: number,
  startRate: number,
  endRate: number,
): RandomEntry[] {
  const [phaseStart, phaseEnd] = setting.getPhaseStartEnd(phase);
  const phaseLength = phaseEnd - phaseStart;
  const areaStart = phaseStart + phaseLength * startRate;
  const areaEnd = phaseEnd - phaseLength * (1 - endRate);
  const candidates: [number, number][] = [];
  for (const straight of setting.trackDetail.straights as readonly Straight[]) {
    if (straight.end < areaStart || straight.start > areaEnd) continue;
    candidates.push([Math.max(straight.start, areaStart), Math.min(straight.end, areaEnd)]);
  }
  return chooseRandomFromEntries(setting, rng, candidates);
}

function initPhaseCornerRandom(setting: DerivedSetting, rng: Rng, phase: number): RandomEntry[] {
  const [phaseStart, phaseEnd] = setting.getPhaseStartEnd(phase);
  const candidates: [number, number][] = [];
  for (const corner of setting.trackDetail.corners) {
    if (corner.end < phaseStart || corner.start > phaseEnd) continue;
    candidates.push([Math.max(corner.start, phaseStart), Math.min(corner.end, phaseEnd)]);
  }
  return chooseRandomFromEntries(setting, rng, candidates);
}

function initFinalStraightRandom(setting: DerivedSetting, rng: Rng): RandomEntry[] {
  const corners = setting.trackDetail.corners;
  if (corners.length === 0) return [];
  const finalCorner = corners[corners.length - 1]!;
  return chooseRandom(setting, rng, finalCorner.end, setting.courseLength);
}

export { horseLane };
