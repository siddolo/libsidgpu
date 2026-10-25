import { PCMRing } from 'libsidgpu';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

/* PCM consumer only; all SID state and synthesis belong to the GPU renderer. */
class SIDConsumer extends AudioWorkletProcessor {
  private ring = new PCMRing(Math.ceil(sampleRate * 0.5));
  private active = false;
  private reportSamples = 0;
  private sequence = 0;
  private received = 0;
  private mute = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'block') {
        try {
          if (data.sequence !== this.sequence || data.startSample !== this.received) throw new Error('Out-of-order PCM block in worklet.');
          this.ring.push(new Float32Array(data.buffer));
          this.sequence++;
          this.received += data.buffer.byteLength / 4;
          /* push() copied the PCM into the ring; the producer can reuse this buffer. */
          this.port.postMessage({ type: 'recycle', buffer: data.buffer }, [data.buffer]);
        } catch (error) {
          this.active = false;
          this.port.postMessage({ type: 'error', message: String(error) });
        }
      } else if (data.type === 'play') this.active = true;
      else if (data.type === 'mute') this.mute = data.value;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const channels = outputs[0];
    if (!channels?.length) return true;
    if (this.active) {
      this.ring.pull(channels[0]);
      /* Muting still consumes PCM: unmuting must resume at the current synth
       * time rather than play the audio accumulated while the output was quiet. */
      if (this.mute) channels[0].fill(0);
      for (let i = 1; i < channels.length; i++) channels[i].set(channels[0]);
    } else for (const channel of channels) channel.fill(0);
    /* Derive report intervals from the actual quantum length. This keeps the
     * feedback rate near 50 Hz without assuming 128-sample render quanta. */
    this.reportSamples += channels[0].length;
    if (this.reportSamples >= sampleRate / 50) {
      this.reportSamples = 0;
      this.port.postMessage({ type: 'stats', fill: this.ring.fill, consumed: this.ring.consumed, underruns: this.ring.underruns });
    }
    return true;
  }
}

registerProcessor('sid-consumer', SIDConsumer);
