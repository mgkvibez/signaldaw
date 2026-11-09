/**
 * The clock, which is the one part of a DAW that must never lie.
 *
 * Every sequencer that feels wrong feels wrong here: musical time is floating point, audio time is integer samples, and
 * the conversion between them is where drift and jitter live. So the transport stores position as samples and derives
 * musical position from it, never the other way round.
 *
 * The other half is scheduling across a block boundary. An event that falls inside the current block must be placed at
 * a sample offset inside that block; an event slightly beyond it must wait exactly one block and not drift by the
 * remainder, which is what `sliceBlock` guarantees.
 */

import { TempoMap, type TempoSegment } from "./tempo.js";

export interface TransportConfig {
  /** Audio samples per second. 48000 and 44100 are the ones that must both be exactly right. */
  readonly sampleRate: number;
  /** Musical ticks per quarter note. 480 and 960 are common; the maths must not assume either. */
  readonly ticksPerQuarter: number;
  /** A constant tempo. Mutually exclusive with `tempoMap`, which exists for sessions that change tempo. */
  readonly bpm?: number;
  /** Every tempo in the session, beginning at tick 0. */
  readonly tempoMap?: readonly TempoSegment[];
  /** Beats per bar for the musical grid. Defaults to 4. */
  readonly beatsPerBar?: number;
}

export interface MusicalPosition {
  readonly bar: number;
  readonly beat: number;
  readonly tick: number;
}

export interface ScheduledEvent {
  /** Musical position in ticks. */
  readonly tick: number;
  /** Samples from the top of the session. */
  readonly sample: number;
}

export interface Block {
  readonly startSample: number;
  readonly frames: number;
  readonly events: readonly { readonly event: ScheduledEvent; readonly offset: number }[];
}

const BEATS_PER_BAR = 4;

export class Transport {
  readonly #tempo: TempoMap;

  constructor(config: TransportConfig) {
    if (config.sampleRate <= 0) throw new RangeError("sampleRate must be positive");
    if (config.ticksPerQuarter <= 0) throw new RangeError("ticksPerQuarter must be positive");
    const hasBpm = config.bpm !== undefined;
    const hasMap = config.tempoMap !== undefined;
    if (hasBpm === hasMap) {
      throw new RangeError("give either bpm (constant tempo) or tempoMap (tempo changes), not both or neither");
    }
    if (hasBpm && config.bpm! <= 0) throw new RangeError("bpm must be positive");
    this.#tempo = new TempoMap(
      config.sampleRate,
      config.ticksPerQuarter,
      hasMap ? config.tempoMap! : [{ atTick: 0, bpm: config.bpm! }],
      { beatsPerBar: config.beatsPerBar ?? BEATS_PER_BAR },
    );
  }

  /** The tempo map behind the clock, so a UI can draw the grid without recomputing it. */
  get tempo(): TempoMap {
    return this.#tempo;
  }

  get samplesPerTick(): number {
    return this.#tempo.samplesPerTickAt(0);
  }

  tickToSample(tick: number): number {
    return this.#tempo.tickToSample(tick);
  }

  sampleToTick(sample: number): number {
    return this.#tempo.sampleToTick(sample);
  }

  /** Musical position for a sample, derived from samples so it cannot drift. */
  positionAt(sample: number): MusicalPosition {
    if (sample < 0) throw new RangeError("sample must not be negative");
    return this.#tempo.positionOf(this.#tempo.sampleToTick(sample));
  }

  /**
   * Places events into one audio block.
   *
   * An event exactly on the block boundary belongs to the block that starts there, not to the previous one: an
   * inclusive-at-start, exclusive-at-end window. Getting that wrong is a one-block-late hi-hat on every bar line.
   */
  sliceBlock(startSample: number, frames: number, events: readonly ScheduledEvent[]): Block {
    if (frames <= 0) throw new RangeError("frames must be positive");
    const end = startSample + frames;
    const placed: { event: ScheduledEvent; offset: number }[] = [];
    for (const event of events) {
      if (event.sample < startSample || event.sample >= end) continue;
      placed.push({ event, offset: event.sample - startSample });
    }
    placed.sort((a, b) => a.offset - b.offset || a.event.tick - b.event.tick);
    return { startSample, frames, events: placed };
  }

  /** Total scheduled latency of a chain, in samples. The number a plugin delay compensation engine needs. */
  static chainLatency(sampleRate: number, chain: readonly { readonly latencySamples: number }[]): number {
    if (sampleRate <= 0) throw new RangeError("sampleRate must be positive");
    return chain.reduce((sum, plugin) => sum + Math.max(0, Math.round(plugin.latencySamples)), 0);
  }
}
