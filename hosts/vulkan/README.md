# Vulkan Host

`hosts/vulkan` implements the `libsidgpu` [C API](../../docs/c-api.md) on a Vulkan 1.0 compute queue.

## Build

Requires CMake 3.19+, a C99 compiler, Vulkan headers and loader, and `glslangValidator`. From the repository root:

```sh
make vulkan
make test-vulkan
```

To invoke CMake directly:

```sh
cmake -S hosts/vulkan -B hosts/vulkan/build -DCMAKE_BUILD_TYPE=Release
cmake --build hosts/vulkan/build --parallel
ctest --test-dir hosts/vulkan/build --output-on-failure
```

CMake compiles the compute shader to SPIR-V, embeds it into `hosts/vulkan/build/libsidgpu.so`, and builds the [Vulkan WAV example](../../examples/vulkan-wav/README.md).

## Device Management

`sidgpu_create()` initializes a `VkInstance` and selects the first physical device with a compute queue (`VK_QUEUE_COMPUTE_BIT`), so it runs headless without a display server. `sidgpu_destroy()` waits for the device to go idle and releases all Vulkan handles.
