/**
 * Plugin delay compensation, expressed as arithmetic rather than hope.
 *
 * A plugin that reports 512 samples of latency delays everything it processes by 512 samples. Left alone, that track
 * drifts behind every other track by exactly that amount. The fix is not to hurry that plugin up (impossible) but to
 * delay everything else to match: the session runs at the latency of its slowest chain, and each track is delayed by
 * the difference between that maximum and its own chain.
 *
 * So `schedulingOffset(track)` is `sessionLatency - trackLatency`, and an event is delivered at
 * `event.sample + schedulingOffset`. A track that is itself the slowest gets an offset of zero and is therefore
 * exactly on time; a track with no plugins is held back by the full session latency. That asymmetry is the whole point:
 * it is what makes the two tracks line up instead of merely both being late.
 */

import type { Block, ScheduledEvent, Transport } from "./transport.js";

export interface PluginDescriptor {
  readonly id: string;
  /** Latency the plugin reports, in samples. Negative values are a broken plugin and are treated as zero. */
  readonly latencySamples: number;
}

export interface TrackDescriptor {
  readonly id: string;
  readonly plugins?: readonly PluginDescriptor[];
}

export interface TrackEvent extends ScheduledEvent {
  readonly trackId: string;
}

export interface DispatchedEvent {
  readonly trackId: string;
  /** Musical position, kept so a UI can show where the event *is* rather than where it was shifted to. */
  readonly tick: number;
  /** The sample the event is delivered at, after compensation. */
  readonly deliverySample: number;
  /** Offset inside the block, which is what an audio callback needs. */
  readonly offset: number;
}

export class Scheduler {
  readonly #transport: Transport;
  readonly #latencyByTrack: ReadonlyMap<string, number>;
  readonly #sessionLatency: number;

  constructor(transport: Transport, tracks: readonly TrackDescriptor[]) {
    const latency = new Map<string, number>();
    let worst = 0;
    for (const track of tracks) {
      const total = (track.plugins ?? []).reduce(
        (sum, plugin) => sum + Math.max(0, Math.round(plugin.latencySamples)),
        0,
      );
      latency.set(track.id, total);
      worst = Math.max(worst, total);
    }
    this.#transport = transport;
    this.#latencyByTrack = latency;
    this.#sessionLatency = worst;
  }

  /** Latency of the slowest chain in the session. Everything is measured against this. */
  get sessionLatency(): number {
    return this.#sessionLatency;
  }

  trackLatency(trackId: string): number {
    const latency = this.#latencyByTrack.get(trackId);
    if (latency === undefined) throw new RangeError("unknown track: " + trackId);
    return latency;
  }

  /** How far *later* than its musical position a track's events must be delivered. */
  schedulingOffset(trackId: string): number {
    return this.#sessionLatency - this.trackLatency(trackId);
  }

  /** The sample a track's event actually sounds at, after compensation. One definition, used everywhere. */
  deliverySample(event: TrackEvent): number {
    return event.sample + this.schedulingOffset(event.trackId);
  }

  /**
   * The events of one audio block, already compensated and sorted.
   *
   * Deliberately does not re-time or clamp events: an event whose delivery sample falls outside the window is simply
   * not in this block. A compensated event is never earlier than its musical position, because the offset is a
   * non-negative shift, so there is no case where an event has to be delivered before the session start.
   */
  block(startSample: number, frames: number, events: readonly TrackEvent[]): Block & { readonly dispatched: readonly DispatchedEvent[] } {
    if (frames <= 0) throw new RangeError("frames must be positive");
    if (startSample < 0) throw new RangeError("startSample must not be negative");
    const end = startSample + frames;
    const dispatched: DispatchedEvent[] = [];

    for (const event of events) {
      const deliverySample = this.deliverySample(event);
      if (deliverySample < startSample || deliverySample >= end) continue;
      dispatched.push({
        trackId: event.trackId,
        tick: event.tick,
        deliverySample,
        offset: deliverySample - startSample,
      });
    }

    dispatched.sort((a, b) => a.offset - b.offset || a.tick - b.tick || a.trackId.localeCompare(b.trackId));

    return {
      startSample,
      frames,
      events: dispatched.map((item) => ({ event: { tick: item.tick, sample: item.deliverySample }, offset: item.offset })),
      dispatched,
    };
  }

  /** Schedule by musical tick: the transport owns the tick-to-sample conversion, not this class. */
  prepare(events: readonly { readonly trackId: string; readonly tick: number }[]): TrackEvent[] {
    return events.map((event) => ({
      trackId: event.trackId,
      tick: event.tick,
      sample: this.#transport.tickToSample(event.tick),
    }));
  }
}
