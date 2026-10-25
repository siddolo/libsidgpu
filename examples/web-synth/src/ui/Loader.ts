const C64_COLORS = [
  '#000000', '#ffffff', '#813338', '#75cec8',
  '#8e3c97', '#56ac4d', '#2e2c9b', '#edf171',
  '#8e5029', '#553800', '#c46c71', '#4a4a4a',
  '#7b7b7b', '#a9ff9f', '#706deb', '#b2b2b2',
];

/* The overlay has its own short animation lifetime. The oscilloscope keeps
 * drawing underneath, so hiding the bands reveals the latest PCM immediately. */
export class Loader {
  private context: CanvasRenderingContext2D;
  private frame = 0;
  private end = 0;
  private nextPaint = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.context = canvas.getContext('2d')!;
  }

  play() {
    cancelAnimationFrame(this.frame);
    const now = performance.now();
    this.end = now + 1600;
    this.nextPaint = now;
    this.canvas.hidden = false;
    this.draw(now);
  }

  private draw = (now: number) => {
    if (now >= this.end) {
      this.canvas.hidden = true;
      this.frame = 0;
      return;
    }

    if (now >= this.nextPaint) {
      const { width, height } = this.canvas;
      for (let y = 0; y < height;) {
        const bandHeight = 2 * (1 + Math.floor(Math.random() * 6));
        this.context.fillStyle = C64_COLORS[Math.floor(Math.random() * C64_COLORS.length)];
        this.context.fillRect(0, y, width, bandHeight);
        y += bandHeight;
      }
      this.nextPaint = now + 40 + Math.random() * 80;
    }
    this.frame = requestAnimationFrame(this.draw);
  };
}
