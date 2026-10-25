/* Mix enveloped voices into separate dry and filter inputs, advance the filter,
 * and return normalized mono PCM. The filter runs even when none of its output
 * modes are selected, so enabling a mode does not start from a fresh state. */
float mixAndFilter() {
  float routed = 0.0;
  float dry = 0.0;
  for (int v = 0; v < 3; v++) {
    float value = registers[v * 7 + 4] >> 4 == 0u ? 0.0 : (float(waveform(v)) / 2047.5 - 1.0) * envelope[v] / 3.0;
    if ((registers[23] & (1u << v)) != 0u) routed += value;
    /* Voice 3 off suppresses only the direct mixer path, not the filter input. */
    else if (v != 2 || (registers[24] & 128u) == 0u) dry += value;
  }
  uint cutoff = (registers[21] & 7u) | (registers[22] << 3);
  /* The tan() prewarp diverges at Nyquist (0.5 * sampleRate). Limiting cutoff
   * to 0.45 * sampleRate leaves a 10% margin below that frequency. */
  float hz = min(12500.0 * float(cutoff) / 2047.0, float(sampleRate) * 0.45);
  float g = tan(3.14159265359 * hz / float(sampleRate));
  /* Approximate 8580 resistor-ladder relation documented by reSID: 1/Q. */
  float damping = exp2((4.0 - float(registers[23] >> 4)) / 8.0);
  /* Solve the filter feedback loop within this sample. If s1 and s2 are the
   * integrator histories stored in filterState, the trapezoidal equations are:
   *
   *   band = s1 + g * high
   *   low  = s2 + g * band
   *   high = routed - damping * band - low
   *
   * Substitution gives the denominator below. Using current-sample feedback
   * avoids the high-cutoff instability of an explicit Euler update. The next
   * histories are 2*band-s1 and 2*low-s2, not the band and low outputs themselves. */
  float band = (filterState.x + g * (routed - filterState.y)) / (1.0 + g * (g + damping));
  float low = filterState.y + g * band;
  float high = routed - damping * band - low;
  filterState = vec2(2.0 * band - filterState.x, 2.0 * low - filterState.y);
  /* Selected filter modes add together before rejoining the dry voices. */
  float filtered = 0.0;
  if ((registers[24] & 16u) != 0u) filtered += low;
  if ((registers[24] & 32u) != 0u) filtered += band;
  if ((registers[24] & 64u) != 0u) filtered += high;
  registers[27] = waveform(2) >> 4;
  /* The 0.7 output gain leaves about 3 dB of headroom. Resonance and summed
   * filter modes can still exceed that margin, so clamp the final PCM. */
  return clamp((dry + filtered) * float(registers[24] & 15u) / 15.0 * 0.7, -1.0, 1.0);
}

/* Apply writes before advancing time. Keep the division remainder as state:
 * over N samples the oscillators receive floor((initial remainder + N*clock)
 * / sampleRate) cycles, regardless of how those samples are split into blocks. */
float stepSample(int index) {
  applyEvents(index);
  remainder += clockFrequency;
  uint cycles = remainder / uint(sampleRate);
  remainder %= uint(sampleRate);
  oscillators(cycles);
  envelopes();
  return mixAndFilter();
}
