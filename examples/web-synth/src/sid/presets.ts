import { frequencyRegister, noteFrequency, type ScheduledEvent } from 'libsidgpu';

export const PRESETS = ['Lead', 'Bass', 'Arpeggio', 'Noise percussion', 'Filter sweep'] as const;
export type Preset = typeof PRESETS[number];

export function presetRegisters(name: Preset) {
  const registers = new Uint8Array(25);
  for (let voice = 0; voice < 3; voice++) {
    const base = voice * 7;
    const frequency = frequencyRegister(noteFrequency(name === 'Bass' ? 36 : 60 + voice * 7));
    registers[base] = frequency & 255;
    registers[base + 1] = frequency >> 8;
    registers[base + 3] = 8;
    registers[base + 4] = name === 'Noise percussion' ? 128 : name === 'Bass' ? 64 : name === 'Arpeggio' ? 16 : 32;
    registers[base + 5] = name === 'Noise percussion' ? 0x06 : 0x24;
    registers[base + 6] = name === 'Noise percussion' ? 0x06 : 0xb5;
  }
  registers[21] = 0;
  registers[22] = name === 'Bass' ? 60 : 160;
  registers[23] = name === 'Filter sweep' ? 0xc7 : name === 'Bass' ? 0x57 : 0;
  registers[24] = 0x1f;
  return registers;
}

export function demoEvents(name: Preset, sampleRate: number, seconds: number, voices = 3, filter = true): ScheduledEvent[] {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw new Error('Demo duration must be between 0 and 120 seconds.');
  const events: ScheduledEvent[] = [];
  const registers = presetRegisters(name);
  if (!filter) registers[23] &= 0xf0;
  const write = (sampleIndex: number, address: number, value: number) => events.push({ sampleIndex, event: { type: 'register-write', address, value } });
  registers.forEach((value, address) => write(0, address, value));
  for (let beat = 0; beat < seconds * 4; beat++) {
    const start = Math.round(beat * sampleRate / 4);
    for (let voice = 0; voice < voices; voice++) {
      const note = (name === 'Bass' ? 36 : 60) + [0, 4, 7, 12][beat % 4] + voice * 7;
      const frequency = frequencyRegister(noteFrequency(note));
      const base = voice * 7;
      write(start, base, frequency & 255);
      write(start, base + 1, frequency >> 8);
      write(start, base + 4, registers[base + 4] | 1);
      write(start + Math.round(sampleRate * 0.19), base + 4, registers[base + 4]);
    }
  }
  if (name === 'Filter sweep') for (let step = 0; step < seconds * 50; step++) {
    const cutoff = Math.round(100 + 1800 * (0.5 - 0.5 * Math.cos(step / 50 * Math.PI)));
    write(Math.round(step * sampleRate / 50), 21, cutoff & 7);
    write(Math.round(step * sampleRate / 50), 22, cutoff >> 3);
  }
  return events.sort((a, b) => a.sampleIndex - b.sampleIndex);
}
