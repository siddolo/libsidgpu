# Shader Interface

The shared GLSL modules in `shaders/` implement the SID synthesis model. Backend interfaces provide `readState(index)` and `readEvent(index)` along with uniform or push-constant parameters. OpenGL ES and WebGL use fragment passes; Vulkan uses a compute shader. State and PCM layouts are specified in [GPU Formats](gpu-formats.md).

## OpenGL ES / WebGL Program Assembly

Each fragment program is built by concatenating the shader sources in order:

1. `#version 300 es\n` (plus `#define PACKED_PCM\n` when rendering to `RGBA8`);
2. `opengles/interface.glsl`;
3. `common.glsl`, `oscillator.glsl`, `envelope.glsl`, and `filter.glsl`;
4. `opengles/state-update.frag.glsl` (state pass) or `opengles/pcm-render.frag.glsl` (PCM pass).

Both programs link with `opengles/fullscreen.vert.glsl`, which generates a full-viewport triangle from `gl_VertexID` (`glDrawArrays(GL_TRIANGLES, 0, 3)`) without vertex buffers. Disable blending, depth testing, and dithering before drawing so integer and packed RGBA8 values are written unaltered.

### Uniforms

| Name | Type | Description |
| --- | --- | --- |
| `initialState` | `usampler2D` | `11x1` `RGBA32UI` texture holding the segment's initial state |
| `events` | `usampler2D` | `Nx1` `RGBA32UI` texture holding the segment's events |
| `eventCount` | `int` | Number of active events in `events` |
| `sampleRate` | `int` | Output sample rate in Hz |
| `clockFrequency` | `uint` | SID clock in Hz (`985248` PAL or `1022727` NTSC) |
| `count` | `int` | Number of samples in the current segment |
| `pcmOffset` | `int` | Horizontal sample offset of the segment in the output texture (PCM pass) |
| `parallelOscillator` | `bool` | Analytical fixed-sawtooth benchmark mode (`false` for normal synthesis) |

### Two-Pass Segment Execution

For each segment of `count` samples (32 samples in checkpoint mode, or the full block in baseline mode), bind the current state texture `A` on unit 0 and upload the segment's events to unit 1:

```text
                             +-- state pass --> B (viewport 0, 0, 11, 1)
     A + segment events -----|
                             +-- PCM pass ----> output (viewport offset, 0, count, 1)
```

Both passes read `A` and replay the same segment events. After both draws complete, `A` and `B` swap so `B` becomes the input checkpoint for the next segment.

## Vulkan Compute Pipeline

Concatenate `vulkan/interface.glsl`, `common.glsl`, `oscillator.glsl`, `envelope.glsl`, `filter.glsl`, and `vulkan/render.comp.glsl`, and compile the combined source to Vulkan 1.0 SPIR-V.

The compute shader runs with `local_size_x = 32` (one workgroup per 32-sample checkpoint segment) and uses four `std430` storage buffers in descriptor set `0`:

| Binding | Contents | Access |
| --- | --- | --- |
| `0` | Initial state (`11` `uvec4` elements) | `readonly` |
| `1` | Block event buffer (`uvec4` elements) | `readonly` |
| `2` | Output state (`11` `uvec4` elements) | `writeonly` |
| `3` | Output PCM (`int` per sample, quantized to `[-32768, 32767]`) | `writeonly` |

Push constants occupy 20 bytes:

```c
struct parameters {
    uint32_t clockFrequency;
    int32_t sampleRate;
    int32_t eventCount;
    int32_t eventOffset;
    int32_t pcmOffset;
};
```

`eventOffset` indexes the first `uvec4` event of the current 32-sample checkpoint within binding `1`, while event timestamps remain relative to the start of that checkpoint (`0..31`). Invocation `i` (`0..31`) writes `pcm[pcmOffset + i]`, and invocation `31` writes the 11 elements of `nextState`. A compute memory barrier (`VK_ACCESS_SHADER_WRITE_BIT` to `VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT`) orders consecutive dispatches before swapping the ping-pong descriptor sets.
