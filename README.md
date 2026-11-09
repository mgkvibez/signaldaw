# signaldaw

**A browser DAW where the clock is honest.**

Dozens of hobby sequencers exist. None of the open ones combine sample-accurate scheduling, plugin delay compensation and
a WASM plugin host. Those three are not features on a list, they are the difference between a toy that plays and a tool
that records.

## The three hard parts, in order

1. **Sample-accurate scheduling.** Musical time is fractional, audio time is integer samples. Store position as samples
   and derive musical time from it, never the reverse. This repository starts here because every timing bug in every
   sequencer traces back to this conversion.
2. **Plugin delay compensation.** A chain of plugins, each with its own latency, must still line up. That means knowing
   the summed latency per path and compensating on playback without artefacts at the splice.
3. **A WASM plugin host.** One process-wide audio graph, plugins in their own modules, sample buffers across a boundary
   that can be shared or copied deliberately.

## What works today

- Transport: position stored as integer samples and musical position derived from it, so it cannot drift; boundary
  rule is inclusive-at-start and exclusive-at-end, so a bar-line event is never one block late.
- Plugin delay compensation (`src/scheduler.ts`): the session runs at the latency of its slowest chain, each track is
  delayed by `sessionLatency - trackLatency`, and the tests assert **audible** alignment rather than identical
  delivery times. A plugin-free track is held back by the full latency; the slowest track gets offset zero.
- 21 tests, of which the drift test checks 750 consecutive callbacks deliver every event exactly once, on the sample.

## What does not work yet

- No audio output yet: this is the clock and the scheduler, not a graph that produces sound.
- No MIDI or sample loading, no WASM plugin host (that is the next milestone), no project file format.
- No sample-rate conversion: both 44.1 and 48 kHz are computed exactly, but resampling is out of scope so far.

## Status

**Stage 0: scaffolding.** The sample-clocked transport exists and is tested: tick/sample conversion at 44.1 and 48 kHz,
bar/beat/tick derivation from samples, block slicing with an inclusive-start window, chain latency summation. There is no
audio engine, no UI, no plugin host and no file format support yet.

**Tests:** 21

```bash
npm ci && npm run verify
```

## Non-goals

- Not a tracker, not a loop pedal. Timeline plus mixer.
- No cloud collaboration in the first year.
- No attempt at VST compatibility; the plugin format is ours, hosting WASM modules.

## Licence

MIT.
