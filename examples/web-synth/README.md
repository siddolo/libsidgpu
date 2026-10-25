# Web Synth

`examples/web-synth` is an interactive browser synthesizer and `.sid` (PSID) player built on `libsidgpu`.

## Running

From the repository root:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5180`, press **Start**, and play with the on-screen keyboard or keys `Z-M` and `Q-U`. Each voice exposes waveform, pulse width, ADSR, **Ring** modulation, hard **Sync**, and filter **Routing** controls. **Gate** keeps a voice active without holding a key, and **Demo** plays an 8-second sequence using the current preset.

Click **SID Player** to open a single-chip PSID v1-v4 file, choose a subsong, and press **Start**. While a tune is playing, the synth controls follow the SID registers in read-only mode; **Back to synth** returns to manual control. Details on PSID execution are in [docs/sid-player.md](docs/sid-player.md).

**Render & Benchmark** renders the selected preset to a mono 16-bit PCM WAV file with a JSON timing report, and **Benchmark** measures throughput across block sizes and rendering strategies.

## Production Build

```sh
npm run build:demo
npm run preview
```

Built files are written to `examples/web-synth/dist/`. Third-party licenses are listed in [public/third-party-notices.txt](public/third-party-notices.txt), and the oscilloscope palette comes from Pepto's [Colodore model](https://www.pepto.de/projects/colorvic/).
