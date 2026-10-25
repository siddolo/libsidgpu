/* Replay the 32-sample checkpoint segment on each workgroup invocation:
 *
 *   invocation index (0..31)
 *     |
 *     +--> load initialState[0..10]
 *     +--> stepSample(0 .. index)  ---> pcm[pcmOffset + index]
 *     |
 *     +--> (index == 31 only)      ---> nextState[0..10]
 *
 * Every invocation starts from the same checkpoint and replays up to its own
 * sample index. Invocation 31 reaches the end of the segment and writes the
 * output checkpoint consumed by the next dispatch. */
void main() {
    int index = int(gl_LocalInvocationID.x);
    loadState();
    float value = 0.0;
    for (int i = 0; i <= index; i++) value = stepSample(i);
    pcm[pcmOffset + index] = int(clamp(floor(value * 32768.0 + 32768.5), 0.0, 65535.0)) - 32768;
    if (index == 31) {
        for (int texel = 0; texel < 11; texel++) nextState[texel] = packState(texel);
    }
}
