# Synthesis Model and Limitations

## Oscillators

Each voice steps a 24-bit integer phase accumulator at every output sample by the number of elapsed PAL or NTSC clock cycles. The noise generator clocks a 23-bit LFSR (taps on bits 22 and 17) on every rising edge of phase bit 19 and forms its 8-bit output from bits `20, 18, 14, 11, 9, 5, 2, 0`.

Hard **Sync** resets the destination voice phase on rising edges of the source voice MSB (`voice 3 > voice 1 > voice 2 > voice 3`), quantized to the sample boundary. **Ring** modulation XORs the triangle MSB with the source voice MSB. Setting **TEST** holds the phase at zero and resets the LFSR to `0x7fffff`.

Only single waveforms (triangle, sawtooth, pulse, noise) are supported; writes with multiple waveform bits set are rejected. Because oscillators step at the audio sample rate without oversampling or BLEP, high frequencies alias.

## Envelopes

The ADSR generator updates a floating-point level in `[0, 1]` at each sample from the 16 nominal SID durations: 2 ms to 8 s for the linear attack ramp, and 6 ms to 24 s for the shifted exponential decay/release curve. Sustain equals the 4-bit register value divided by 15.

Toggling **Gate** switches to attack or release from the current level without a step discontinuity. The hardware's integer rate counters and exponential divider tables (along with the ADSR delay bug) are not emulated.

## Filter and Mixer

The filter is a two-integrator trapezoidal (TPT) state-variable design modeled after the MOS 8580. The 11-bit cutoff register maps linearly to `0 - 12.5 kHz` (clamped at 45% of the sample rate), and the 4-bit resonance register sets damping as `1/Q = 2^((4 - res) / 8)`.

Any combination of low-pass, band-pass, and high-pass outputs can be enabled together. Voices bypassed around the filter go straight to the mixer, where **Voice 3 off** mutes voice 3 unless it is routed into the filter. The sum is scaled by the 4-bit master volume and clamped to `[-1, 1]`, without modeling analog saturation, DAC DC offsets, or the 6581 filter response.

## Diagnostics

When the browser and driver expose `EXT_disjoint_timer_query_webgl2`, the WebGL host measures GPU pass durations per block. In the web synth, estimated note-on latency adds the duration of samples queued between the GPU and the AudioWorklet to `AudioContext.baseLatency` and `outputLatency`.

## References

- [reSID](https://github.com/libsidplayfp/resid) (`wave.h`, `envelope.cc`, `filter8580new.cc`) for the digital oscillator/LFSR logic and nominal 8580 parameters.
- [The Art of VA Filter Design](https://www.native-instruments.com/fileadmin/ni_media/downloads/pdf/VAFilterDesign_2.1.0.pdf) by Vadim Zavalishin for the TPT state-variable filter formulation.
- [WebGL 2 Specification](https://registry.khronos.org/webgl/specs/latest/2.0/) for integer textures and Pixel Buffer Object transfers.
