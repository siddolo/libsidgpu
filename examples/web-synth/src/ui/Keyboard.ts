const KEYS = ['z', 's', 'x', 'd', 'c', 'v', 'g', 'b', 'h', 'n', 'j', 'm', 'q', '2', 'w', '3', 'e', 'r', '5', 't', '6', 'y', '7', 'u'];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* Track input sources separately from notes. A pointer and a computer key may
 * hold the same note: emit noteOn for the first source and noteOff only when
 * the last source releases it. Losing focus releases every held source. */
export class Keyboard {
  private held = new Map<string, number>();
  private buttons: HTMLButtonElement[];
  private enabled = true;

  constructor(private root: HTMLElement, private noteOn: (note: number) => void, private noteOff: (note: number) => void) {
    root.innerHTML = KEYS.map((key, index) => {
      const name = NAMES[index % 12];
      const octave = 3 + Math.floor(index / 12);
      return `<button type="button" class="key ${name.includes('#') ? 'black' : ''}"
        data-note="${48 + index}" aria-label="${name}${octave}">
        <span>${name}</span><kbd>${key.toUpperCase()}</kbd>
      </button>`;
    }).join('');
    this.buttons = [...root.querySelectorAll('button')];
    root.addEventListener('pointerdown', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      this.press(`pointer-${event.pointerId}`, Number(button.dataset.note));
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      root.addEventListener(type, event => this.release(`pointer-${event.pointerId}`));
    }
    window.addEventListener('keydown', event => {
      if (!this.enabled || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) return;
      const index = KEYS.indexOf(event.key.toLowerCase());
      if (index >= 0) {
        event.preventDefault();
        this.press(event.code, 48 + index);
      }
    });
    window.addEventListener('keyup', event => this.release(event.code));
    window.addEventListener('blur', () => this.clear());
  }

  /* inert covers pointer and focus input; the window key listener also needs
   * the enabled flag. Release held notes before changing input modes. */
  setEnabled(value: boolean) {
    if (this.enabled === value) return;
    this.clear();
    this.enabled = value;
    this.root.inert = !value;
  }

  private press(id: string, note: number) {
    if (!this.enabled || this.held.has(id)) return;
    if (![...this.held.values()].includes(note)) this.noteOn(note);
    this.held.set(id, note);
    this.buttons[note - 48].classList.add('active');
  }

  private release(id: string) {
    const note = this.held.get(id);
    if (note === undefined) return;
    this.held.delete(id);
    if (![...this.held.values()].includes(note)) {
      this.noteOff(note);
      this.buttons[note - 48].classList.remove('active');
    }
  }

  clear() {
    for (const id of this.held.keys()) this.release(id);
  }
}
