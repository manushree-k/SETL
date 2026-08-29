// Seeded pseudo-random number generation for the synthetic data generator.
//
// Everything in Setl's dataset must be reproducible: running the generator
// twice with the same seed has to produce byte-identical CSVs, so that
// "different seed, different merchant" is a real, checkable claim rather
// than a one-off snapshot. That rules out Math.random(), which reads from
// unseedable OS entropy and cannot be reproduced or checked into a test.
//
// mulberry32 is a small, well-known seeded PRNG: a 32-bit state, one
// multiply-and-xor step per call, full 32-bit period. It is not
// cryptographically secure and does not need to be — nothing here is a
// secret, it only needs to be deterministic and reasonably well mixed.

/**
 * mulberry32: given a 32-bit integer seed, returns a generator function.
 * Each call to that function advances the internal state and returns a
 * float in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded random source with the helpers the generator needs, all built
 * on a single mulberry32 instance. Every draw in the generator should go
 * through one Rng instance so the whole run is reproducible from one seed.
 */
export class Rng {
  private readonly draw: () => number;

  constructor(seed: number) {
    this.draw = mulberry32(seed);
  }

  /** Next float in [0, 1). */
  next(): number {
    return this.draw();
  }

  /** Random boolean, true with probability `p` (default 0.5). */
  bool(p = 0.5): boolean {
    return this.draw() < p;
  }

  /** Random integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max (${max}) < min (${min})`);
    return min + Math.floor(this.draw() * (max - min + 1));
  }

  /** Random float in [min, max). */
  float(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.float: max (${max}) < min (${min})`);
    return min + this.draw() * (max - min);
  }

  /** Pick one element of a non-empty array uniformly at random. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: cannot pick from an empty array');
    return items[this.int(0, items.length - 1)];
  }

  /**
   * Pick one element according to relative weights. Weights need not sum
   * to 1 — they are normalized internally. Used for method mix, injected
   * case selection, and anything else sampled from a named distribution.
   */
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
    if (items.length === 0) throw new Error('Rng.weightedPick: no items to pick from');
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    if (total <= 0) throw new Error('Rng.weightedPick: total weight must be positive');

    let target = this.draw() * total;
    for (const item of items) {
      target -= item.weight;
      if (target <= 0) return item.value;
    }
    // Floating-point edge case: rounding could leave target > 0 after the
    // loop. Fall back to the last item rather than returning undefined.
    return items[items.length - 1].value;
  }

  /** Fisher-Yates shuffle. Returns a new array; does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
