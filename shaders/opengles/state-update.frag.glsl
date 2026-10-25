/* Each fragment replays the entire segment, then writes only its assigned
 * state texel. The repeated simulation avoids scatter writes, which fragment
 * shaders cannot perform, and gives every texel the same final checkpoint. */
layout(location = 0) out uvec4 outputState;
void main() {
  loadState();
  for (int i = 0; i < count; i++) stepSample(i);
  outputState = packState(int(gl_FragCoord.x));
}
