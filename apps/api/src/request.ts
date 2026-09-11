import type { GameData } from '../../../packages/data/src/index.ts';
import { defaultFieldProfile } from '../../../packages/sim/src/field/field.ts';
import type { FieldSpec, SerializableRaceSetting } from '../../../packages/sim/src/parallel/protocol.ts';
import { defaultSystemSetting, type SystemSetting } from '../../../packages/sim/src/setting.ts';

/**
 * 受け取った要求の検査。
 *
 * この口は外から引ける場所に立つので、渡ってきた値をそのまま
 * シミュレータに入れない。壊れた設定は Worker の中で例外になり、
 * ジョブごと落ちる。手前で弾いて理由を返すほうが調べやすい。
 *
 * 検査の重さは「クラスタを埋められるか」で決めている。
 * 数値が非有限だったり、候補が数百を超えたり、試行回数が桁違いだったりする
 * ものを落とす。細かい妥当性（このステータスが現実的か等）は見ない。
 */

export interface SearchRequest {
  /** 候補を 1 つも取らない土台。スキルは ID で送る。 */
  readonly base: SerializableRaceSetting;
  readonly candidates: readonly string[];
  readonly budget: number;
  readonly seed: number;
  /** 順位条件を判定するなら出走頭数を渡す。null なら本家と同じく満たしている前提。 */
  readonly field: { readonly gateCount: number; readonly seed?: number; readonly samples?: number } | null;
  readonly system?: Partial<SystemSetting>;
  readonly hintLevels?: Readonly<Record<string, number>>;
  readonly stages?: readonly number[];
}

export interface ResolvedRequest {
  readonly base: SerializableRaceSetting;
  readonly system: SystemSetting;
  readonly candidates: readonly string[];
  readonly budget: number;
  readonly seed: number;
  readonly field: FieldSpec | null;
  readonly hintLevels: Readonly<Record<string, number>>;
  readonly stages: readonly number[] | undefined;
}

export class RequestError extends Error {}

export function fail(message: string): never {
  throw new RequestError(message);
}

export function finite(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} は数値で指定する`);
  if (value < min || value > max) fail(`${name} は ${min} から ${max} の範囲で指定する`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DEFAULT_STAGES_MAX = 20000;

function checkSystem(raw: unknown): SystemSetting {
  const base = defaultSystemSetting();
  if (raw === undefined) return base;
  if (!isRecord(raw)) fail('system はオブジェクトで指定する');

  const rates = [
    'skillLaneChangeRate', 'positionCompetitionRate', 'competeFightRate',
    'secureLeadRate', 'staminaKeepRate',
  ] as const;
  const merged: Record<string, unknown> = { ...base };
  for (const key of rates) {
    if (raw[key] !== undefined) merged[key] = finite(raw[key], `system.${key}`, 0, 1);
  }
  if (raw['leadCompetitionPosition'] !== undefined) {
    merged['leadCompetitionPosition'] = finite(raw['leadCompetitionPosition'], 'system.leadCompetitionPosition', 0, 10000);
  }
  for (const key of ['positionKeepSectionSen', 'positionKeepSectionSasi', 'positionKeepSectionOi'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length !== 10 || value.some((v) => typeof v !== 'boolean')) {
      fail(`system.${key} は真偽値 10 個の配列で指定する`);
    }
    merged[key] = value;
  }
  return merged as unknown as SystemSetting;
}

function checkBase(raw: unknown, data: GameData): SerializableRaceSetting {
  if (!isRecord(raw)) fail('base はオブジェクトで指定する');

  const uma = raw['uma'];
  if (!isRecord(uma)) fail('base.uma はオブジェクトで指定する');
  for (const key of ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const) {
    finite(uma[key], `base.uma.${key}`, 1, 3000);
  }
  finite(uma['popularity'], 'base.uma.popularity', 1, 18);
  finite(uma['gateNumber'], 'base.uma.gateNumber', -2, 18);
  finite(uma['uniqueLevel'], 'base.uma.uniqueLevel', 0, 10);

  const track = raw['track'];
  if (!isRecord(track)) fail('base.track はオブジェクトで指定する');
  // trackData はレース場（location）で引き、その中の courses にコースが入る。
  const location = finite(track['location'], 'base.track.location', 0, 1e9);
  const course = finite(track['course'], 'base.track.course', 0, 1e9);
  const place = data.trackData[location];
  if (place === undefined) fail(`知らないレース場: ${location}`);
  if (place.courses[course] === undefined) fail(`知らないコース: ${course}`);
  finite(track['gateCount'], 'base.track.gateCount', 1, 18);

  // 土台に付いているスキル（候補ではなく、常に持っているもの）
  const skillIds = raw['skillIds'];
  if (!Array.isArray(skillIds)) fail('base.skillIds は配列で指定する');
  if (skillIds.length > 100) fail('base.skillIds が多すぎる');
  for (const id of skillIds) {
    if (typeof id !== 'string' || !data.skillsById.has(id)) fail(`知らないスキル: ${String(id)}`);
  }

  return raw as unknown as SerializableRaceSetting;
}

export function checkRequest(raw: unknown, data: GameData): ResolvedRequest {
  if (!isRecord(raw)) fail('本文は JSON のオブジェクトで送る');

  const base = checkBase(raw['base'], data);
  const system = checkSystem(raw['system']);

  const candidates = raw['candidates'];
  if (!Array.isArray(candidates)) fail('candidates は配列で指定する');
  if (candidates.length === 0) fail('candidates が空である');
  if (candidates.length > 400) fail(`candidates が多すぎる: ${candidates.length}`);
  for (const id of candidates) {
    if (typeof id !== 'string' || !data.skillsById.has(id)) fail(`知らないスキル: ${String(id)}`);
  }

  const budget = finite(raw['budget'], 'budget', 0, 1e6);
  const seed = finite(raw['seed'], 'seed', 0, 2 ** 32 - 1);

  const hintLevelsRaw = raw['hintLevels'];
  const hintLevels: Record<string, number> = {};
  if (hintLevelsRaw !== undefined) {
    if (!isRecord(hintLevelsRaw)) fail('hintLevels はオブジェクトで指定する');
    for (const [id, level] of Object.entries(hintLevelsRaw)) {
      if (!data.skillsById.has(id)) fail(`知らないスキル: ${id}`);
      hintLevels[id] = finite(level, `hintLevels.${id}`, 0, 5);
    }
  }

  let stages: readonly number[] | undefined;
  const stagesRaw = raw['stages'];
  if (stagesRaw !== undefined) {
    if (!Array.isArray(stagesRaw) || stagesRaw.length === 0 || stagesRaw.length > 5) {
      fail('stages は 1 個から 5 個の配列で指定する');
    }
    const checked = stagesRaw.map((v, i) => finite(v, `stages[${i}]`, 1, DEFAULT_STAGES_MAX));
    for (let i = 1; i < checked.length; i++) {
      if (checked[i]! <= checked[i - 1]!) fail('stages は増加する順に並べる');
    }
    stages = checked;
  }

  let field: FieldSpec | null = null;
  const fieldRaw = raw['field'];
  if (fieldRaw !== undefined && fieldRaw !== null) {
    if (!isRecord(fieldRaw)) fail('field はオブジェクトか null で指定する');
    const gateCount = finite(fieldRaw['gateCount'], 'field.gateCount', 2, 18);
    const fieldSeed = fieldRaw['seed'] === undefined ? 9001 : finite(fieldRaw['seed'], 'field.seed', 0, 2 ** 32 - 1);
    const samples = fieldRaw['samples'] === undefined ? 64 : finite(fieldRaw['samples'], 'field.samples', 1, 256);
    // プロフィールは受け取らずこちらで作る。任意の相手を渡せるようにすると
    // 検査すべき面が一気に広がるうえ、いまの画面もこれしか使っていない。
    field = {
      profile: defaultFieldProfile(gateCount),
      track: base.track,
      seed: fieldSeed,
      samples,
    };
  }

  return { base, system, candidates, budget, seed, field, hintLevels, stages };
}
