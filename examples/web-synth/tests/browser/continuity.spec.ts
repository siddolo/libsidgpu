import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('120 seconds of three-voice GPU audio without underruns', async ({ page }, testInfo) => {
  test.setTimeout(160000);
  await page.goto('/tests/browser/continuity.html');
  const result = await page.evaluate(async () => {
    const audioPath = '/src/audio/AudioEngine.ts';
    const sidPath = '/tests/gpu-harness.ts';
    const presetPath = '/src/sid/presets.ts';
    const { AudioEngine } = await import(audioPath);
    const { SIDEngine } = await import(sidPath);
    const { demoEvents } = await import(presetPath);
    const audio = new AudioEngine();
    let error: string | null = null;
    let peak = 0;
    audio.onError = (message: string) => { error = message; };
    audio.onSamples = (samples: Float32Array) => { for (const sample of samples) peak = Math.max(peak, Math.abs(sample)); };
    let renderer = '';
    const start = performance.now();
    try {
      await audio.start((rate: number) => {
        const engine = new SIDEngine(rate, 256, 'checkpoint');
        renderer = engine.renderer;
        for (const { sampleIndex, event } of demoEvents('Filter sweep', rate, 120)) engine.schedule(sampleIndex, event);
        return engine;
      });
      const rate = audio.context.sampleRate;
      while (audio.consumed < rate * 120 && !error && performance.now() - start < 145000) {
        document.querySelector('output')!.textContent = `${(audio.consumed / rate).toFixed(1)} / 120 s\nUnderrun: ${audio.underruns}\nBuffer: ${(audio.fill / rate * 1000).toFixed(1)} ms\n${renderer}`;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { elapsedMs: performance.now() - start, sampleRate: rate, consumed: audio.consumed, underruns: audio.underruns, peak, error, renderer };
    } finally { await audio.stop(); }
  });
  const path = testInfo.outputPath('continuity.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await testInfo.attach('continuity.json', { path, contentType: 'application/json' });
  expect(result.error).toBeNull();
  expect(result.consumed).toBeGreaterThanOrEqual(result.sampleRate * 120);
  expect(result.peak).toBeGreaterThan(0.05);
  expect(result.underruns).toBe(0);
});
