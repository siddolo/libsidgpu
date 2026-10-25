/* Nominal SID envelope times in seconds, indexed by the 4-bit rate value
 * (0..15). Attack uses AD's upper nibble; decay uses AD's lower nibble.
 * Release uses SR's lower nibble and the same time table as decay. */
const float attackSeconds[16] = float[16](0.002, 0.008, 0.016, 0.024, 0.038, 0.056, 0.068, 0.080, 0.100, 0.250, 0.500, 0.800, 1.0, 3.0, 5.0, 8.0);
const float decaySeconds[16] = float[16](0.006, 0.024, 0.048, 0.072, 0.114, 0.168, 0.204, 0.240, 0.300, 0.750, 1.5, 2.4, 3.0, 9.0, 15.0, 24.0);

/* Advance each envelope by one audio sample. Stage 0 is attack, 1 is decay
 * toward sustain, and 2 is release toward zero. Gate events select the stage
 * in applyEvents() without resetting the current level.
 *
 * Attack adds a constant step. Decay/release use a shifted exponential:
 *
 *   E(t) = (E(0) + 0.01) * exp(-ln(101) * t / T) - 0.01
 *
 * Starting at E(0) = 1, it reaches zero at the nominal SID time T rather than
 * approaching zero forever. Partial envelopes reach zero sooner. Clamp at the
 * selected floor; raising sustain above the current level does not restart an
 * attack. This sample-rate model does not implement the chip's ADSR counters. */
void envelopes() {
  for (int v = 0; v < 3; v++) {
    uint ad = registers[v * 7 + 5];
    uint sr = registers[v * 7 + 6];
    float sustain = float(sr >> 4) / 15.0;
    if (stage[v] == 0u) {
      envelope[v] = min(1.0, envelope[v] + 1.0 / (attackSeconds[ad >> 4] * float(sampleRate)));
      if (envelope[v] >= 1.0) stage[v] = 1u;
    } else {
      float floorLevel = stage[v] == 1u ? sustain : 0.0;
      uint rate = stage[v] == 1u ? ad & 15u : sr & 15u;
      if (envelope[v] > floorLevel) envelope[v] = max(floorLevel, (envelope[v] + 0.01) * exp(-4.6151205 / (decaySeconds[rate] * float(sampleRate))) - 0.01);
    }
  }
}
