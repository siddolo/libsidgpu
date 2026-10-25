import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('WAV export contains nonzero GPU PCM and the selected sample rate', async ({ page }) => {
  await page.goto('/');
  await page.locator('#duration').fill('0.1');
  await page.locator('#offline-rate').selectOption('44100');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export preset WAV + JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('gpu-sid.wav');
  const data = await readFile((await download.path())!);
  expect(data.toString('ascii', 0, 4)).toBe('RIFF');
  expect(data.readUInt32LE(24)).toBe(44100);
  expect(data.length).toBe(44 + 4410 * 2);
  expect(data.subarray(44).some(byte => byte !== 0)).toBe(true);
  await expect(page.locator('#status')).toContainText('WAV generated');
});
