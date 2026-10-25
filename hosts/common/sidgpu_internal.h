#ifndef SIDGPU_INTERNAL_H
#define SIDGPU_INTERNAL_H

#include "sidgpu.h"

/* Checkpoint width and state packing must match the shader interfaces. */
enum {
    SIDGPU_CHECKPOINT_SAMPLES = 32,
    SIDGPU_MAX_BLOCK_SAMPLES = 2048,
    SIDGPU_MAX_CHECKPOINTS = SIDGPU_MAX_BLOCK_SAMPLES / SIDGPU_CHECKPOINT_SAMPLES,
    SIDGPU_MAX_SEGMENT_EVENTS = 4096,
    SIDGPU_STATE_ELEMENTS = SIDGPU_STATE_WORDS / 4,
    SIDGPU_EVENT_WRITE = 0,
    SIDGPU_EVENT_RESET = 1
};

struct sidgpu_event {
    uint64_t sample;
    uint32_t address, value, type;
};

struct sidgpu_events {
    struct sidgpu_event *items;
    size_t count, capacity;
};

/* Return NULL on success or a static diagnostic; rejected events leave the
 * queue unchanged. Equal sample times retain insertion order. */
const char *sidgpu_events_schedule(struct sidgpu_events *queue, uint64_t next_sample, struct sidgpu_event event);
void sidgpu_events_consume(struct sidgpu_events *queue, size_t count);

#endif
