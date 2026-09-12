import type { GameData } from '../../../packages/data/src/index.ts';
import { FIT_RANKS, type FitRank } from '../../../packages/sim/src/data/constants.ts';
import type { UmaStatus } from '../../../packages/sim/src/setting.ts';
import type { SkillIndex } from './skills.ts';

/**
 * 本家の設定文字列の受け渡し。
 *
 * 本家（mee1080/umasim）はキャラ名、ステータス 5 つ、適性 3 つ、スキル名を
 * 区切って並べた 1 行で設定を渡す（docs/roadmap.md 1.1 節と 3.5 節）。
 * 書く側は `join(',')` で足り、読む側は値の形から何なのかを決められる。
 *
 * - 数字はステータス。出てきた順に スピード、スタミナ、パワー、根性、賢さ。
 * - 1 文字の `S` から `G` は適性。出てきた順に 距離、バ場、脚質。
 * - それ以外はキャラ名かスキル名として引き当てる。
 *
 * 区切りは広く受ける。本家の画面から写すと、カンマではなく改行やタブで
 * 貼られることがある。
 *
 * **引き当てられなかった語は捨てずに返す。** 黙って減ると、本家と違う結果が
 * 出たときに、移植の誤りなのか読み込みの取りこぼしなのかが分からなくなる。
 *
 * この形式が運べないもの（脚質、やる気、コース、人気、枠番、ヒントレベル、
 * デバフ、実行オプション）は触らない。本家の形式に無いからである。
 */

/** 区切り。カンマ、改行、タブ、コロン、スラッシュ、読点、全角カンマ。 */
const SEPARATOR = /[,\n\r\t:：/、，]+/;

/** ステータスを入れる順。本家の並びである。 */
const STATUS_ORDER = ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const;

/** 適性を入れる順。距離、バ場、脚質（docs/race-emulator-analysis.md の 22 行目）。 */
const FIT_ORDER = ['distanceFit', 'surfaceFit', 'styleFit'] as const;

export type StatusKey = (typeof STATUS_ORDER)[number];
export type FitKey = (typeof FIT_ORDER)[number];

export interface TransferIndex {
  /** 表記からキャラ名（`[勝負服]ウマ娘名`）を引く。見つからなければ null。 */
  charaOf(token: string): string | null;
  /** 名前からスキル ID。固有と進化はキャラ側から入るので一覧だけを見る。 */
  skillOf(token: string): string | null;
  /** スキル ID から名前。書き出しに使う。 */
  nameOf(skillId: string): string | null;
  /** そのスキルが固有か進化か。書き出しから外すのに使う。 */
  fromChara(skillId: string): boolean;
}

export function buildTransferIndex(data: GameData, index: SkillIndex): TransferIndex {
  // 勝負服名を外した呼び方でも引けるようにする。同じウマ娘に勝負服が複数ある
  // 場合は、並びの先にあるものを採る。どれか 1 つに決まれば用は足りる。
  const byBareName = new Map<string, string>();
  for (const chara of index.charas) {
    const end = chara.indexOf(']');
    const bare = end < 0 ? chara : chara.slice(end + 1);
    if (!byBareName.has(bare)) byBareName.set(bare, chara);
  }
  const charas = new Set(index.charas);

  // 一覧に出すスキルだけを名前で引く。固有の名前は継承版と同じなので、
  // ここを通すと継承版に落ちる。固有はキャラ名のほうが運ぶ。
  const byName = new Map<string, string>();
  for (const skill of index.selectable) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill.id);
  }

  return {
    charaOf: (token) => (charas.has(token) ? token : (byBareName.get(token) ?? null)),
    skillOf: (token) => byName.get(token) ?? null,
    nameOf: (skillId) => data.skillsById.get(skillId)?.name ?? null,
    fromChara: (skillId) => {
      const skill = data.skillsById.get(skillId);
      return skill !== undefined && (skill.rarity === 'unique' || skill.rarity === 'evo');
    },
  };
}

export interface ParsedTransfer {
  /** 読めたステータス。書いていない項目は持たない。 */
  readonly status: Readonly<Partial<Record<StatusKey, number>>>;
  /** 読めた適性。書いていない項目は持たない。 */
  readonly fits: Readonly<Partial<Record<FitKey, FitRank>>>;
  /** キャラ名。書いていなければ null。 */
  readonly charaName: string | null;
  /** 引き当てられたスキル。並びは書いてあった順で、重複は落とす。 */
  readonly skillIds: readonly string[];
  /** 引き当てられなかった語。 */
  readonly unknown: readonly string[];
}

function isFitRank(token: string): token is FitRank {
  return token.length === 1 && (FIT_RANKS as readonly string[]).includes(token);
}

export function parseTransfer(text: string, index: TransferIndex): ParsedTransfer {
  const status: Partial<Record<StatusKey, number>> = {};
  const fits: Partial<Record<FitKey, FitRank>> = {};
  const skillIds: string[] = [];
  const unknown: string[] = [];
  let charaName: string | null = null;
  let statusAt = 0;
  let fitAt = 0;

  for (const raw of text.split(SEPARATOR)) {
    const token = raw.trim();
    if (token === '') continue;

    // 数字はステータス。6 つ目以降は入れる先が無いので、読めなかった語として返す。
    if (/^[0-9]+$/.test(token)) {
      const key = STATUS_ORDER[statusAt];
      if (key === undefined) unknown.push(token);
      else {
        status[key] = Number(token);
        statusAt++;
      }
      continue;
    }

    if (isFitRank(token)) {
      const key = FIT_ORDER[fitAt];
      if (key === undefined) unknown.push(token);
      else {
        fits[key] = token;
        fitAt++;
      }
      continue;
    }

    // キャラ名はスキル名より先に見る。キャラ名と同じ名前のスキルは無いが、
    // 先に決めておけば、あとで増えても取り違えない。
    const chara = index.charaOf(token);
    if (chara !== null && charaName === null) {
      charaName = chara;
      continue;
    }

    const skillId = index.skillOf(token);
    if (skillId === null) unknown.push(token);
    else if (!skillIds.includes(skillId)) skillIds.push(skillId);
  }

  return { status, fits, charaName, skillIds, unknown };
}

/**
 * 本家に渡す 1 行を作る。
 *
 * 固有と進化は出さない。名前が継承版と同じなので、読み直すと継承版になって
 * 意味が変わる。キャラ名を出しておけば、読む側がそのキャラの固有を入れる。
 */
export function formatTransfer(
  uma: UmaStatus,
  skillIds: readonly string[],
  index: TransferIndex,
): string {
  const parts: string[] = [];
  if (uma.charaName !== '') parts.push(uma.charaName);
  for (const key of STATUS_ORDER) parts.push(String(uma[key]));
  for (const key of FIT_ORDER) parts.push(uma[key]);
  for (const id of skillIds) {
    if (index.fromChara(id)) continue;
    const name = index.nameOf(id);
    if (name !== null) parts.push(name);
  }
  return parts.join(',');
}
