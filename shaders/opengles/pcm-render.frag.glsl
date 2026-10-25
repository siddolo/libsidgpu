/* One fragment owns one PCM texel. Reconstruct its sample from the checkpoint
 * by replaying samples 0 through index, inclusive. gl_FragCoord is relative to
 * the full output texture, so subtract pcmOffset to recover the segment index. */
layout(location = 0) out vec4 outputPCM;
uniform int pcmOffset;
void main() {
  loadState();
  int index = int(gl_FragCoord.x) - pcmOffset;
  float value = 0.0;
  if (parallelOscillator) {
    /* For a fixed saw with a unit envelope and no filter or events, phase can
     * be evaluated directly. SIDEngine initializes precisely that experiment. */
    uint cycles = (remainder + uint(index + 1) * clockFrequency) / uint(sampleRate);
    uint p = (phase[0] + frequency(0) * cycles) & 0xffffffu;
    value = (float(p >> 12) / 2047.5 - 1.0) / 3.0 * 0.7;
  } else for (int i = 0; i <= index; i++) value = stepSample(i);
  #ifdef PACKED_PCM
    /* Offset binary places silence at 32768. The two bytes travel through R/G;
     * decodePCM16() reverses this mapping after readback. +1 saturates at 65535. */
    uint q = uint(clamp(floor(value * 32768.0 + 32768.5), 0.0, 65535.0));
    outputPCM = vec4(float(q & 255u), float(q >> 8), 0.0, 255.0) / 255.0;
  #else
    outputPCM = vec4(value, 0.0, 0.0, 1.0);
  #endif
}
