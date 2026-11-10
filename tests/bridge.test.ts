import { describe, expect, it } from "vitest";

import { AudioBridge, createProcessorCore, type AudioThreadReport, type MainThreadCommand } from "../src/bridge.js";
import { Scheduler, type TrackDescriptor } from "../src/scheduler.js";
import { Transport } from "../src/transport.js";

const transport = new Transport({ sampleRate: 48_000, ticksPerQuarter: 480, bpm: 120 });

/** A port pair wired the way a real MessagePort pair is, but synchronous, so a test can step both threads. */
function wire(): {
  main: { postMessage: (message: unknown) => void; onmessage: ((event: { readonly data: unknown }) => void) | null };
  audio: { postMessage: (message: unknown) => void; onmessage: ((event: { readonly data: unknown }) => void) | null };
  toAudio: unknown[];
  toMain: unknown[];
} {
  const toAudio: unknown[] = [];
  const toMain: unknown[] = [];
  const main = {
    postMessage(message: unknown) {
      toAudio.push(message);
      audio.onmessage?.({ data: message });
    },
    onmessage: null as ((event: { readonly data: unknown }) => void) | null,
  };
  const audio = {
    postMessage(message: unknown) {
      toMain.push(message);
      main.onmessage?.({ data: message });
    },
    onmessage: null as ((event: { readonly data: unknown }) => void) | null,
  };
  return { main, audio, toAudio, toMain };
}

function bridgeFor(tracks: TrackDescriptor[], lookaheadFrames?: number) {
  const port = wire();
  const scheduler = new Scheduler(transport, tracks);
  const core = createProcessorCore({ port: port.audio });
  const bridge = new AudioBridge({
    transport,
    scheduler,
    port: port.main,
    ...(lookaheadFrames === undefined ? {} : { lookaheadFrames }),
  });
  return { bridge, core, port, scheduler };
}

describe("the audio-thread half", () => {
  it("renders queued events at their offset inside the block", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    core.receive({ type: "schedule", events: [{ trackId: "a", tick: 0, sample: 10 }, { trackId: "a", tick: 1, sample: 140 }] });
    const first = core.renderBlock(128);
    expect(first.startSample).toBe(0);
    expect(first.events.map((event) => event.offset)).toEqual([10]);
    // 140 belongs to the next block, whose offsets restart at zero
    expect(first.events[0]!.sample).toBe(10);
    const second = core.renderBlock(128);
    expect(second.startSample).toBe(128);
    expect(second.events.map((event) => event.offset)).toEqual([12]);
  });

  it("puts a boundary event in the block that starts there, not one block early", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    core.receive({ type: "schedule", events: [{ trackId: "a", tick: 1, sample: 128 }] });
    expect(core.renderBlock(128).events).toHaveLength(0);
    expect(core.renderBlock(128).events.map((event) => event.offset)).toEqual([0]);
  });

  it("refuses a block size that is not a positive integer", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    expect(() => core.renderBlock(0)).toThrow(/positive integer/);
    expect(() => core.renderBlock(64.5)).toThrow(/positive integer/);
  });

  it("ignores a resent event instead of playing it twice", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    const events = [{ trackId: "a", tick: 7, sample: 4 }];
    core.receive({ type: "schedule", events });
    core.receive({ type: "schedule", events });
    expect(core.renderBlock(128).events).toHaveLength(1);
  });

  it("reports an event that arrives after its sample has passed instead of nudging it", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    core.renderBlock(128);
    core.renderBlock(128);
    core.receive({ type: "schedule", events: [{ trackId: "a", tick: 2, sample: 40 }] });
    expect(core.renderBlock(128).events).toHaveLength(0);
    expect(core.late).toEqual([{ trackId: "a", tick: 2, sample: 40, missedBy: 216 }]);
    const lateReport = port.toMain.filter(
      (message): message is AudioThreadReport => (message as AudioThreadReport).type === "late",
    );
    expect(lateReport).toHaveLength(1);
  });

  it("reports its position after every block, monotonically", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    for (let i = 0; i < 5; i += 1) core.renderBlock(128);
    const positions = port.toMain
      .filter((message): message is AudioThreadReport => (message as AudioThreadReport).type === "position")
      .map((report) => (report as { sample: number }).sample);
    expect(positions).toEqual([128, 256, 384, 512, 640]);
  });

  it("clears its queue on reset and continues from the new sample", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    core.receive({ type: "schedule", events: [{ trackId: "a", tick: 9, sample: 300 }] });
    core.receive({ type: "reset", sample: 1000 });
    expect(core.position).toBe(1000);
    expect(core.renderBlock(128).events).toHaveLength(0);
    // 1128 is where the reset block ended, so this is the first sample that can still be played
    core.receive({ type: "schedule", events: [{ trackId: "a", tick: 10, sample: 1128 }] });
    expect(core.renderBlock(128).events.map((event) => event.offset)).toEqual([0]);
  });

  it("ignores a message it does not recognise rather than throwing in the audio callback", () => {
    const port = wire();
    const core = createProcessorCore({ port: port.audio });
    expect(() => core.receive({ type: "nonsense" })).not.toThrow();
    expect(() => core.receive(undefined)).not.toThrow();
  });
});

describe("the main-thread half", () => {
  it("converts ticks and applies compensation before anything is sent", () => {
    const { bridge, scheduler, port } = bridgeFor(
      [{ id: "wet", plugins: [{ id: "p", latencySamples: 512 }] }, { id: "dry" }],
      30_000,
    );
    // tick 480 at 120 bpm and 48 kHz is 24000 samples; the dry track is held back by the session latency, 512 samples
    expect(scheduler.schedulingOffset("dry")).toBe(512);
    bridge.schedule([{ trackId: "dry", tick: 480 }]);
    expect(bridge.pump()).toBe(1);
    const schedule = port.toAudio.find(
      (message): message is Extract<MainThreadCommand, { type: "schedule" }> =>
        (message as MainThreadCommand).type === "schedule",
    );
    expect(schedule?.events).toEqual([{ trackId: "dry", tick: 480, sample: 24_512 }]);
  });

  it("does not send an event beyond the lookahead window", () => {
    const { bridge, port } = bridgeFor([{ id: "a" }], 512);
    bridge.schedule([{ trackId: "a", tick: 0 }, { trackId: "a", tick: 480 }, { trackId: "a", tick: 960 }]);
    expect(bridge.pump()).toBe(1);
    const schedule = port.toAudio.find(
      (message): message is Extract<MainThreadCommand, { type: "schedule" }> =>
        (message as MainThreadCommand).type === "schedule",
    );
    expect(schedule?.events.length).toBe(1);

    // after the audio thread reports 384, the horizon moves to 896 and the second event (24000) still waits
    bridge.handleReport({ type: "position", sample: 384, queued: 0 });
    expect(bridge.pump()).toBe(0);
  });

  it("refuses a lookahead that cannot work", () => {
    const port = wire();
    const scheduler = new Scheduler(transport, [{ id: "a" }]);
    expect(() => new AudioBridge({ transport, scheduler, port: port.main, lookaheadFrames: 0 })).toThrow(
      /positive integer/,
    );
  });

  it("records a stall as late events, with how far they missed, rather than shifting them", () => {
    const { bridge, core } = bridgeFor([{ id: "a" }], 128);
    // 50 samples to the tick here, so these land at 0, 5000 and 10000, far outside a 128-sample window
    bridge.schedule([{ trackId: "a", tick: 0 }, { trackId: "a", tick: 100 }, { trackId: "a", tick: 200 }]);
    bridge.pump();
    core.renderBlock(128);
    // the main thread now stalls: no further pump, so the audio thread runs past samples it was never given
    for (let block = 0; block < 40; block += 1) core.renderBlock(128);
    expect(bridge.lateEvents.map((event) => event.tick)).toEqual([100]);
    expect(bridge.lateEvents[0]!.missedBy).toBe(120);
    // and the late one is never played, on time or otherwise
    expect(core.played.map((event) => event.tick)).toEqual([0]);
  });

  it("never plays an event twice across a long run", () => {
    const { bridge, core } = bridgeFor([{ id: "a" }, { id: "b", plugins: [{ id: "p", latencySamples: 64 }] }]);
    const ticks = Array.from({ length: 120 }, (_, index) => index * 4);
    bridge.schedule(ticks.map((tick) => ({ trackId: "a", tick })));
    bridge.schedule(ticks.map((tick) => ({ trackId: "b", tick })));

    for (let block = 0; block < 400; block += 1) {
      bridge.pump();
      core.renderBlock(128);
    }

    expect(core.late).toHaveLength(0);
    const keys = core.played.map((event) => `${event.trackId}:${event.tick}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(core.played).toHaveLength(240);
  });

  it("keeps compensation intact across a block boundary", () => {
    const { bridge, core } = bridgeFor([{ id: "wet" }, { id: "dry", plugins: [{ id: "p", latencySamples: 300 }] }]);
    // the plugin track is the session's reference and sounds on its musical sample; the plugin-free track waits 300,
    // which is two blocks and a bit later, so the same tick is delivered in a different block on each track
    bridge.schedule([{ trackId: "wet", tick: 0 }, { trackId: "dry", tick: 0 }]);
    const played: { trackId: string; sample: number }[] = [];
    for (let block = 0; block < 4; block += 1) {
      bridge.pump();
      played.push(...core.renderBlock(128).events.map((event) => ({ trackId: event.trackId, sample: event.sample })));
    }
    const wet = played.find((event) => event.trackId === "wet")!;
    const dry = played.find((event) => event.trackId === "dry")!;
    expect(dry.sample).toBe(0);
    expect(wet.sample).toBe(300);
  });

  it("moves both clocks on a seek and drops what was queued", () => {
    const { bridge, core } = bridgeFor([{ id: "a" }]);
    bridge.schedule([{ trackId: "a", tick: 0 }]);
    bridge.seek(99_999);
    expect(bridge.audioPosition).toBe(99_999);
    expect(core.position).toBe(99_999);
    bridge.pump();
    expect(core.renderBlock(128).events).toHaveLength(0);
  });

  it("refuses a seek to a sample that cannot exist", () => {
    const { bridge } = bridgeFor([{ id: "a" }]);
    expect(() => bridge.seek(-1)).toThrow(/non-negative integer/);
    expect(() => bridge.seek(1.5)).toThrow(/non-negative integer/);
  });

  it("keeps the whole session on one clock for a thousand blocks", () => {
    const { bridge, core } = bridgeFor([{ id: "a" }], 4096);
    const total = 1000;
    bridge.schedule(Array.from({ length: total }, (_, index) => ({ trackId: "a", tick: index * 5 })));
    for (let block = 0; block < 4000; block += 1) {
      bridge.pump();
      core.renderBlock(128);
    }
    expect(core.played).toHaveLength(total);
    // every event sounds on its exact musical sample: tick n * 5 at 120 bpm and 48 kHz is n * 250 samples
    expect(core.played.every((event, index) => event.sample === index * 250)).toBe(true);
    expect(bridge.lateEvents).toHaveLength(0);
  });
});
