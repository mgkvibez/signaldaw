import { describe, expect, it } from "vitest";

import { Scheduler, type TrackDescriptor, type TrackEvent } from "../src/scheduler.js";
import { Transport } from "../src/transport.js";

const transport = new Transport({ sampleRate: 48_000, ticksPerQuarter: 480, bpm: 120 });

function scheduler(tracks: TrackDescriptor[]): Scheduler {
  return new Scheduler(transport, tracks);
}

function eventsFor(trackId: string, samples: number[]): TrackEvent[] {
  return samples.map((sample) => ({ trackId, tick: sample, sample }));
}

describe("plugin delay compensation", () => {
  it("shifts nothing when no track has latency", () => {
    const s = scheduler([{ id: "a" }, { id: "b" }]);
    expect(s.sessionLatency).toBe(0);
    expect(s.schedulingOffset("a")).toBe(0);

    const block = s.block(0, 128, eventsFor("a", [0, 64]));
    expect(block.dispatched.map((e) => e.offset)).toEqual([0, 64]);
  });

  it("holds a plugin-free track back by the session latency", () => {
    const s = scheduler([{ id: "slow", plugins: [{ id: "limiter", latencySamples: 512 }] }, { id: "dry" }]);
    expect(s.sessionLatency).toBe(512);
    // The slow track is the reference, so it is delivered on its musical position.
    expect(s.schedulingOffset("slow")).toBe(0);
    // The dry track has to wait for it.
    expect(s.schedulingOffset("dry")).toBe(512);
  });

  it("delays each track by the difference, so two chains line up", () => {
    const s = scheduler([
      { id: "a", plugins: [{ id: "p", latencySamples: 512 }] },
      { id: "b", plugins: [{ id: "q", latencySamples: 256 }] },
      { id: "c" },
    ]);
    expect(s.sessionLatency).toBe(512);
    expect([s.schedulingOffset("a"), s.schedulingOffset("b"), s.schedulingOffset("c")]).toEqual([0, 256, 512]);
  });

  it("sums several plugins on one chain", () => {
    const s = scheduler([
      { id: "a", plugins: [{ id: "p", latencySamples: 64 }, { id: "q", latencySamples: 192 }] },
      { id: "b" },
    ]);
    expect(s.trackLatency("a")).toBe(256);
    expect(s.sessionLatency).toBe(256);
  });

  it("treats a negative reported latency as zero instead of moving events earlier", () => {
    const s = scheduler([{ id: "broken", plugins: [{ id: "p", latencySamples: -128 }] }, { id: "ok" }]);
    expect(s.trackLatency("broken")).toBe(0);
    expect(s.sessionLatency).toBe(0);
    expect(s.schedulingOffset("ok")).toBe(0);
  });

  it("lines up the audible result even though delivery times differ", () => {
    const s = scheduler([
      { id: "wet", plugins: [{ id: "p", latencySamples: 100 }] },
      { id: "dry" },
    ]);
    // Delivery is deliberately NOT simultaneous. The wet track is handed its event on its musical position and the
    // plugin spends 100 samples producing it; the dry track is held back by those same 100 samples. What must match is
    // when the sound reaches the speakers, which is delivery + that track's own latency.
    const block = s.block(1000, 200, [
      { trackId: "wet", tick: 1000, sample: 1000 },
      { trackId: "dry", tick: 1000, sample: 1000 },
    ]);
    expect(block.dispatched.map((e) => e.deliverySample)).toEqual([1000, 1100]);
    const audible = block.dispatched.map((e) => e.deliverySample + s.trackLatency(e.trackId));
    expect(audible).toEqual([1100, 1100]);
  });
});

describe("block dispatch", () => {
  it("places an event exactly on the boundary in the block that starts there", () => {
    const s = scheduler([{ id: "a" }]);
    const events = eventsFor("a", [128]);
    expect(s.block(0, 128, events).dispatched).toHaveLength(0);
    expect(s.block(128, 128, events).dispatched[0]?.offset).toBe(0);
  });

  it("places the last frame of a block in that block, not the next", () => {
    const s = scheduler([{ id: "a" }]);
    const block = s.block(0, 128, eventsFor("a", [127]));
    expect(block.dispatched[0]?.offset).toBe(127);
  });

  it("drops events outside the window entirely", () => {
    const s = scheduler([{ id: "a" }]);
    const block = s.block(256, 128, eventsFor("a", [0, 255, 384, 1000]));
    expect(block.dispatched).toHaveLength(0);
  });

  it("orders ties by tick then track id, so dispatch is deterministic", () => {
    const s = scheduler([{ id: "b" }, { id: "a" }]);
    const block = s.block(0, 64, [
      { trackId: "b", tick: 10, sample: 10 },
      { trackId: "a", tick: 10, sample: 10 },
      { trackId: "a", tick: 5, sample: 10 },
    ]);
    expect(block.dispatched.map((e) => `${e.trackId}@${e.tick}`)).toEqual(["a@5", "a@10", "b@10"]);
  });

  it("does not drift over a minute of callbacks", () => {
    const s = scheduler([{ id: "a", plugins: [{ id: "p", latencySamples: 64 }] }, { id: "b" }]);
    const frames = 128;
    // Two seconds of audio at 375 blocks per second: enough for drift to show, small enough to stay fast.
    const blocks = Math.floor((48_000 * 2) / frames);
    // One event every fourth block, on the boundary.
    const events = eventsFor("a", Array.from({ length: Math.ceil(blocks / 4) }, (_, i) => i * 4 * frames));

    const delivered: number[] = [];
    for (let index = 0; index < blocks; index += 1) {
      for (const item of s.block(index * frames, frames, events).dispatched) {
        delivered.push(item.deliverySample);
      }
    }

    expect(delivered).toHaveLength(events.length);
    // Track "a" carries the session's maximum latency (64 samples), so its offset is zero and every event is delivered
    // exactly on its own boundary: no accumulation and no rounding creep across 750 callbacks.
    expect(delivered).toEqual(events.map((event) => event.sample));
  });

  it("converts musical ticks through the transport when preparing", () => {
    const s = scheduler([{ id: "a" }]);
    // At 120 bpm and 480 ppq, one tick is 50 samples at 48 kHz.
    expect(transport.samplesPerTick).toBeCloseTo(50, 10);
    expect(s.prepare([{ trackId: "a", tick: 0 }, { trackId: "a", tick: 960 }]).map((e) => e.sample)).toEqual([
      0,
      48_000,
    ]);
  });
});

describe("refusals", () => {
  it("rejects an unknown track rather than silently scheduling it at zero offset", () => {
    const s = scheduler([{ id: "a" }]);
    expect(() => s.schedulingOffset("nope")).toThrowError(/unknown track/);
    expect(() => s.block(0, 64, [{ trackId: "nope", tick: 0, sample: 0 }])).toThrowError(/unknown track/);
  });

  it("rejects invalid windows", () => {
    const s = scheduler([{ id: "a" }]);
    expect(() => s.block(0, 0, [])).toThrowError(RangeError);
    expect(() => s.block(-1, 64, [])).toThrowError(RangeError);
  });
});
