#include "sidgpu_internal.h"

#include <stdlib.h>
#include <string.h>

/* Insert `event` into `queue` sorted by ascending sample index while preserving
 * insertion order for equal timestamps, so same-sample Gate off/on pairs keep
 * their meaning. Return NULL on success or a static error message; on failure
 * `queue` is left unmodified.
 *
 * Insert E at sample 10 after existing event A; [.] is unused capacity:
 *
 *   Before:  [5][10:A][12][15][.]
 *   Shifted: [5][10:A][12][12][15]
 *   After:   [5][10:A][10:E][12][15] */
const char *sidgpu_events_schedule(struct sidgpu_events *queue, uint64_t next_sample, struct sidgpu_event event)
{
    if (event.sample < next_sample) return "Event precedes the ungenerated timeline";
    if (event.type == SIDGPU_EVENT_WRITE) {
        /* Control registers sit at offset 4 of each 7-byte voice block
         * (addresses 4, 11, 18). Reject writes with more than one waveform bit
         * set in the upper nibble (`waveform & (waveform - 1)` is non-zero). */
        unsigned waveform = event.value >> 4;
        if (event.address > 24 || event.value > 255 ||
            (event.address < 21 && event.address % 7 == 4 && (waveform & (waveform - 1)))) {
            return "Invalid SID register, byte or combined waveform";
        }
    }
    if (queue->count == queue->capacity) {
        size_t capacity = queue->capacity ? queue->capacity * 2 : 64;
        struct sidgpu_event *items = realloc(queue->items, capacity * sizeof(*items));
        if (!items) return "Out of memory";
        queue->items = items;
        queue->capacity = capacity;
    }
    size_t index = queue->count;
    while (index && queue->items[index - 1].sample > event.sample) {
        queue->items[index] = queue->items[index - 1];
        index--;
    }
    queue->items[index] = event;
    queue->count++;
    return NULL;
}

/* Remove the first `count` events after their block has been rendered on the
 * GPU and shift the remaining suffix to index 0. */
void sidgpu_events_consume(struct sidgpu_events *queue, size_t count)
{
    if (!count) return;
    queue->count -= count;
    memmove(queue->items, queue->items + count, queue->count * sizeof(*queue->items));
}
