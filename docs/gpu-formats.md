# GPU Formats

## State Layout

The OpenGL ES and WebGL hosts store state in two `11x1` `RGBA32UI` textures with `NEAREST` filtering, ping-ponged across segments. Vulkan stores the same layout in two storage buffers of 11 `uvec4` elements. Each element holds four 32-bit unsigned integers:

| Element | Components |
| --- | --- |
| 0-6 | Registers 0-27 in order; 25 and 26 reserved, 27 holds `OSC3` |
| 7-9 | Per voice: 24-bit phase, 23-bit LFSR, envelope level (IEEE 754 float32 bits), ADSR stage |
| 10 | Filter integrator histories, band-pass then low-pass (IEEE 754 float32 bits), clock remainder, 8-bit `ENV3` |

ADSR stages are encoded as `0` (attack), `1` (decay/sustain), and `2` (release). Continuous values (envelope level and filter states) are packed into integer words with `floatBitsToUint` and unpacked with `uintBitsToFloat`, avoiding numeric conversion and keeping state storage independent of float render target support.

The WebGL host's `snapshot()` asynchronously reads back the 11 texels of the current state texture through a PBO. The C hosts' `sidgpu_snapshot()` reads the same state synchronously.

## Event Layout

OpenGL ES and WebGL upload each segment's events to an `Nx1` `RGBA32UI` texture (minimum `1x1`). Vulkan uploads block events into a storage buffer and selects each segment's range through push constants. Each event contains four unsigned 32-bit words:

1. sample offset relative to the start of the segment;
2. register address (`0-24`);
3. register value (`0-255`);
4. event type (`0` for register write, `1` for state reset).

The active event count for the segment (up to 4096) is passed as `eventCount`, using a uniform on OpenGL ES or a push constant on Vulkan.

## PCM Output

When the WebGL context supports `EXT_color_buffer_float`, the PCM framebuffer uses a block-wide `RGBA32F` texture and writes the normalized sample to the `R` channel.

The OpenGL ES host uses an `RGBA8` framebuffer, as does the WebGL host without float support. This format encodes 16-bit offset-binary PCM across `R` (low byte) and `G` (high byte):

```text
q = clamp(floor(s * 32768 + 32768.5), 0, 65535)
R = q & 255
G = q >> 8
B = 0
A = 255
s_decoded = (R + 256 * G - 32768) / 32768
```

The representable range spans `-1.0` to `32767 / 32768`. Rounding introduces at most half an LSB of error within that range; positive saturation increases the error to 1 LSB at input `+1.0`. The web demo's WAV export converts samples to signed little-endian 16-bit integers.

Vulkan applies the same quantization and stores `q - 32768` in a signed 32-bit word per sample. After fence completion, the C host reads coherent mapped memory and narrows each word to `int16_t`.

## WebGL Asynchronous Readback

At the end of each block, `readPixels` copies the PCM framebuffer into a dedicated `PIXEL_PACK_BUFFER` and inserts a fence with `fenceSync`. On subsequent ticks, `ReadbackQueue` polls the fence via `clientWaitSync` with a zero timeout and reads the buffer with `getBufferSubData` once signaled. A fence that remains unsignaled after 10 seconds raises a timeout error.

The web demo's diagnostics report the elapsed time between `fenceSync` submission and fence completion polling (`Readback fence`) separately from the host memory read (`Readback CPU copy`).
