# OpenGL ES Host

`hosts/opengles` implements the `libsidgpu` [C API](../../docs/c-api.md) on OpenGL ES 3.0.

## Build

Requires CMake 3.19+, a C99 compiler, `pkg-config`, and development packages for EGL and OpenGL ES 3. From the repository root:

```sh
make opengles
make test-opengles
```

To invoke CMake directly:

```sh
cmake -S hosts/opengles -B hosts/opengles/build -DCMAKE_BUILD_TYPE=Release
cmake --build hosts/opengles/build --parallel
ctest --test-dir hosts/opengles/build --output-on-failure
```

The build embeds the GLSL sources from `shaders/` and outputs `hosts/opengles/build/libsidgpu.so` along with the [EGL WAV example](../../examples/opengles-wav/README.md).

## Context Requirements

An OpenGL ES 3.0 context created by the application must be current on the calling thread when invoking `sidgpu_create()`, `sidgpu_render()`, `sidgpu_snapshot()`, and `sidgpu_destroy()`. Context lifetime remains managed by the application.
