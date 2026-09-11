import type { GameData } from '../../../packages/data/src/index.ts';
import { FIT_RANKS, conditionValue, styleValue } from '../../../packages/sim/src/data/constants.ts';
import type { UmaStatus } from '../../../packages/sim/src/setting.ts';
import { fail, finite, isRecord } from './request.ts';
import type { NewIndividual } from './individuals.ts';

const STYLES = Object.keys(styleValue);
const CONDITIONS = Object.keys(conditionValue);

function checkEnum<T extends string>(raw: unknown, name: string, allowed: readonly string[]): T {
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    fail(`${name} は ${allowed.join(' / ')} のいずれかで指定する`);
  }
  return raw as T;
}

function checkUma(raw: unknown): UmaStatus {
  if (!isRecord(raw)) fail('uma はオブジェクトで指定する');
  const charaName = raw['charaName'];
  if (typeof charaName !== 'string') fail('uma.charaName は文字列で指定する');
  return {
    charaName,
    speed: finite(raw['speed'], 'uma.speed', 1, 3000),
    stamina: finite(raw['stamina'], 'uma.stamina', 1, 3000),
    power: finite(raw['power'], 'uma.power', 1, 3000),
    guts: finite(raw['guts'], 'uma.guts', 1, 3000),
    wisdom: finite(raw['wisdom'], 'uma.wisdom', 1, 3000),
    condition: checkEnum(raw['condition'], 'uma.condition', CONDITIONS),
    style: checkEnum(raw['style'], 'uma.style', STYLES),
    distanceFit: checkEnum(raw['distanceFit'], 'uma.distanceFit', FIT_RANKS),
    surfaceFit: checkEnum(raw['surfaceFit'], 'uma.surfaceFit', FIT_RANKS),
    styleFit: checkEnum(raw['styleFit'], 'uma.styleFit', FIT_RANKS),
    popularity: finite(raw['popularity'], 'uma.popularity', 1, 18),
    gateNumber: finite(raw['gateNumber'], 'uma.gateNumber', -2, 18),
    uniqueLevel: finite(raw['uniqueLevel'], 'uma.uniqueLevel', 0, 10),
  };
}

/**
 * 保存する個体の検査。
 *
 * レース設定（コース等）は持たないぶん `checkBase`（request.ts）より単純。
 * ステータスの範囲とスキル ID の存在だけ見る。
 */
export function checkNewIndividual(raw: unknown, data: GameData): NewIndividual {
  if (!isRecord(raw)) fail('本文は JSON のオブジェクトで送る');

  const label = raw['label'];
  if (label !== undefined && typeof label !== 'string') fail('label は文字列で指定する');
  if (typeof label === 'string' && label.length > 200) fail('label が長すぎる');

  const uma = checkUma(raw['uma']);

  const skillIds = raw['skillIds'];
  if (!Array.isArray(skillIds)) fail('skillIds は配列で指定する');
  if (skillIds.length > 100) fail('skillIds が多すぎる');
  for (const id of skillIds) {
    if (typeof id !== 'string' || !data.skillsById.has(id)) fail(`知らないスキル: ${String(id)}`);
  }

  return { label: label ?? '', uma, skillIds };
}
