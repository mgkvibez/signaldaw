/**
 * Tempo, and the reason it is a map rather than a number.
 *
 * A single BPM is easy: samples per tick is one ratio, and the transport multiplies. The moment a session has a tempo
 * change, every naive implementation starts accumulating float error, because each segment contributes a fractional
 * number of samples and rounding each segment separately drifts against the musical grid by a sample per change.
 *
 * So positions are accumulated here as exact rationals in BigInt: each segment contributes
 * `ticks * sampleRate * 60 * bpmDenominator / (bpmNumerator * ticksPerQuarter)`, the sum is reduced by its gcd at every
 * step so the numbers stay small, and only the final answer is floored to an integer sample. Nothing drifts, and the
 * same map answers the inverse question for sample to tick.
 */

/** BPM is stored as an exact rational so that 127.3 bpm means 1273/10 and not 127.30000000000001. */
export interface TempoSegment {
  /** Musical position where this tempo begins. The first segment must start at tick 0. */
  readonly atTick: number;
  readonly bpm: number;
}

export interface MusicalGrid {
  /** Beats per bar. 4/4 is the default; 3/4 and 7/8 must not be special cases. */
  readonly beatsPerBar?: number;
}

export interface BarBeatTick {
  /** 1-based, as musicians count them. */
  readonly bar: number;
  /** 1-based. */
  readonly beat: number;
  /** 0-based tick within the beat. */
  readonly tick: number;
}

interface Segment {
  readonly atTick: number;
  readonly bpmNum: bigint;
  readonly bpmDen: bigint;
}

const BPM_DENOMINATOR = 1_000_000n;

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x === 0n ? 1n : x;
}

/** An exact fraction, kept reduced. Only used internally, and never converted to float before the final floor. */
class Fraction {
  readonly #numerator: bigint;
  readonly #denominator: bigint;

  constructor(numerator: bigint, denominator: bigint) {
    if (denominator === 0n) throw new RangeError("denominator must not be zero");
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = greatestCommonDivisor(numerator, denominator);
    this.#numerator = (sign * numerator) / divisor;
    this.#denominator = (sign * denominator) / divisor;
  }

  add(other: Fraction): Fraction {
    return new Fraction(
      this.#numerator * other.#denominator + other.#numerator * this.#denominator,
      this.#denominator * other.#denominator,
    );
  }

  subtract(other: Fraction): Fraction {
    return new Fraction(
      this.#numerator * other.#denominator - other.#numerator * this.#denominator,
      this.#denominator * other.#denominator,
    );
  }

  multiply(integer: bigint): Fraction {
    return new Fraction(this.#numerator * integer, this.#denominator);
  }

  /** Floor, which is what a sample position needs: the frame at or before the musical instant. */
  floor(): bigint {
    const quotient = this.#numerator / this.#denominator;
    const remainder = this.#numerator % this.#denominator;
    const negative = remainder !== 0n && this.#numerator < 0n;
    return negative ? quotient - 1n : quotient;
  }

  get numerator(): bigint {
    return this.#numerator;
  }

  get denominator(): bigint {
    return this.#denominator;
  }

  compare(other: Fraction): number {
    const left = this.#numerator * other.#denominator;
    const right = other.#numerator * this.#denominator;
    return left === right ? 0 : left < right ? -1 : 1;
  }
}

export class TempoMap {
  readonly #sampleRate: number;
  readonly #ticksPerQuarter: number;
  readonly #beatsPerBar: number;
  readonly #segments: readonly Segment[];

  constructor(
    sampleRate: number,
    ticksPerQuarter: number,
    segments: readonly TempoSegment[],
    grid: MusicalGrid = {},
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("sampleRate must be positive");
    if (!Number.isInteger(ticksPerQuarter) || ticksPerQuarter <= 0) {
      throw new RangeError("ticksPerQuarter must be a positive integer");
    }
    const beatsPerBar = grid.beatsPerBar ?? 4;
    if (!Number.isInteger(beatsPerBar) || beatsPerBar <= 0) throw new RangeError("beatsPerBar must be a positive integer");
    if (segments.length === 0) throw new RangeError("a tempo map needs at least one segment");
    if (segments[0]!.atTick !== 0) throw new RangeError("the first tempo segment must start at tick 0");

    let previous = -1;
    const parsed: Segment[] = segments.map((segment) => {
      if (!Number.isInteger(segment.atTick) || segment.atTick < 0) {
        throw new RangeError(`tempo segment atTick must be a non-negative integer, got ${segment.atTick}`);
      }
      if (segment.atTick <= previous) throw new RangeError("tempo segments must be ordered and unique");
      previous = segment.atTick;
      if (!Number.isFinite(segment.bpm) || segment.bpm <= 0) throw new RangeError("bpm must be positive");
      const scaled = Math.round(segment.bpm * Number(BPM_DENOMINATOR));
      if (scaled <= 0) throw new RangeError("bpm is too small to represent");
      return { atTick: segment.atTick, bpmNum: BigInt(scaled), bpmDen: BPM_DENOMINATOR };
    });

    this.#sampleRate = sampleRate;
    this.#ticksPerQuarter = ticksPerQuarter;
    this.#beatsPerBar = beatsPerBar;
    this.#segments = parsed;
  }

  get beatsPerBar(): number {
    return this.#beatsPerBar;
  }

  get segmentCount(): number {
    return this.#segments.length;
  }

  bpmAt(tick: number): number {
    const segment = this.#segmentAt(tick);
    return Number(segment.bpmNum) / Number(segment.bpmDen);
  }

  /** How long one tick lasts at a given musical position, in samples. Useful for a UI, never for placement. */
  samplesPerTickAt(tick: number): number {
    const segment = this.#segmentAt(tick);
    return (
      (this.#sampleRate * 60 * Number(segment.bpmDen)) /
      (Number(segment.bpmNum) * this.#ticksPerQuarter)
    );
  }

  /** Exact: the sample at or before a tick, accumulated across every tempo change without float drift. */
  tickToSample(tick: number): number {
    if (!Number.isInteger(tick)) throw new RangeError("tick must be an integer");
    if (tick < 0) throw new RangeError("tick must not be negative");
    const exact = this.#exactSampleAt(tick);
    const floored = exact.floor();
    const asNumber = Number(floored);
    if (!Number.isSafeInteger(asNumber)) throw new RangeError("tick is beyond the safe sample range");
    return asNumber;
  }

  /** The inverse, floored to a whole tick: the tick sounding at a sample. */
  sampleToTick(sample: number): number {
    if (!Number.isInteger(sample)) throw new RangeError("sample must be an integer");
    if (sample < 0) throw new RangeError("sample must not be negative");

    // the last segment whose start is at or before this sample
    let index = 0;
    for (let i = 0; i < this.#segments.length; i += 1) {
      const startsAt = this.#exactSampleAt(this.#segments[i]!.atTick);
      if (startsAt.compare(new Fraction(BigInt(sample), 1n)) <= 0) index = i;
      else break;
    }

    const segment = this.#segments[index]!;
    const baseline = this.#exactSampleAt(segment.atTick);
    const remainder = new Fraction(BigInt(sample), 1n).subtract(baseline);

    // ticks = samples * bpmNum * tpq / (sampleRate * 60 * bpmDen), floored
    const ticks = new Fraction(
      remainder.numerator * segment.bpmNum * BigInt(this.#ticksPerQuarter),
      remainder.denominator * BigInt(this.#sampleRate) * 60n * segment.bpmDen,
    );
    return segment.atTick + Number(ticks.floor());
  }

  /** The tick of a bar/beat/tick position, which is what a grid control edits. */
  tickOf(position: BarBeatTick): number {
    if (position.bar < 1) throw new RangeError("bar is 1-based");
    if (position.beat < 1 || position.beat > this.#beatsPerBar) {
      throw new RangeError(`beat must be between 1 and ${this.#beatsPerBar}`);
    }
    if (position.tick < 0 || position.tick >= this.#ticksPerQuarter) {
      throw new RangeError(`tick must be between 0 and ${this.#ticksPerQuarter - 1}`);
    }
    const bars = position.bar - 1;
    return (
      bars * this.#beatsPerBar * this.#ticksPerQuarter +
      (position.beat - 1) * this.#ticksPerQuarter +
      position.tick
    );
  }

  positionOf(tick: number): BarBeatTick {
    if (!Number.isInteger(tick) || tick < 0) throw new RangeError("tick must be a non-negative integer");
    const ticksPerBar = this.#beatsPerBar * this.#ticksPerQuarter;
    const bar = Math.floor(tick / ticksPerBar);
    const withinBar = tick - bar * ticksPerBar;
    return {
      bar: bar + 1,
      beat: Math.floor(withinBar / this.#ticksPerQuarter) + 1,
      tick: withinBar % this.#ticksPerQuarter,
    };
  }

  #segmentAt(tick: number): Segment {
    let found = this.#segments[0]!;
    for (const segment of this.#segments) {
      if (segment.atTick <= tick) found = segment;
      else break;
    }
    return found;
  }

  #exactSampleAt(tick: number): Fraction {
    let total = new Fraction(0n, 1n);
    for (let i = 0; i < this.#segments.length; i += 1) {
      const segment = this.#segments[i]!;
      const next = this.#segments[i + 1];
      const start = segment.atTick;
      if (tick <= start) break;
      const end = next === undefined ? tick : Math.min(tick, next.atTick);
      const span = end - start;
      if (span <= 0) continue;
      total = total.add(
        new Fraction(BigInt(span) * BigInt(this.#sampleRate) * 60n * segment.bpmDen, segment.bpmNum * BigInt(this.#ticksPerQuarter)),
      );
    }
    return total;
  }
}
