import { describe, expect, it } from 'vitest';
import { EventQueue, frequencyRegister, registerFrequency, SID_CLOCK, validateRegister } from 'libsidgpu';

describe('SID timeline', () => {
  it('preserves same-sample write ordering and the next block boundary', () => {
    const queue = new EventQueue();
    queue.schedule(128, { type: 'reset' });
    queue.schedule(17, { type: 'register-write', address: 4, value: 32 });
    queue.schedule(17, { type: 'register-write', address: 4, value: 33 });
    expect(queue.take(0, 128).map(item => item.event)).toEqual([
      { type: 'register-write', address: 4, value: 32 }, { type: 'register-write', address: 4, value: 33 },
    ]);
    expect(() => queue.schedule(127, { type: 'reset' })).toThrow();
    expect(queue.take(128, 128)).toEqual([{ sampleIndex: 128, event: { type: 'reset' } }]);
    expect(() => queue.take(300, 128)).toThrow();
  });

  it('quantizes frequencies to half a register step', () => {
    for (const hz of [0, 55, 440, 1000, 3000]) expect(Math.abs(registerFrequency(frequencyRegister(hz)) - hz)).toBeLessThanOrEqual(SID_CLOCK / 16777216 / 2);
    expect(() => frequencyRegister(NaN)).toThrow();
    expect(() => frequencyRegister(4000)).toThrow();
  });

  it('rejects invalid bytes and unsupported waveform combinations', () => {
    expect(() => validateRegister(4, 0x31)).toThrow(/Combined/);
    expect(() => validateRegister(25, 0)).toThrow();
    expect(() => validateRegister(0, 256)).toThrow();
    expect(() => validateRegister(4, 0x8f)).not.toThrow();
  });
});
