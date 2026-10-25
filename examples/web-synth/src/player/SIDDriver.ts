import CPU from '6502.ts/lib/machine/cpu/BatchedAccessCpu';
import type { SIDFile } from './SIDFile';
import { validateRegister, type ScheduledEvent } from 'libsidgpu';

/* Execute a PSID's routines and emit register writes, never PCM. The CPU clock
 * and GPU sample timeline share an origin after init has returned:
 *
 *   init > register image at sample 0
 *   play at cycle 0 ----- play at period ----- play at 2*period
 *          | writes              | writes
 *          +---- floor(cycle * sampleRate / clock) ----> GPU events
 *
 * Run each routine to completion before returning to the caller. Writes past
 * the requested sample boundary stay scheduled in the GPU event queue. Absolute
 * cycle counts avoid accumulating rounding error at every video frame.
 * This is a subroutine player: there is no ROM, interrupt dispatcher or DMA. */
export class SIDDriver {
  private readonly ram = new Uint8Array(65536);
  private readonly sid = new Uint8Array(25);
  private readonly cpu: CPU;
  private cycles = 0;
  private nextCall = 0;
  private initializing = true;
  private readonly cia: boolean;
  private timerLatch: number;
  private timerControl = 1;
  private videoControl = 0x1b;

  constructor(readonly file: SIDFile, song: number, readonly sampleRate: number, private readonly emit: (event: ScheduledEvent) => void) {
    if (!Number.isInteger(song) || song < 1 || song > file.songs) throw new Error('Invalid subsong.');
    this.cia = !!((file.speed >>> Math.min(song - 1, 31)) & 1);
    this.timerLatch = Math.round(file.clock / 60) - 1;
    this.ram[0] = 0x2f;
    this.ram[1] = 0x37;
    this.ram[0x2a6] = file.video === 'PAL' ? 1 : 0;
    this.ram.set(file.data, file.loadAddress);
    this.cpu = new CPU({
      read: address => this.read(address), peek: address => this.read(address),
      readWord: address => this.read(address) | (this.read((address + 1) & 65535) << 8),
      write: (address, value) => this.write(address, value),
      poke: (address, value) => this.write(address, value),
    });
    this.cpu.setInvalidInstructionCallback(() => { throw new Error(`Unsupported 6502 opcode at $${this.cpu.getLastInstructionPointer().toString(16)}.`); });
    /* Bypass the reset-vector fetch: PSID provides the entry point directly.
     * Every subsequent call also starts at an instruction-fetch boundary. */
    this.cpu.executionState = 1;
    this.cpu.state.a = song - 1;
    this.call(file.initAddress, Math.floor(file.clock / 2));
    this.initializing = false;
    this.cycles = 0;
    this.sid.forEach((value, address) => this.send(address, value, 0));
  }

  private get port() { return (this.ram[1] | (~this.ram[0] & 255)) & 7; }
  private get ioVisible() { return !!(this.port & 4) && !!(this.port & 3); }
  private get period() {
    if (!this.cia) return this.file.video === 'PAL' ? 19656 : 17095;
    if (!(this.timerControl & 1) || (this.timerControl & 0x28)) throw new Error('Unsupported CIA Timer A mode: continuous CPU-clock timer required.');
    return this.timerLatch + 1;
  }

  private read(address: number): number {
    if ((address >= 0xe000 && (this.port & 2)) || (address >= 0xa000 && address < 0xc000 && (this.port & 3) === 3)) {
      throw new Error(`Driver requires C64 ROM at $${address.toString(16)}.`);
    }
    if (address >= 0xd000 && address < 0xe000 && (this.port & 3)) {
      if (!this.ioVisible) throw new Error('Driver requires C64 character ROM.');
      if (address >= 0xd400 && address < 0xd800) {
        const register = address & 31;
        if (register === 25 || register === 26) return 255;
        throw new Error(`SID read at $${(0xd400 + register).toString(16)} is not supported by the GPU player.`);
      }
      /* Raster reads allow short synchronization loops to terminate. They do
       * not model badlines or change the host's periodic play-call schedule. */
      const raster = Math.floor(this.cycles / (this.file.video === 'PAL' ? 63 : 65)) % (this.file.video === 'PAL' ? 312 : 263);
      if (address === 0xd012) return raster & 255;
      if (address === 0xd011) return (this.videoControl & 127) | ((raster >> 1) & 128);
      if (address === 0xdc0d || address === 0xdd0d) return 0;
      throw new Error(`Unsupported C64 peripheral read at $${address.toString(16)}.`);
    }
    return this.ram[address];
  }

  private write(address: number, value: number) {
    if (this.ioVisible && address >= 0xd000 && address < 0xe000) {
      if (address >= 0xd400 && address < 0xd800) {
        const register = address & 31;
        if (register <= 24) {
          this.sid[register] = value;
          if (!this.initializing) this.send(register, value, Math.floor(this.cycles * this.sampleRate / this.file.clock));
        }
      } else if (address === 0xdc04) this.timerLatch = (this.timerLatch & 0xff00) | value;
      else if (address === 0xdc05) this.timerLatch = (this.timerLatch & 255) | (value << 8);
      else if (address === 0xdc0e) this.timerControl = value;
      else if (address === 0xd011) this.videoControl = value;
      else if (address >= 0xde00) throw new Error('C64 expansion or extra SID is not supported.');
      return;
    }
    this.ram[address] = value;
  }

  private send(address: number, value: number, sampleIndex: number) {
    validateRegister(address, value);
    this.emit({ sampleIndex, event: { type: 'register-write', address, value } });
  }

  /* The synthetic caller uses a stack return address of $ffff: RTS wraps it
   * to $0000. Check both PC and SP so nested JSR/RTS calls can use the stack
   * normally. A cycle budget bounds malformed code and drivers that never
   * return. On error this machine is unusable and playback must stop. */
  private call(address: number, budget: number) {
    const state = this.cpu.state;
    if (address >= 0xa000) this.ram[1] = 0x35;
    state.p = address;
    state.s = 0xfd;
    state.flags = 0x24;
    this.ram[0x1ff] = this.ram[0x1fe] = 255;
    const deadline = this.cycles + budget;
    do {
      if (this.cycles >= deadline) throw new Error('PSID routine did not return within the cycle budget.');
      if (this.cpu.executionState === 1 && this.read(state.p) === 0) throw new Error(`BRK at $${state.p.toString(16)}: file requires an unsupported C64 environment.`);
      this.cpu.cycle();
      this.cycles++;
    } while (this.cpu.executionState !== 1 || state.p !== 0 || state.s !== 0xff);
  }

  /* Emit all calls that can affect [0, endSample). Requests must advance with
   * the renderer; no call or register write is repeated across block borders. */
  advance(endSample: number) {
    while (Math.floor(this.nextCall * this.sampleRate / this.file.clock) < endSample) {
      this.cycles = this.nextCall;
      const start = this.cycles;
      this.call(this.file.playAddress, this.period);
      this.nextCall = start + this.period;
      if (this.cycles > this.nextCall) throw new Error('PSID routine exceeded the timer period.');
    }
  }
}
