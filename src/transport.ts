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

export interface TransportConfig {
  /** Audio samples per second. 48000 and 44100 are the ones that must both be exactly right. */
  readonly sampleRate: number;
  /** Musical ticks per quarter note. 480 and 960 are common; the maths must not assume either. */
  readonly ticksPerQuarter: number;
  readonly bpm: number;
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
  readonly #config: TransportConfig;

  constructor(config: TransportConfig) {
    if (config.sampleRate <= 0) throw new RangeError("sampleRate must be positive");
    if (config.ticksPerQuarter <= 0) throw new RangeError("ticksPerQuarter must be positive");
    if (config.bpm <= 0) throw new RangeError("bpm must be positive");
    this.#config = config;
  }

  get samplesPerTick(): number {
    // One quarter note is 60/bpm seconds, i.e. sampleRate * 60 / bpm samples.
    return (this.#config.sampleRate * 60) / (this.#config.bpm * this.#config.ticksPerQuarter);
  }

  tickToSample(tick: number): number {
    return Math.round(tick * this.samplesPerTick);
  }

  sampleToTick(sample: number): number {
    return Math.round(sample / this.samplesPerTick);
  }

  /** Musical position for a sample, derived from samples so it cannot drift. */
  positionAt(sample: number): MusicalPosition {
    if (sample < 0) throw new RangeError("sample must not be negative");
    const tick = this.sampleToTick(sample);
    const ticksPerBeat = this.#config.ticksPerQuarter;
    const ticksPerBar = ticksPerBeat * BEATS_PER_BAR;
    const bar = Math.floor(tick / ticksPerBar);
    const withinBar = tick - bar * ticksPerBar;
    return { bar: bar + 1, beat: Math.floor(withinBar / ticksPerBeat) + 1, tick: withinBar % ticksPerBeat };
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
