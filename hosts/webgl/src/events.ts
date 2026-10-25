import { validateRegister } from './registers.js';

export type SIDEvent = { type: 'register-write'; address: number; value: number } | { type: 'reset' };
export interface ScheduledEvent { sampleIndex: number; event: SIDEvent }

/* Sample-addressed register writes, ordered stably at equal timestamps. */
export class EventQueue {
  private events: ScheduledEvent[] = [];
  private horizon = 0;

  /* Cancel pending events without reopening sample intervals already consumed. */
  clear() { this.events = []; }

  /* Reject writes into an interval already consumed by take(). */
  schedule(sampleIndex: number, event: SIDEvent) {
    if (!Number.isSafeInteger(sampleIndex) || sampleIndex < this.horizon) throw new RangeError('Event falls before the generatable timeline.');
    if (event.type === 'register-write') validateRegister(event.address, event.value);
    /* Insert after equal timestamps to preserve Gate off/on and reset ordering.
     * Chronological writes go straight to the end of the queue. */
    let index = this.events.length;
    while (index > 0 && this.events[index - 1].sampleIndex > sampleIndex) {
      index--;
    }
    this.events.splice(index, 0, { sampleIndex, event });
  }

  /* Consume [start, start + length), advancing the scheduling horizon.
   * Calls must cover adjacent intervals. Events exactly at the end belong to
   * the next interval, including same-sample reset and register-write pairs. */
  take(start: number, length: number) {
    if (start !== this.horizon) throw new Error('Discontinuous event timeline.');
    const end = start + length;
    const count = this.events.findIndex(item => item.sampleIndex >= end);
    const events = this.events.splice(0, count < 0 ? this.events.length : count);
    if (events.length > 4096) throw new Error('Too many events in block (maximum 4096).');
    this.horizon = end;
    return events;
  }
}
