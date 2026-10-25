import { expect, test } from '@playwright/test';
import reference from '../../../../tests/reference/resid-digital.json' with { type: 'json' };

test('GPU phase, A4, checkpoint continuity and PCM16', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/tests/gpu-harness.ts';
    const { render } = await import(path);
    const baseline = await render();
    const checkpoint = await render({ strategy: 'checkpoint', blockSize: 256 });
    const packed = await render({ packed: true });
    return { baseline, checkpoint, packed };
  });
  const { baseline, checkpoint, packed } = result;
  const cycles = Math.floor(1024 * 985248 / 48000);
  expect(baseline.state[28]).toBe((Math.round(440 * 16777216 / 985248) * cycles) % 16777216);
  expect(checkpoint.state).toEqual(baseline.state);
  expect(Math.max(...baseline.samples.map((v: number, i: number) => Math.abs(v - checkpoint.samples[i])))).toBeLessThan(1e-6);
  expect(Math.max(...baseline.samples.map((v: number, i: number) => Math.abs(v - packed.samples[i])))).toBeLessThan(1 / 32768);
  const edges = baseline.samples.slice(100).flatMap((value: number, i: number, samples: number[]) => i > 0 && value - samples[i - 1] < -0.2 ? [i] : []);
  expect(edges.length).toBeGreaterThan(5);
  const hz = 48000 * (edges.length - 1) / (edges.at(-1)! - edges[0]);
  expect(hz).toBeCloseTo(440, 0);
});

test('sample events, zero frequency, TEST, deterministic LFSR and envelope retrigger', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/tests/gpu-harness.ts';
    const { render, toneEvents } = await import(path);
    const write = (sampleIndex: number, address: number, value: number) => ({ sampleIndex, event: { type: 'register-write', address, value } });
    const zero = await render({ events: toneEvents(32, 0) });
    const reset = await render({ events: [...toneEvents(), write(113, 4, 41)] });
    const noise = await render({ events: toneEvents(128, 3000) });
    const noiseCheckpoint = await render({ strategy: 'checkpoint', events: toneEvents(128, 3000) });
    const events = [...toneEvents(), write(0, 6, 0x80), write(200, 4, 32), write(500, 4, 33), write(700, 5, 0x20)];
    const retrigger = await render({ events });
    const split = await render({ events, blockSize: 256, strategy: 'checkpoint' });
    const released = await render({ events: [...toneEvents(), write(200, 4, 32)] });
    return { zero, reset, noise, noiseCheckpoint, retrigger, split, released };
  });
  expect(result.zero.state[28]).toBe(0);
  expect(result.reset.state[28]).toBe(0);
  expect(result.reset.state[29]).toBe(0x7fffff);
  expect(result.noise.samples).toEqual(result.noiseCheckpoint.samples);
  expect(result.noise.state).toEqual(result.noiseCheckpoint.state);
  const frequency = Math.round(3000 * 16777216 / 985248);
  const cycles = Math.floor(1024 * 985248 / 48000);
  let lfsr = 0x7fffff;
  const edges = Math.floor((cycles * frequency + 0x80000) / 0x100000);
  for (let i = 0; i < edges; i++) lfsr = ((lfsr << 1) | (((lfsr >> 22) ^ (lfsr >> 17)) & 1)) & 0x7fffff;
  expect(result.noise.state[29]).toBe(lfsr);
  expect(result.retrigger.samples).toEqual(result.split.samples);
  expect(result.released.state[30]).toBe(0);
  expect(result.retrigger.state[30]).toBeGreaterThan(0);
});

test('three voices and filter remain finite and continuous at maximum resonance', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/tests/gpu-harness.ts';
    const { render, demoEvents, toneEvents } = await import(path);
    const events = demoEvents('Filter sweep', 44100, 0.05);
    events.push({ sampleIndex: 100, event: { type: 'register-write', address: 23, value: 0xf7 } });
    events.push({ sampleIndex: 101, event: { type: 'register-write', address: 22, value: 255 } });
    const baseline = await render({ sampleRate: 44100, seconds: 0.05, events });
    const checkpoint = await render({ sampleRate: 44100, seconds: 0.05, events, strategy: 'checkpoint', blockSize: 512 });
    const dry = await render({ seconds: 0.05 });
    const low = await render({ seconds: 0.05, events: [...toneEvents(), ...[[21, 0], [22, 4], [23, 1], [24, 31]].map(([address, value]) => ({ sampleIndex: 0, event: { type: 'register-write', address, value } }))] });
    return { baseline, checkpoint, dry, low };
  });
  expect(result.baseline.samples.every((sample: number) => Number.isFinite(sample) && Math.abs(sample) <= 1)).toBe(true);
  expect(Math.max(...result.baseline.samples.map((v: number, i: number) => Math.abs(v - result.checkpoint.samples[i])))).toBeLessThan(1e-6);
  const rms = (samples: number[]) => Math.sqrt(samples.slice(1000).reduce((sum, value) => sum + value * value, 0) / (samples.length - 1000));
  expect(rms(result.low.samples)).toBeLessThan(rms(result.dry.samples) * 0.4);
});

test('analytical saw matches the sequential oscillator after attack', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/tests/gpu-harness.ts';
    const { render, toneEvents } = await import(path);
    const sequential = await render({ events: toneEvents(32, 0x1d44 * 985248 / 16777216), blockSize: 2048, seconds: 0.05 });
    const parallel = await render({ strategy: 'parallel', events: [], blockSize: 2048, seconds: 0.05 });
    return Math.max(...sequential.samples.slice(100).map((sample: number, i: number) => Math.abs(sample - parallel.samples[i + 100])));
  });
  expect(result).toBeLessThan(1e-6);
});

test('digital state agrees with reSID delta-clock reference vectors', async ({ page }) => {
  await page.goto('/');
  const states = await page.evaluate(async vectors => {
    const path = '/tests/gpu-harness.ts';
    const { render, toneEvents } = await import(path);
    const states = [];
    for (const vector of vectors) {
      const result = await render({
        sampleRate: vector.sampleRate, seconds: vector.samples / vector.sampleRate,
        strategy: 'checkpoint', blockSize: 128,
        events: toneEvents(128, vector.frequency * 985248 / 16777216),
      });
      states.push({ phase: result.state[28], lfsr: result.state[29] });
    }
    return states;
  }, reference);
  for (let i = 0; i < reference.length; i++) expect(states[i]).toEqual({ phase: reference[i].phase, lfsr: reference[i].lfsr });
});

test('pulse duty, ring modulation, sync topology and voice 3 routing', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/tests/gpu-harness.ts';
    const { render, toneEvents } = await import(path);
    const write = (address: number, value: number) => ({ sampleIndex: 0, event: { type: 'register-write', address, value } });
    const duty = [];
    for (const width of [1024, 2048, 3072]) {
      const result = await render({ seconds: 0.05, events: [...toneEvents(64, 1000), write(2, width & 255), write(3, width >> 8)] });
      const samples = result.samples.slice(100);
      duty.push(samples.filter((v: number) => v > 0).length / samples.length);
    }
    const coupling = [write(14, 0), write(15, 60)];
    const plain = await render({ events: [...toneEvents(16), ...coupling] });
    const ring = await render({ events: [...toneEvents(16), ...coupling, write(4, 21)] });
    const sync = await render({ events: [...toneEvents(16), ...coupling, write(4, 19)] });
    const voice3 = toneEvents().map((item: { sampleIndex: number; event: { address: number; value: number; type: string } }) => item.event.address < 7 ? { ...item, event: { ...item.event, address: item.event.address + 14 } } : item);
    const dry = await render({ events: [...voice3, write(24, 143)] });
    const routed = await render({ events: [...voice3, write(24, 159), write(23, 4), write(22, 200)] });
    return { duty, plain, ring, sync, dry, routed };
  });
  for (let i = 0; i < 3; i++) expect(result.duty[i]).toBeCloseTo(0.75 - i * 0.25, 1);
  expect(result.ring.state[28]).toBe(result.plain.state[28]);
  expect(result.ring.samples).not.toEqual(result.plain.samples);
  expect(result.sync.state[28]).not.toBe(result.plain.state[28]);
  expect(result.sync.state[36]).toBe(result.plain.state[36]);
  expect(result.dry.samples.every((sample: number) => sample === 0)).toBe(true);
  expect(Math.max(...result.routed.samples.map(Math.abs))).toBeGreaterThan(0.1);
});
