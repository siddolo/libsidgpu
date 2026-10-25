import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('repeatable GPU strategy and load benchmark', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/benchmark/BenchmarkRunner.ts';
    const { runBenchmarks } = await import(path);
    return runBenchmarks(48000, 1, ['baseline', 'checkpoint', 'parallel'], new AbortController().signal, () => {});
  });
  const path = testInfo.outputPath('benchmark.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await testInfo.attach('benchmark.json', { path, contentType: 'application/json' });
  console.log(JSON.stringify(result));
  expect(result.rows.filter((row: { error?: string }) => !row.error).length).toBeGreaterThanOrEqual(10);
});
