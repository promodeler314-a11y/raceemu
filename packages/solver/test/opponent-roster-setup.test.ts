import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { defaultFieldProfile } from '../../sim/src/field/field.ts';
import { DEFAULT_ROSTER_PROFILE } from '../../sim/src/field/opponent-roster.ts';
import {
  ROSTER_FALLBACK_NOTE,
  SKILL_LIST_DIR,
  prepareRoster,
  rosterFieldProfile,
  rosterOpponentsLine,
  rosterSettingsFromArgv,
  searchFieldSpec,
} from '../src/opponent-roster-setup.ts';
import { readSkillListCourse } from '../src/skill-list-index.ts';

const data = loadGameData();
const kyoto = { location: 10008, course: 10808 };
const hasKyoto = readSkillListCourse(SKILL_LIST_DIR, kyoto.location, kyoto.course) !== null;

describe('名簿の指定（コマンドライン）', () => {
  it('何も指定しなければ typical で、名簿の既定がそのまま入る', () => {
    const settings = rosterSettingsFromArgv(['node', 'cli.ts', '--trials', '10']);
    expect(settings.model).toBe('typical');
    expect(settings.profile).toEqual(DEFAULT_ROSTER_PROFILE);
    expect(settings.rosterFile).toBeNull();
  });

  it('4 つの口を読む。SP 予算と固有レベル以外は既定のまま', () => {
    const settings = rosterSettingsFromArgv([
      '--opponents', 'roster', '--sp-budget', '8000', '--unique-level', '6', '--roster-file', 'x.txt',
    ]);
    expect(settings.model).toBe('roster');
    expect(settings.profile).toEqual({ ...DEFAULT_ROSTER_PROFILE, spBudget: 8000, uniqueLevel: 6 });
    expect(settings.rosterFile).toBe('x.txt');
  });

  it('--sp-budget を省いたときの値は、呼ぶ側が決められる。指定があればそちらが勝つ', () => {
    // 探索の CLI（plan / optimize）は、省いたら自分の予算に揃える。
    const followed = rosterSettingsFromArgv(['--opponents', 'roster'], { spBudget: 600 });
    expect(followed.profile.spBudget).toBe(600);
    expect(followed.spBudgetFromRun).toBe(true);
    const given = rosterSettingsFromArgv(['--opponents', 'roster', '--sp-budget', '8000'], { spBudget: 600 });
    expect(given.profile.spBudget).toBe(8000);
    expect('spBudgetFromRun' in given).toBe(false);
    // 既定を渡さない呼び出しは、今までと同じ（キーも増えない）
    const plain = rosterSettingsFromArgv(['--opponents', 'roster']);
    expect(plain.profile.spBudget).toBe(DEFAULT_ROSTER_PROFILE.spBudget);
    expect('spBudgetFromRun' in plain).toBe(false);
    // 0 も有効な既定（予算を使い切った構成）
    expect(rosterSettingsFromArgv([], { spBudget: 0 }).profile.spBudget).toBe(0);
  });

  it('おかしな値は黙って既定に落とさず、エラーにする', () => {
    expect(() => rosterSettingsFromArgv(['--opponents', 'rosterr'])).toThrow('--opponents');
    expect(() => rosterSettingsFromArgv(['--sp-budget', 'たくさん'])).toThrow('--sp-budget');
    expect(() => rosterSettingsFromArgv(['--sp-budget', '-1'])).toThrow('--sp-budget');
    expect(() => rosterSettingsFromArgv(['--unique-level', '7'])).toThrow('--unique-level');
    expect(() => rosterSettingsFromArgv(['--unique-level', '2.5'])).toThrow('--unique-level');
  });
});

describe('名簿の用意', () => {
  const roster = rosterSettingsFromArgv(['--opponents', 'roster']);

  it('順位表が無いコースでは名簿を作らず、理由を返す', () => {
    const prepared = prepareRoster(data, roster, { location: 1, course: 2 });
    expect(prepared.roster).toBeNull();
    expect(prepared.notes.join('\n')).toContain('順位表が無いコース');
  });

  it('notes は作れなかった理由だけを持つ。作れなかったあとの扱いは呼ぶ側が決める', () => {
    // MCP は相手を補わずに出走表の頭だけで回す。notes が「典型スキルの相手で回す」と言うと食い違う。
    const prepared = prepareRoster(data, roster, { location: 1, course: 2 });
    expect(prepared.notes.join('\n')).not.toContain('典型スキル');
    // CLI が足す一文のほうに、典型スキルへ落とすことが書いてある。
    expect(ROSTER_FALLBACK_NOTE).toContain('典型スキルの相手で回す');
  });

  it.skipIf(!hasKyoto)('置いてある表があれば、名簿と順位表ができる', () => {
    const prepared = prepareRoster(data, roster, kyoto);
    expect(prepared.roster).not.toBeNull();
    expect(prepared.roster!.cards.length).toBeGreaterThan(200);
    expect(prepared.roster!.ranking.SEN.length).toBeGreaterThan(100);
  });

  it.skipIf(!hasKyoto)('名簿ファイルがあれば、載っているカードだけに絞って脚質を上書きする', () => {
    const all = prepareRoster(data, roster, kyoto).roster!.cards;
    const picks = all.filter((card) => card.styles.length > 0).slice(0, 2);
    const dir = mkdtempSync(join(tmpdir(), 'roster-file-'));
    try {
      const path = join(dir, 'roster.json');
      writeFileSync(
        path,
        JSON.stringify([
          { cardId: picks[0]!.id, style: 'OI' },
          { cardId: picks[1]!.id, style: '逃げ' },
          { cardId: 999999, style: 'SEN' },
        ]),
      );
      const withFile = rosterSettingsFromArgv(['--opponents', 'roster', '--roster-file', path]);
      const prepared = prepareRoster(data, withFile, kyoto);
      expect(prepared.roster!.cards.map((card) => [card.id, card.styles])).toEqual([
        [picks[0]!.id, ['OI']],
        [picks[1]!.id, ['NIGE']],
      ]);
      expect(prepared.notes.join('\n')).toContain('2 行を読み');

      // 1 枚も読めない名簿ファイルは、黙って全員を典型に落とさず、名簿を作らない。
      writeFileSync(path, 'これは名簿ではない\n');
      const empty = prepareRoster(data, withFile, kyoto);
      expect(empty.roster).toBeNull();
      expect(empty.notes.join('\n')).toContain('1 枚も読めなかった');
      expect(empty.notes.join('\n')).not.toContain('典型スキル');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('名簿ファイルを読めないとき', () => {
  it.skipIf(!hasKyoto)('存在しないパスは、例外のスタックを出さず、理由を返して名簿を作らない', () => {
    const missing = join(tmpdir(), 'raceemu-no-such-dir', 'none.txt');
    const withFile = rosterSettingsFromArgv(['--opponents', 'roster', '--roster-file', missing]);
    const prepared = prepareRoster(data, withFile, kyoto);
    expect(prepared.roster).toBeNull();
    const notes = prepared.notes.join('\n');
    expect(notes).toContain(missing);
    expect(notes).toContain('読めない');
    expect(notes).toContain('ENOENT');
    expect(notes).not.toContain('典型スキル');
  });
});

describe('相手の想定への足し方', () => {
  const base = defaultFieldProfile(9);
  const roster = { cards: [], ranking: { NIGE: [], SEN: [], SASI: [], OI: [] } };

  it('typical か、名簿が作れなかったときは、渡した想定をそのまま返す', () => {
    const typical = rosterSettingsFromArgv([]);
    const wanted = rosterSettingsFromArgv(['--opponents', 'roster']);
    expect(rosterFieldProfile(base, typical, roster)).toBe(base);
    expect(rosterFieldProfile(base, wanted, null)).toBe(base);
    // 既定の想定にキーが増えていない（skill-list の版がこの中身から決まる）。
    expect('opponentModel' in base).toBe(false);
    expect('roster' in base).toBe(false);
  });

  it('roster のときは、元の想定を変えずにキーを足した写しを返す', () => {
    const wanted = rosterSettingsFromArgv(['--opponents', 'roster', '--sp-budget', '5000']);
    const profile = rosterFieldProfile(base, wanted, roster);
    expect(profile.opponentModel).toBe('roster');
    expect(profile.roster?.spBudget).toBe(5000);
    expect('opponentModel' in base).toBe(false);
  });
});

describe('探索の相手の束（searchFieldSpec）', () => {
  const profile = { ...defaultFieldProfile(9), offset: 0 };
  const common = { data, profile, seed: 9001, samples: 64 };
  const tokyo = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
  const hasTokyo = readSkillListCourse(SKILL_LIST_DIR, tokyo.location, tokyo.course) !== null;
  const logged = (): { log: (m: string) => void; lines: string[] } => {
    const lines: string[] = [];
    return { log: (m) => lines.push(m), lines };
  };

  it('typical のときは、名簿の口を足す前と同じ指定を返す（キーも増えない）', () => {
    const { log, lines } = logged();
    const spec = searchFieldSpec({ ...common, settings: rosterSettingsFromArgv([]), useField: true, track: tokyo, log });
    // 束の鍵は指定の JSON。キーが増えると同じ相手が別の束になる。
    expect(JSON.stringify(spec)).toBe(JSON.stringify({ profile, track: tokyo, seed: 9001, samples: 64 }));
    expect(spec).not.toBeNull();
    expect('roster' in spec!).toBe(false);
    expect(lines).toEqual([]);
  });

  it('--field off なら束を作らない。名簿の指定があれば、効かない理由を出す', () => {
    const quiet = logged();
    expect(
      searchFieldSpec({ ...common, settings: rosterSettingsFromArgv([]), useField: false, track: tokyo, log: quiet.log }),
    ).toBeNull();
    expect(quiet.lines).toEqual([]);

    const noisy = logged();
    expect(
      searchFieldSpec({
        ...common,
        settings: rosterSettingsFromArgv(['--opponents', 'roster']),
        useField: false,
        track: tokyo,
        log: noisy.log,
      }),
    ).toBeNull();
    expect(noisy.lines.join('\n')).toContain('--field off');
  });

  it('順位表が無いコースでは、理由と落とし先を出して典型スキルの相手の指定を返す', () => {
    const { log, lines } = logged();
    const track = { location: 1, course: 2, condition: 1, gateCount: 9 } as const;
    const spec = searchFieldSpec({
      ...common,
      settings: rosterSettingsFromArgv(['--opponents', 'roster']),
      useField: true,
      track,
      log,
    });
    expect(JSON.stringify(spec)).toBe(JSON.stringify({ profile, track, seed: 9001, samples: 64 }));
    expect(lines.join('\n')).toContain('順位表が無いコース');
    expect(lines[lines.length - 1]).toBe(ROSTER_FALLBACK_NOTE);
  });

  it.skipIf(!hasTokyo)('名簿が作れれば、想定に名簿の指定を足し、名簿そのものを載せる', () => {
    const { log, lines } = logged();
    const settings = rosterSettingsFromArgv(['--opponents', 'roster'], { spBudget: 600 });
    const spec = searchFieldSpec({ ...common, settings, useField: true, track: tokyo, log });
    expect(spec?.profile.opponentModel).toBe('roster');
    expect(spec?.profile.roster?.spBudget).toBe(600);
    expect(spec?.roster?.cards.length).toBeGreaterThan(200);
    // 渡した想定は変えない
    expect('opponentModel' in profile).toBe(false);
    expect(lines.join('\n')).toContain('SP 予算 600');
    expect(lines).not.toContain(ROSTER_FALLBACK_NOTE);
    expect(rosterOpponentsLine(settings)).toContain('SP 予算 600、自分の予算に揃えた');
    expect(rosterOpponentsLine(rosterSettingsFromArgv(['--sp-budget', '9000']))).not.toContain('揃えた');
  });
});
