export const SID_CLOCK = 985248;
export const CONTROL = { GATE: 1, SYNC: 2, RING: 4, TEST: 8, TRIANGLE: 16, SAW: 32, PULSE: 64, NOISE: 128 } as const;

export function frequencyRegister(hz: number) {
  if (!Number.isFinite(hz) || hz < 0 || hz > 65535 * SID_CLOCK / 16777216) throw new RangeError('Frequency out of SID range.');
  /* The SID adds a 16-bit frequency word to a 24-bit phase once per chip cycle. */
  return Math.round(hz * 16777216 / SID_CLOCK);
}

export function registerFrequency(value: number, clock = SID_CLOCK) { return value * clock / 16777216; }
export function noteFrequency(note: number) { return 440 * 2 ** ((note - 69) / 12); }

export function validateRegister(address: number, value: number) {
  if (!Number.isInteger(address) || address < 0 || address > 24) throw new RangeError('SID register is not writable.');
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Register value must be a byte.');
  if (address < 21 && address % 7 === 4) {
    const wave = value >> 4;
    if (wave && (wave & (wave - 1))) throw new Error('Combined waveforms are not supported.');
  }
}
