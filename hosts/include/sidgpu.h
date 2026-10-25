#ifndef SIDGPU_H
#define SIDGPU_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* SID clock frequencies in Hz for PAL and NTSC C64 timing. */
#define SIDGPU_CLOCK_PAL 985248u
#define SIDGPU_CLOCK_NTSC 1022727u
/* Snapshot size in uint32_t words: 11 GPU state elements, 4 words each.
 * Includes registers and internal synthesis state; see docs/gpu-formats.md. */
#define SIDGPU_STATE_WORDS 44

typedef struct sidgpu sidgpu;

/* Link one host implementation. OpenGL ES requires a caller-owned current
 * context; Vulkan owns its device and command queue.
 * sample_rate: 8000..192000; block_size: 128, 256, 512, 1024 or 2048.
 * clock must be SIDGPU_CLOCK_PAL or SIDGPU_CLOCK_NTSC.
 * On failure, create returns NULL and writes a diagnostic to error, if supplied. */
sidgpu *sidgpu_create(uint32_t sample_rate, uint32_t block_size, uint32_t clock,
                      char *error, size_t error_size);
void sidgpu_destroy(sidgpu *engine);

/* Scheduling, rendering and snapshots return 0 on success, -1 on failure.
 * Diagnostics remain valid until the next failed call.
 * Do not use an engine concurrently. */
const char *sidgpu_error(const sidgpu *engine);
/* Return the absolute index of the first sample not yet rendered. */
uint64_t sidgpu_next_sample(const sidgpu *engine);

/* Absolute sample times must be at or after next_sample. Equal timestamps keep
 * insertion order. A scheduled reset resets SID state, not the sample timeline
 * or pending events. Writes require address 0..24 and value 0..255; control
 * registers 4, 11 and 18 accept at most one waveform bit in the upper nibble.
 * Rejected events leave the queue unchanged. */
int sidgpu_schedule_write(sidgpu *engine, uint64_t sample, unsigned address, unsigned value);
int sidgpu_schedule_reset(sidgpu *engine, uint64_t sample);

/* Synchronously render block_size signed mono PCM16 samples. The caller owns
 * that output buffer. GPU failures invalidate the engine; destroy it afterwards. */
int sidgpu_render(sidgpu *engine, int16_t *pcm);

/* Synchronously read the latest checkpoint using the shared GPU state layout. */
int sidgpu_snapshot(sidgpu *engine, uint32_t state[SIDGPU_STATE_WORDS]);

#ifdef __cplusplus
}
#endif
#endif
