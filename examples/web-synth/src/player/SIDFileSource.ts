import { SIDEngine, type ScheduledEvent } from 'libsidgpu';
import { SIDDriver } from './SIDDriver';
import type { SIDFile } from './SIDFile';

/* Prepare register events before each GPU block is submitted. The audio
 * transport owns this source and, through dispose(), the attached GPU engine. */
export class SIDFileSource {
  private readonly driver: SIDDriver;
  private readonly playbackRegisters = new Uint8Array(25);
  private readonly pendingDisplay: ScheduledEvent[] = [];
  constructor(readonly engine: SIDEngine, file: SIDFile, song: number) {
    this.driver = new SIDDriver(file, song, engine.sampleRate, item => {
      engine.schedule(item.sampleIndex, item.event);
      this.pendingDisplay.push(item);
    });
  }
  get sampleRate() { return this.engine.sampleRate; }
  get blockSize() { return this.engine.blockSize; }
  get nextSample() { return this.engine.nextSample; }
  get readback() { return this.engine.readback; }
  render() {
    this.driver.advance(this.nextSample + this.blockSize);
    this.engine.render();
  }
  /* Return a borrowed register image after [0, consumed) has played. Calls
   * must use a nondecreasing worklet cursor; callers must not modify the image.
   *
   *   consumed                 engine.nextSample
   *      |                            |
   *   displayed <--- queued audio ---> generated
   *
   * Driver writes arrive in timestamp order, ahead of the audible position.
   * Retain the unplayed suffix and discard displayed events so memory follows
   * the audio backlog rather than the duration of the song. */
  readPlaybackRegisters(consumed: number) {
    let count = 0;
    while (count < this.pendingDisplay.length && this.pendingDisplay[count].sampleIndex < consumed) {
      const { event } = this.pendingDisplay[count++];
      if (event.type === 'reset') this.playbackRegisters.fill(0);
      else this.playbackRegisters[event.address] = event.value;
    }
    this.pendingDisplay.splice(0, count);
    return this.playbackRegisters;
  }
  dispose() { this.engine.dispose(); }
}
