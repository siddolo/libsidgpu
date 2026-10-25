# Validation

## Test Suites

Unit tests (`npm test`, powered by Vitest) are split between `hosts/webgl/tests/unit/` and `examples/web-synth/tests/unit/`. They cover:

- conversion between Hz frequencies and 16-bit registers, along with SID register write validation;
- sample timeline event ordering and block/segment partitioning;
- out-of-order block reassembly in `PCMQueue`, underrun handling in `PCMRing`, `RGBA8` PCM16 decoding, and WAV encoding;
- PSID header parsing and 6502 execution in `SIDDriver` (load addresses, subsong selection, CIA timers, memory banking, non-returning routines, and unsupported hardware reads).

Browser tests (`npm run test:browser -- --headed`, powered by Playwright and Chromium) in `examples/web-synth/tests/browser/` execute the WebGL 2 shaders and verify:

- 440 Hz tone frequency, phase continuity across blocks, and numerical equivalence between `baseline` and `checkpoint` strategies (within `1e-6`);
- a maximum difference of 1 LSB between `RGBA32F` readback and `RGBA8` PCM16 packing;
- sample-accurate event application, `TEST` bit reset, deterministic LFSR stepping, and envelope retriggering;
- filter stability at maximum resonance, low-pass attenuation, pulse duty cycles, `Ring` modulation, `Sync` topology, and `Voice 3 off` routing;
- PSID upload and playback in the UI, WAV export, offline render cancellation, and 120 seconds of continuous AudioWorklet playback without underruns.

Native host tests (`make test`, defined in `tests/hosts/engine.c` and run via CTest) execute against both the OpenGL ES and Vulkan implementations and verify:

- exact digital state agreement with the 18 reSID reference vectors;
- sample-accurate event ordering, same-sample reset/write precedence, and atomic rejection when a checkpoint exceeds `4096` events;
- bit-identical PCM and final state across block sizes `128`, `256`, `512`, `1024`, and `2048` on both PAL and NTSC clocks;
- 440 Hz fundamental frequency on a rendered sawtooth tone.

## reSID Reference Vectors

`tests/reference/resid-digital.json` contains 18 reference vectors generated from reSID (`MOS8580`, stepped via `clock(delta_t)` at commit `3bf8eff22bc81743d2d5fa089eaf2414bf3ed6e4`). The configurations cross 44100 and 48000 Hz sample rates, frequency register values `0`, `7492`, and `65535`, and durations of 128, 1024, and 4096 samples. Both the browser and native test suites check for exact equality of the 24-bit phase accumulator and 23-bit noise LFSR.

To regenerate the JSON vectors from a local reSID checkout (using a C++ compiler, Python 3, and Perl):

```sh
git clone https://github.com/libsidplayfp/resid.git /tmp/resid
git -C /tmp/resid checkout 3bf8eff22bc81743d2d5fa089eaf2414bf3ed6e4
python3 tests/reference/generate.py /tmp/resid
```
