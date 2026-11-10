/**
 * The bridge between the session clock and the audio thread.
 *
 * A DAW has two threads that cannot share state. The main thread owns the session: tempo map, tracks, plugin chains, the
 * UI. The audio thread owns the callback, and it may not block, allocate in a hurry, or ask the main thread a question
 * and wait for the answer. So scheduling cannot be "the audio thread asks what to play next"; it has to be the main
 * thread pushing events ahead of time into a queue the audio thread drains.
 *
 * That shape has one failure mode worth taking seriously: if the main thread stalls, the audio thread has nothing to
 * play. The dishonest fix is to nudge the late event to the next block and carry on, which is how sequencers acquire a
 * permanent one-block lag that nobody can find later. This bridge does the honest thing: an event that could not be
 * delivered on its sample is counted as late, reported with the sample it missed by, and dropped. A count of late events
 * is a bug report; a silently shifted event is a bug.
 *
 * What this is not: it produces no sound. There is no audio graph yet, so the audio-thread half renders *timing* (which
 * event, at which sample offset inside the block) and the app writes that into its WebAudio nodes. Both halves are
 * tested here against a fake port and a fake clock, which is the part that would otherwise be duplicated in the browser.
 */

import type { Scheduler, TrackEvent } from "./scheduler.js";
import type { Transport } from "./transport.js";

/** The subset of `MessagePort` used here. A real port satisfies it in both the browser and a worker. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

/** An event that reached the audio thread, with everything the callback needs to place it. */
export interface RenderedEvent {
  readonly trackId: string;
  readonly tick: number;
  /** Absolute sample, after plugin delay compensation. */
  readonly sample: number;
  /** Sample offset inside the block: what a WebAudio `start(when)` or an audio-rate envelope wants. */
  readonly offset: number;
}

export interface RenderedBlock {
  readonly startSample: number;
  readonly frames: number;
  readonly events: readonly RenderedEvent[];
}

/** What the audio thread reports back. The main thread never guesses the audio position; it is told. */
export type AudioThreadReport =
  | { readonly type: "position"; readonly sample: number; readonly queued: number }
  | { readonly type: "late"; readonly trackId: string; readonly tick: number; readonly sample: number; readonly at: number }
  | { readonly type: "reset"; readonly sample: number };

export type MainThreadCommand =
  | { readonly type: "schedule"; readonly events: readonly TrackEvent[] }
  | { readonly type: "reset"; readonly sample: number };

export interface LateEvent {
  readonly trackId: string;
  readonly tick: number;
  readonly sample: number;
  /** How many samples too late it was. Positive by definition; a zero would not be late. */
  readonly missedBy: number;
}

/** Bounded dedupe memory: past this many keys the oldest are forgotten, and old keys cannot recur in practice. */
const MAX_REMEMBERED_EVENTS = 100_000;

function eventKey(event: { readonly trackId: string; readonly tick: number }): string {
  return `${event.trackId}:${event.tick}`;
}

function bySample(a: { readonly sample: number; readonly tick: number }, b: { readonly sample: number; readonly tick: number }): number {
  return a.sample - b.sample || a.tick - b.tick;
}

export interface ProcessorCore {
  /** Deliver a message from the main thread. In a worklet this is `port.onmessage`. */
  readonly receive: (data: unknown) => void;
  /** Render one block's schedule. `frames` is the callback's frame count, not a buffer. */
  readonly renderBlock: (frames: number) => RenderedBlock;
  readonly position: number;
  readonly played: readonly RenderedEvent[];
  readonly late: readonly LateEvent[];
}

/**
 * The audio-thread half.
 *
 * `renderBlock` is deliberately pure with respect to audio: it returns what should sound and when, and advances an
 * absolute sample counter that only ever increases. Events are queued by absolute sample, so a block boundary is an
 * address, not a case.
 */
export function createProcessorCore(options: { readonly port: MessagePortLike }): ProcessorCore {
  const { port } = options;
  let position = 0;
  let queue: RenderedEvent[] = [];
  const played: RenderedEvent[] = [];
  const late: LateEvent[] = [];
  const remembered = new Set<string>();
  const rememberOrder: string[] = [];

  const remember = (key: string): boolean => {
    if (remembered.has(key)) return false;
    remembered.add(key);
    rememberOrder.push(key);
    if (rememberOrder.length > MAX_REMEMBERED_EVENTS) {
      const oldest = rememberOrder.shift();
      if (oldest !== undefined) remembered.delete(oldest);
    }
    return true;
  };

  const receive = (data: unknown): void => {
    const message = data as MainThreadCommand | undefined;
    if (message?.type === "reset") {
      queue = [];
      position = message.sample;
      port.postMessage({ type: "reset", sample: position } satisfies AudioThreadReport);
      return;
    }
    if (message?.type !== "schedule") return;

    for (const event of message.events) {
      const rendered: RenderedEvent = { trackId: event.trackId, tick: event.tick, sample: event.sample, offset: 0 };
      if (!remember(eventKey(event))) continue; // a resend is not a second event
      if (event.sample < position) {
        // already gone: report the miss rather than pretending the event is on time
        const missed: LateEvent = {
          trackId: event.trackId,
          tick: event.tick,
          sample: event.sample,
          missedBy: position - event.sample,
        };
        late.push(missed);
        port.postMessage({
          type: "late",
          trackId: missed.trackId,
          tick: missed.tick,
          sample: missed.sample,
          at: position,
        } satisfies AudioThreadReport);
        continue;
      }
      queue.push(rendered);
    }
    queue.sort(bySample);
  };

  const renderBlock = (frames: number): RenderedBlock => {
    if (!Number.isInteger(frames) || frames <= 0) {
      throw new RangeError("frames must be a positive integer");
    }
    const startSample = position;
    const end = startSample + frames;
    const ready: RenderedEvent[] = [];
    while (queue.length > 0 && queue[0]!.sample < end) {
      const event = queue.shift()!;
      // the queue only holds events at or after `position`, so the offset cannot be negative here
      ready.push({ ...event, offset: event.sample - startSample });
    }
    ready.sort((a, b) => a.offset - b.offset || a.tick - b.tick);
    played.push(...ready);
    position = end;
    port.postMessage({ type: "position", sample: position, queued: queue.length } satisfies AudioThreadReport);
    return { startSample, frames, events: ready };
  };

  // a worklet's glue is exactly this line: the port's messages are the processor's input
  port.onmessage = (event) => receive(event.data);

  return {
    receive,
    renderBlock,
    get position() {
      return position;
    },
    get played() {
      return played;
    },
    get late() {
      return late;
    },
  };
}

export interface AudioBridgeOptions {
  readonly transport: Transport;
  readonly scheduler: Scheduler;
  readonly port: MessagePortLike;
  /** How far ahead of the audio position the main thread keeps events queued. */
  readonly lookaheadFrames?: number;
}

const DEFAULT_LOOKAHEAD = 2048;

/**
 * The main-thread half.
 *
 * It holds the queue, pushes a lookahead window at a time, and records anything the audio thread could not have played on
 * time. Compensation is applied here, once, using the scheduler's per-track offsets, so the audio thread receives
 * absolute delivery samples and needs to know nothing about plugin latency.
 */
export class AudioBridge {
  readonly #transport: Transport;
  readonly #scheduler: Scheduler;
  readonly #port: MessagePortLike;
  readonly #lookahead: number;
  #pending: TrackEvent[] = [];
  #audioSample: number | null = null;
  readonly #late: LateEvent[] = [];
  #sent = 0;

  constructor(options: AudioBridgeOptions) {
    const lookahead = options.lookaheadFrames ?? DEFAULT_LOOKAHEAD;
    if (!Number.isInteger(lookahead) || lookahead <= 0) {
      throw new RangeError("lookaheadFrames must be a positive integer");
    }
    this.#transport = options.transport;
    this.#scheduler = options.scheduler;
    this.#port = options.port;
    this.#lookahead = lookahead;
    this.#port.onmessage = (event) => this.handleReport(event.data);
  }

  /** The audio thread's clock, as last reported. `null` until the first block has been rendered. */
  get audioPosition(): number | null {
    return this.#audioSample;
  }

  /** Every event the audio thread could not play on time, with the sample it missed by. */
  get lateEvents(): readonly LateEvent[] {
    return this.#late;
  }

  /** Events queued but not yet sent: the number a "lookahead health" meter shows. */
  get unsent(): number {
    return this.#pending.length;
  }

  /**
   * Queue events for the audio thread. Musical ticks are converted here, by the transport, and compensated here, by the
   * scheduler, so nothing downstream re-derives either.
   */
  schedule(events: readonly { readonly trackId: string; readonly tick: number }[]): void {
    for (const event of events) {
      const sample = this.#transport.tickToSample(event.tick);
      this.#pending.push({
        trackId: event.trackId,
        tick: event.tick,
        sample: sample + this.#scheduler.schedulingOffset(event.trackId),
      });
    }
    this.#pending.sort(bySample);
  }

  /**
   * Push the next lookahead window. Returns how many events were posted.
   *
   * Before the first report the audio position is unknown, so the first pump sends one window from sample zero: doing
   * nothing would guarantee the first block is empty, and starting the queue empty is not a feature.
   */
  pump(): number {
    const horizon = (this.#audioSample ?? 0) + this.#lookahead;
    const window: TrackEvent[] = [];
    while (this.#pending.length > 0 && this.#pending[0]!.sample < horizon) {
      window.push(this.#pending.shift()!);
    }
    if (window.length === 0) return 0;
    this.#port.postMessage({ type: "schedule", events: window } satisfies MainThreadCommand);
    this.#sent += window.length;
    return window.length;
  }

  /** Handle one report from the audio thread. A late report is recorded, never repaired. */
  handleReport(data: unknown): void {
    const report = data as AudioThreadReport | undefined;
    if (report === undefined) return;
    if (report.type === "position" || report.type === "reset") {
      this.#audioSample = report.sample;
      // anything still unsent that the audio thread has already passed is late by definition
      while (this.#pending.length > 0 && this.#pending[0]!.sample < report.sample) {
        const missed = this.#pending.shift()!;
        this.#late.push({
          trackId: missed.trackId,
          tick: missed.tick,
          sample: missed.sample,
          missedBy: report.sample - missed.sample,
        });
      }
      return;
    }
    if (report.type === "late") {
      this.#late.push({
        trackId: report.trackId,
        tick: report.tick,
        sample: report.sample,
        missedBy: report.at - report.sample,
      });
    }
  }

  /** Move both clocks to a sample, dropping whatever was queued: a seek is not a late event. */
  seek(sample: number): void {
    if (!Number.isInteger(sample) || sample < 0) throw new RangeError("seek sample must be a non-negative integer");
    this.#pending = [];
    this.#audioSample = sample;
    this.#port.postMessage({ type: "reset", sample } satisfies MainThreadCommand);
  }

  /** Total events handed to the audio thread. Useful in tests and in a diagnostics panel. */
  get sentCount(): number {
    return this.#sent;
  }
}
