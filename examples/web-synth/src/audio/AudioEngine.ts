import workletURL from './sid-worklet.ts?worker&url';
import { PCMQueue, type PCMBlock } from 'libsidgpu';

export interface AudioSource {
  sampleRate: number;
  blockSize: number;
  nextSample: number;
  readback: { count: number; poll(): PCMBlock[] };
  render(): void;
  dispose(): void;
}

/* Feed the worklet from a producer that runs ahead of playback. There are three
 * sample positions, all measured from the start of the current audio session:
 *
 *   consumed <= delivered <= source.nextSample
 *
 * consumed advances when the worklet copies PCM to its output. delivered counts
 * PCM sent through the port. nextSample also includes GPU work still in flight.
 * The producer fills the interval [consumed, nextSample) to the target size.
 * Using only the reported FIFO fill would submit too much work while readback
 * is pending. The scheduling timer is independent of UI animation frames. */
export class AudioEngine {
  context: AudioContext | null = null;
  source: AudioSource | null = null;
  fill = 0;
  consumed = 0;
  underruns = 0;
  schedulingMs = 0;
  running = false;
  onSamples: (samples: Float32Array) => void = () => {};
  onError: (message: string) => void = () => {};
  private node: AudioWorkletNode | null = null;
  private timer = 0;
  private queue = new PCMQueue();
  private buffers: ArrayBuffer[] = [];
  private delivered = 0;
  private started = false;

  /* Start from a user gesture and create the source at AudioContext's real rate.
   * Returns false if Stop interrupts startup. Runtime failures stop playback
   * and are delivered through onError; setup failures reject this promise. */
  async start(factory: (sampleRate: number) => AudioSource) {
    if (this.context) return this.running;
    const context = new AudioContext();
    this.context = context;
    try {
      await context.resume();
      await context.audioWorklet.addModule(workletURL);
      /* Stop/Start may replace the context while addModule is pending. */
      if (this.context !== context) return false;
      this.source = factory(context.sampleRate);
      this.node = new AudioWorkletNode(context, 'sid-consumer', { outputChannelCount: [2] });
      this.node.connect(context.destination);
      this.node.onprocessorerror = () => this.fail('AudioWorklet processor error.');
      this.node.port.onmessage = ({ data }) => {
        if (this.context !== context) return;
        if (data.type === 'stats') {
          this.fill = data.fill;
          this.consumed = data.consumed;
          this.underruns = data.underruns;
        } else if (data.type === 'recycle') this.buffers.push(data.buffer);
        else if (data.type === 'error') this.fail(data.message);
      };
      context.onstatechange = () => {
        if (this.running && context.state === 'suspended') this.fail('AudioContext suspended. Press Start to resume.');
      };
      this.running = true;
      this.tick();
      return this.running;
    } catch (error) {
      if (this.context !== context) return false;
      await this.stop();
      throw error;
    }
  }

  private tick = () => {
    if (!this.running || !this.source || !this.node) return;
    const before = performance.now();
    try {
      /* Drain completed readbacks in timeline order. Reuse transfer buffers
       * returned by the worklet after it has copied their PCM into the ring. */
      for (const block of this.source.readback.poll()) {
        for (const ready of this.queue.push(block)) {
          this.onSamples(ready.samples);
          const buffer = this.buffers.pop();
          const samples = buffer?.byteLength === ready.samples.byteLength
            ? new Float32Array(buffer)
            : new Float32Array(ready.samples.length);
          samples.set(ready.samples);
          /* postMessage detaches samples; read its length before transferring it. */
          this.delivered += samples.length;
          this.node.port.postMessage({
            type: 'block',
            sequence: ready.sequence,
            startSample: ready.startSample,
            buffer: samples.buffer,
          }, [samples.buffer]);
        }
      }
      const target = Math.ceil(this.source.sampleRate * 0.15);
      /* The port preserves message order, so play follows the prefill blocks.
       * Starting earlier would count startup silence as audio underruns. */
      if (!this.started && this.delivered >= target) {
        this.node.port.postMessage({ type: 'play' });
        this.started = true;
      }
      /* Replenish the backlog, including blocks still waiting for GPU readback. */
      while (this.source.nextSample - this.consumed < target && this.source.readback.count < 4) this.source.render();
      this.schedulingMs = performance.now() - before;
      this.timer = window.setTimeout(this.tick, 4);
    } catch (error) { this.fail(String(error)); }
  };

  mute(value: boolean) { this.node?.port.postMessage({ type: 'mute', value }); }

  private fail(message: string) {
    void this.stop();
    this.onError(message);
  }

  /* Stop submission and detach the consumer before releasing its source.
   * Clear the session before awaiting close(), so a subsequent Start cannot
   * inherit counters or buffers from the context being closed. */
  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.node?.disconnect();
    this.node?.port.close();
    this.node = null;
    this.source?.dispose();
    this.source = null;
    const context = this.context;
    this.context = null;
    this.queue = new PCMQueue();
    this.buffers = [];
    this.fill = this.consumed = this.underruns = this.delivered = 0;
    this.started = false;
    if (context && context.state !== 'closed') await context.close();
  }
}
