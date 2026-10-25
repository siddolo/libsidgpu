interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/* Accumulate GPU query results by audio block. Queries measure individual
 * draws, while a block may contain several checkpoint segments. A null entry
 * marks the end of a block; poll() publishes its totals only after every query
 * before that marker has completed. Without the extension, times stay null. */
export class GPUTimer {
  private ext: TimerExtension | null;
  private pending: ({ query: WebGLQuery; pass: 'state' | 'pcm' } | null)[] = [];
  private sums = { state: 0, pcm: 0 };
  totalStateMs = 0;
  totalPCMMs = 0;
  blocks = 0;
  stateMs: number | null = null;
  pcmMs: number | null = null;

  constructor(private gl: WebGL2RenderingContext) { this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
  /* Start a non-nested timing interval. Pair each begin() with end(), then call
   * endBlock() after the last pass belonging to the audio block. */
  begin(pass: 'state' | 'pcm') {
    if (!this.ext) return;
    const query = this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.pending.push({ query, pass });
  }
  end() { if (this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); }
  endBlock() { if (this.ext) this.pending.push(null); }
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      /* A GPU clock discontinuity invalidates outstanding queries as well as
       * partial block totals; CPU wall time cannot replace these measurements. */
      for (const item of this.pending) if (item) gl.deleteQuery(item.query);
      this.pending = [];
      this.stateMs = this.pcmMs = null;
      this.sums = { state: 0, pcm: 0 };
      this.totalStateMs = this.totalPCMMs = this.blocks = 0;
      return;
    }
    while (this.pending.length) {
      const item = this.pending[0];
      if (!item) {
        /* All queries for this block were consumed before reaching its marker.
         * Publish the complete totals and start accumulating the next block. */
        this.pending.shift();
        this.stateMs = this.sums.state;
        this.pcmMs = this.sums.pcm;
        this.totalStateMs += this.stateMs;
        this.totalPCMMs += this.pcmMs;
        this.blocks++;
        this.sums = { state: 0, pcm: 0 };
        continue;
      }
      if (!gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const { query, pass } = item;
      const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      this.sums[pass] += ms;
      gl.deleteQuery(query);
    }
  }
  dispose() { for (const item of this.pending) if (item) this.gl.deleteQuery(item.query); }
}
