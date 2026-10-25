import { expect, test } from '@playwright/test';

test('GLSL PCM reaches AudioWorklet continuously', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await page.locator('[data-voice="0"] [data-field="gate"]').check();
  await expect.poll(async () => Number(await page.locator('#consumed').textContent()), { timeout: 30000 }).toBeGreaterThan(48000);
  expect(Number(await page.locator('#underruns').textContent())).toBe(0);
  await expect(page.locator('#levels')).not.toContainText('Peak 0.000');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});
