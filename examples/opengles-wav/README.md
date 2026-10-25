# OpenGL ES WAV Example

`examples/opengles-wav` builds `sidgpu-wav` (`examples/common/wav.c`) against the OpenGL ES `sidgpu` host. It initializes a headless `1x1` EGL pbuffer context and renders two seconds of a 440 Hz sawtooth tone (1.5 s sustain followed by a 0.5 s release) to a 48 kHz mono 16-bit WAV file.

From the repository root:

```sh
make opengles
hosts/opengles/build/examples/opengles-wav/sidgpu-wav /tmp/tone.wav
```

On Mesa, `EGL_PLATFORM=surfaceless` runs the binary without an X11 or Wayland display server:

```sh
EGL_PLATFORM=surfaceless hosts/opengles/build/examples/opengles-wav/sidgpu-wav /tmp/tone.wav
```
