import { describe, expect, it } from "vitest";

import { TempoMap } from "../src/tempo.js";

const map = (segments: { atTick: number; bpm: number }[], sampleRate = 48000, tpq = 480, beatsPerBar = 4) =>
  new TempoMap(sampleRate, tpq, segments, { beatsPerBar });

describe("tempo map", () => {
  it("matches the single-tempo arithmetic exactly at 48 kHz", () => {
    // 120 bpm, 480 ticks per quarter: one tick is 50 samples, one beat 24000, one bar 96000
    const tempo = map([{ atTick: 0, bpm: 120 }]);
    expect(tempo.tickToSample(480)).toBe(24000);
    expect(tempo.tickToSample(1920)).toBe(96000);
    expect(tempo.samplesPerTickAt(0)).toBe(50);
  });

  it("matches the single-tempo arithmetic exactly at 44.1 kHz", () => {
    const tempo = map([{ atTick: 0, bpm: 120 }], 44100);
    expect(tempo.tickToSample(480)).toBe(22050);
    expect(tempo.tickToSample(1920)).toBe(88200);
  });

  it("accumulates across a tempo change instead of rescaling from zero", () => {
    // bar 1 at 120 bpm = 96000 samples; after that, 60 bpm doubles the length of a bar
    const tempo = map([
      { atTick: 0, bpm: 120 },
      { atTick: 1920, bpm: 60 },
    ]);
    expect(tempo.tickToSample(1920)).toBe(96000);
    expect(tempo.tickToSample(3840)).toBe(96000 + 192000);
    expect(tempo.bpmAt(1919)).toBe(120);
    expect(tempo.bpmAt(1920)).toBe(60);
  });

  it("does not drift across ten thousand bars of a fractional tempo", () => {
    const tempo = map([{ atTick: 0, bpm: 127.3 }]);
    const tick = 1920 * 10_000;
    // exact value: tick * sampleRate * 60 / (bpm * tpq), computed independently in BigInt
    const expected = Number((BigInt(tick) * 48000n * 60n * 1_000_000n) / (127_300_000n * 480n));
    expect(tempo.tickToSample(tick)).toBe(expected);
  });

  it("round-trips sample to tick within one tick", () => {
    const tempo = map([
      { atTick: 0, bpm: 127.3 },
      { atTick: 960, bpm: 91.5 },
      { atTick: 5000, bpm: 140 },
    ]);
    for (const tick of [0, 1, 479, 480, 959, 960, 961, 4999, 5000, 12_345]) {
      const sample = tempo.tickToSample(tick);
      const back = tempo.sampleToTick(sample);
      expect(Math.abs(back - tick)).toBeLessThanOrEqual(1);
    }
  });

  it("maps ticks to bar/beat/tick and back", () => {
    const tempo = map([{ atTick: 0, bpm: 120 }]);
    expect(tempo.positionOf(0)).toEqual({ bar: 1, beat: 1, tick: 0 });
    expect(tempo.positionOf(1920)).toEqual({ bar: 2, beat: 1, tick: 0 });
    expect(tempo.positionOf(1920 + 480 + 1)).toEqual({ bar: 2, beat: 2, tick: 1 });
    expect(tempo.tickOf(tempo.positionOf(12_345))).toBe(12_345);
  });

  it("converts bar/beat/tick to a tick and back for a non-4/4 bar", () => {
    const tempo = map([{ atTick: 0, bpm: 120 }], 48000, 480, 3);
    const tick = tempo.tickOf({ bar: 2, beat: 1, tick: 0 });
    expect(tick).toBe(3 * 480);
    expect(tempo.positionOf(tick)).toEqual({ bar: 2, beat: 1, tick: 0 });
    expect(tempo.positionOf(tick - 1)).toEqual({ bar: 1, beat: 3, tick: 479 });
  });

  it("refuses a map that does not start at tick zero", () => {
    expect(() => map([{ atTick: 480, bpm: 120 }])).toThrow(/must start at tick 0/);
  });

  it("refuses unordered or duplicate segments", () => {
    expect(() => map([{ atTick: 0, bpm: 120 }, { atTick: 960, bpm: 90 }, { atTick: 480, bpm: 60 }])).toThrow(
      /ordered and unique/,
    );
    expect(() => map([{ atTick: 0, bpm: 120 }, { atTick: 0, bpm: 90 }])).toThrow(/ordered and unique/);
  });

  it("refuses a tempo of zero or less instead of dividing by it", () => {
    expect(() => map([{ atTick: 0, bpm: 0 }])).toThrow(/bpm must be positive/);
    expect(() => map([{ atTick: 0, bpm: -120 }])).toThrow(/bpm must be positive/);
  });

  it("refuses a beat outside the bar rather than normalising it", () => {
    const tempo = map([{ atTick: 0, bpm: 120 }]);
    expect(() => tempo.tickOf({ bar: 1, beat: 5, tick: 0 })).toThrow(/between 1 and 4/);
    expect(() => tempo.tickOf({ bar: 0, beat: 1, tick: 0 })).toThrow(/1-based/);
  });
});
