import { SIDEngine, type Strategy, type ScheduledEvent } from 'libsidgpu';

export interface RenderConfig {
  sampleRate: number;
  blockSize: number;
  strategy: Strategy;
  seconds: number;
  events: ScheduledEvent[];
  packed?: boolean;
}

/* Render a deterministic event timeline on a private GPU context and return
 * exactly round(seconds * sampleRate) samples. The state snapshot includes the
 * whole final block, even when its PCM tail is trimmed. Timings cover synthesis
 * and PCM readback, excluding setup and the diagnostic snapshot. Cancellation
 * and errors release the context before rejecting. */
export async function renderOffline(config: RenderConfig, signal?: AbortSignal) {
  if (!Number.isFinite(config.seconds) || config.seconds <= 0 || config.seconds > 120) throw new Error('Duration must be between 0 and 120 seconds.');
  const engine = new SIDEngine(config.sampleRate, config.blockSize, config.strategy, config.packed);
  try {
    for (const { sampleIndex, event } of config.events) engine.schedule(sampleIndex, event);
    const samples = new Float32Array(Math.round(config.sampleRate * config.seconds));
    const total = Math.ceil(samples.length / config.blockSize) * config.blockSize;
    let delivered = 0;
    let cpuMs = 0;
    /* Start timing after setup. The loop measures submission and PCM readback;
     * the final state snapshot below is a diagnostic, outside this interval. */
    const start = performance.now();
    while (delivered < total) {
      signal?.throwIfAborted();
      const cpuStart = performance.now();
      for (const block of engine.readback.poll()) {
        if (block.startSample !== delivered) throw new Error('Discontinuous offline output.');
        const remaining = samples.length - delivered;
        if (remaining > 0) samples.set(block.samples.subarray(0, remaining), delivered);
        delivered += block.samples.length;
      }
      while (engine.nextSample < total && engine.readback.count < 4) engine.render();
      engine.timer.poll();
      cpuMs += performance.now() - cpuStart;
      /* Yield so the browser can report fence completion and deliver aborts.
       * This wait belongs to elapsedMs, but not to the CPU orchestration time. */
      if (delivered < total) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const elapsedMs = performance.now() - start;
    const state = await engine.snapshot();
    engine.timer.poll();
    return {
      samples, state,
      metrics: {
        elapsedMs, cpuMs, readbackMs: engine.readback.totalLatencyMs / engine.readback.completed,
        readbackCopyMs: engine.readback.totalCopyMs / engine.readback.completed,
        stateMs: engine.timer.blocks ? engine.timer.totalStateMs / engine.timer.blocks : null,
        pcmMs: engine.timer.blocks ? engine.timer.totalPCMMs / engine.timer.blocks : null,
        samplesPerSecond: total / (elapsedMs / 1000),
        realTimeFactor: total / config.sampleRate / (elapsedMs / 1000),
        renderer: engine.renderer,
        format: engine.readback.float ? 'RGBA32F' : 'RGBA8 PCM16',
      },
    };
  } finally { engine.dispose(); }
}
