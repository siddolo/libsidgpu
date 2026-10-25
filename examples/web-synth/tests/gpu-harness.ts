import { renderOffline, type RenderConfig } from '../src/benchmark/OfflineRenderer';
import { demoEvents } from '../src/sid/presets';
import { frequencyRegister, type ScheduledEvent } from 'libsidgpu';

export async function render(config: Partial<RenderConfig> = {}) {
  const result = await renderOffline({ sampleRate: 48000, blockSize: 128, strategy: 'baseline', seconds: 0.02, events: toneEvents(), ...config });
  return { samples: Array.from(result.samples), state: Array.from(result.state), metrics: result.metrics };
}

export function toneEvents(wave = 32, hz = 440): ScheduledEvent[] {
  const frequency = frequencyRegister(hz);
  return [[0, frequency & 255], [1, frequency >> 8], [3, 8], [4, wave | 1], [5, 0], [6, 0xf0], [24, 15]].map(([address, value]) => ({ sampleIndex: 0, event: { type: 'register-write', address, value } }));
}

export { demoEvents };
export { SIDEngine } from 'libsidgpu';
