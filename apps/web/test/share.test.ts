import { describe, expect, it } from 'vitest';
import {
  decodeShareState,
  defaultShareField,
  defaultShareOptions,
  encodeShareState,
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
