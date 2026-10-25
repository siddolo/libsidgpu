/* OpenGL ES 3.0 / WebGL 2 binding interface for the shared synthesis model.
 * State and events are stored in single-row RGBA32UI textures and fetched by
 * texel index so common.glsl can remain independent of the host API. */
precision highp float;
precision highp int;
precision highp usampler2D;

uniform highp uint clockFrequency;
uniform usampler2D initialState;
uniform usampler2D events;
uniform int eventCount;
uniform int sampleRate;
uniform int count;
uniform bool parallelOscillator;

uvec4 readState(int index) { return texelFetch(initialState, ivec2(index, 0), 0); }
uvec4 readEvent(int index) { return texelFetch(events, ivec2(index, 0), 0); }
