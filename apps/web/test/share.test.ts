import { describe, expect, it } from 'vitest';
import {
  decodeShareState,
  defaultShareField,
  defaultShareOptions,
  encodeShareState,
  hashWithTab,
  normalizeGateCount,
  readTabFromHash,
  type ShareState,
} from '../src/share.ts';

/**
 * 共有 URL の書式の検査。
 *
 * 項目は後ろに足していくので、古いリンクを読んだときに足りない項目が
 * 既定で埋まることを見る。既に配ったリンクを壊さないためである。
 */

const base: ShareState = {
  uma: {
    charaName: '',
    speed: 1200,
    stamina: 1000,
    power: 900,
    guts: 600,
    wisdom: 900,
    condition: 'BEST',
    style: 'SEN',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 1,
    gateNumber: 5,
    uniqueLevel: 6,
  },
  track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
  skillIds: ['200331'],
  count: 2000,
  seed: 42,
  options: defaultShareOptions(),
  debuffCounts: {},
  hintLevels: {},
  useField: true,
  field: defaultShareField(),
};

describe('共有 URL', () => {
  it('相手の想定が往復する', () => {
    const field = {
      matchSelf: false,
      offset: -100,
      sigma: 40,
      redrawComposition: false,
      withSkills: true,
    };
    const decoded = decodeShareState(encodeShareState({ ...base, field }));
    expect(decoded?.field).toEqual(field);
  });

  it('既定の相手の想定も往復する', () => {
    const decoded = decodeShareState(encodeShareState(base));
    expect(decoded?.field).toEqual(defaultShareField());
    expect(decoded?.useField).toBe(true);
  });

  it('相手の想定を持たない古いリンクは既定で埋まる', () => {
    // 相手の想定を足す前の書式。実行オプションの列が 5 項目で終わっている。
    const encoded = encodeShareState(base);
    const parts = atob(encoded.replace(/-/g, '+').replace(/_/g, '/')).split('|');
    parts[5] = parts[5]!.split(',').slice(0, 5).join(',');
    const old = btoa(parts.join('|')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = decodeShareState(old);
    expect(decoded).not.toBeNull();
    expect(decoded?.field).toEqual(defaultShareField());
  });
});

/** 符号化した文字列のコースの列だけを書き換える。手で壊したリンクを作るのに使う。 */
function withTrackPart(encoded: string, track: string): string {
  const parts = atob(encoded.replace(/-/g, '+').replace(/_/g, '/')).split('|');
  parts[1] = track;
  return btoa(parts.join('|')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('共有 URL の出走頭数', () => {
  const gateCountOf = (track: string) =>
    decodeShareState(withTrackPart(encodeShareState(base), track))?.track.gateCount;

  it('9 と 12 はそのまま読む', () => {
    expect(gateCountOf('10006,10606,1,9,1,1,1')).toBe(9);
    expect(gateCountOf('10006,10606,1,12,1,1,1')).toBe(12);
  });

  it('19 以上は 18 に丸める。枠番の表の外に出ると Worker が落ちる', () => {
    expect(gateCountOf('10006,10606,1,19,1,1,1')).toBe(18);
    expect(gateCountOf('10006,10606,1,1000,1,1,1')).toBe(18);
  });

  it('0 以下は 1 に丸める', () => {
    expect(gateCountOf('10006,10606,1,0,1,1,1')).toBe(1);
    expect(gateCountOf('10006,10606,1,-3,1,1,1')).toBe(1);
  });

  it('数として読めなければ 9 にする', () => {
    expect(gateCountOf('10006,10606,1,NaN,1,1,1')).toBe(9);
    expect(gateCountOf('10006,10606,1,abc,1,1,1')).toBe(9);
    // 列が途中で切れている。
    expect(gateCountOf('10006,10606,1')).toBe(9);
  });

  it('小数は整数に丸める', () => {
    expect(gateCountOf('10006,10606,1,11.6,1,1,1')).toBe(12);
  });
});

describe('出走頭数の丸め', () => {
  it('整数の 1 から 18 に収める', () => {
    expect(normalizeGateCount(9)).toBe(9);
    expect(normalizeGateCount(18)).toBe(18);
    expect(normalizeGateCount(19)).toBe(18);
    expect(normalizeGateCount(1)).toBe(1);
    expect(normalizeGateCount(0)).toBe(1);
    expect(normalizeGateCount(8.5)).toBe(9);
  });

  it('数でないものは 9 にする', () => {
    expect(normalizeGateCount(Number.NaN)).toBe(9);
    expect(normalizeGateCount(Number.POSITIVE_INFINITY)).toBe(9);
    expect(normalizeGateCount('12')).toBe(9);
    expect(normalizeGateCount(undefined)).toBe(9);
    expect(normalizeGateCount(null)).toBe(9);
  });
});

describe('ハッシュに載せる面', () => {
  it('書いて読み直せる', () => {
    expect(readTabFromHash(hashWithTab('', 'solve'))).toBe('solve');
  });

  it('書いていなければ null', () => {
    expect(readTabFromHash('')).toBeNull();
    expect(readTabFromHash('#s=abc')).toBeNull();
  });

  it('設定と同居できる', () => {
    const hash = hashWithTab('#s=abc', 'field');
    expect(readTabFromHash(hash)).toBe('field');
    // 設定の読み取りは元から `&` 区切りを受けるので、既に配ったリンクが壊れない。
    expect(/[#&]s=([^&]+)/.exec(hash)?.[1]).toBe('abc');
  });

  it('面だけを差し替え、ほかの鍵は残す', () => {
    const hash = hashWithTab(hashWithTab('#s=abc', 'solve'), 'compare');
    expect(readTabFromHash(hash)).toBe('compare');
    expect(/[#&]s=([^&]+)/.exec(hash)?.[1]).toBe('abc');
    expect(hash.split('&').filter((part) => part.includes('tab='))).toHaveLength(1);
  });

  it('面を先に置く。設定は長いので後ろだと人の目に入らない。', () => {
    expect(hashWithTab('#s=abc', 'detail').startsWith('#tab=detail')).toBe(true);
  });

  it('先頭の # が無いハッシュも受ける', () => {
    expect(readTabFromHash(hashWithTab('s=abc', 'summary'))).toBe('summary');
  });
});
