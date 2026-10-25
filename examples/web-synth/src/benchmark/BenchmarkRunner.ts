import { renderOffline } from './OfflineRenderer';
import { BLOCK_SIZES, type Strategy } from 'libsidgpu';
import { demoEvents } from '../sid/presets';

export interface BenchmarkRow {
  strategy: Strategy;
  blockSize: number;
  voices: number;
  filter: boolean;
  trials: number;
  medianRTF?: number;
  minRTF?: number;
  maxRTF?: number;
  cpuMs?: number;
  readbackMs?: number;
  stateMs?: number | null;
  pcmMs?: number | null;
  renderer?: string;
  error?: string;
}

/* Compare block sizes using a warm-up and three independent renders per load.
 * onRow receives each completed configuration, including failures, so one bad
 * configuration does not hide the others. Cancellation rejects the whole run.
 * The parallel experiment uses its fixed oscillator instead of a preset. */
export async function runBenchmarks(sampleRate: number, seconds: number, strategies: Strategy[], signal: AbortSignal, onRow: (row: BenchmarkRow) => void) {
  const rows: BenchmarkRow[] = [];
  for (const strategy of strategies) for (const blockSize of BLOCK_SIZES) for (const voices of strategy === 'parallel' ? [1] : [1, 3]) {
    signal.throwIfAborted();
    const filter = voices === 3;
    const row: BenchmarkRow = { strategy, blockSize, voices, filter, trials: 3 };
    try {
      const config = { sampleRate, seconds, blockSize, strategy, events: strategy === 'parallel' ? [] : demoEvents(filter ? 'Filter sweep' : 'Lead', sampleRate, seconds, voices, filter) };
      await renderOffline({ ...config, seconds: Math.min(seconds, 0.05) }, signal);
      const trials = [];
      for (let trial = 0; trial < 3; trial++) trials.push((await renderOffline(config, signal)).metrics);
      trials.sort((a, b) => a.realTimeFactor - b.realTimeFactor);
      /* Keep the timings from the same trial as the median throughput. Choosing
       * each metric's median separately could describe a run that never occurred. */
      Object.assign(row, {
        medianRTF: trials[1].realTimeFactor,
        minRTF: trials[0].realTimeFactor,
        maxRTF: trials[2].realTimeFactor,
        cpuMs: trials[1].cpuMs,
        readbackMs: trials[1].readbackMs,
        stateMs: trials[1].stateMs,
        pcmMs: trials[1].pcmMs,
        renderer: trials[1].renderer,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      row.error = String(error);
    }
    rows.push(row);
    onRow(row);
  }
  return { date: new Date().toISOString(), userAgent: navigator.userAgent, sampleRate, seconds, rows };
}
