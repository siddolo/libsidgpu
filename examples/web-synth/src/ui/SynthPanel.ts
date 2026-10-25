import { frequencyRegister, registerFrequency, SID_CLOCK } from 'libsidgpu';

const TOGGLE_BITS: Record<string, number> = {
  gate: 1, sync: 2, ring: 4, test: 8,
  low: 16, band: 32, high: 64, voice3off: 128,
};

export class SynthPanel {
  private enabled = [true, true, true];
  private fieldsets: HTMLFieldSetElement[];

  constructor(private root: HTMLElement, readonly registers: Uint8Array, private write: (address: number, value: number) => void) {
    root.innerHTML = `
      <div class="voices">
        ${[0, 1, 2].map(voice => `
          <fieldset data-voice="${voice}">
            <legend>Voice ${voice + 1}</legend>
            <label class="toggle"><input data-field="enabled" type="checkbox" checked> Enable</label>
            <label>Frequency Hz <input data-field="frequency" type="number" min="0" max="3848" step="0.1"></label>
            <label>Waveform
              <select data-field="wave">
                <option value="0">None</option>
                <option value="16">Triangle</option>
                <option value="32">Sawtooth</option>
                <option value="64">Pulse</option>
                <option value="128">Noise</option>
              </select>
            </label>
            ${[
              ['width', 'Pulse width', 4095],
              ['attack', 'Attack', 15],
              ['decay', 'Decay', 15],
              ['sustain', 'Sustain', 15],
              ['release', 'Release', 15],
            ].map(([field, label, max]) => `
              <label>${label} <output data-value="${field}"></output>
                <input data-field="${field}" type="range" min="0" max="${max}" step="1">
              </label>
            `).join('')}
            <div class="toggles">
              ${['gate', 'ring', 'sync', 'test', 'routing'].map(field => `
                <label><input data-field="${field}" type="checkbox"> ${field}</label>
              `).join('')}
            </div>
          </fieldset>
        `).join('')}
      </div>
      <fieldset data-voice="global">
        <legend>Filter</legend>
        <div class="filter-controls">
          ${[
            ['cutoff', 'Cutoff', 2047],
            ['resonance', 'Resonance', 15],
            ['volume', 'Master volume', 15],
          ].map(([field, label, max]) => `
            <label>${label} <output data-value="${field}"></output>
              <input data-field="${field}" type="range" min="0" max="${max}">
            </label>
          `).join('')}
          <div class="toggles">
            ${[
              ['low', 'Low-pass'], ['band', 'Band-pass'],
              ['high', 'High-pass'], ['voice3off', 'Voice 3 off'],
            ].map(([field, label]) => `
              <label><input data-field="${field}" type="checkbox"> ${label}</label>
            `).join('')}
          </div>
        </div>
      </fieldset>`;
    this.fieldsets = [...root.querySelectorAll('fieldset')];
    root.addEventListener('input', event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return;
      if (!input.dataset.field) return;
      if (!input.reportValidity()) return;
      const voice = input.closest('fieldset')!.dataset.voice!;
      const checked = input instanceof HTMLInputElement && input.checked;
      this.change(voice, input.dataset.field, Number(input.value), checked);
      this.refresh();
    });
    this.refresh();
  }

  isEnabled(voice: number) { return this.enabled[voice]; }

  setReadOnly(value: boolean) {
    this.root.classList.toggle('monitor', value);
    for (const fieldset of this.fieldsets) fieldset.disabled = value;
  }

  send(address: number, value: number) {
    this.registers[address] = value;
    const voiceControl = address < 21 && address % 7 === 4;
    const disabledVoice = voiceControl && !this.enabled[Math.floor(address / 7)];
    /* Disable the oscillator output without erasing its editable waveform. */
    this.write(address, disabledVoice ? value & 15 : value);
  }

  private change(voice: string, field: string, value: number, checked: boolean) {
    const r = this.registers;
    const voiceIndex = Number(voice);
    const base = voiceIndex * 7;
    if (field === 'enabled') {
      this.enabled[voiceIndex] = checked;
      this.send(base + 4, r[base + 4]);
    } else if (field === 'frequency') {
      const frequency = frequencyRegister(value);
      this.send(base, frequency & 255);
      this.send(base + 1, frequency >> 8);
    } else if (field === 'wave') {
      this.send(base + 4, (r[base + 4] & 15) | value);
    } else if (field === 'width') {
      this.send(base + 2, value & 255);
      this.send(base + 3, value >> 8);
    } else if (field === 'attack') {
      this.send(base + 5, (value << 4) | (r[base + 5] & 15));
    } else if (field === 'decay') {
      this.send(base + 5, (r[base + 5] & 240) | value);
    } else if (field === 'sustain') {
      this.send(base + 6, (value << 4) | (r[base + 6] & 15));
    } else if (field === 'release') {
      this.send(base + 6, (r[base + 6] & 240) | value);
    } else if (field === 'routing') {
      const bit = 1 << voiceIndex;
      this.send(23, checked ? r[23] | bit : r[23] & ~bit);
    } else if (field === 'cutoff') {
      this.send(21, value & 7);
      this.send(22, value >> 3);
    } else if (field === 'resonance') {
      this.send(23, (r[23] & 15) | (value << 4));
    } else if (field === 'volume') {
      this.send(24, (r[24] & 240) | value);
    } else {
      const address = voice === 'global' ? 24 : base + 4;
      const bit = TOGGLE_BITS[field];
      this.send(address, checked ? r[address] | bit : r[address] & ~bit);
    }
  }

  /* Display a register image without sending writes or changing the editable
   * synth preset. File playback supplies its consumed image and chip clock. */
  refresh(r = this.registers, clock = SID_CLOCK) {
    for (const fieldset of this.fieldsets) {
      const voice = Number(fieldset.dataset.voice);
      const base = voice * 7;
      const values: Record<string, number | boolean> = fieldset.dataset.voice === 'global' ? {
        cutoff: (r[21] & 7) | (r[22] << 3),
        resonance: r[23] >> 4,
        volume: r[24] & 15,
        low: !!(r[24] & 16),
        band: !!(r[24] & 32),
        high: !!(r[24] & 64),
        voice3off: !!(r[24] & 128),
      } : {
        enabled: this.enabled[voice],
        frequency: Number(registerFrequency(r[base] | (r[base + 1] << 8), clock).toFixed(1)),
        wave: r[base + 4] & 240,
        width: r[base + 2] | ((r[base + 3] & 15) << 8),
        attack: r[base + 5] >> 4,
        decay: r[base + 5] & 15,
        sustain: r[base + 6] >> 4,
        release: r[base + 6] & 15,
        gate: !!(r[base + 4] & 1),
        sync: !!(r[base + 4] & 2),
        ring: !!(r[base + 4] & 4),
        test: !!(r[base + 4] & 8),
        routing: !!(r[23] & (1 << voice)),
      };
      for (const input of fieldset.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
        const value = values[input.dataset.field!];
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = String(value);
      }
      for (const output of fieldset.querySelectorAll('output')) {
        output.value = String(values[output.dataset.value!]);
      }
    }
  }
}
