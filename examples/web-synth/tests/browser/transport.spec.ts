import { expect, test } from '@playwright/test';
import { sidFixture } from '../sid-fixture';

type StartupWindow = typeof window & {
  startup: { requested: boolean; settled: boolean; release(): void };
};

test('Stop cancels a pending startup without disturbing the next audio session', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const startup: StartupWindow['startup'] = {
      requested: false, settled: false, release: () => {},
    };
    (window as StartupWindow).startup = startup;
    const pending = new Promise<void>(resolve => { startup.release = resolve; });
    const addModule = Worklet.prototype.addModule;
    /* Hold only the first startup; both sessions still load the real worklet. */
    Worklet.prototype.addModule = async function (...args) {
      if (startup.requested) return addModule.apply(this, args);
      startup.requested = true;
      await pending;
      try {
        return await addModule.apply(this, args);
      } finally {
        startup.settled = true;
      }
    };
  });
  await page.goto('/');

  await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => (window as StartupWindow).startup.requested)).toBe(true);
  await expect(page.locator('#reset')).toBeDisabled();
  await page.locator('#stop').click();
  await expect(page.locator('#start')).toBeEnabled();

  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await page.locator('[data-voice="0"] [data-field="gate"]').check();
  await page.evaluate(() => (window as StartupWindow).startup.release());
  await expect.poll(() => page.evaluate(() => (window as StartupWindow).startup.settled)).toBe(true);
  await expect.poll(async () => Number(await page.locator('#consumed').textContent())).toBeGreaterThan(48000);
  await expect(page.locator('#start')).toBeDisabled();
  await expect(page.locator('#status')).toContainText('Audio active');
  await expect(page.locator('#levels')).not.toContainText('Peak 0.000');
  await page.locator('#stop').click();
  expect(errors).toEqual([]);
});

test('cancelling an offline render restores a playable synth', async ({ page }) => {
  await page.goto('/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await page.locator('[data-voice="0"] [data-field="gate"]').check();
  await page.locator('#duration').fill('120');
  await page.locator('#export').click();
  await expect(page.locator('#status')).toContainText('Rendering WAV');
  await expect(page.locator('#start')).toBeDisabled();
  await expect(page.locator('#sid-file')).toBeDisabled();
  await expect(page.locator('#reset')).toBeDisabled();
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toContainText('Operation cancelled');

  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await expect.poll(async () => Number(await page.locator('#consumed').textContent())).toBeGreaterThan(48000);
  await expect(page.locator('#levels')).not.toContainText('Peak 0.000');
  await page.locator('#stop').click();
});

test('keyboard shares held notes across input sources and ignores SID monitor input', async ({ page }) => {
  await page.goto('/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  const gate = page.locator('[data-voice="0"] [data-field="gate"]');
  await page.locator('[data-note="48"]').hover();
  await page.mouse.down();
  await page.keyboard.down('z');
  await page.mouse.up();
  await expect(gate).toBeChecked();
  await page.keyboard.up('z');
  await expect(gate).not.toBeChecked();

  await page.locator('#stop').click();
  await page.locator('#sid-toggle').click();
  await page.locator('#sid-file').setInputFiles({
    name: 'test.sid', mimeType: 'audio/prs.sid', buffer: Buffer.from(sidFixture()),
  });
  await expect(page.locator('#status')).toContainText('PSID loaded');
  await page.locator('#sid-unload').focus();
  await page.keyboard.down('z');
  await expect(page.locator('#keyboard .active')).toHaveCount(0);
  await page.keyboard.up('z');
  await page.locator('#sid-unload').click();
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Audio active');
  await page.keyboard.down('z');
  await expect(gate).toBeChecked();
  await page.keyboard.up('z');
  await expect(gate).not.toBeChecked();
  await page.locator('#stop').click();
});
