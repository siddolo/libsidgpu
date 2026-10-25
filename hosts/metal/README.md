# Metal Host Design Notes

A Metal host for Apple platforms can implement the `libsidgpu` [C API](../../docs/c-api.md) by translating the Vulkan compute shader (`shaders/vulkan/render.comp.glsl`) to Metal Shading Language (MSL).

## Shader Pipeline

```text
GLSL (shaders/vulkan + shared modules) > SPIR-V (glslangValidator) > MSL (SPIRV-Cross) > Metallib
```

1. Concatenate `shaders/vulkan/interface.glsl`, `common.glsl`, `oscillator.glsl`, `envelope.glsl`, `filter.glsl`, and `shaders/vulkan/render.comp.glsl`.
2. Compile to SPIR-V with `glslangValidator -V --target-env vulkan1.0`.
3. Translate SPIR-V to MSL with `spirv-cross --msl`.
4. Compile the MSL source with `xcrun -sdk macosx metal` and `metallib` at build time (or `newLibraryWithSource:options:error:` at startup).

## Buffers and Dispatch

Each `sidgpu` instance manages an `MTLDevice`, an `MTLCommandQueue`, an `MTLComputePipelineState`, and four `MTLBuffer` allocations in `MTLResourceStorageModeShared` memory:

- two state buffers of 11 `uint4` elements each, swapped between segments;
- an event buffer sized for `(block_size / 32) * 4096` `uint4` elements;
- a PCM buffer of `block_size` `int32_t` words, narrowed to `int16_t` when copied to the caller's buffer.

During `sidgpu_render()`, the host encodes one 32-thread threadgroup (`MTLSizeMake(32, 1, 1)`) per 32-sample checkpoint segment, inserts a buffer memory barrier (`MTLBarrierScopeBuffers`) before swapping the two state bindings for the next segment, and waits for the command buffer to complete before copying the rendered PCM.
