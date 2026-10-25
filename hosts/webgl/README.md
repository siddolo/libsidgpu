# libsidgpu WebGL 2 Host

`libsidgpu` is a WebGL 2 synthesizer modeled after the Commodore 64 MOS 8580
SID chip. It runs the three SID voices (triangle, sawtooth, pulse, and LFSR
noise waveforms, with ADSR envelopes, hard sync, and ring modulation) and the
multimode resonant filter in GLSL fragment shaders, rendering mono PCM blocks
from sample-timestamped register writes.

## Installation

```sh
npm install libsidgpu
```

The synthesis engine runs in a browser with WebGL 2. Audio playback uses the
Web Audio API. Serve the application over HTTPS or localhost when using
AudioWorklet.

## Play a Tone

This example renders one second of a 440 Hz sawtooth, releases the note after
750 ms, and plays the completed buffer.

Call `playTone()` from a button's click handler and handle its rejected promise
to display errors in your application.

```ts
import { CONTROL, SIDEngine, frequencyRegister } from 'libsidgpu';

async function playTone() {
  const audio = new AudioContext();
  let engine: SIDEngine | undefined;
  try {
    await audio.resume();
    engine = new SIDEngine(audio.sampleRate);

    const frequency = frequencyRegister(440);
    engine.writeRegister(0, frequency & 255);
    engine.writeRegister(1, frequency >> 8);
    engine.writeRegister(5, 0x00);
    engine.writeRegister(6, 0xf0);
    engine.writeRegister(4, CONTROL.SAW | CONTROL.GATE);
    engine.writeRegister(24, 15);
    engine.schedule(Math.round(audio.sampleRate * 0.75), {
      type: 'register-write',
      address: 4,
      value: CONTROL.SAW,
    });

    const buffer = audio.createBuffer(1, Math.round(audio.sampleRate), audio.sampleRate);
    const samples = buffer.getChannelData(0);
    let received = 0;

    while (received < samples.length) {
      while (engine.nextSample < samples.length && engine.readback.count < 4) {
        engine.render();
      }
      for (const block of engine.readback.poll()) {
        const count = Math.min(block.samples.length, samples.length - received);
        samples.set(block.samples.subarray(0, count), received);
        received += count;
      }
      if (received < samples.length) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }

    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.onended = () => { void audio.close(); };
    source.start();
  } catch (error) {
    await audio.close();
    throw error;
  } finally {
    engine?.dispose();
  }
}
```

## API Reference

The [WebGL 2 API](https://github.com/siddolo/libsidgpu/blob/main/docs/webgl-api.md)
documents `SIDEngine`, event scheduling and PCM utilities, including continuous
playback with AudioWorklet.

## Build

From the repository root:

```sh
npm ci
npm run build --workspace hosts/webgl
```
