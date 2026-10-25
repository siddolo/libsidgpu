export class Oscilloscope {
  private samples = new Float32Array(1024);
  private pending = false;
  rms = 0;
  peak = 0;
  clipping = 0;
  private colors: { background: string; axis: string; trace: string };

  constructor(private canvas: HTMLCanvasElement) {
    const style = getComputedStyle(canvas);
    this.colors = {
      background: style.getPropertyValue('--scope-bg').trim(),
      axis: style.getPropertyValue('--scope-axis').trim(),
      trace: style.getPropertyValue('--scope-trace').trim(),
    };
    this.draw();
  }

  update(samples: Float32Array) {
    let sum = 0;
    this.peak = 0;
    for (const sample of samples) {
      sum += sample * sample;
      this.peak = Math.max(this.peak, Math.abs(sample));
      if (Math.abs(sample) >= 0.9999) this.clipping++;
    }
    this.rms = Math.sqrt(sum / samples.length);
    if (samples.length >= this.samples.length) {
      this.samples.set(samples.subarray(samples.length - this.samples.length));
    } else {
      this.samples.copyWithin(0, samples.length);
      this.samples.set(samples, this.samples.length - samples.length);
    }
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => this.draw());
    }
  }

  private draw() {
    this.pending = false;
    const context = this.canvas.getContext('2d')!;
    const { width, height } = this.canvas;
    context.fillStyle = this.colors.background;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = this.colors.axis;
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
    context.strokeStyle = this.colors.trace;
    context.lineWidth = 1.5;
    context.beginPath();
    for (let i = 0; i < this.samples.length; i++) {
      const x = i * width / (this.samples.length - 1);
      const y = (1 - this.samples[i]) * height / 2;
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
}
