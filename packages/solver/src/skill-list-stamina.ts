/**
 * 基準個体のスタミナ。**コースごとに実測した値を持つ。**
 *
 * 距離帯ごとに 1 つ置くと、同じ距離帯でもコースが違えば要るスタミナが違うこと
 * （東京 芝2000m と阪神 芝2200m は坂も直線も違う）を表に出せない。
 * スキル一覧の軸をコースにした以上、スタミナもコースごとである。
 *
 * ## どう決めるか
 *
 * 逆算器（`critical.ts`、目標は最大スパート）でコースごとに
 * 「最大スパートに要る最小スタミナ」の分布を取り、分位点を採る。
 *
 * - 普通：**50 パーセンタイル**。五分五分で最大スパートが出る個体になる。
 *   回復と速度のどちらも効く、いちばん読み分けが要る位置である。
 * - 強い：**90 パーセンタイル**。ほぼ確実に最大スパートが出る個体になる。
 *   ここでは回復はほとんど効かず、速度と加速の比べ合いになる。
 *
 * 脚質でスタミナの要りようが違うが、基準個体は脚質をまたいで同じものを使うので、
 * **4 脚質ぶんをまとめて 1 つの分布**にする。
 *
 * ## なぜ JSON に置くか
 *
 * 137 コースぶんを手でソースに写すことはできない。`pnpm skill-list --calibrate` が
 * この 1 枚を書き、commit する。**表を作るたびに測り直さない**（1 コース 10 秒でも
 * 137 コースで 25 分かかり、そのぶん表の測定が遅れる）。
 * コースのデータが動いたときだけ測り直す。
 *
 * **このファイルは Node でしか動かない**（`node:fs` を読む）。画面から import してはならない。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SkillListBaseline,
  SkillListCourse,
  SkillListTier,
} from './skill-list.ts';
import { skillListCourseKey } from './skill-list.ts';

/** 測ってある 1 コースぶん。値は 25 の倍数に丸めてある（分位点の誤差より細かい桁は意味を持たない）。 */
export interface StaminaEntry {
  /** 50 パーセンタイル */
  readonly normal: number;
  /** 90 パーセンタイル */
  readonly strong: number;
  /** 範囲内で最大スパートに届かなかった試行の割合 */
  readonly unreached: number;
}

export interface StaminaTable {
  readonly generatedAt: string;
  /** 測ったときの条件。読み直すときの手がかりにする。 */
  readonly settings: {
    readonly trials: number;
    readonly seed: number;
    readonly gateCount: number;
    readonly trackCondition: number;
    readonly from: number;
    readonly to: number;
    readonly step: number;
  };
  /** `skillListCourseKey` → 測った値 */
  readonly courses: Readonly<Record<string, StaminaEntry>>;
}

export const STAMINA_TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'skill-list-stamina.json',
);

/**
 * 基準個体のステータス（スタミナ以外）。
 *
 * **「普通」は相手の束と同じ個体である。**`defaultFieldProfile` が持つ
 * 1100 / 900 / 900 / 600 / 900 をそのまま使う。相手は自分と同格に引き直されるので
 * （`matchSelf`）、普通の行は「同格の集団の中の 1 頭」の話になる。
 * 借り物ではあるが、リポジトリが既に「同格」と決めて使っている唯一の数値である。
 *
 * **「強い」は普通に一律 +150 した個体である。**相手の強さを振る口が
 * `FieldProfile.offset`（一律に足す）なので、その使い方に倣った。
 * ただし **+150 という幅は勘である。** ゲームからの実測ではない。
 * 2 段あることに意味があり、段の間隔そのものに根拠は無い。
 */
export const NORMAL_SKELETON = { speed: 1100, power: 900, guts: 600, wisdom: 900 } as const;

/** 強いほうの上乗せ。勘である（上の注記）。 */
export const STRONG_OFFSET = 150;

/**
 * 実測の値を挟む上下の限り。
 *
 * - **下限 300**：短距離では逆算が探索の下限（200）に張り付く。スタミナが
 *   縛りになっていないので値そのものに意味が無く、そのまま使うとゲームに出てこない
 *   個体になる。**300 という値は勘である。**
 * - **上限 1200**：育成が終わった時点のステータスの上限である。芝の長距離は
 *   逆算が 1500 を超える値を返すが、そこまで持った個体は基準にならない。
 *   上限に張り付いたコースでは 2 段のスタミナが同じになる。それは
 *   「長距離では上限でも最大スパートが五分」という実測そのものである。
 */
export const STAMINA_FLOOR = 300;
export const STAMINA_CAP = 1200;

const TIER_LABEL: Readonly<Record<SkillListTier, string>> = { normal: '普通', strong: '強い' };

/** 測ってある値が無いときに使う。距離から粗く置くだけで、**実測ではない。** */
export function fallbackStamina(distance: number): StaminaEntry {
  // 2000 m でおよそ 600、1000 m ごとに 300 という当て推量である。
  // ここに落ちるのは「まだ測っていないコース」だけなので、表には
  // そのコースが載らない（CLI が測っていないコースを弾く）のが普通である。
  const guess = Math.round(((distance - 1200) * 0.3 + 300) / 25) * 25;
  return { normal: guess, strong: guess + 150, unreached: Number.NaN };
}

/** 1 コースぶんの基準個体 2 段を作る。 */
export function baselinesFor(
  course: SkillListCourse,
  table: StaminaTable | null,
): SkillListBaseline[] {
  const entry =
    table?.courses[skillListCourseKey(course.location, course.course)] ??
    fallbackStamina(course.distance);
  const clamp = (value: number) => Math.min(STAMINA_CAP, Math.max(STAMINA_FLOOR, value));
  const normal = clamp(entry.normal);
  const strong = Math.max(normal, clamp(entry.strong));
  const make = (id: SkillListTier, offset: number, stamina: number): SkillListBaseline => ({
    id,
    label: TIER_LABEL[id],
    speed: NORMAL_SKELETON.speed + offset,
    stamina,
    power: NORMAL_SKELETON.power + offset,
    guts: NORMAL_SKELETON.guts + offset,
    wisdom: NORMAL_SKELETON.wisdom + offset,
  });
  return [make('normal', 0, normal), make('strong', STRONG_OFFSET, strong)];
}

/** 測ってあるコースかどうか。**測っていないコースは表に載せない。** */
export function hasStamina(course: SkillListCourse, table: StaminaTable | null): boolean {
  if (table === null) return false;
  return skillListCourseKey(course.location, course.course) in table.courses;
}

export function isStaminaTable(value: unknown): value is StaminaTable {
  if (typeof value !== 'object' || value === null) return false;
  const table = value as Partial<StaminaTable>;
  return typeof table.courses === 'object' && table.courses !== null;
}

/** 測ってある 1 枚を読む。無ければ null。 */
export function loadStaminaTable(path: string = STAMINA_TABLE_PATH): StaminaTable | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isStaminaTable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 測った値を書き込む。**既にある値は消さない。**
 *
 * 137 コースを一度に測るとは限らない（`--courses` で分けて測れる）ので、
 * 読んでから足して書く。鍵は並べ替えて書き、差分が読める形にする。
 */
export function saveStaminaTable(
  measured: Readonly<Record<string, StaminaEntry>>,
  settings: StaminaTable['settings'],
  path: string = STAMINA_TABLE_PATH,
): StaminaTable {
  const current = loadStaminaTable(path);
  const merged = { ...(current?.courses ?? {}), ...measured };
  const courses: Record<string, StaminaEntry> = {};
  for (const key of Object.keys(merged).sort()) courses[key] = merged[key]!;
  const table: StaminaTable = { generatedAt: new Date().toISOString(), settings, courses };
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`);
  return table;
}
