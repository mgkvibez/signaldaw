import { describe, expect, it } from "vitest";

import { Transport } from "../src/transport.js";

const at120 = (sampleRate: number) => new Transport({ sampleRate, ticksPerQuarter: 960, bpm: 120 });

describe("sample-clocked transport", () => {
  it("converts a quarter note to samples exactly", () => {
    // 120 bpm means one quarter note is 0.5 s, so 24000 samples at 48 kHz.
    expect(at120(48_000).tickToSample(960)).toBe(24_000);
    expect(at120(44_100).tickToSample(960)).toBe(22_050);
  });

  it("round-trips tick and sample without drift", () => {
    const transport = at120(48_000);
    for (const tick of [0, 1, 479, 960, 3_840, 76_800]) {
      expect(transport.sampleToTick(transport.tickToSample(tick))).toBe(tick);
    }
  });

  it("reports bar, beat and tick from samples", () => {
    const transport = at120(48_000);
    expect(transport.positionAt(0)).toEqual({ bar: 1, beat: 1, tick: 0 });
    expect(transport.positionAt(24_000)).toEqual({ bar: 1, beat: 2, tick: 0 });
    expect(transport.positionAt(96_000)).toEqual({ bar: 2, beat: 1, tick: 0 });
  });

  it("places an event on a block boundary in the block that starts there", () => {
    const transport = at120(48_000);
    const events = [{ tick: 960, sample: 24_000 }];
    expect(transport.sliceBlock(24_000 - 128, 128, events).events).toHaveLength(0);
    const next = transport.sliceBlock(24_000, 128, events);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.offset).toBe(0);
  });

  it("keeps sample offsets inside the block instead of rounding to the boundary", () => {
    const block = at120(48_000).sliceBlock(1_000, 256, [
      { tick: 40, sample: 1_200 },
      { tick: 41, sample: 1_050 },
      { tick: 42, sample: 2_000 },
    ]);
    expect(block.events.map((e) => e.offset)).toEqual([50, 200]);
  });

  it("sums chain latency for plugin delay compensation", () => {
    expect(Transport.chainLatency(48_000, [{ latencySamples: 64 }, { latencySamples: 128 }])).toBe(192);
  });

  it("refuses nonsense configuration rather than dividing by zero", () => {
    expect(() => new Transport({ sampleRate: 0, ticksPerQuarter: 960, bpm: 120 })).toThrow(RangeError);
    expect(() => new Transport({ sampleRate: 48_000, ticksPerQuarter: 960, bpm: 0 })).toThrow(RangeError);
    expect(() => at120(48_000).sliceBlock(0, 0, [])).toThrow(RangeError);
  });
});

describe("transport over a tempo map", () => {
  it("places a bar line exactly across a tempo change", () => {
    const transport = new Transport({
      sampleRate: 48000,
      ticksPerQuarter: 480,
      tempoMap: [
        { atTick: 0, bpm: 120 },
        { atTick: 1920, bpm: 60 },
      ],
    });
    expect(transport.tickToSample(1920)).toBe(96000);
    expect(transport.tickToSample(3840)).toBe(288000);
    expect(transport.positionAt(96000)).toEqual({ bar: 2, beat: 1, tick: 0 });
  });

  it("requires exactly one of bpm and tempoMap", () => {
    expect(() => new Transport({ sampleRate: 48000, ticksPerQuarter: 480 })).toThrow(/either bpm/);
    expect(
      () =>
        new Transport({
          sampleRate: 48000,
          ticksPerQuarter: 480,
          bpm: 120,
          tempoMap: [{ atTick: 0, bpm: 120 }],
        }),
    ).toThrow(/either bpm/);
  });

  it("keeps the same block semantics when the tempo changes mid-block", () => {
    const transport = new Transport({
      sampleRate: 48000,
      ticksPerQuarter: 480,
      tempoMap: [
        { atTick: 0, bpm: 120 },
        { atTick: 480, bpm: 60 },
      ],
    });
    const events = [0, 480, 960].map((tick) => ({ tick, sample: transport.tickToSample(tick) }));
    const block = transport.sliceBlock(0, 48000, events);
    expect(block.events.map((placed) => placed.event.tick)).toEqual([0, 480]);
    expect(block.events[1]!.offset).toBe(24000);
  });
});
