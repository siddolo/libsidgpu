# C API

The native OpenGL ES and Vulkan hosts implement `hosts/include/sidgpu.h` and build `libsidgpu.so`. Both expose the same sample-addressed event queue and synchronous signed 16-bit mono PCM output.

```c
#include "sidgpu.h"
```

## Lifecycle

```c
sidgpu *sidgpu_create(uint32_t sample_rate, uint32_t block_size, uint32_t clock,
                      char *error, size_t error_size);
void sidgpu_destroy(sidgpu *engine);
const char *sidgpu_error(const sidgpu *engine);
```

`sidgpu_create()` initializes an engine for `sample_rate` (`8000..192000` Hz), `block_size` (`128`, `256`, `512`, `1024`, or `2048` samples), and `clock` (`SIDGPU_CLOCK_PAL` at `985248` Hz or `SIDGPU_CLOCK_NTSC` at `1022727` Hz). On failure it returns `NULL` and writes a message to `error` when a buffer is provided.

The OpenGL ES backend uses the calling thread's current OpenGL ES 3.0 context during creation, rendering, state readback, and destruction. The Vulkan backend creates its own device and compute queue. A single `sidgpu` instance must not be called concurrently from multiple threads.

## Scheduling Events

```c
uint64_t sidgpu_next_sample(const sidgpu *engine);
int sidgpu_schedule_write(sidgpu *engine, uint64_t sample, unsigned address, unsigned value);
int sidgpu_schedule_reset(sidgpu *engine, uint64_t sample);
```

`sidgpu_next_sample()` returns the index of the first sample not yet rendered. `sidgpu_schedule_write()` queues a write of byte `value` (`0..255`) to SID register `address` (`0..24`) at `sample >= sidgpu_next_sample(engine)`. Writes that combine multiple waveform bits on a voice control register (`4`, `11`, `18`) are rejected. `sidgpu_schedule_reset()` clears the synthesizer state at `sample` while keeping the sample counter and any later events intact.

Events at the same sample index execute in insertion order. Each 32-sample checkpoint segment accepts up to `4096` events.

## Rendering and State Snapshot

```c
int sidgpu_render(sidgpu *engine, int16_t *pcm);
int sidgpu_snapshot(sidgpu *engine, uint32_t state[SIDGPU_STATE_WORDS]);
```

`sidgpu_render()` writes `block_size` signed 16-bit mono PCM samples into `pcm` and advances `next_sample` by `block_size`. `sidgpu_snapshot()` copies the 44 `uint32_t` words of the latest checkpoint into `state` (see [GPU Formats](gpu-formats.md)).

Both functions and the scheduling calls return `0` on success and `-1` on error, updating the string returned by `sidgpu_error()`. A GPU error during rendering or snapshot readback leaves the engine unusable; call `sidgpu_destroy()` to release it.
