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

## Status

**Stage 0: scaffolding.** The sample-clocked transport exists and is tested: tick/sample conversion at 44.1 and 48 kHz,
bar/beat/tick derivation from samples, block slicing with an inclusive-start window, chain latency summation. There is no
audio engine, no UI, no plugin host and no file format support yet.

```bash
npm ci && npm run verify
```

## Non-goals

- Not a tracker, not a loop pedal. Timeline plus mixer.
- No cloud collaboration in the first year.
- No attempt at VST compatibility; the plugin format is ours, hosting WASM modules.

## Licence

MIT.
