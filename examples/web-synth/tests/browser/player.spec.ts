import { expect, test } from '@playwright/test';
import { sidFixture } from '../sid-fixture';

test('NTSC driver writes produce identical GPU state and PCM across block sizes', async ({ page }) => {
  await page.goto('/');
  const bytes = sidFixture();
  bytes[119] = 0x28;
  const result = await page.evaluate(async data => {
    const parserPath = '/src/player/SIDFile.ts';
    const driverPath = '/src/player/SIDDriver.ts';
    const enginePath = '/tests/gpu-harness.ts';
    const sourcePath = '/src/player/SIDFileSource.ts';
    const { parseSID } = await import(parserPath);
    const { SIDDriver } = await import(driverPath);
    const { SIDEngine } = await import(enginePath);
    const { SIDFileSource } = await import(sourcePath);
    const file = parseSID(new Uint8Array(data));
    const runs = [];
    for (const size of [128, 512]) {
      const engine = new SIDEngine(48000, size, 'checkpoint', false, file.clock);
      try {
        const source = new SIDFileSource(engine, file, 1);
        const samples: number[] = [];
        while (samples.length < 4096) {
          for (const block of source.readback.poll()) samples.push(...block.samples);
          while (source.nextSample < 4096 && source.readback.count < 4) source.render();
          if (samples.length < 4096) await new Promise(resolve => setTimeout(resolve, 1));
        }
        const beforePlayback = Array.from(source.readPlaybackRegisters(0));
        const firstSample = Array.from(source.readPlaybackRegisters(1));
        const nextWrite = Math.floor((17095 + 11) * 48000 / file.clock);
        const beforeWrite = Array.from(source.readPlaybackRegisters(nextWrite));
        const afterWrite = Array.from(source.readPlaybackRegisters(nextWrite + 1));
        const played = Array.from(source.readPlaybackRegisters(4096));
        runs.push({ samples, state: Array.from(await engine.snapshot()), beforePlayback, firstSample, beforeWrite, afterWrite, played });
      } finally { engine.dispose(); }
    }
    const events: { sampleIndex: number; event: { address: number; value: number } }[] = [];
    new SIDDriver(file, 1, 48000, (event: typeof events[number]) => events.push(event)).advance(4096);
    const registers = new Uint8Array(25);
    let phase = 0;
    let cursor = 0;
    for (let sample = 0; sample < 4096; sample++) {
      while (cursor < events.length && events[cursor].sampleIndex <= sample) {
        const { address, value } = events[cursor++].event;
        registers[address] = value;
      }
      const cycles = Math.floor((sample + 1) * file.clock / 48000) - Math.floor(sample * file.clock / 48000);
      phase = (phase + cycles * (registers[0] + 256 * registers[1])) % 16777216;
    }
    return { runs, phase };
  }, Array.from(bytes));
  expect(result.runs[0]).toEqual(result.runs[1]);
  expect(result.runs[0].state[28]).toBe(result.phase);
  expect(Math.max(...result.runs[0].samples.map(Math.abs))).toBeGreaterThan(0.2);
  expect(result.runs[0].beforePlayback).toEqual(Array(25).fill(0));
  expect(result.runs[0].firstSample[0]).toBe(0x41);
  expect(result.runs[0].beforeWrite).toEqual(result.runs[0].firstSample);
  expect(result.runs[0].afterWrite[0]).toBe(0x42);
  expect(result.runs[0].played).toEqual(result.runs[0].state.slice(0, 25));
});

test('PSID upload, subsong, GPU audio and restart', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#sid-toggle').click();
  const frequency = page.locator('[data-voice="0"] [data-field="frequency"]');
  await frequency.fill('333');
  const manualFrequency = await frequency.inputValue();
  const bytes = sidFixture();
  bytes[119] = 0x28;
  await page.locator('#sid-file').setInputFiles({ name: 'test.sid', mimeType: 'audio/prs.sid', buffer: Buffer.from(bytes) });
  await expect(page.locator('#status')).toContainText('PSID loaded');
  await expect(page.locator('#sid-file')).toHaveValue(/test\.sid$/);
  await page.locator('#sid-song').selectOption('2');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('subsong 2');
  await expect.poll(async () => Number(await page.locator('#consumed').textContent())).toBeGreaterThan(48000);
  await expect(page.locator('#levels')).not.toContainText('Peak 0.000');
  await expect(page.locator('#underruns')).toHaveText('0');
  await expect(frequency).toBeDisabled();
  await expect.poll(async () => Number(await frequency.inputValue())).toBeGreaterThan(900);
  const playingFrequency = await frequency.inputValue();
  await expect.poll(() => frequency.inputValue()).not.toBe(playingFrequency);
  await expect(page.locator('[data-voice="0"] [data-field="gate"]')).toBeChecked();
  await expect(page.locator('[data-voice="0"] [data-field="wave"]')).toHaveValue('32');
  const beforeReset = Number(await frequency.inputValue());
  await page.locator('#reset').click();
  await expect.poll(async () => Number(await frequency.inputValue())).toBeLessThan(beforeReset);
  await expect(page.locator('#status')).toContainText('subsong 2');
  await expect.poll(async () => Number(await frequency.inputValue())).toBeGreaterThan(900);
  const restartedFrequency = await frequency.inputValue();
  await expect.poll(() => frequency.inputValue()).not.toBe(restartedFrequency);
  await page.locator('#stop').click();
  await expect(page.locator('#sid-song')).toBeEnabled();
  expect(Number(await frequency.inputValue())).toBeGreaterThan(900);
  await page.locator('#sid-song').selectOption('1');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('subsong 1');
  await expect.poll(async () => Number(await frequency.inputValue())).toBeGreaterThan(450);
  await expect.poll(async () => Number(await frequency.inputValue())).toBeLessThan(500);
  await page.locator('#stop').click();
  await page.locator('#sid-unload').click();
  await expect(page.locator('#sid-file')).toHaveValue('');
  await expect(frequency).toBeEnabled();
  await expect(frequency).toHaveValue(manualFrequency);
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await page.locator('#stop').click();
  expect(errors).toEqual([]);
});

test('unsupported file and CPU runtime failure leave the transport usable', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sid-toggle').click();
  const bytes = sidFixture();
  bytes[0] = 82;
  await page.locator('#sid-file').setInputFiles({ name: 'rsid.sid', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page.locator('#status')).toContainText('RSID requires');
  bytes[0] = 80;
  bytes.set([0x4c, 0x40, 0x10], 124 + 0x40);
  await page.locator('#sid-file').setInputFiles({ name: 'loop.sid', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page.locator('#status')).toContainText('PSID loaded');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('did not return');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#sid-unload').click();
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await page.locator('#stop').click();
});
