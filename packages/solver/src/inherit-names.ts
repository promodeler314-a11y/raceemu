/**
 * 育成計画の探索（`pnpm plan`）に渡す、家系で決まった継承固有の指定。
 *
 *   --inherit "名前,名前,..."   継承固有の名前。最大 6 つ
 *   --inherit-hint N            その因子のヒントレベル（0 から 5。既定 0）
 *
 * 継承固有は、親や祖父母の家系で何が積まれるかが育成の前に決まる。取るかどうかを
 * 探索が選ぶものではないので、候補ではなく必須として渡し、その費用を予算から先に払う
 * （`OptimizeOptions.required`）。払い忘れると、買えない構成を推すことになる。
 * 固有 1 つは 200 SP（ヒントレベル 2 で 160）で、6 つ積めば 1200 SP（Lv2 なら 960）を先に使う。
 *
 * 名前は rarity 'inherit' のスキルから引く。継承進化（rarity 'special'）は、継承版を積んで進化させる
 * もので、skills.json に sp が無い（値段は同じグループの継承版から決まる。`cost.ts`）。
 * **継承進化の名前は継承版と同じ**（黄金を訪ねて、光れ！弾けろ！超新星爆発！、ずっとずっと輝いて）
 * なので、名前だけでは継承版に引かれる。進化させるものは名前のあとに `:進化` を付ける。
 *
 * 画面にも Node にも依存しない（スキルの一覧だけを受け取る）。
 */
import { skillLvToFactor } from '../../sim/src/data/constants.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';

/** 継承進化を指す、名前の末尾の印 */
export const EVOLVED_MARK = ':進化';

export interface InheritSettings {
  /** 指定された名前（印つきのまま）。指定が無ければ空。 */
  readonly names: readonly string[];
  /** 継承固有の因子のヒントレベル */
  readonly hint: number;
}

/** 名前の解決に要る項目だけ。スキルの実体でなくても引ける。 */
export type NamedSkill = Pick<SkillData, 'id' | 'name' | 'rarity' | 'group'>;

export interface InheritedPick {
  /** 持たせるスキルの ID。継承進化のときはその ID（継承版ではない）。 */
  readonly skillId: string;
  readonly name: string;
  readonly evolved: boolean;
}

function valueOf(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

/** コマンドラインから継承固有の指定を読む。値がおかしければ Error を投げる。 */
export function inheritSettingsFromArgv(argv: readonly string[]): InheritSettings {
  const names = (valueOf(argv, 'inherit') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const hintText = valueOf(argv, 'inherit-hint');
  const maxHint = skillLvToFactor.length - 1;
  const hint = hintText === null ? 0 : Number(hintText);
  if (!Number.isInteger(hint) || hint < 0 || hint > maxHint) {
    throw new Error(`--inherit-hint は 0 から ${maxHint} の整数: ${hintText}`);
  }
  if (hintText !== null && names.length === 0) {
    // ヒントレベルは継承固有にだけ掛かる。名前が無いのに渡されたら、書き間違いを疑う。
    throw new Error('--inherit-hint は --inherit と一緒に使う（継承固有の名前が無い）');
  }
  return { names, hint };
}

/**
 * 名前を、持たせるスキルに引く。引けない名前があれば、見つからなかった理由つきで Error を投げる。
 * 同じスキルを指す名前が重なったときは 1 つにする。
 */
export function resolveInheritedNames(
  skills: readonly NamedSkill[],
  names: readonly string[],
): InheritedPick[] {
  const inheritByName = new Map<string, NamedSkill>();
  const inheritByGroup = new Map<number, NamedSkill>();
  for (const skill of skills) {
    if (skill.rarity !== 'inherit') continue;
    if (!inheritByName.has(skill.name)) inheritByName.set(skill.name, skill);
    if (!inheritByGroup.has(skill.group)) inheritByGroup.set(skill.group, skill);
  }
  // 継承進化のうち、値段の元になる継承版を持つもの。持たないものは値段が決まらず、買うものではない。
  const evolvedByName = new Map<string, NamedSkill>();
  for (const skill of skills) {
    if (skill.rarity === 'special' && inheritByGroup.has(skill.group) && !evolvedByName.has(skill.name)) {
      evolvedByName.set(skill.name, skill);
    }
  }

  const picks = new Map<string, InheritedPick>();
  for (const rawName of names) {
    const raw = rawName.trim();
    const evolved = raw.endsWith(EVOLVED_MARK);
    const name = evolved ? raw.slice(0, -EVOLVED_MARK.length).trim() : raw;
    // 印が無くても、継承版が無く継承進化だけがある名前なら、継承進化として引く
    // （いまのデータには無いが、名前が分かれたときに黙って落とさないため）。
    const found = evolved ? evolvedByName.get(name) : (inheritByName.get(name) ?? evolvedByName.get(name));
    if (found === undefined) {
      const hint = evolved
        ? `継承版を持つ継承進化は ${[...evolvedByName.keys()].join('、')} だけ`
        : '固有の継承版の名前を、スキル名のとおりに書く（進化させるものは名前のあとに :進化）';
      throw new Error(`継承固有として引けない: ${raw}（${hint}）`);
    }
    picks.set(found.id, { skillId: found.id, name: found.name, evolved: found.rarity === 'special' });
  }
  return [...picks.values()];
}
