export interface PCMBlock {
  sequence: number;
  startSample: number;
  samples: Float32Array;
}

/* Decode complete RGBA8 texels into a new mono PCM array. R holds the low byte
 * and G the high byte of an offset-binary sample: 0x8000 is silence, 0 is -1,
 * and 0xffff is 32767/32768. B and A carry no audio data. */
export function decodePCM16(bytes: Uint8Array) {
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = ((bytes[i * 4] | (bytes[i * 4 + 1] << 8)) - 32768) / 32768;
  return samples;
}

/* Reassemble asynchronous completions into a contiguous sample timeline.
 * For example, if blocks arrive as 0, 2, 1, return 0 immediately, hold 2, then
 * return 1 and 2 together. Sequence numbers order arrivals; sample offsets
 * independently detect holes or overlaps in the audio carried by those blocks. */
export class PCMQueue {
  private pending = new Map<number, PCMBlock>();
  private sequence = 0;
  private sample = 0;

  /* Retain block until its predecessors arrive and return the prefix now ready
   * to play. Retained blocks are not copied or transferred, so the caller must
   * leave their samples intact. Duplicates and discontinuous intervals throw;
   * more than 32 waiting blocks are treated as a missing predecessor. */
  push(block: PCMBlock): PCMBlock[] {
    if (block.sequence < this.sequence || this.pending.has(block.sequence)) throw new Error('Duplicate or stale PCM block.');
    this.pending.set(block.sequence, block);
    const ready: PCMBlock[] = [];
    while (this.pending.has(this.sequence)) {
      const next = this.pending.get(this.sequence)!;
      if (next.startSample !== this.sample) throw new Error('Discontinuous PCM interval.');
      this.pending.delete(this.sequence++);
      this.sample += next.samples.length;
      ready.push(next);
    }
    if (this.pending.size > 32) throw new Error('Missing PCM sequence.');
    return ready;
  }
}

/* Bounded mono FIFO. Pushing beyond capacity throws rather than dropping audio. */
export class PCMRing {
  private data: Float32Array;
  private read = 0;
  private write = 0;
  fill = 0;
  underruns = 0;
  consumed = 0;

  constructor(capacity: number) { this.data = new Float32Array(capacity); }

  /* Copy all samples into the ring. On overflow throw before changing the ring,
   * so a rejected block cannot leave a partial write in the playback stream. */
  push(samples: Float32Array) {
    if (samples.length > this.data.length - this.fill) throw new Error('Audio buffer overflow.');
    for (let i = 0; i < samples.length; i++) {
      this.data[this.write] = samples[i];
      this.write = (this.write + 1) % this.data.length;
    }
    this.fill += samples.length;
  }

  /* Fill any output length, padding a shortage with silence and counting one
   * underrun for that call. consumed advances only by real PCM samples, so the
   * producer does not skip synth time after the consumer has been starved. */
  pull(output: Float32Array) {
    const count = Math.min(output.length, this.fill);
    for (let i = 0; i < count; i++) {
      output[i] = this.data[this.read];
      this.read = (this.read + 1) % this.data.length;
    }
    output.fill(0, count);
    this.fill -= count;
    this.consumed += count;
    if (count < output.length) this.underruns++;
  }
}
