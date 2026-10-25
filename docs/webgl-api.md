# WebGL 2 API

The `libsidgpu` npm package exposes the WebGL 2 host as an ES module with
TypeScript declarations. See the [WebGL 2 Host](https://github.com/siddolo/libsidgpu/blob/main/hosts/webgl/README.md)
for installation and a playable example.

## SIDEngine

```ts
new SIDEngine(
  sampleRate,
  blockSize = 256,
  strategy = 'checkpoint',
  packed = false,
  clock = 985248,
)
```

Construction creates a private WebGL 2 context and compiles the shaders.
It throws if parameters are invalid or GPU initialization fails.

| Parameter | Accepted values |
| --- | --- |
| `sampleRate` | Integer output rate in Hz, `8000..192000`; use `AudioContext.sampleRate` for playback |
| `blockSize` | `128`, `256`, `512`, `1024`, or `2048`, also exported as `BLOCK_SIZES` |
| `strategy` | `'checkpoint'`, `'baseline'`, or `'parallel'`; exported as the `Strategy` type |
| `packed` | `true` forces PCM16 packing in RGBA8; `false` uses floating-point output when supported |
| `clock` | `985248` for PAL or `1022727` for NTSC |

`checkpoint` uses 32-sample segments. `baseline` uses one segment per block.
`parallel` is a fixed-sawtooth benchmark experiment and rejects scheduled events,
including register writes and resets.

### Scheduling

Sample indices are absolute positions starting at zero, measured at the output
sample rate. `nextSample` is the first sample not yet submitted for synthesis;
it is not the playback position. Treat it as read-only.

```ts
export type SIDEvent =
  | { type: 'register-write'; address: number; value: number }
  | { type: 'reset' };

export interface ScheduledEvent {
  sampleIndex: number;
  event: SIDEvent;
}
```

| Method | Behavior |
| --- | --- |
| `schedule(sampleIndex, event)` | Apply an event before synthesizing that sample. The index must be a safe integer at or after `nextSample`. |
| `writeRegister(address, value)` | Schedule a register write at `nextSample`. |
| `reset()` | Discard pending events and schedule a reset at `nextSample`. The sample timeline continues. |

Writes accept integer addresses `0..24` and byte values `0..255`. Control
registers `4`, `11`, and `18` accept at most one waveform bit in the upper nibble.
Invalid writes throw before insertion.

Events with equal sample indices execute in insertion order, including Gate
off/on pairs. At most 4096 events may fall in one segment: 32 samples in
checkpoint mode or `blockSize` samples in baseline mode.

A scheduled `{ type: 'reset' }` clears synthesis state while retaining later
events. Unlike `reset()`, it does not clear the pending queue. Neither operation
removes PCM already submitted for playback.

### Rendering and Readback

| Member | Behavior |
| --- | --- |
| `render()` | Submit one block and advance `nextSample` by `blockSize`. PCM becomes available asynchronously. |
| `readback.count` | Number of submitted blocks awaiting retrieval, up to four. |
| `readback.poll()` | Return the completed prefix of blocks in submission order, or an empty array. Does not wait for GPU completion. |
| `readback.float` | Whether readback uses floating-point GPU output. Returned samples are always a `Float32Array`. |

```ts
export interface PCMBlock {
  sequence: number;
  startSample: number;
  samples: Float32Array;
}
```

Sequence numbers start at zero; `startSample` identifies
the first sample in the block. Each block contains `blockSize` normalized mono
samples in `[-1, 1]`. The caller owns the returned array and may transfer its
buffer to an AudioWorklet.

Drain readback regularly and yield to the browser while waiting for completion.
Calling `render()` with four pending blocks throws before submitting more work.
Readback throws on context loss, failed waits, non-finite PCM, or a pending
fence exceeding 10 seconds. Dispose the engine after a submission or readback
failure; synthesis state may already have advanced.

### Inspection and Lifetime

| Member | Behavior |
| --- | --- |
| `snapshot()` | Return a `Promise<Uint32Array>` containing 44 words from the latest submitted checkpoint. Rendering may continue while it is pending. |
| `readRegister(address)` | Return `255` for POTX/POTY (`25`, `26`); throw for other addresses. Use `snapshot()` to inspect GPU state. |
| `renderer` | GPU renderer description supplied by the browser. |
| `dispose()` | Release GPU resources. Repeated calls are harmless; do not reuse the engine afterwards. |

Snapshots describe synthesis progress, which may be ahead of audible playback.
They reject on context loss or a 10-second timeout. The
[GPU state layout](gpu-formats.md)
specifies the register and internal-state offsets.

## Register Utilities

| Export | Behavior |
| --- | --- |
| `SID_CLOCK` | PAL clock frequency, `985248` Hz. |
| `CONTROL` | Bit masks: `GATE=1`, `SYNC=2`, `RING=4`, `TEST=8`, `TRIANGLE=16`, `SAW=32`, `PULSE=64`, `NOISE=128`. |
| `frequencyRegister(hz)` | Round a frequency to the nearest 16-bit SID register value using the PAL clock. Reject non-finite or out-of-range frequencies. |
| `registerFrequency(value, clock = SID_CLOCK)` | Convert a register value to Hz using the selected clock. |
| `noteFrequency(note)` | Convert a MIDI note number to Hz with A4 (`69`) at `440` Hz. |
| `validateRegister(address, value)` | Validate a writable register and byte value, including waveform restrictions; throw on invalid input. |

`frequencyRegister()` always uses PAL timing. For an NTSC engine, compute
`Math.round(hz * 16777216 / 1022727)` and ensure the result is in `0..65535`.

## Queue and PCM Utilities

These exports support applications that manage their own scheduling or audio
transport.

### EventQueue

`new EventQueue()` creates a timeline starting at sample zero.

- `schedule(sampleIndex, event)` inserts an event in timestamp order and rejects
  writes into an interval already consumed.
- `take(start, length)` removes and returns events in `[start, start + length)`
  as `ScheduledEvent[]`. Calls must cover adjacent intervals starting at zero.
  Each call accepts at most 4096 events. Treat a failed `take()` as fatal to
  that queue.
- `clear()` removes pending events without rewinding the consumed timeline.

`SIDEngine` manages its own event queue. Applications using the engine normally
schedule through `engine.schedule()` or `engine.writeRegister()`.

### PCMQueue

`new PCMQueue()` assembles blocks starting at sequence zero and sample zero.
`push(block)` returns the contiguous `PCMBlock[]` prefix ready for consumption,
retaining blocks whose predecessors have not arrived.

It throws for duplicate or stale blocks, holes or overlaps in sample positions,
or more than 32 waiting blocks. Treat a failed `push()` as fatal to that queue.
Retained sample arrays are borrowed, so leave them intact until returned.
Engine readback already returns blocks in order; this utility is useful when
another transport can reorder them.

### PCMRing

`new PCMRing(capacity)` creates a mono FIFO; supply a positive integer capacity
in samples.

- `push(samples)` copies a `Float32Array` into the ring. Overflow throws before
  changing its contents.
- `pull(output)` fills an output `Float32Array`, padding shortages with silence.
- `fill` reports queued samples.
- `consumed` counts actual PCM samples delivered, excluding silence padding.
- `underruns` counts calls to `pull()` that could not fill the entire output.

Treat the counters as read-only. A ring has no reset method; create a new one
for a new playback session.

### decodePCM16

`decodePCM16(bytes: Uint8Array)` returns a new `Float32Array` decoded from complete
RGBA8 texels; supply a byte length divisible by four. R contains the low byte
and G the high byte of offset-binary PCM16. B and A are ignored.

## Continuous Playback with AudioWorklet

For interactive playback, run `SIDEngine` on the main thread and send completed
PCM blocks to an AudioWorklet. The processor consumes PCM from a FIFO; GPU
submission and readback happen outside the audio callback.

Create the engine at the AudioContext's actual sample rate. Prefill the FIFO
before starting playback, then replenish it using the difference between
`engine.nextSample` and the worklet's consumed-sample counter. That difference
includes blocks still waiting for GPU readback.

The web synth contains a complete integration:

- [AudioEngine.ts](https://github.com/siddolo/libsidgpu/blob/main/examples/web-synth/src/audio/AudioEngine.ts)
  manages startup, prefill and buffer transfers.
- [sid-worklet.ts](https://github.com/siddolo/libsidgpu/blob/main/examples/web-synth/src/audio/sid-worklet.ts)
  consumes PCM and reports playback progress.

The example uses Vite's `?worker&url` import to bundle the worklet. Applications
using another build system must provide an equivalent module URL to
`audioContext.audioWorklet.addModule()`.
