import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';
import { createCostModel, dedupeByGroup } from '../src/cost.ts';
import { EVOLVED_MARK, inheritSettingsFromArgv, resolveInheritedNames } from '../src/inherit-names.ts';

const data = loadGameData();

describe('継承固有の指定（コマンドライン）', () => {
  it('指定が無ければ、名前は空でヒントは 0', () => {
    expect(inheritSettingsFromArgv(['node', 'plan-cli.ts', '--budget', '600'])).toEqual({ names: [], hint: 0 });
  });

  it('名前はコンマで区切り、空白と空の項目を落とす。ヒントレベルを読む', () => {
    const settings = inheritSettingsFromArgv(['--inherit', ' 黄金を訪ねて , ,光れ！弾けろ！超新星爆発！:進化,', '--inherit-hint', '2']);
    expect(settings.names).toEqual(['黄金を訪ねて', '光れ！弾けろ！超新星爆発！:進化']);
    expect(settings.hint).toBe(2);
  });

  it('おかしな値は黙って落とさず、エラーにする', () => {
    expect(() => inheritSettingsFromArgv(['--inherit', 'x', '--inherit-hint', '6'])).toThrow('--inherit-hint');
    expect(() => inheritSettingsFromArgv(['--inherit', 'x', '--inherit-hint', '-1'])).toThrow('--inherit-hint');
    expect(() => inheritSettingsFromArgv(['--inherit', 'x', '--inherit-hint', '1.5'])).toThrow('--inherit-hint');
    expect(() => inheritSettingsFromArgv(['--inherit', 'x', '--inherit-hint', 'たくさん'])).toThrow('--inherit-hint');
    // 名前が無いのにヒントだけ渡された
    expect(() => inheritSettingsFromArgv(['--inherit-hint', '2'])).toThrow('--inherit');
  });
});

describe('継承固有の名前の解決', () => {
  const inherit = (name: string): SkillData => {
    const found = data.skills.find((s) => s.rarity === 'inherit' && s.name === name);
    if (found === undefined) throw new Error(`継承版が見つからない: ${name}`);
    return found;
  };

  it('名前は rarity inherit のスキルに引く', () => {
    const picks = resolveInheritedNames(data.skills, ['黄金を訪ねて', 'Romantic Horizon']);
    expect(picks.map((p) => p.skillId)).toEqual([inherit('黄金を訪ねて').id, inherit('Romantic Horizon').id]);
    expect(picks.every((p) => !p.evolved)).toBe(true);
  });

  it('継承進化の名前は継承版と同じなので、:進化 を付けたものだけが継承進化になる', () => {
    const plain = resolveInheritedNames(data.skills, ['光れ！弾けろ！超新星爆発！'])[0]!;
    expect(plain.skillId).toBe('901411');
    expect(plain.evolved).toBe(false);

    const evolved = resolveInheritedNames(data.skills, [`光れ！弾けろ！超新星爆発！${EVOLVED_MARK}`])[0]!;
    expect(evolved.skillId).toBe('91101411');
    expect(evolved.evolved).toBe(true);
    expect(evolved.name).toBe('光れ！弾けろ！超新星爆発！');
  });

  it('継承進化は、継承版の値段で数える。継承版と並べても総額は 1 つぶん', () => {
    const model = createCostModel(data.skillsById);
    expect(model.cost('91101411')).toBe(model.cost('901411'));
    expect(model.totalCost(['901411', '91101411'])).toBe(model.cost('901411'));
    // 同じグループなので、並べても 1 つに絞られる
    expect(dedupeByGroup(['901411', '91101411'], model)).toHaveLength(1);
    // ヒントレベルは、持たせるスキル自身の ID のものを使う（200 pt が Lv2 で 160 pt）
    const hinted = createCostModel(data.skillsById, { hintLevels: { '91101411': 2 } });
    expect(hinted.cost('91101411')).toBe(160);
  });

  it('同じスキルを指す名前は 1 つにする', () => {
    const picks = resolveInheritedNames(data.skills, ['黄金を訪ねて', ' 黄金を訪ねて']);
    expect(picks).toHaveLength(1);
  });

  it('引けない名前は、黙って落とさず理由つきで投げる', () => {
    // 存在しない名前
    expect(() => resolveInheritedNames(data.skills, ['そんなスキルは無い'])).toThrow('継承固有として引けない');
    // 継承版を持たない固有（育成ウマ娘の固有は買うものではない）
    expect(() => resolveInheritedNames(data.skills, ['日本総大将'])).toThrow('継承固有として引けない');
    // 継承進化ではないものに :進化 を付けた。引ける継承進化を添える
    const error = (() => {
      try {
        resolveInheritedNames(data.skills, [`Romantic Horizon${EVOLVED_MARK}`]);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(error).toContain('継承固有として引けない');
    expect(error).toContain('光れ！弾けろ！超新星爆発！');
  });

  it('継承版が無く継承進化だけがある名前は、印が無くても継承進化に引く', () => {
    // いまのデータでは名前が重なるので、継承版を取り除いた写しで確かめる
    const withoutTwin = data.skills.filter((s) => s.id !== '901411');
    // 継承版が無ければ、継承進化は値段の元を失う（同じグループの継承版が無い）ので引けない
    expect(() => resolveInheritedNames(withoutTwin, ['光れ！弾けろ！超新星爆発！'])).toThrow('継承固有として引けない');
    // 名前の違う継承版を同じグループに置くと、継承進化の名前だけで引ける
    const twin = data.skills.find((s) => s.id === '901411')!;
    const renamed = [...withoutTwin, { ...twin, name: '別名の継承版' }];
    const pick = resolveInheritedNames(renamed, ['光れ！弾けろ！超新星爆発！'])[0]!;
    expect(pick.skillId).toBe('91101411');
    expect(pick.evolved).toBe(true);
  });
});
