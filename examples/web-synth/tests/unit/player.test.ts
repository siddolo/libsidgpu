import { describe, expect, it } from 'vitest';
import { parseSID } from '../../src/player/SIDFile';
import { SIDDriver } from '../../src/player/SIDDriver';
import { EventQueue, type ScheduledEvent } from 'libsidgpu';
import { sidFixture } from '../sid-fixture';

describe('PSID decoding', () => {
  it('decodes endian fields and owns the payload, including embedded load addresses', () => {
    const original = sidFixture();
    const bytes = new Uint8Array(original.length + 2);
    bytes.set(original.subarray(0, 124));
    bytes[8] = bytes[9] = 0;
    bytes.set([0x00, 0x10], 124);
    bytes.set(original.subarray(124), 126);
    const file = parseSID(bytes);
    expect(file.loadAddress).toBe(0x1000);
    expect(file.data).toEqual(parseSID(original).data);
    expect(file.title).toBe('GPU player test');
    expect(file.songs).toBe(2);
    bytes[126] = 0;
    expect(file.data[0]).toBe(0xaa);
    original[119] = 0x28;
    expect(parseSID(original).clock).toBe(1022727);
  });

  it('rejects truncated, overflowing and unsupported files before executing code', () => {
    const bytes = sidFixture();
    for (const length of [0, 4, 117, 120, 124]) expect(() => parseSID(bytes.subarray(0, length))).toThrow();
    for (const [offset, value, message] of [[0, 82, 'RSID'], [5, 5, 'version'], [7, 20, 'offset'], [15, 0, 'subsong'], [17, 3, 'subsong'], [119, 1, 'MUS']] as const) {
      const bad = bytes.slice(); bad[offset] = value;
      expect(() => parseSID(bad)).toThrow(message);
    }
    const bad = bytes.slice();
    new DataView(bad.buffer).setUint16(8, 0xfff0);
    expect(() => parseSID(bad)).toThrow('RAM');
    bad.set([0, 0], 12);
    bad.set([0x10, 0], 8);
    expect(() => parseSID(bad)).toThrow('playAddress=0');
    bad.set([0x10, 0x40], 12);
    bad[5] = 3; bad[122] = 0x42;
    expect(() => parseSID(bad)).toThrow('Multi-SID');
  });
});

describe('PSID execution', () => {
  it('passes the subsong to init and preserves ordered writes across GPU block horizons', () => {
    const file = parseSID(sidFixture());
    const queue = new EventQueue();
    const events: ScheduledEvent[] = [];
    const driver = new SIDDriver(file, 2, 48000, item => queue.schedule(item.sampleIndex, item.event));
    for (let start = 0; start < 48000; start += 128) {
      driver.advance(start + 128);
      events.push(...queue.take(start, 128));
    }
    expect(events.find(e => e.event.type === 'register-write' && e.event.address === 1)?.event).toEqual({ type: 'register-write', address: 1, value: 0x3a });
    const writes = events.slice(25);
    expect(writes.length).toBe(51);
    for (let frame = 0; frame < writes.length; frame++) {
      expect(writes[frame].event).toEqual({ type: 'register-write', address: 0, value: 0x41 + frame });
      expect(writes[frame].sampleIndex).toBe(Math.floor((frame * 19656 + 11) * 48000 / 985248));
    }
    const all: ScheduledEvent[] = [];
    new SIDDriver(file, 2, 48000, event => all.push(event)).advance(48000);
    expect(all).toEqual(events);
  });

  it('uses the CIA latch and the last speed bit for subsongs above 32', () => {
    const file = parseSID(sidFixture());
    file.songs = 33;
    file.speed = 0x80000000;
    file.data.set([0xa9, 0xff, 0x8d, 0x04, 0xdc, 0xa9, 0x3f, 0x8d, 0x05, 0xdc, 0x60]);
    const writes: ScheduledEvent[] = [];
    new SIDDriver(file, 33, 44100, event => writes.push(event)).advance(44100);
    expect(writes.length - 25).toBe(61);
    expect(writes[26].sampleIndex).toBe(Math.floor((16384 + 11) * 44100 / 985248));
  });

  it('executes nested calls, decimal arithmetic and RAM under banked-out I/O', () => {
    const file = parseSID(sidFixture());
    file.data.set([
      0x20, 0x20, 0x10,             /* JSR $1020 */
      0x8d, 0x00, 0xd4,
      0xa9, 0x30, 0x85, 0x01,       /* Bank out I/O. */
      0xa9, 0x55, 0x8d, 0x00, 0xd4,
      0xa9, 0x37, 0x85, 0x01, 0x60,
    ]);
    file.data.set([0xf8, 0x18, 0xa9, 0x09, 0x69, 0x01, 0x60], 0x20);
    const writes: ScheduledEvent[] = [];
    new SIDDriver(file, 1, 48000, event => writes.push(event));
    expect(writes[0].event).toEqual({ type: 'register-write', address: 0, value: 0x10 });
  });

  it('bounds non-returning routines and rejects unsupported SID reads and waveforms', () => {
    const file = parseSID(sidFixture());
    file.data.set([0x4c, 0x00, 0x10]);
    expect(() => new SIDDriver(file, 1, 48000, () => {})).toThrow('did not return');
    file.data.set([0xad, 0x1b, 0xd4, 0x60]);
    expect(() => new SIDDriver(file, 1, 48000, () => {})).toThrow('SID read');
    file.data.set([0xa9, 0x31, 0x8d, 0x04, 0xd4, 0x60]);
    expect(() => new SIDDriver(file, 1, 48000, () => {})).toThrow('Combined waveforms');
  });
});
