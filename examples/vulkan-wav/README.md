# Vulkan WAV Example

`examples/vulkan-wav` builds `sidgpu-wav` (`examples/common/wav.c`) against the Vulkan `sidgpu` host and renders two seconds of a 440 Hz sawtooth tone (1.5 s sustain followed by a 0.5 s release) to a 48 kHz mono 16-bit WAV file.

From the repository root:

```sh
make vulkan
hosts/vulkan/build/examples/vulkan-wav/sidgpu-wav /tmp/tone.wav
```
