/**
 * シード付き乱数と、用途ごとのストリーム分離。
 *
 * 単一の乱数列を頭から消費すると、スキルを1つ足しただけで以降の乱数が
 * すべてずれ、2つの設定を同じ乱数で比較できなくなる。用途ごとに独立した
 * ストリームを持ち、種を (baseSeed, trial, streamKey) から導くことで、
 * ある乱数源の消費が他に影響しないようにする。
 * docs/solver-design.md 1.1 節を参照。
 */

export interface Rng {
  nextDouble(): number;
  /** [0, max) の実数 */
  nextDoubleMax(max: number): number;
  /** [min, max) の実数 */
  nextDoubleRange(min: number, max: number): number;
  /** [0, maxExclusive) の整数 */
  nextInt(maxExclusive: number): number;
  /** [min, max] の整数 */
  nextIntRange(min: number, max: number): number;
  pick<T>(items: readonly T[]): T | undefined;
  shuffled<T>(items: readonly T[]): T[];
}

/** 32bit FNV-1a。ストリーム名から種を導くのに使う。 */
function hashString(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** sfc32。状態が小さく、生成が速い。 */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return function next(): number {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    d = (d + 1) >>> 0;
    t = (t + d) >>> 0;
    c = (c + t) >>> 0;
    return (t >>> 0) / 4294967296;
  };
}

class StreamRng implements Rng {
  private readonly next: () => number;

  constructor(s0: number, s1: number, s2: number, s3: number) {
    this.next = sfc32(s0, s1, s2, s3);
    // 初期状態の偏りを流す
    for (let i = 0; i < 12; i++) this.next();
  }

  nextDouble(): number {
    return this.next();
  }

  nextDoubleMax(max: number): number {
    return this.next() * max;
  }

  nextDoubleRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  nextIntRange(min: number, max: number): number {
    return min + this.nextInt(max - min + 1);
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.nextInt(items.length)];
  }

  shuffled<T>(items: readonly T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = result[i]!;
      result[i] = result[j]!;
      result[j] = tmp;
    }
    return result;
  }
}

/** 常に中央値を返す決定論的な乱数。乱数固定モードで使う。 */
class FixedRng implements Rng {
  nextDouble(): number {
    return 0.5;
  }
  nextDoubleMax(max: number): number {
    return 0.5 * max;
  }
  nextDoubleRange(min: number, max: number): number {
    return (min + max) / 2;
  }
  nextInt(maxExclusive: number): number {
    return Math.floor(maxExclusive / 2);
  }
  nextIntRange(min: number, max: number): number {
    return Math.floor((min + max) / 2);
  }
  pick<T>(items: readonly T[]): T | undefined {
    return items[Math.floor(items.length / 2)];
  }
  shuffled<T>(items: readonly T[]): T[] {
    return items.slice();
  }
}

/**
 * 1試行ぶんの乱数一式。ストリーム名で引くと、その用途専用の生成器が返る。
 * 同じ (seed, trial) なら、どのストリームをいくつ消費しても他は変わらない。
 */
export class RngSet {
  private readonly cache = new Map<string, Rng>();
  private readonly base: number;

  constructor(
    readonly seed: number,
    readonly trial: number,
  ) {
    this.base = mix(seed >>> 0, trial >>> 0);
  }

  stream(name: string, key?: string): Rng {
    const full = key === undefined ? name : `${name} ${key}`;
    let rng = this.cache.get(full);
    if (rng === undefined) {
      const h = hashString(full, this.base);
      rng = new StreamRng(
        mix(h, 0x243f6a88),
        mix(h, 0x85a308d3),
        mix(h, 0x13198a2e),
        mix(h, 0x03707344),
      );
      this.cache.set(full, rng);
    }
    return rng;
  }
}

export const fixedRng: Rng = new FixedRng();
