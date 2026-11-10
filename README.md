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
- Audio-thread bridge (`src/bridge.ts`): the audio callback cannot ask the main thread anything, so the main thread
  pushes events ahead of time and the audio thread drains them by absolute sample. Both halves are tested against a
  fake port and a fake clock, which is the part that would otherwise only exist inside a browser.
- 52 tests, of which the drift test checks 750 consecutive callbacks deliver every event exactly once, on the sample.

## The bridge, and what happens when the main thread stalls

Scheduling across threads has one honest failure mode: if the main thread is busy, the audio thread has nothing to play.
The dishonest fix, which most sequencers pick, is to nudge the late event into the next block: it sounds, roughly, and
the session quietly acquires a permanent one-block lag that nobody can date. This bridge counts instead. An event that
misses its sample is reported as late, with the exact number of samples it missed by, and is dropped. A counter at zero is
a bug report; a shifted event is a bug.

The protocol is two message types each way. The main thread sends `schedule` (candidates by absolute sample) and `reset`
(a seek, which is not a late event). The audio thread sends `position` after every block, plus `late` when something
arrived too old to play. Compensation is applied on the main thread, once, so the audio thread receives absolute delivery
samples and knows nothing about plugin latency. Events are deduplicated by track and tick, so a resent batch cannot play
twice.

## Tempo changes, exactly

A session that changes tempo is where float drift starts: each segment contributes a fractional number of samples, and
rounding each one separately walks the grid by a sample per change. `TempoMap` accumulates positions as exact rationals in
BigInt, reduced at every step, and floors once at the end, so a bar line is the same sample whether you ask for it from
the top of the session or from a sample just before it. Ten thousand bars at 127.3 bpm match the exact value, which is a
test rather than a hope.

## What does not work yet

- No audio output yet: this is the clock, the scheduler and the thread bridge, not a graph that produces sound. Nothing
  in this repository creates an `AudioWorkletNode`; the glue in the app is a dozen lines, and untested glue is why it is
  not claimed here.
- The bridge queues events in a plain array rather than a preallocated ring buffer. That is correct and tested, but it
  allocates on the audio thread, which a realtime callback should not do. Fixing that is a scheduling problem, not a
  protocol problem, and the protocol is what exists today.
- No MIDI or sample loading, no WASM plugin host (that is the next milestone), no project file format.
- No sample-rate conversion: both 44.1 and 48 kHz are computed exactly, but resampling is out of scope so far.

## Status

**Stage 0: scaffolding.** The sample-clocked transport, the compensation scheduler and the audio-thread bridge exist and
are tested: tick/sample conversion at 44.1 and 48 kHz, bar/beat/tick derivation from samples, block slicing with an
inclusive-start window, chain latency summation, an exact tempo map, and a cross-thread schedule protocol that reports
stalls instead of hiding them. There is no audio graph, no UI, no plugin host and no file format support yet.

**Tests:** 52

```bash
npm ci && npm run verify
```

## Non-goals

- Not a tracker, not a loop pedal. Timeline plus mixer.
- No cloud collaboration in the first year.
- No attempt at VST compatibility; the plugin format is ours, hosting WASM modules.

## Licence

MIT.
