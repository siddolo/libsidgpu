uint frequency(int v) { return registers[v * 7] | (registers[v * 7 + 1] << 8); }

/* Advance all oscillators by the chip cycles assigned to one audio sample.
 *
 * Phase accumulators are 24-bit unsigned integers, while the GLSL uint type is
 * 32-bit. Before masking `end` to 24 bits, we can count rising edges of bit B
 * across [phase[v], end] by shifting the rising threshold (2^B) to a multiple
 * of the period (2^(B+1)):
 *
 *   bit B:      0 ------ 1 ------ 0 ------ 1
 *   phase:      0       2^B     2^(B+1)  3*2^B
 *   + 2^B:     2^B    2^(B+1)   3*2^B   2*2^(B+1)
 *                        ^ rising edge crosses a multiple of 2^(B+1)
 *
 * For MSB (bit 23), 2^23 = 0x800000 and 2^24 = 0x1000000.
 * For the noise clock (bit 19), 2^19 = 0x80000 and 2^20 = 0x100000.
 *
 * Record all natural MSB rises first, then apply hard sync at the sample
 * boundary. Resetting a destination inside the first loop would make voice
 * coupling depend on loop iteration order. */
void oscillators(uint cycles) {
  bool rising[3];
  for (int v = 0; v < 3; v++) {
    uint control = registers[v * 7 + 4];
    rising[v] = false;
    if ((control & 8u) != 0u) {
      phase[v] = 0u;
      noise[v] = 0x7fffffu;
    } else {
      uint end = phase[v] + frequency(v) * cycles;
      rising[v] = (end + 0x800000u) / 0x1000000u != (phase[v] + 0x800000u) / 0x1000000u;
      /* Bit 19 rises at 2^19 + k*2^20. Subtracting the two crossing counts
       * includes every noise clock, even when several occur in one audio sample. */
      uint edges = (end + 0x80000u) / 0x100000u - (phase[v] + 0x80000u) / 0x100000u;
      for (uint edge = 0u; edge < edges; edge++) {
        uint feedback = ((noise[v] >> 22) ^ (noise[v] >> 17)) & 1u;
        noise[v] = ((noise[v] << 1) | feedback) & 0x7fffffu;
      }
      phase[v] = end & 0xffffffu;
    }
  }
  /* Sync follows voice 3 > voice 1 > voice 2 > voice 3. If a source is itself
   * synchronized by an upstream rise in this interval, suppress its reset of
   * the destination. All decisions use the rises captured before this loop. */
  for (int v = 0; v < 3; v++) {
    int source = (v + 2) % 3;
    int upstream = (source + 2) % 3;
    bool syncRequested = (registers[v * 7 + 4] & 2u) != 0u && rising[source];
    bool syncSuppressed = (registers[source * 7 + 4] & 2u) != 0u && rising[upstream];
    if (syncRequested && !syncSuppressed) {
      phase[v] = 0u;
    }
  }
}

/* Read a 12-bit waveform from the current phase without advancing it. Triangle
 * folds the accumulator around its MSB; saw takes the upper 12 bits; pulse
 * compares those bits with the width register. Noise uses selected LFSR taps
 * for bits 11..4 of the DAC word and leaves the bottom four bits zero. */
uint waveform(int v) {
  uint control = registers[v * 7 + 4];
  uint wave = control >> 4;
  if (wave == 1u) {
    uint p = phase[v];
    uint sign = p;
    /* Ring modulation alters the triangle inversion bit; it does not multiply
     * the two audio outputs or modify either phase accumulator. */
    if ((control & 4u) != 0u) sign ^= phase[(v + 2) % 3];
    if ((sign & 0x800000u) != 0u) p = ~p;
    return (p >> 11) & 0xffeu;
  }
  if (wave == 2u) return phase[v] >> 12;
  if (wave == 4u) {
    uint width = registers[v * 7 + 2] | ((registers[v * 7 + 3] & 15u) << 8);
    return (control & 8u) != 0u || (phase[v] >> 12) >= width ? 4095u : 0u;
  }
  if (wave == 8u) {
    const int taps[8] = int[8](20, 18, 14, 11, 9, 5, 2, 0);
    uint result = 0u;
    for (int bit = 0; bit < 8; bit++) result |= ((noise[v] >> taps[bit]) & 1u) << (11 - bit);
    return result;
  }
  return 2048u;
}
