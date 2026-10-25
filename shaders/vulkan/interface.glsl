#version 450

/* Vulkan compute interface for the shared synthesis model. One workgroup of 32
 * invocations renders one 32-sample checkpoint segment. All segment event slices
 * for a block live in `events[]`; `eventOffset` selects the current slice. */
layout(local_size_x = 32) in;
layout(set = 0, binding = 0, std430) readonly buffer InitialState { uvec4 initialState[]; };
layout(set = 0, binding = 1, std430) readonly buffer Events { uvec4 events[]; };
layout(set = 0, binding = 2, std430) writeonly buffer NextState { uvec4 nextState[]; };
layout(set = 0, binding = 3, std430) writeonly buffer PCM { int pcm[]; };
layout(push_constant) uniform Parameters {
    uint clockFrequency;
    int sampleRate;
    int eventCount;
    int eventOffset;
    int pcmOffset;
};

uvec4 readState(int index) { return initialState[index]; }
uvec4 readEvent(int index) { return events[eventOffset + index]; }
