import { expect, it } from 'vitest';
import { decodePCM16, PCMQueue, PCMRing } from 'libsidgpu';
import { encodeWav } from '../../src/audio/WavExporter';

it('reorders asynchronous blocks and rejects gaps in sample intervals', () => {
  const queue = new PCMQueue();
  const first = { sequence: 0, startSample: 0, samples: new Float32Array([1, 2]) };
  const second = { sequence: 1, startSample: 2, samples: new Float32Array([3]) };
  expect(queue.push(second)).toEqual([]);
  expect(queue.push(first)).toEqual([first, second]);
  expect(() => queue.push(first)).toThrow();
  expect(() => queue.push({ sequence: 2, startSample: 9, samples: new Float32Array(1) })).toThrow(/Discontinuous/);
});

it('wraps the FIFO with variable render quanta and counts silence underruns', () => {
  const ring = new PCMRing(8);
  ring.push(new Float32Array([1, 2, 3, 4, 5, 6]));
  const first = new Float32Array(5);
  ring.pull(first);
  expect(Array.from(first)).toEqual([1, 2, 3, 4, 5]);
  ring.push(new Float32Array([7, 8, 9, 10]));
  const last = new Float32Array(7);
  ring.pull(last);
  expect(Array.from(last)).toEqual([6, 7, 8, 9, 10, 0, 0]);
  expect(ring.underruns).toBe(1);
  expect(ring.consumed).toBe(10);
  expect(() => ring.push(new Float32Array(9))).toThrow(/overflow/);
});

it('decodes offset-binary PCM16 endpoints and writes clipped little-endian WAV', () => {
  expect(Array.from(decodePCM16(new Uint8Array([0, 0, 0, 255, 0, 128, 0, 255, 255, 255, 0, 255])))).toEqual([-1, 0, 32767 / 32768]);
  const wav = encodeWav(new Float32Array([-2, -0.5, 0, 0.5, 2]), 44100);
  const view = new DataView(wav);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
  expect(view.getUint32(24, true)).toBe(44100);
  expect(view.getUint32(40, true)).toBe(10);
  expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, -16384, 0, 16384, 32767]);
  expect(() => encodeWav(new Float32Array([NaN]), 48000)).toThrow();
});
