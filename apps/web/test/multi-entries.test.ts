import { beforeEach, describe, expect, it } from 'vitest';
import { defaultFieldProfile } from '../../../packages/sim/src/field/field.ts';
import type { Style } from '../../../packages/sim/src/data/constants.ts';
import type { UmaStatus } from '../../../packages/sim/src/setting.ts';
import { entryLabel, shortCharaName } from '../src/skills.ts';
import {
  DEFAULT_MULTI_GATE_COUNT,
  defaultOpponents,
  estimateMulti,
  fitOpponents,
  multiEntriesOf,
  normalizeMultiGateCount,
  useStore,
  visibleOpponents,
  type Opponent,
  type Snapshot,
} from '../src/store.ts';

/**
 * 勝率の面の状態の検査。
 *
 * 出走頭数はコースの欄とは別に 2 から 18 で持ち、相手は頭数を減らしても消さずに
 * 覚えておく。ここが崩れると、頭数を触っただけで相手の編集が黙って消える。
 */

const SPE = '[スペシャルドリーマー]スペシャルウィーク';
const SUZUKA = '[サイレントイノセンス]サイレンススズカ';
/** シューティングスター。スペの固有。 */
const UNIQUE_SPE = '100011';
const UNIQUE_SUZUKA = '100021';
/** 右回り○ と 右回りの鬼。同じグループの下位と上位で、固有でも進化でもない。 */
const MINOR = '200012';
const MAJOR = '200014';

const STYLES: readonly Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];

/** 既定の相手のステータス（`defaultFieldProfile` の基準）。脚質だけが頭ごとに違う。 */
const DEFAULT_UMA: Omit<UmaStatus, 'style'> = {
  charaName: '',
  speed: 1100,
  stamina: 900,
  power: 900,
  guts: 600,
  wisdom: 900,
  condition: 'BEST',
  distanceFit: 'A',
  surfaceFit: 'A',
  styleFit: 'A',
  popularity: 5,
  gateNumber: 0,
  uniqueLevel: 6,
};

function stylesOf(opponents: readonly Opponent[]): Style[] {
  return opponents.map((opponent) => opponent.uma.style);
}

function countsOf(opponents: readonly Opponent[]): Record<string, number> {
  const counts: Record<string, number> = { NIGE: 0, SEN: 0, SASI: 0, OI: 0 };
  for (const opponent of opponents) counts[opponent.uma.style] = (counts[opponent.uma.style] ?? 0) + 1;
  return counts;
}

/** 既定のままの相手。`edited` を渡すと手を入れた相手にする。 */
function opponentOf(id: number, style: Style, patch: Partial<UmaStatus> = {}, edited = false): Opponent {
  const opponent: Opponent = { id, uma: { ...DEFAULT_UMA, style, ...patch }, skillIds: [] };
  return edited ? { ...opponent, edited: true } : opponent;
}

/** 手を入れた相手にする。store の 4 つの経路と同じく印を立てる。 */
function edit(opponent: Opponent, patch: Partial<UmaStatus> = {}, skillIds = opponent.skillIds): Opponent {
  return { ...opponent, uma: { ...opponent.uma, ...patch }, skillIds, edited: true };
}

/** 頭数の既定の構成。脚質ごとの頭数。 */
function targetOf(gateCount: number): Record<string, number> {
  const counts = defaultFieldProfile(gateCount).counts;
  return { NIGE: counts.NIGE, SEN: counts.SEN, SASI: counts.SASI, OI: counts.OI };
}

/** 走らせる範囲の、手を入れた相手が既定の構成を超えていないか。 */
function editedWithinTarget(opponents: readonly Opponent[], gateCount: number): boolean {
  const target = targetOf(gateCount);
  const edited = countsOf(visibleOpponents(opponents, gateCount).filter((o) => o.edited));
  return STYLES.every((style) => edited[style]! <= target[style]!);
}

/** 試験の手順を決めるための、種から決まる乱数。 */
function rngOf(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
}

describe('相手の既定', () => {
  it('9 頭の既定は変わらない', () => {
    // 変更前の `defaultOpponents(9)` の戻り値をそのまま書いて固定する。
    // 手を入れた印の項目が紛れ込んでも気付けるよう、項目の有無まで見る。
    const expected: Opponent[] = (['NIGE', 'NIGE', 'SEN', 'SEN', 'SASI', 'SASI', 'OI', 'OI'] as const).map(
      (style, i) => opponentOf(i + 1, style),
    );
    expect(defaultOpponents(9)).toStrictEqual(expected);
  });

  it('12 頭の既定は変わらない', () => {
    const styles: Style[] = ['NIGE', 'NIGE', 'SEN', 'SEN', 'SEN', 'SASI', 'SASI', 'SASI', 'OI', 'OI', 'OI'];
    expect(defaultOpponents(12)).toStrictEqual(styles.map((style, i) => opponentOf(i + 1, style)));
  });

  it('2 から 18 頭のどれでも、相手は頭数から自分を引いた数で、構成は既定そのものになる', () => {
    for (let gateCount = 2; gateCount <= 18; gateCount++) {
      const opponents = defaultOpponents(gateCount);
      expect(opponents, `${gateCount} 頭`).toHaveLength(gateCount - 1);
      expect(opponents.map((o) => o.id)).toEqual([...Array(gateCount - 1).keys()].map((i) => i + 1));
      expect(countsOf(opponents), `${gateCount} 頭`).toEqual(targetOf(gateCount));
      // 既定の相手は手を入れた印を持たない（項目ごと無い）。
      for (const opponent of opponents) expect('edited' in opponent).toBe(false);
    }
  });

  it('脚質は逃げ、先行、差し、追込の順に並ぶ', () => {
    const order = stylesOf(defaultOpponents(18)).map((style) => STYLES.indexOf(style));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('相手の数合わせ', () => {
  it('変わるところが無ければ受け取った配列をそのまま返す', () => {
    const opponents = defaultOpponents(12);
    expect(fitOpponents(opponents, 12)).toBe(opponents);
    // 同じ頭数でもう一度合わせても変わらない。
    const edited = [opponentOf(1, 'OI', {}, true), ...defaultOpponents(18).slice(1)];
    const once = fitOpponents(edited, 7);
    expect(once).not.toBe(edited);
    expect(fitOpponents(once, 7)).toBe(once);
  });

  it('減らすと、走らせる相手はその頭数の既定に作り直し、隠れた既定のままの相手は捨てる', () => {
    // 18 頭の既定の先頭 8 頭は 3-5-0-0 に偏る。先頭を取るだけでは 9 頭の既定にならない。
    expect(fitOpponents(defaultOpponents(18), 9)).toStrictEqual(defaultOpponents(9));
    expect(fitOpponents(defaultOpponents(18), 5)).toStrictEqual(defaultOpponents(5));
    expect(fitOpponents(defaultOpponents(12), 9)).toStrictEqual(defaultOpponents(9));
    expect(fitOpponents(defaultOpponents(18), 2)).toStrictEqual(defaultOpponents(2));
  });

  it('増やすときは、手を入れた相手の添字を保ち、ほかの枠を既定の構成に合わせる', () => {
    const before = defaultOpponents(9);
    const edited = before.map((o) => (o.id === 3 ? edit(o, { speed: 1500 }, [MAJOR]) : o));
    const fitted = fitOpponents(edited, 12);
    expect(fitted).toHaveLength(11);
    expect(fitted[2]).toBe(edited[2]);
    // 12 頭の既定（2-3-3-3）から、手を入れた先行 1 頭を引いた残りを脚質の順に配る。
    expect(stylesOf(fitted)).toEqual(stylesOf(defaultOpponents(12)));
    expect(countsOf(fitted)).toEqual({ NIGE: 2, SEN: 3, SASI: 3, OI: 3 });
    // id は枠にいた相手のものを使い回し、新しい枠は続きから振る。
    expect(fitted.map((o) => o.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // 中身が変わらない枠は前の相手をそのまま使う。脚質が変わる枠だけを作り直す。
    expect(fitted[0]).toBe(edited[0]);
    expect(fitted[1]).toBe(edited[1]);
    expect(fitted[3]).toBe(edited[3]);
    expect(fitted[4]).not.toBe(edited[4]);
    expect(fitted[4]!.uma.style).toBe('SEN');
    expect('edited' in fitted[4]!).toBe(false);
  });

  it('手を入れた相手の分を引いた不足を、逃げ、先行、差し、追込の順に埋める', () => {
    // 手を入れた逃げが既定より多い。9 頭の既定は 2-2-2-2 なので、不足は先行・差し・追込が 2 ずつで、
    // 枠は 5 つしかない。追込の側から切れる。
    const current = [opponentOf(1, 'NIGE', {}, true), opponentOf(2, 'NIGE', {}, true), opponentOf(3, 'NIGE', {}, true)];
    const fitted = fitOpponents(current, 9);
    expect(fitted.slice(0, 3)).toEqual(current);
    expect(stylesOf(fitted.slice(3))).toEqual(['SEN', 'SEN', 'SASI', 'SASI', 'OI']);
  });

  it('手を入れた相手が途中にいても、ほかの枠を添字の若い順に埋める', () => {
    // 12 頭の既定の添字 1 と 7 を追込に変えてから 13 頭にする。13 頭の既定 2-4-4-2 から
    // 手を入れた追込 2 を引いた 2-4-4-0 を、残りの 10 枠に添字の若い順に配る。
    const opponents = defaultOpponents(12).map((o, i) =>
      i === 1 || i === 7 ? edit(o, { style: 'OI' }) : o,
    );
    const fitted = fitOpponents(opponents, 13);
    expect(stylesOf(fitted)).toEqual(['NIGE', 'OI', 'NIGE', 'SEN', 'SEN', 'SEN', 'SEN', 'OI', 'SASI', 'SASI', 'SASI', 'SASI']);
    expect(countsOf(fitted)).toEqual(targetOf(13));
  });

  it('新しい id は覚えている相手の最大の続きから振る', () => {
    const current = [opponentOf(5, 'SEN'), opponentOf(2, 'SASI'), opponentOf(9, 'OI')];
    const fitted = fitOpponents(current, 9);
    expect(fitted.map((o) => o.id)).toEqual([5, 2, 9, 10, 11, 12, 13, 14]);
    expect(stylesOf(fitted)).toEqual(stylesOf(defaultOpponents(9)));
    // 隠れた相手の id も数に入れる。
    const hidden = [...defaultOpponents(9), opponentOf(30, 'OI', {}, true)];
    const grown = fitOpponents(hidden, 12);
    expect(grown[8]).toBe(hidden[8]);
    expect(grown.map((o) => o.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 30, 31, 32]);
  });

  it('減らしてから増やし直すと、隠していた手を入れた相手が元の添字に戻る', () => {
    const edited = defaultOpponents(18).map((o) => (o.id === 15 ? edit(o, { charaName: SPE }) : o));
    const shrunk = fitOpponents(edited, 5);
    // 走らせる相手は 5 頭の既定に作り直す。
    expect(visibleOpponents(shrunk, 5)).toStrictEqual(defaultOpponents(5));
    // 隠れた範囲は、手を入れた相手（添字 14）までを残す。間の相手は添字を保つためのつなぎ。
    expect(shrunk).toHaveLength(15);
    expect(shrunk[14]).toBe(edited[14]);
    // 増やし直すと同じ相手が同じ添字に戻り、ほかは 18 頭の既定の構成になる。
    const grown = fitOpponents(shrunk, 18);
    expect(grown[14]).toBe(edited[14]);
    expect(grown[14]!.uma.charaName).toBe(SPE);
    expect(stylesOf(grown)).toEqual(stylesOf(defaultOpponents(18)));
    expect(grown.map((o) => o.id)).toEqual([...Array(17).keys()].map((i) => i + 1));
  });

  it('手を入れていなければ、1 頭ずつ増やしても減らしても既定のまま', () => {
    let opponents: readonly Opponent[] = [];
    const counts = [...Array(17).keys()].map((i) => i + 2);
    for (const gateCount of [...counts, ...[...counts].reverse()]) {
      opponents = fitOpponents(opponents, gateCount);
      expect(opponents, `${gateCount} 頭`).toStrictEqual(defaultOpponents(gateCount));
    }
  });

  it('手を入れた相手が既定の構成を超えなければ、走らせる相手の構成は既定に一致する', () => {
    const next = rngOf(20260926);
    for (let round = 0; round < 200; round++) {
      // 18 頭の既定に、ばらばらの添字と脚質で手を入れる。隠れる添字にも入れる。
      let opponents: readonly Opponent[] = defaultOpponents(18);
      const edits = next(6);
      for (let k = 0; k < edits; k++) {
        const index = next(17);
        opponents = opponents.map((o, i) => (i === index ? edit(o, { style: STYLES[next(4)]! }) : o));
      }
      const gateCount = 2 + next(17);
      const fitted = fitOpponents(opponents, gateCount);
      const visible = visibleOpponents(fitted, gateCount);
      expect(visible).toHaveLength(gateCount - 1);
      // 手を入れた相手はどれも同じ添字にいる。隠れたものも消えない。
      opponents.forEach((o, i) => {
        if (o.edited) expect(fitted[i], `添字 ${i}`).toBe(o);
      });
      expect(new Set(fitted.map((o) => o.id)).size).toBe(fitted.length);
      if (editedWithinTarget(opponents, gateCount)) {
        expect(countsOf(visible), `${gateCount} 頭`).toEqual(targetOf(gateCount));
      }
    }
  });

  it('頭数は 2 から 18 に丸めてから合わせる', () => {
    expect(fitOpponents([], 1)).toHaveLength(1);
    expect(fitOpponents([], 30)).toHaveLength(17);
    expect(visibleOpponents(defaultOpponents(18), 40)).toHaveLength(17);
    expect(visibleOpponents(defaultOpponents(18), 0)).toHaveLength(1);
  });
});

describe('勝率の面の出走頭数', () => {
  beforeEach(() => {
    useStore.setState({
      multiGateCount: DEFAULT_MULTI_GATE_COUNT,
      opponents: defaultOpponents(DEFAULT_MULTI_GATE_COUNT),
      track: { location: 10006, course: 10606, condition: 1, gateCount: 9, season: 1, weather: 1, time: 1 },
    });
  });

  it('既定は 9 頭で、相手 8 頭を最初から持つ', () => {
    expect(useStore.getState().multiGateCount).toBe(9);
    expect(useStore.getState().opponents).toHaveLength(8);
  });

  it('整数の 2 から 18 に丸める', () => {
    expect(normalizeMultiGateCount(1)).toBe(2);
    expect(normalizeMultiGateCount(19)).toBe(18);
    expect(normalizeMultiGateCount(11.5)).toBe(12);
    expect(normalizeMultiGateCount(Number.NaN)).toBe(9);
    expect(normalizeMultiGateCount(Number.NaN, 5)).toBe(5);

    const { setMultiGateCount } = useStore.getState();
    setMultiGateCount(18.4);
    expect(useStore.getState().multiGateCount).toBe(18);
    setMultiGateCount(0);
    expect(useStore.getState().multiGateCount).toBe(2);
    // 読めない値では今の頭数を変えない。
    setMultiGateCount(Number.NaN);
    expect(useStore.getState().multiGateCount).toBe(2);
  });

  it('増やすと相手を足し、減らしても消さない', () => {
    const { setMultiGateCount, setOpponent } = useStore.getState();
    setMultiGateCount(18);
    expect(useStore.getState().opponents).toHaveLength(17);
    setOpponent(17, { speed: 1400 });
    setMultiGateCount(3);
    expect(useStore.getState().opponents).toHaveLength(17);
    setMultiGateCount(18);
    expect(useStore.getState().opponents.find((o) => o.id === 17)?.uma.speed).toBe(1400);
  });

  it('コースの欄の頭数は動かさない', () => {
    useStore.getState().setMultiGateCount(14);
    expect(useStore.getState().track.gateCount).toBe(9);
  });

  it('相手の初期化は、いまの頭数の既定で全部作り直す', () => {
    const { setMultiGateCount, setOpponent, resetOpponents } = useStore.getState();
    setMultiGateCount(18);
    setOpponent(17, { speed: 1400 });
    setMultiGateCount(5);
    // 手を入れた相手が隠れていても、初期化すると消える。
    expect(useStore.getState().opponents).toHaveLength(17);
    resetOpponents();
    expect(useStore.getState().opponents).toStrictEqual(defaultOpponents(5));
    setMultiGateCount(18);
    expect(useStore.getState().opponents).toStrictEqual(defaultOpponents(18));
  });

  // 以下の 3 件は、誰も相手に手を入れていないのに既定と違う構成で走っていた手順である。
  // 既定の相手は脚質の順に並ぶので、大きい頭数の先頭を取ると逃げと先行に偏っていた。
  it('手を入れていなければ、9 → 18 → 12 で 12 頭の既定になる', () => {
    const { setMultiGateCount } = useStore.getState();
    setMultiGateCount(18);
    setMultiGateCount(12);
    expect(useStore.getState().opponents).toStrictEqual(defaultOpponents(12));
  });

  it('12 頭で初期化してから 9 頭にすると 9 頭の既定になる', () => {
    const { setMultiGateCount, resetOpponents } = useStore.getState();
    setMultiGateCount(12);
    resetOpponents();
    setMultiGateCount(9);
    expect(useStore.getState().opponents).toStrictEqual(defaultOpponents(9));
  });

  it('18 頭で初期化してから 9 頭、5 頭にすると、それぞれの既定になる', () => {
    const { setMultiGateCount, resetOpponents } = useStore.getState();
    setMultiGateCount(18);
    resetOpponents();
    setMultiGateCount(9);
    expect(useStore.getState().opponents).toStrictEqual(defaultOpponents(9));
    setMultiGateCount(5);
    expect(useStore.getState().opponents).toStrictEqual(defaultOpponents(5));
  });

  it('18 頭で 17 番目の相手だけに手を入れ、9 頭にしてから 18 頭に戻すと、同じ添字に戻る', () => {
    const { setMultiGateCount, setOpponent } = useStore.getState();
    setMultiGateCount(18);
    const target = useStore.getState().opponents[16]!;
    setOpponent(target.id, { speed: 1400, style: 'NIGE' });
    const edited = useStore.getState().opponents[16]!;
    setMultiGateCount(9);
    // 9 頭では走らせる 8 頭が既定に作り直され、手を入れた相手は隠れて残る。
    expect(visibleOpponents(useStore.getState().opponents, 9)).toStrictEqual(defaultOpponents(9));
    expect(useStore.getState().opponents[16]).toBe(edited);
    setMultiGateCount(18);
    const opponents = useStore.getState().opponents;
    expect(opponents).toHaveLength(17);
    expect(opponents[16]).toBe(edited);
    expect(opponents[16]!.uma.speed).toBe(1400);
    // ほかの 16 頭は、18 頭の既定 3-5-5-4 から手を入れた逃げ 1 頭を引いた 2-5-5-4 になる。
    expect(countsOf(opponents)).toEqual(targetOf(18));
    expect(countsOf(opponents.slice(0, 16))).toEqual({ NIGE: 2, SEN: 5, SASI: 5, OI: 4 });
  });

  it('同じ頭数を選び直しても、相手には触らない', () => {
    const { setMultiGateCount, setOpponent } = useStore.getState();
    // 手を入れると構成が既定からずれる。同じ頭数で合わせ直すと、ほかの相手が組み替わってしまう。
    setOpponent(1, { style: 'OI' });
    const before = useStore.getState().opponents;
    setMultiGateCount(9);
    setMultiGateCount(9.2);
    expect(useStore.getState().opponents).toBe(before);
  });

  it('手を入れる 4 つの経路は、どれも手を入れた印を立てる', () => {
    const state = useStore.getState();
    state.setOpponent(1, { speed: 1200 });
    state.toggleOpponentSkill(2, MAJOR);
    state.setOpponentChara(3, SPE);
    state.setOpponentFromIndividual(4, {
      id: 'x',
      label: 'x',
      uma: { ...DEFAULT_UMA, style: 'OI' },
      skillIds: [],
      createdAt: '2026-09-01T00:00:00Z',
    });
    const opponents = useStore.getState().opponents;
    expect(opponents.slice(0, 4).map((o) => o.edited)).toEqual([true, true, true, true]);
    for (const opponent of opponents.slice(4)) expect('edited' in opponent).toBe(false);
  });

  it('どんな順に頭数を変えても、手を入れていなければ既定のまま', () => {
    const next = rngOf(9);
    const { setMultiGateCount, resetOpponents } = useStore.getState();
    for (let step = 0; step < 300; step++) {
      if (next(8) === 0) resetOpponents();
      else setMultiGateCount(2 + next(17));
      const { opponents, multiGateCount } = useStore.getState();
      expect(opponents, `${step} 手目、${multiGateCount} 頭`).toStrictEqual(defaultOpponents(multiGateCount));
    }
  });

  it('どんな順に頭数を変えても、手を入れた相手の添字は変わらない', () => {
    const next = rngOf(118);
    const store = useStore.getState();
    /** 手を入れた相手の id から、手を入れたときの添字。 */
    const indexOf = new Map<number, number>();
    for (let step = 0; step < 400; step++) {
      const { opponents, multiGateCount } = useStore.getState();
      const op = next(10);
      if (op < 5) {
        store.setMultiGateCount(2 + next(17));
      } else if (op === 9) {
        store.resetOpponents();
        indexOf.clear();
      } else {
        // 走らせる範囲の相手に、4 つの経路のどれかで手を入れる。
        const index = next(multiGateCount - 1);
        const { id } = opponents[index]!;
        if (op === 5) store.setOpponent(id, { style: STYLES[next(4)]!, speed: 1000 + next(500) });
        else if (op === 6) store.toggleOpponentSkill(id, MAJOR);
        else if (op === 7) store.setOpponentChara(id, next(2) === 0 ? SPE : SUZUKA);
        else
          store.setOpponentFromIndividual(id, {
            id: String(step),
            label: 'x',
            uma: { ...DEFAULT_UMA, style: STYLES[next(4)]! },
            skillIds: [],
            createdAt: '2026-09-01T00:00:00Z',
          });
        if (!indexOf.has(id)) indexOf.set(id, index);
      }
      const after = useStore.getState();
      expect(after.opponents.length).toBeGreaterThanOrEqual(after.multiGateCount - 1);
      expect(new Set(after.opponents.map((o) => o.id)).size).toBe(after.opponents.length);
      for (const [id, index] of indexOf) {
        expect(after.opponents[index]?.id, `${step} 手目、id ${id}`).toBe(id);
        expect(after.opponents[index]?.edited).toBe(true);
      }
      expect(after.opponents.filter((o) => o.edited)).toHaveLength(indexOf.size);
      // 頭数を変えた直後は、手を入れた相手が既定を超えない限り、走らせる相手の構成が既定に一致する。
      if (op < 5 && after.multiGateCount !== multiGateCount && editedWithinTarget(after.opponents, after.multiGateCount)) {
        expect(countsOf(visibleOpponents(after.opponents, after.multiGateCount))).toEqual(
          targetOf(after.multiGateCount),
        );
      }
    }
  });

  it('見積もりは勝率の面の頭数で出す', () => {
    const at = (multiGateCount: number) =>
      estimateMulti({ pace: {}, multiGateCount, multiTrials: 1100 }).ms -
      estimateMulti({ pace: {}, multiGateCount, multiTrials: 100 }).ms;
    expect(at(18) / at(9)).toBeCloseTo(2);
    expect(at(2) / at(9)).toBeCloseTo(2 / 9);
    // 範囲の外は丸めてから見積もる。
    expect(at(40)).toBeCloseTo(at(18));
  });
});

describe('コースの頭数の検証', () => {
  beforeEach(() => {
    useStore.setState({
      track: { location: 10006, course: 10606, condition: 1, gateCount: 9, season: 1, weather: 1, time: 1 },
    });
  });

  it('setTrack は 1 から 18 に丸め、読めなければ 9 にする', () => {
    const { setTrack } = useStore.getState();
    setTrack({ gateCount: 30 });
    expect(useStore.getState().track.gateCount).toBe(18);
    setTrack({ gateCount: Number.NaN });
    expect(useStore.getState().track.gateCount).toBe(9);
    setTrack({ gateCount: 12 });
    expect(useStore.getState().track.gateCount).toBe(12);
  });

  it('スナップショットの復元でも丸める', () => {
    const state = useStore.getState();
    const broken = {
      id: 1,
      label: '#1',
      uma: state.uma,
      track: { ...state.track, gateCount: 25 },
      skillIds: [],
      options: state.options,
      debuffCounts: {},
    } as unknown as Snapshot;
    useStore.setState({ snapshots: [broken] });
    state.restoreSnapshot(1);
    expect(useStore.getState().track.gateCount).toBe(18);
    useStore.setState({ snapshots: [] });
  });
});

describe('相手のキャラ', () => {
  beforeEach(() => {
    useStore.setState({ multiGateCount: 9, opponents: defaultOpponents(9) });
  });

  it('キャラを選ぶと固有が入り、選び直すと入れ替わる', () => {
    const { setOpponentChara, toggleOpponentSkill } = useStore.getState();
    toggleOpponentSkill(2, MAJOR);
    setOpponentChara(2, SPE);
    let opponent = useStore.getState().opponents.find((o) => o.id === 2)!;
    expect(opponent.uma.charaName).toBe(SPE);
    expect(opponent.skillIds).toEqual([MAJOR, UNIQUE_SPE]);
    setOpponentChara(2, SUZUKA);
    opponent = useStore.getState().opponents.find((o) => o.id === 2)!;
    expect(opponent.uma.charaName).toBe(SUZUKA);
    expect(opponent.skillIds).toEqual([MAJOR, UNIQUE_SUZUKA]);
    // ほかの相手には触らない。
    expect(useStore.getState().opponents.find((o) => o.id === 1)!.uma.charaName).toBe('');
  });

  it('スキルの持ち替えは自分と同じ規則に従う', () => {
    const { toggleOpponentSkill } = useStore.getState();
    const skillsOf = () => useStore.getState().opponents.find((o) => o.id === 4)!.skillIds;
    // 右回り○ と 右回りの鬼は同じグループなので、後から入れたほうだけが残る。
    toggleOpponentSkill(4, MINOR);
    toggleOpponentSkill(4, MAJOR);
    expect(skillsOf()).toEqual([MAJOR]);
    toggleOpponentSkill(4, MAJOR);
    expect(skillsOf()).toEqual([]);
  });

  it('固有 Lv は setOpponent で変える', () => {
    useStore.getState().setOpponent(1, { uniqueLevel: 4 });
    expect(useStore.getState().opponents.find((o) => o.id === 1)!.uma.uniqueLevel).toBe(4);
  });

  it('キャラ名の無い個体は、持っている固有からキャラを補う', () => {
    const uma: UmaStatus = { ...DEFAULT_UMA, style: 'SASI' };
    useStore.getState().setOpponentFromIndividual(3, {
      id: 'a',
      label: '差し 1100/900/900/600/900',
      uma,
      skillIds: [MAJOR, UNIQUE_SPE],
      createdAt: '2026-09-01T00:00:00Z',
    });
    const opponent = useStore.getState().opponents.find((o) => o.id === 3)!;
    expect(opponent.uma.charaName).toBe(SPE);
    expect(opponent.uma.style).toBe('SASI');
    expect(opponent.skillIds).toEqual([MAJOR, UNIQUE_SPE]);
  });

  it('キャラ名のある個体はそのまま使う', () => {
    const uma: UmaStatus = { ...DEFAULT_UMA, charaName: SUZUKA, style: 'NIGE' };
    useStore.getState().setOpponentFromIndividual(3, {
      id: 'b',
      label: 'x',
      uma,
      skillIds: [MAJOR],
      createdAt: '2026-09-01T00:00:00Z',
    });
    expect(useStore.getState().opponents.find((o) => o.id === 3)!.uma.charaName).toBe(SUZUKA);
  });
});

describe('呼び名', () => {
  it('勝負服を落とす', () => {
    expect(shortCharaName(SPE)).toBe('スペシャルウィーク');
    expect(shortCharaName('スペシャルウィーク')).toBe('スペシャルウィーク');
    expect(shortCharaName('')).toBe('');
  });

  it('自分は「自分」、名前があれば添える', () => {
    expect(entryLabel(0, '')).toBe('自分');
    expect(entryLabel(0, SPE)).toBe('自分（スペシャルウィーク）');
  });

  it('相手は名前、無ければ出走の番号', () => {
    expect(entryLabel(1, '')).toBe('2 番');
    expect(entryLabel(17, '')).toBe('18 番');
    expect(entryLabel(3, SUZUKA)).toBe('サイレンススズカ');
  });
});

describe('全頭同時の出走の並び', () => {
  const base = () => useStore.getState();

  it('全頭の頭数を勝率の面の値にする。コースの欄の頭数は使わない', () => {
    const state = { ...base(), track: { ...base().track, gateCount: 9 }, multiGateCount: 18 };
    const { settings, names, opponents, gateCount } = multiEntriesOf(state);
    expect(gateCount).toBe(18);
    expect(settings).toHaveLength(18);
    expect(names).toHaveLength(18);
    expect(opponents).toHaveLength(17);
    for (const setting of settings) expect(setting.track.gateCount).toBe(18);
    // 自分の設定の元の値は書き換えない。
    expect(state.track.gateCount).toBe(9);
  });

  it('12 頭のコースでも、勝率の面が 9 頭なら 9 頭で走らせる', () => {
    const state = { ...base(), track: { ...base().track, gateCount: 12 }, multiGateCount: 9 };
    const { settings } = multiEntriesOf(state);
    expect(settings).toHaveLength(9);
    for (const setting of settings) expect(setting.track.gateCount).toBe(9);
  });

  it('覚えている相手が多ければ先頭から頭数ぶんだけを走らせ、覚えている相手は変えない', () => {
    const remembered = defaultOpponents(18);
    const state = { ...base(), opponents: remembered, multiGateCount: 2 };
    const { settings, opponents } = multiEntriesOf(state);
    expect(settings).toHaveLength(2);
    expect(settings[1]!.uma).toBe(remembered[0]!.uma);
    expect(opponents).toBe(remembered);
  });

  it('同じ頭数のまま手を入れても、走らせるときにほかの相手を組み替えない', () => {
    // 逃げを追込に変えると構成は既定からずれる。出走表に見えている顔ぶれのまま走らせる。
    const shown = defaultOpponents(9).map((o, i) => (i === 0 ? edit(o, { style: 'OI' }) : o));
    const state = { ...base(), opponents: shown, multiGateCount: 9 };
    const { settings, opponents } = multiEntriesOf(state);
    expect(opponents).toBe(shown);
    expect(settings.slice(1).map((setting) => setting.uma)).toEqual(shown.map((o) => o.uma));
  });

  it('覚えている相手が足りないときだけ、既定の相手で埋める', () => {
    const state = { ...base(), opponents: [] as Opponent[], multiGateCount: 12 };
    const { settings, opponents } = multiEntriesOf(state);
    expect(opponents).toStrictEqual(defaultOpponents(12));
    expect(settings).toHaveLength(12);
  });

  it('既定の 9 頭では、自分と相手の設定が今までと同じ形になる', () => {
    const state = { ...base(), opponents: defaultOpponents(9), multiGateCount: 9 };
    const { settings } = multiEntriesOf(state);
    expect(settings[0]!.uma).toBe(state.uma);
    expect(settings[0]!.track).toEqual({ ...state.track, gateCount: 9 });
    for (let i = 1; i < settings.length; i++) {
      expect(settings[i]!.uma).toBe(state.opponents[i - 1]!.uma);
      expect(settings[i]!.skills).toEqual([]);
      expect(settings[i]!.track).toEqual(settings[0]!.track);
      expect(settings[i]!.positionKeepMode).toBe(settings[0]!.positionKeepMode);
      expect(settings[i]!.debuffCounts).toBe(settings[0]!.debuffCounts);
    }
  });

  it('呼び名は走らせたときのキャラから作る', () => {
    const opponents = defaultOpponents(4).map((o) =>
      o.id === 1 ? { ...o, uma: { ...o.uma, charaName: SPE } } : o,
    );
    const state = {
      ...base(),
      uma: { ...base().uma, charaName: SUZUKA },
      opponents,
      multiGateCount: 4,
    };
    expect(multiEntriesOf(state).names).toEqual(['自分（サイレンススズカ）', 'スペシャルウィーク', '3 番', '4 番']);
  });
});
