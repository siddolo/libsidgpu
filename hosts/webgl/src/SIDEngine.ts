import interfaceShader from '../../../shaders/opengles/interface.glsl?raw';
import common from '../../../shaders/common.glsl?raw';
import oscillator from '../../../shaders/oscillator.glsl?raw';
import envelope from '../../../shaders/envelope.glsl?raw';
import filter from '../../../shaders/filter.glsl?raw';
import stateShader from '../../../shaders/opengles/state-update.frag.glsl?raw';
import pcmShader from '../../../shaders/opengles/pcm-render.frag.glsl?raw';
import { createContext, program, target } from './WebGLContext.js';
import { ReadbackQueue } from './ReadbackQueue.js';
import { GPUTimer } from './GPUTimer.js';
import { EventQueue, type SIDEvent } from './events.js';

export type Strategy = 'baseline' | 'checkpoint' | 'parallel';
export const BLOCK_SIZES = [128, 256, 512, 1024, 2048] as const;

/* Generate PCM and preserve SID state using two fragment passes per segment.
 *
 * A fragment cannot scatter samples into arbitrary texture positions. Instead,
 * the PCM pass gives each fragment one output sample and replays the simulation
 * from the segment's initial state up to that sample. A separate pass computes
 * the final state. Baseline uses one segment per block; checkpoint mode limits
 * replay to 32 samples at the cost of more draw calls.
 *
 * Each segment starts with the following texture dependencies:
 *
 *                  +-- state pass --> B (state after the segment)
 *   A (checkpoint)-|
 *                  +-- PCM pass ----> output[offset .. offset + count)
 *
 * B becomes the next checkpoint only after both draws. Reading B for the PCM
 * pass would skip the segment we are trying to generate. The output texture
 * accumulates all segments before a single readback copies the complete block. */
export class SIDEngine {
  readonly gl: WebGL2RenderingContext;
  readonly readback: ReadbackQueue;
  readonly timer: GPUTimer;
  readonly events = new EventQueue();
  readonly renderer: string;
  nextSample = 0;
  private sequence = 0;
  private states: ReturnType<typeof target>[];
  private output: ReturnType<typeof target>;
  private eventTexture: WebGLTexture;
  private passes: {
    program: WebGLProgram;
    kind: 'state' | 'pcm';
    eventCount: WebGLUniformLocation | null;
    count: WebGLUniformLocation | null;
    pcmOffset: WebGLUniformLocation | null;
  }[];
  private current = 0;
  private disposed = false;

  constructor(readonly sampleRate: number, readonly blockSize = 256, readonly strategy: Strategy = 'checkpoint', packed = false, readonly clock = 985248) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Unsupported sample rate.');
    if (!(BLOCK_SIZES as readonly number[]).includes(blockSize)) throw new Error('Unsupported block size.');
    if (clock !== 985248 && clock !== 1022727) throw new Error('Unsupported SID clock.');
    const gl = this.gl = createContext();
    try {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      this.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      this.readback = new ReadbackQueue(gl, !!gl.getExtension('EXT_color_buffer_float') && !packed);
      this.timer = new GPUTimer(gl);
      const state = new Uint32Array(44);
      /* Keep initialization aligned with the texel layout in common.glsl. */
      for (let voice = 0; voice < 3; voice++) {
        state[(7 + voice) * 4 + 1] = 0x7fffff;
        state[(7 + voice) * 4 + 3] = 2;
      }
      if (strategy === 'parallel') {
        /* The analytic PCM experiment requires a fixed saw and an envelope
         * already at sustain. 0x3f800000 is the float32 bit pattern for 1.0. */
        state[0] = 0x44;
        state[1] = 0x1d;
        state[4] = 0x21;
        state[6] = 0xf0;
        state[24] = 15;
        state[30] = 0x3f800000;
        state[31] = 1;
      }
      this.states = [0, 1].map(() => target(gl, 11, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, state));
      this.output = target(gl, blockSize, this.readback.float ? gl.RGBA32F : gl.RGBA8, gl.RGBA, this.readback.float ? gl.FLOAT : gl.UNSIGNED_BYTE);
      this.eventTexture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.eventTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const source = `#version 300 es\n${!this.readback.float ? '#define PACKED_PCM\n' : ''}${interfaceShader}\n${common}\n${oscillator}\n${envelope}\n${filter}\n`;
      /* Sampler units and timing are fixed for this engine. Cache the remaining
       * uniform locations for the per-segment updates. */
      this.passes = ([
        ['state', stateShader],
        ['pcm', pcmShader],
      ] as const).map(([kind, fragment]) => {
        const shader = program(gl, source + fragment);
        gl.useProgram(shader);
        gl.uniform1i(gl.getUniformLocation(shader, 'initialState'), 0);
        gl.uniform1i(gl.getUniformLocation(shader, 'events'), 1);
        gl.uniform1i(gl.getUniformLocation(shader, 'sampleRate'), sampleRate);
        gl.uniform1ui(gl.getUniformLocation(shader, 'clockFrequency'), clock);
        gl.uniform1i(gl.getUniformLocation(shader, 'parallelOscillator'), strategy === 'parallel' ? 1 : 0);
        return {
          program: shader,
          kind,
          eventCount: gl.getUniformLocation(shader, 'eventCount'),
          count: gl.getUniformLocation(shader, 'count'),
          pcmOffset: gl.getUniformLocation(shader, 'pcmOffset'),
        };
      });
    } catch (error) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw error;
    }
  }

  /* Schedule an event before synthesis of the given absolute sample index.
   * The index must be at or after nextSample; submitted audio cannot be changed.
   * The fixed-oscillator experiment rejects all events. */
  schedule(sampleIndex: number, event: SIDEvent) {
    if (this.strategy === 'parallel') throw new Error('Parallel strategy uses a fixed oscillator and does not accept events.');
    this.events.schedule(sampleIndex, event);
  }
  writeRegister(address: number, value: number) { this.schedule(this.nextSample, { type: 'register-write', address, value }); }
  /* Discard pending events and reset at the next ungenerated sample. Audio
   * already queued for playback remains audible until that point is reached. */
  reset() { this.events.clear(); this.schedule(this.nextSample, { type: 'reset' }); }
  readRegister(address: number): number {
    if (address === 25 || address === 26) return 255;
    throw new Error('Synchronous read is available only for POTX/POTY; use snapshot() for GPU state.');
  }

  /* Submit one complete block and advance nextSample without waiting for PCM.
   * The caller must drain readback; at most four blocks may be pending. After a
   * submission error the engine must be disposed, since some state draws may
   * already have executed. */
  render() {
    if (this.disposed || this.gl.isContextLost()) throw new Error('WebGL context lost or disposed.');
    if (this.readback.count >= 4) throw new Error('Readback queue is full.');
    const gl = this.gl;
    const segmentSize = this.strategy === 'checkpoint' ? 32 : this.blockSize;
    for (let offset = 0; offset < this.blockSize; offset += segmentSize) {
      const count = Math.min(segmentSize, this.blockSize - offset);
      /* Convert absolute event times to offsets from this checkpoint. Both
       * shaders replay this same list, including writes inside the segment. */
      const scheduled = this.events.take(this.nextSample + offset, count);
      const data = new Uint32Array(Math.max(1, scheduled.length) * 4);
      scheduled.forEach(({ sampleIndex, event }, index) => {
        data[index * 4] = sampleIndex - this.nextSample - offset;
        if (event.type === 'reset') data[index * 4 + 3] = 1;
        else { data[index * 4 + 1] = event.address; data[index * 4 + 2] = event.value; }
      });
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.eventTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, Math.max(1, scheduled.length), 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.states[this.current].texture);
      /* Bind A for both draws. The state pass covers its 11 texels; the PCM
       * viewport covers only this segment's slice of the output texture.
       * WebGL orders these draws before the next event-texture upload. */
      for (const pass of this.passes) {
        const isState = pass.kind === 'state';
        gl.useProgram(pass.program);
        gl.uniform1i(pass.eventCount, scheduled.length);
        gl.uniform1i(pass.count, count);
        gl.uniform1i(pass.pcmOffset, offset);
        gl.bindFramebuffer(gl.FRAMEBUFFER,
          isState ? this.states[1 - this.current].framebuffer : this.output.framebuffer);
        gl.viewport(isState ? 0 : offset, 0, isState ? 11 : count, 1);
        this.timer.begin(pass.kind);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.timer.end();
      }
      this.current = 1 - this.current; /* B is now the checkpoint for the next segment. */
    }
    this.timer.endBlock();
    this.readback.submit(this.sequence++, this.nextSample, this.blockSize);
    this.nextSample += this.blockSize;
    this.timer.poll();
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}.`);
  }

  /* Return the last submitted checkpoint, not necessarily the one being heard.
   * The PBO captures it before later state writes, so rendering can continue
   * while this call awaits the GPU. Throws on context loss or a 10 s timeout. */
  async snapshot() {
    const gl = this.gl;
    const buffer = gl.createBuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.states[this.current].framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 44 * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, 11, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.flush();
    const start = performance.now();
    try {
      while (true) {
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.WAIT_FAILED || gl.isContextLost()) throw new Error('GPU snapshot failed.');
        if (status !== gl.TIMEOUT_EXPIRED) break;
        if (performance.now() - start > 10000) throw new Error('GPU snapshot timeout.');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      const result = new Uint32Array(44);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, result);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      return result;
    } finally { gl.deleteSync(fence); gl.deleteBuffer(buffer); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.readback.dispose();
    this.timer.dispose();
    for (const item of [...this.states, this.output]) {
      this.gl.deleteTexture(item.texture);
      this.gl.deleteFramebuffer(item.framebuffer);
    }
    this.gl.deleteTexture(this.eventTexture);
    for (const pass of this.passes) this.gl.deleteProgram(pass.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
