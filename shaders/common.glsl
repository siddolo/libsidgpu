/* State layout across 11 uvec4 elements (44 uint32 words):
 *
 *   element   .x                 .y                 .z                 .w
 *   [0..6]    registers[4*i+0]   registers[4*i+1]   registers[4*i+2]   registers[4*i+3]
 *   [7..9]    phase[v] (24-bit)  noise[v] (23-bit)  envelope[v] bits   stage[v] (0..2)
 *   [10]      filterState.x bits filterState.y bits remainder          ENV3 (8-bit)
 *
 * Register 27 (element 6, .w) holds OSC3. Float bitcasts preserve the envelope
 * and filter integrators in integer storage without float render targets.
 * Keep loadState(), packState() and host initialization (SIDEngine and
 * sidgpu_create()) synchronized when changing this layout. */
uint registers[28];
uint phase[3];
uint noise[3];
float envelope[3];
uint stage[3];
uint remainder;
vec2 filterState;
int eventCursor;

/* Reset the synthesizer without rewinding eventCursor. A reset may itself be
 * an event inside this segment; rewinding would replay it and earlier writes. */
void resetState() {
  for (int i = 0; i < 28; i++) registers[i] = 0u;
  for (int v = 0; v < 3; v++) {
    phase[v] = 0u;
    noise[v] = 0x7fffffu;
    envelope[v] = 0.0;
    stage[v] = 2u;
  }
  remainder = 0u;
  filterState = vec2(0.0);
}

void loadState() {
  for (int i = 0; i < 7; i++) {
    uvec4 data = readState(i);
    for (int j = 0; j < 4; j++) registers[i * 4 + j] = data[j];
  }
  for (int v = 0; v < 3; v++) {
    uvec4 data = readState(7 + v);
    phase[v] = data.x;
    noise[v] = data.y;
    envelope[v] = uintBitsToFloat(data.z);
    stage[v] = data.w;
  }
  uvec4 data = readState(10);
  filterState = uintBitsToFloat(data.xy);
  remainder = data.z;
  eventCursor = 0;
}

uvec4 packState(int texel) {
  if (texel < 7) return uvec4(registers[texel * 4], registers[texel * 4 + 1], registers[texel * 4 + 2], registers[texel * 4 + 3]);
  if (texel < 10) {
    int v = texel - 7;
    return uvec4(phase[v], noise[v], floatBitsToUint(envelope[v]), stage[v]);
  }
  return uvec4(floatBitsToUint(filterState), remainder, uint(envelope[2] * 255.0));
}

/* Consume every event due before this sample is synthesized. Equal timestamps
 * retain their upload order, so Gate off/on pairs change stage even though no
 * audio sample falls between the two writes. */
void applyEvents(int sampleIndex) {
  while (eventCursor < eventCount) {
    uvec4 e = readEvent(eventCursor);
    if (int(e.x) > sampleIndex) break;
    if (e.w == 1u) resetState();
    else {
      int address = int(e.y);
      if (address < 21 && address % 7 == 4) {
        int v = address / 7;
        /* Gate changes the envelope stage, not its level. Interrupted attacks
         * and retriggers therefore remain continuous at the event sample. */
        if ((registers[address] & 1u) != (e.z & 1u)) stage[v] = (e.z & 1u) != 0u ? 0u : 2u;
      }
      registers[address] = e.z;
    }
    eventCursor++;
  }
}
