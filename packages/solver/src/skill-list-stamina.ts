/**
 * 基準個体。**スタミナは足りている前提で置く。**
 *
 * ## なぜ上限に置くか
 *
 * 以前はコースごとに「最大スパートに要る最小スタミナ」を逆算し、その 50
 * パーセンタイル（普通）と 90 パーセンタイル（強い）を採っていた。
 * 「回復と速度のどちらも効く、いちばん読み分けが要る位置」のつもりだった。
 *
 * **その表は使いものにならなかった。** 配ってある 137 コースで数えると、
 * 上位 20 に占める回復スキルは芝マイルで 94 %、芝中距離で 99.8 %、長距離で 100 %
 * になる（短距離だけが母集団比の 19 % 前後）。ぎりぎり最大スパートに届く個体では
 * スタミナ 1 点の値打ちが他のどの効果より大きいので、当然そうなる。
 * 表が「回復を買え」としか言わないなら、読む値打ちが無い。
 *
 * **そもそも前提が実際と違っていた。** いまのゲームではスタミナは足りるもので、
 * 回復スキルは超長距離でなければ取らない。表もその前提に合わせる。
 *
 * そこでスタミナは**育成の上限（`STAMINA_CAP`）に置く**。
 * 東京 芝2400m・先行で測り直すと、上位 20 の回復は次のように動く。
 *
 * | スタミナ | 上位 20 の回復 |
 * | --- | ---: |
 * | 725（旧・普通 = p50） | 100 % |
 * | 850（旧・強い = p90） | 85 % |
 * | 1000 | 60 % |
 * | 1200（上限） | **15 %** |
 *
 * 15 % は買えるスキルに占める回復スキルの割合とほぼ同じで、つまり回復が
 * 特別扱いされていない状態である。中山 芝1200m では 0 %、京都 芝3000m では
 * 上限でも 100 % になる。**「短距離・中距離では回復を取らない、超長距離では取る」
 * という実際の姿が、そのまま出る。**
 *
 * ## 2 段は強さの幅だけを持つ
 *
 * スタミナを両段とも上限に置いたので、`normal` と `strong` の違いは
 * 速さ・パワー・根性・賢さの +150 だけになった。
 * **スタミナを段の軸に混ぜていたのが、そもそもの取り違えだった。**
 *
 * ## 実測は捨てない。読み方の説明に使う
 *
 * コースごとの「最大スパートに要るスタミナ」は測ってあり（`pnpm skill-list --calibrate`）、
 * この 1 枚に残している。**上限でも足りないコースがどれかを言うため**である。
 * 京都 芝3000m は p50 が 1225 で、上限の 1200 を超える。そこで回復が上位を占めるのは
 * モデルの都合ではなく、そのコースの性質である。画面はそう書ける（`StaminaDemand`）。
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
  StaminaDemand,
} from './skill-list.ts';
import { STAMINA_CAP, skillListCourseKey } from './skill-list.ts';

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

// スタミナの上限は契約の側（`skill-list.ts`）にある。画面とテストも同じ値で
// 「余裕があるか」を判断するからである。ここでは基準個体に置くだけ。
export { STAMINA_CAP };

const TIER_LABEL: Readonly<Record<SkillListTier, string>> = { normal: '普通', strong: '強い' };

/**
 * 基準個体の 2 段。**スタミナは両段とも上限**で、違いは骨格の +150 だけである。
 *
 * コースを受け取るのは呼び出しの形を変えないためで、いまはコースによって変わらない。
 */
export function baselinesFor(course: SkillListCourse): SkillListBaseline[] {
  void course;
  const make = (id: SkillListTier, offset: number): SkillListBaseline => ({
    id,
    label: TIER_LABEL[id],
    speed: NORMAL_SKELETON.speed + offset,
    stamina: STAMINA_CAP,
    power: NORMAL_SKELETON.power + offset,
    guts: NORMAL_SKELETON.guts + offset,
    wisdom: NORMAL_SKELETON.wisdom + offset,
  });
  return [make('normal', 0), make('strong', STRONG_OFFSET)];
}

/**
 * そのコースで最大スパートに要るスタミナを引く。**基準個体には使わない。**
 *
 * 画面が「上限でも足りないコースだから回復が上位に来る」と言うために持つ
 * （型は `skill-list.ts` にある。画面が読むからである）。測っていないコースでは `null`。
 */
export function staminaDemandFor(
  course: SkillListCourse,
  table: StaminaTable | null,
): StaminaDemand | null {
  const entry = table?.courses[skillListCourseKey(course.location, course.course)];
  if (entry === undefined) return null;
  // **事実だけを持つ。** 「縛りになっているか」の判断は契約側の
  // `isStaminaBinding` にある（線の引き方を、表を作り直さずに直せるようにするため）。
  return { p50: entry.normal, p90: entry.strong };
}

/**
 * 基準個体の決め方そのものの指紋。**版に混ぜる。**
 *
 * 骨格や上限を動かすと表の値は全部変わるのに、スキルデータもコースデータも
 * 計算式も動いていないので、これを混ぜないと版が同じままになる。
 * 古い基準で測った表を新しい基準の表と取り違える（しかも気付けない）。
 */
export function baselinePolicy(): string {
  return JSON.stringify({
    skeleton: NORMAL_SKELETON,
    strongOffset: STRONG_OFFSET,
    stamina: 'cap',
    cap: STAMINA_CAP,
  });
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
