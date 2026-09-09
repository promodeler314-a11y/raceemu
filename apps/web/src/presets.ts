import type { TrackRef, UmaStatus } from '../../../packages/sim/src/setting.ts';
import { gameData } from './store.ts';

/**
 * 最初に開いた人が押せる設定。
 *
 * [モック](../../../design/Main.dc.html)の空状態に 3 つ並んでいるもので、
 * 空の入力欄を前にして何を入れればよいか分からない、という状態を解く。
 *
 * スキルは ID ではなく名前で持つ。本家データの更新で ID が変わっても、
 * 名前で引き直せば追随できる。見つからないものは黙って飛ばす。
 */

export interface Preset {
  readonly id: string;
  readonly name: string;
  /** カードの 2 行目。コースとスキル数を出す。 */
  readonly note: string;
  readonly uma: Omit<UmaStatus, 'charaName'>;
  readonly track: TrackRef;
  readonly skillNames: readonly string[];
}

const base = {
  charaName: '',
  condition: 'BEST',
  distanceFit: 'A',
  surfaceFit: 'A',
  styleFit: 'A',
  popularity: 1,
  gateNumber: 0,
  uniqueLevel: 6,
} as const;

export const PRESETS: readonly Preset[] = [
  {
    id: 'nige-speed',
    name: '逃げ・スピード型',
    note: '東京 芝 2400m ／ スキル 10',
    uma: { ...base, speed: 1400, stamina: 900, power: 1000, guts: 600, wisdom: 800, style: 'NIGE' },
    track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
    skillNames: [
      '逃げのコツ○', 'ハヤテ一文字', 'コーナー加速○', '直線加速', '好転一息',
      '円弧のマエストロ', '弧線のプロフェッサー', '中距離コーナー○', '中距離直線○', '危険回避',
    ],
  },
  {
    id: 'sasi-stamina',
    name: '差し・スタミナ型',
    note: '阪神 芝 3000m ／ スキル 12',
    uma: { ...base, speed: 1150, stamina: 1400, power: 900, guts: 700, wisdom: 900, style: 'SASI' },
    track: { location: 10009, course: 10909, condition: 1, gateCount: 9 },
    skillNames: [
      '末脚', '深呼吸', '食い下がり', 'コーナー回復○', '直線回復', '長距離コーナー○',
      '円弧のマエストロ', '弧線のプロフェッサー', '好転一息', 'アガッてきた！', '危険回避', '直線加速',
    ],
  },
  {
    id: 'reference',
    name: '本家の既定値',
    note: '中山 芝 2000m ／ スキルなし',
    uma: { ...base, speed: 1000, stamina: 1000, power: 1000, guts: 1000, wisdom: 1000, style: 'SEN' },
    track: { location: 10005, course: 10504, condition: 1, gateCount: 9 },
    skillNames: [],
  },
];

/** 名前からスキル ID を引く。見つからないものは落とす。 */
export function resolveSkillIds(names: readonly string[]): string[] {
  return names
    .map((name) => gameData.skillsByName.get(name)?.[0]?.id)
    .filter((id): id is string => id !== undefined);
}
