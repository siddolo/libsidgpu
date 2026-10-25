import { decodePCM16, type PCMBlock } from './pcm.js';

interface Pending {
  buffer: WebGLBuffer;
  fence: WebGLSync;
  sequence: number;
  startSample: number;
  size: number;
  submitted: number;
}

/* Copy framebuffer rows without waiting for the GPU in the submission call.
 * A pixel pack buffer (PBO) holds each copy until its fence signals:
 *
 *   free PBO > readPixels > pending fence > CPU copy > free PBO
 *
 * The framebuffer can be rendered into again after submission. The PBO cannot
 * be reused until poll() has copied its contents, even if its fence is ready. */
export class ReadbackQueue {
  private pending: Pending[] = [];
  private free: WebGLBuffer[] = [];
  latencyMs = 0;
  copyMs = 0;
  totalLatencyMs = 0;
  totalCopyMs = 0;
  completed = 0;
  get count() { return this.pending.length; }

  constructor(private gl: WebGL2RenderingContext, readonly float: boolean) {}

  /* Copy size texels from the currently bound framebuffer into a queued PBO.
   * The framebuffer may be reused after this call; its copy is already ordered
   * in the GL command stream. Poll later to obtain the tagged mono PCM block. */
  submit(sequence: number, startSample: number, size: number) {
    const gl = this.gl;
    const buffer = this.free.pop() ?? gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size * (this.float ? 16 : 4), gl.STREAM_READ);
    /* A bound PBO makes 0 a byte offset rather than a destination in JS memory. */
    gl.readPixels(0, 0, size, 1, gl.RGBA, this.float ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (!fence) throw new Error('GPU fence creation failed.');
    this.pending.push({ buffer, fence, sequence, startSample, size, submitted: performance.now() });
    gl.flush();
  }

  /* Return the completed prefix in submission order without waiting for fences.
   * A pending fence stops the scan. Throws if a copy fails, produces non-finite
   * PCM, or remains pending for more than 10 seconds. */
  poll(): PCMBlock[] {
    const gl = this.gl;
    const ready: PCMBlock[] = [];
    while (this.pending.length) {
      const item = this.pending[0];
      const status = gl.clientWaitSync(item.fence, 0, 0);
      if (status === gl.WAIT_FAILED || gl.isContextLost()) throw new Error('GPU readback failed.');
      if (status === gl.TIMEOUT_EXPIRED) {
        if (performance.now() - item.submitted > 10000) throw new Error('GPU readback timeout (10 s).');
        break;
      }
      /* The fence covers both rendering and the PBO copy. Its observed latency
       * also includes time until this poll, so it is not a GPU copy timer. */
      this.latencyMs = performance.now() - item.submitted;
      const before = performance.now();
      const raw = this.float ? new Float32Array(item.size * 4) : new Uint8Array(item.size * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, item.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      /* The float target stores mono PCM in R. The byte target stores an
       * offset-binary 16-bit sample across R and G. */
      let samples: Float32Array;
      if (raw instanceof Float32Array) {
        samples = new Float32Array(item.size);
        for (let i = 0; i < samples.length; i++) {
          if (!Number.isFinite(raw[i * 4])) throw new Error('GPU produced non-finite PCM.');
          samples[i] = raw[i * 4];
        }
      } else samples = decodePCM16(raw);
      this.copyMs = performance.now() - before;
      this.totalLatencyMs += this.latencyMs;
      this.totalCopyMs += this.copyMs;
      this.completed++;
      this.pending.shift();
      gl.deleteSync(item.fence);
      this.free.push(item.buffer);
      ready.push({ sequence: item.sequence, startSample: item.startSample, samples });
    }
    return ready;
  }

  dispose() {
    for (const item of this.pending) {
      this.gl.deleteSync(item.fence);
      this.gl.deleteBuffer(item.buffer);
    }
    for (const buffer of this.free) this.gl.deleteBuffer(buffer);
    this.pending = [];
    this.free = [];
  }
}
