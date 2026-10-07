/**
 * 相手の名簿（`packages/sim/src/field/opponent-roster.ts`）を CLI で使うための用意。
 * `pnpm order-field` と `pnpm run multi` が同じ 4 つの口を持つので、ここに 1 か所だけ置く。
 *
 *   --opponents typical|roster   相手の作り方。既定は typical（今までと同じ）
 *   --sp-budget N                名簿の相手が白・金・緑に使う SP の予算（表示の合計）
 *   --unique-level N             名簿の相手の固有スキルのレベル（1 から 6）
 *   --roster-file PATH           手元の名簿。`parseRosterOverrides` の 2 通りの形のどちらでもよい
 *
 * 材料は 3 つで、名簿は育成ウマ娘のデータとスキル条件からの推定（`packages/data/src/roster.ts`）、
 * 順位表はスキル一覧のコース 1 枚（`opponent-ranking.ts`）、組み方は `RosterProfile` である。
 * **順位表が無いコース（一覧にまだ載っていない）では名簿を作れない。** 名簿ファイルを読めないときも同じである。
 * そのときは null を返し、呼ぶ側が扱いを決める（CLI は典型スキルで回し、MCP は相手を補わない）。
 * 黙って落とさず、理由を `notes` に入れる。
 *
 * **このファイルは Node でしか動かない**（`node:fs` を読む）。画面から import してはならない。
 * sim の CLI（`order-cli.ts`、`multi/cli.ts`）がここを import する。sim の計算側は
 * solver を import しない（CLI の入口だけが、データと同じように上の層へ手を伸ばす）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeckData } from '../../data/src/deck-node.ts';
import type { GameData } from '../../data/src/index.ts';
import { buildRoster, parseRosterOverrides } from '../../data/src/roster.ts';
import type { FieldProfile } from '../../sim/src/field/field.ts';
import {
  DEFAULT_ROSTER_PROFILE,
  type OpponentRoster,
  type RosterProfile,
} from '../../sim/src/field/opponent-roster.ts';
import { opponentRankingFromSkillList, opponentRankingTier } from './opponent-ranking.ts';
import { readSkillListCourse } from './skill-list-index.ts';
import { readSkillListDataset, skillListVersion } from './skill-list-version.ts';

/**
 * 置いてある表の版が、いまのデータから決まる版と違えば、その旨の説明を返す。
 * 順位表は大小関係にしか使わないので、古くても使える。ただし黙らない。
 */
function staleNote(file: { readonly version: string; readonly settings: { readonly gateCount: number } }): string | null {
  try {
    const current = skillListVersion(readSkillListDataset(REPO_ROOT, file.settings.gateCount));
    return current === file.version
      ? null
      : `置いてある表の版 ${file.version} は、いまのデータから決まる版 ${current} と違う` +
          '（データか計算式が動いた。順位表は古い表のまま使う。作り直しは `pnpm skill-list-check` で見る）。';
  } catch {
    return null;
  }
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** スキル一覧の置き場。`skill-list-cli.ts` の既定と同じ。 */
export const SKILL_LIST_DIR = join(REPO_ROOT, 'apps/web/public/skill-list');

export interface RosterCliSettings {
  readonly model: 'typical' | 'roster';
  /** 名簿の相手の組み方。`--sp-budget` と `--unique-level` 以外は既定のまま。 */
  readonly profile: RosterProfile;
  /** `--roster-file` のパス。無ければ null。 */
  readonly rosterFile: string | null;
}

function valueOf(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

function numberOf(argv: readonly string[], name: string, fallback: number): number {
  const text = valueOf(argv, name);
  if (text === null) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`--${name} は数で指定する: ${text}`);
  return value;
}

/** コマンドラインから名簿の指定を読む。値がおかしければ Error を投げる。 */
export function rosterSettingsFromArgv(argv: readonly string[]): RosterCliSettings {
  const model = valueOf(argv, 'opponents') ?? 'typical';
  if (model !== 'typical' && model !== 'roster') {
    throw new Error(`--opponents は typical か roster: ${model}`);
  }
  const spBudget = numberOf(argv, 'sp-budget', DEFAULT_ROSTER_PROFILE.spBudget);
  if (spBudget < 0) throw new Error(`--sp-budget は 0 以上: ${spBudget}`);
  const uniqueLevel = numberOf(argv, 'unique-level', DEFAULT_ROSTER_PROFILE.uniqueLevel);
  if (!Number.isInteger(uniqueLevel) || uniqueLevel < 1 || uniqueLevel > 6) {
    throw new Error(`--unique-level は 1 から 6 の整数: ${uniqueLevel}`);
  }
  return {
    model,
    profile: { ...DEFAULT_ROSTER_PROFILE, spBudget, uniqueLevel },
    rosterFile: valueOf(argv, 'roster-file'),
  };
}

export interface PreparedRoster {
  /** 作れなければ null。作れなかったあとにどう回すかは、呼ぶ側が決める。 */
  readonly roster: OpponentRoster | null;
  /**
   * 説明。作れなかった理由もここに入る。**理由だけを持たせ、作れなかったあとの扱いは書かない。**
   * CLI は典型スキルの相手に落とし（`ROSTER_FALLBACK_NOTE`）、MCP は相手を補わない。
   * 帰結まで書くと、呼ぶ側の扱いと食い違う。
   */
  readonly notes: readonly string[];
}

/** CLI が、名簿を作れなかったときに標準エラーへ足す一文。典型スキルの相手に落とす（MCP は落とさない）。 */
export const ROSTER_FALLBACK_NOTE = '名簿は作れなかったので、典型スキルの相手で回す。';

/**
 * そのコースの名簿を用意する。
 *
 * 名簿のカードは `buildRoster` の推定、`--roster-file` があればそのカードだけに絞って
 * 脚質を上書きする。順位表はスキル一覧のコース 1 枚から。
 */
export function prepareRoster(
  data: GameData,
  settings: RosterCliSettings,
  course: { readonly location: number; readonly course: number },
  dir: string = SKILL_LIST_DIR,
): PreparedRoster {
  const notes: string[] = [];
  const file = readSkillListCourse(dir, course.location, course.course);
  if (file === null) {
    notes.push(
      `順位表が無いコース（${course.location}-${course.course}。スキル一覧に載っていない）。` +
        '名簿は作れない。',
    );
    return { roster: null, notes };
  }
  const ranking = opponentRankingFromSkillList(file);
  const stale = staleNote(file);
  if (stale !== null) notes.push(stale);

  let cards = buildRoster(loadDeckData().charas, data);
  const eligible = cards.filter((card) => card.styles.length > 0).length;
  notes.push(`名簿 ${cards.length} 枚（脚質の手掛かりがあるのは ${eligible} 枚。推定）。`);

  if (settings.rosterFile !== null) {
    let text: string;
    try {
      text = readFileSync(settings.rosterFile, 'utf8');
    } catch (error) {
      // 存在しないパスや読めないファイル。入力の誤りだが、他の「作れない」経路と同じく理由を返す。
      notes.push(`名簿ファイル ${settings.rosterFile} を読めない（${(error as Error).message}）。名簿は作れない。`);
      return { roster: null, notes };
    }
    const overrides = parseRosterOverrides(text, cards);
    notes.push(
      `名簿ファイル ${settings.rosterFile}: ${overrides.parsed} 行を読み、` +
        `${overrides.skipped} 行を飛ばした。載っている ${overrides.cards.length} 枚だけを使う。`,
    );
    if (overrides.cards.length === 0) {
      notes.push('名簿ファイルから 1 枚も読めなかったので、名簿は作れない。');
      return { roster: null, notes };
    }
    cards = overrides.cards;
  }

  notes.push(
    `順位表: スキル一覧 ${file.version} の ${file.course.locationName} ${file.course.courseName}、` +
      `基準は ${opponentRankingTier(file) ?? 'なし'}、試行 ${file.settings.trials}。` +
      `SP 予算 ${settings.profile.spBudget}、固有 Lv${settings.profile.uniqueLevel}。`,
  );
  return { roster: { cards, ranking }, notes };
}

/**
 * 相手の想定に名簿の指定を足す。名簿が作れなかった（null）ときや typical のときは、渡した想定をそのまま返す。
 * 既定の想定にはキーを足さない（`FieldProfile.opponentModel` の注記）。
 */
export function rosterFieldProfile(
  base: FieldProfile,
  settings: RosterCliSettings,
  roster: OpponentRoster | null,
): FieldProfile {
  if (settings.model !== 'roster' || roster === null) return base;
  return { ...base, opponentModel: 'roster', roster: settings.profile };
}
