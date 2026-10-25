import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { SIDEngine, BLOCK_SIZES, frequencyRegister, noteFrequency, type Strategy } from 'libsidgpu';
import { PRESETS, presetRegisters, demoEvents, type Preset } from './sid/presets';
import { SynthPanel } from './ui/SynthPanel';
import { Keyboard } from './ui/Keyboard';
import { Oscilloscope } from './ui/Oscilloscope';
import { Loader } from './ui/Loader';
import { renderOffline } from './benchmark/OfflineRenderer';
import { runBenchmarks, type BenchmarkRow } from './benchmark/BenchmarkRunner';
import { download, encodeWav } from './audio/WavExporter';
import { parseSID, type SIDFile } from './player/SIDFile';
import { SIDFileSource } from './player/SIDFileSource';

const ui = {
  start: document.querySelector<HTMLButtonElement>('#start')!,
  stop: document.querySelector<HTMLButtonElement>('#stop')!,
  reset: document.querySelector<HTMLButtonElement>('#reset')!,
  mute: document.querySelector<HTMLInputElement>('#mute')!,
  preset: document.querySelector<HTMLSelectElement>('#preset')!,
  demo: document.querySelector<HTMLButtonElement>('#demo')!,
  block: document.querySelector<HTMLSelectElement>('#block')!,
  strategy: document.querySelector<HTMLSelectElement>('#strategy')!,
  sidToggle: document.querySelector<HTMLButtonElement>('#sid-toggle')!,
  sidPlayer: document.querySelector<HTMLElement>('#sid-player')!,
  sidFile: document.querySelector<HTMLInputElement>('#sid-file')!,
  sidSong: document.querySelector<HTMLSelectElement>('#sid-song')!,
  sidUnload: document.querySelector<HTMLButtonElement>('#sid-unload')!,
  sidInfo: document.querySelector<HTMLParagraphElement>('#sid-info')!,
  sidTime: document.querySelector<HTMLOutputElement>('#sid-time')!,
  clock: document.querySelector<HTMLSpanElement>('#clock')!,
  status: document.querySelector<HTMLParagraphElement>('#status')!,
  synth: document.querySelector<HTMLElement>('#synth')!,
  keyboard: document.querySelector<HTMLDivElement>('#keyboard')!,
  scope: document.querySelector<HTMLCanvasElement>('#scope')!,
  headerScope: document.querySelector<HTMLCanvasElement>('#header-scope')!,
  headerLoader: document.querySelector<HTMLCanvasElement>('#header-loader')!,
  levels: document.querySelector<HTMLSpanElement>('#levels')!,
  diagnostics: document.querySelector<HTMLDListElement>('#diagnostics')!,
  duration: document.querySelector<HTMLInputElement>('#duration')!,
  offlineRate: document.querySelector<HTMLSelectElement>('#offline-rate')!,
  export: document.querySelector<HTMLButtonElement>('#export')!,
  trialSeconds: document.querySelector<HTMLInputElement>('#trial-seconds')!,
  experiment: document.querySelector<HTMLSelectElement>('#experiment')!,
  benchmark: document.querySelector<HTMLButtonElement>('#benchmark')!,
  cancel: document.querySelector<HTMLButtonElement>('#cancel')!,
  results: document.querySelector<HTMLPreElement>('#results')!,
};

ui.preset.replaceChildren(...PRESETS.map(name => new Option(name)));
ui.block.replaceChildren(...BLOCK_SIZES.map(size => new Option(String(size))));
ui.block.value = '256';

/* Activity owns the transport controls, including asynchronous setup and close.
 * Each operation keeps its own object: after an await, only the current owner
 * may update the UI. A stopped startup cannot overwrite a later session. */
type Activity =
  | { kind: 'idle' | 'starting' | 'playing' | 'stopping' | 'loading' }
  | { kind: 'offline'; controller: AbortController };

let activity: Activity = { kind: 'idle' };
let sidFile: SIDFile | null = null;
let engine: SIDEngine | null = null;
const audio = new AudioEngine();
const registers = presetRegisters('Lead');
const allocations = new Map<number, number>();
const scope = new Oscilloscope(ui.scope);
const headerScope = new Oscilloscope(ui.headerScope);
const loader = new Loader(ui.headerLoader);
let noteLatency = 0;
let generationStart = 0;
let generated = 0;
let generationRate = 0;

const panel = new SynthPanel(ui.synth, registers, (address, value) => {
  try {
    if (!sidFile) engine?.writeRegister(address, value);
  } catch (error) {
    showError(error);
  }
});
const keyboard = new Keyboard(ui.keyboard, noteOn, noteOff);

function showStatus(message: string) {
  ui.status.textContent = message;
  ui.status.classList.remove('error');
}

function showError(error: unknown) {
  ui.status.textContent = String(error);
  ui.status.classList.add('error');
}

function updateControls() {
  const idle = activity.kind === 'idle';
  const playing = activity.kind === 'playing';
  const interactive = idle || playing;
  const fileMode = sidFile !== null;

  ui.start.disabled = !idle;
  ui.stop.disabled = !playing && activity.kind !== 'starting';
  ui.reset.disabled = !interactive;
  ui.block.disabled = !idle;
  ui.strategy.disabled = !idle;
  ui.sidFile.disabled = !idle;
  ui.sidSong.disabled = !idle || !fileMode;
  ui.sidUnload.disabled = !idle || !fileMode;
  ui.preset.disabled = !interactive || fileMode;
  ui.demo.disabled = !interactive || fileMode;
  ui.export.disabled = !interactive;
  ui.benchmark.disabled = !interactive;
  ui.cancel.disabled = activity.kind !== 'offline';
  panel.setReadOnly(!interactive || fileMode);
  keyboard.setEnabled(interactive && !fileMode);
  ui.clock.textContent = sidFile ? `${sidFile.video} ${sidFile.clock} Hz` : 'PAL 985248 Hz';
}

function noteOn(note: number) {
  if (!engine || sidFile) return;
  const occupied = new Set(allocations.values());
  const voice = [0, 1, 2].find(index => panel.isEnabled(index) && !occupied.has(index));
  if (voice === undefined) return;

  allocations.set(note, voice);
  const base = voice * 7;
  const frequency = frequencyRegister(noteFrequency(note));
  panel.send(base, frequency & 255);
  panel.send(base + 1, frequency >> 8);
  panel.send(base + 4, registers[base + 4] & ~1);
  panel.send(base + 4, registers[base + 4] | 1);
  panel.refresh();

  const queuedSeconds = (engine.nextSample - audio.consumed) / engine.sampleRate;
  const contextLatency = (audio.context?.baseLatency ?? 0) + (audio.context?.outputLatency ?? 0);
  noteLatency = (queuedSeconds + contextLatency) * 1000;
}

function noteOff(note: number) {
  if (sidFile) return;
  const voice = allocations.get(note);
  if (voice === undefined) return;
  const control = voice * 7 + 4;
  panel.send(control, registers[control] & ~1);
  allocations.delete(note);
  panel.refresh();
}

audio.onSamples = samples => {
  scope.update(samples);
  headerScope.update(samples);
  generated += samples.length;
  const now = performance.now();
  if (now - generationStart >= 1000) {
    generationRate = generated * 1000 / (now - generationStart);
    generationStart = now;
    generated = 0;
  }
};
audio.onError = message => {
  engine = null;
  keyboard.clear();
  allocations.clear();
  activity = { kind: 'idle' };
  showError(message);
  updateControls();
};

async function start() {
  if (activity.kind !== 'idle' || document.hidden) return;
  const startup: Activity = { kind: 'starting' };
  activity = startup;
  ui.status.classList.remove('error');
  updateControls();

  try {
    const started = await audio.start(rate => {
      engine = new SIDEngine(rate, Number(ui.block.value), ui.strategy.value as Strategy, false, sidFile?.clock);
      if (sidFile) {
        panel.refresh(new Uint8Array(25), sidFile.clock);
        try {
          return new SIDFileSource(engine, sidFile, Number(ui.sidSong.value));
        } catch (error) {
          engine.dispose();
          throw error;
        }
      }
      registers.forEach((value, address) => panel.send(address, value));
      return engine;
    });
    if (activity !== startup) return;
    activity = { kind: started ? 'playing' : 'idle' };
    if (started) {
      audio.mute(ui.mute.checked);
      generationStart = performance.now();
      generated = 0;
      generationRate = 0;
      showStatus(sidFile
        ? `Playing: ${sidFile.title || 'PSID'} / subsong ${ui.sidSong.value}.`
        : 'Audio active. Play with the keyboard or enable Gate.');
    }
  } catch (error) {
    if (activity !== startup) return;
    engine = null;
    activity = { kind: 'idle' };
    showError(error);
  }
  updateControls();
}

/* Capture the audible register image before AudioEngine clears its cursor.
 * Keyboard releases must reach the live engine before it is disposed. */
async function releaseAudio() {
  if (audio.source instanceof SIDFileSource) {
    panel.refresh(audio.source.readPlaybackRegisters(audio.consumed), audio.source.engine.clock);
  }
  keyboard.clear();
  allocations.clear();
  engine = null;
  await audio.stop();
}

async function stop() {
  if (activity.kind === 'idle') return true;
  if (activity.kind !== 'starting' && activity.kind !== 'playing') return false;
  const stopping: Activity = { kind: 'stopping' };
  activity = stopping;
  updateControls();
  try {
    await releaseAudio();
  } catch (error) {
    if (activity !== stopping) return false;
    showError(error);
    activity = { kind: 'idle' };
    updateControls();
    return false;
  }
  if (activity !== stopping) return false;
  activity = { kind: 'idle' };
  updateControls();
  return true;
}

async function reset() {
  if (activity.kind !== 'idle' && activity.kind !== 'playing') return;
  if (sidFile) {
    if (await stop()) await start();
    return;
  }
  keyboard.clear();
  allocations.clear();
  engine?.reset();
  registers.set(presetRegisters(ui.preset.value as Preset));
  registers.forEach((value, address) => panel.send(address, value));
  panel.refresh();
}

async function loadFile() {
  const file = ui.sidFile.files?.[0];
  if (!file || activity.kind !== 'idle') return;
  loader.play();
  activity = { kind: 'loading' };
  updateControls();
  try {
    if (file.size > 0x10000 + 0xffff) throw new Error('File too large for a 64 KiB PSID.');
    const parsed = parseSID(new Uint8Array(await file.arrayBuffer()));
    sidFile = parsed;
    panel.refresh(new Uint8Array(25), parsed.clock);
    ui.sidSong.replaceChildren(...Array.from({ length: parsed.songs }, (_, index) => new Option(String(index + 1))));
    ui.sidSong.value = String(parsed.startSong);
    ui.sidInfo.textContent = `${parsed.title || file.name} / ${parsed.author || 'unknown author'} / ${parsed.released} / ${parsed.video} / SID ${parsed.model}`;
    showStatus('PSID loaded. Select a subsong and press Start.');
  } catch (error) {
    showError(error);
  } finally {
    activity = { kind: 'idle' };
    updateControls();
  }
}

async function offline(task: (signal: AbortSignal) => Promise<void>) {
  if (activity.kind !== 'idle' && activity.kind !== 'playing') return;
  const controller = new AbortController();
  activity = { kind: 'offline', controller };
  ui.status.classList.remove('error');
  updateControls();
  try {
    await releaseAudio();
    controller.signal.throwIfAborted();
    await task(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) showStatus('Operation cancelled.');
    else showError(error);
  } finally {
    activity = { kind: 'idle' };
    updateControls();
  }
}

async function exportWav(signal: AbortSignal) {
  const preset = ui.preset.value as Preset;
  const sampleRate = Number(ui.offlineRate.value);
  const seconds = Number(ui.duration.value);
  const config = {
    sampleRate,
    seconds,
    strategy: ui.strategy.value as Strategy,
    blockSize: Number(ui.block.value),
    events: demoEvents(preset, sampleRate, seconds),
  };
  showStatus('Rendering WAV on GPU...');
  const result = await renderOffline(config, signal);
  download(encodeWav(result.samples, sampleRate), 'gpu-sid.wav', 'audio/wav');
  const report = { preset, ...config, ...result.metrics, userAgent: navigator.userAgent };
  download(JSON.stringify(report, null, 2), 'gpu-sid.json', 'application/json');
  showStatus(`WAV generated. RTF ${result.metrics.realTimeFactor.toFixed(2)}x.`);
}

async function benchmark(signal: AbortSignal) {
  const seconds = Number(ui.trialSeconds.value);
  if (!Number.isFinite(seconds) || seconds < 0.02 || seconds > 10) {
    throw new Error('Trial duration must be between 0.02 and 10 s.');
  }
  const rows: BenchmarkRow[] = [];
  const strategies: Strategy[] = ui.experiment.value === 'parallel' ? ['parallel'] : ['baseline', 'checkpoint'];
  showStatus('Running GPU benchmark...');
  const result = await runBenchmarks(Number(ui.offlineRate.value), seconds, strategies, signal, row => {
    rows.push(row);
    ui.results.textContent = rows.map(row => {
      const configuration = `${row.strategy.padEnd(10)} ${String(row.blockSize).padStart(4)} / ${row.voices} voices / ${row.filter ? 'filter' : 'dry'}`;
      const timing = row.error ?? `RTF ${row.medianRTF!.toFixed(2)}x (${row.minRTF!.toFixed(2)}-${row.maxRTF!.toFixed(2)})`;
      return `${configuration} / ${timing}`;
    }).join('\n');
  });
  download(JSON.stringify(result, null, 2), 'gpu-sid-benchmark.json', 'application/json');
  showStatus('Benchmark complete.');
}

ui.start.onclick = start;
ui.stop.onclick = () => {
  showStatus('Audio stopped.');
  void stop();
};
ui.reset.onclick = reset;
ui.preset.onchange = reset;
ui.mute.onchange = () => audio.mute(ui.mute.checked);
ui.demo.onclick = () => {
  if (sidFile) return;
  if (!engine) {
    showStatus('Press Start before running the demo.');
    return;
  }
  const startSample = engine.nextSample;
  const events = demoEvents(ui.preset.value as Preset, engine.sampleRate, 8);
  for (const { sampleIndex, event } of events) engine.schedule(startSample + sampleIndex, event);
  showStatus('Playing demo (8 s).');
};
ui.sidToggle.onclick = () => {
  ui.sidPlayer.hidden = !ui.sidPlayer.hidden;
  ui.sidToggle.setAttribute('aria-expanded', String(!ui.sidPlayer.hidden));
};
ui.sidFile.onchange = loadFile;
ui.sidSong.onchange = () => {
  if (sidFile) panel.refresh(new Uint8Array(25), sidFile.clock);
};
ui.sidUnload.onclick = () => {
  loader.play();
  sidFile = null;
  ui.sidFile.value = '';
  panel.refresh();
  ui.sidSong.replaceChildren();
  ui.sidInfo.textContent = 'Select a PSID file and press Start.';
  showStatus('Synth mode active. Press Start to play.');
  updateControls();
};
ui.export.onclick = () => { void offline(exportWav); };
ui.benchmark.onclick = () => { void offline(benchmark); };
ui.cancel.onclick = () => {
  if (activity.kind === 'offline') activity.controller.abort();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (activity.kind === 'starting' || activity.kind === 'playing')) {
    showStatus('Page hidden. Press Start to resume.');
    void stop();
  }
});

setInterval(() => {
  const source = audio.source;
  if (source instanceof SIDFileSource) {
    panel.refresh(source.readPlaybackRegisters(audio.consumed), source.engine.clock);
  }
}, 33);

setInterval(() => {
  const rate = audio.context?.sampleRate ?? 0;
  const seconds = rate ? Math.floor(audio.consumed / rate) : 0;
  ui.sidTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const timer = engine?.timer;
  const ms = (value: number | null | undefined) => value == null ? 'unavailable' : `${value.toFixed(3)} ms`;
  const metrics: Record<string, string> = {
    'Output sample rate': rate ? `${rate} Hz` : 'stopped',
    'Block size': String(engine?.blockSize ?? ui.block.value),
    'Audio buffer fill': rate ? ms(audio.fill / rate * 1000) : '0 ms',
    'Underruns': String(audio.underruns),
    'Consumed samples': String(audio.consumed),
    'GPU state update / block': ms(timer?.stateMs),
    'GPU PCM shader / block': ms(timer?.pcmMs),
    'GPU render / block': timer?.stateMs != null && timer.pcmMs != null ? ms(timer.stateMs + timer.pcmMs) : 'unavailable',
    'Readback fence': ms(engine?.readback.latencyMs),
    'Readback CPU copy': ms(engine?.readback.copyMs),
    'CPU scheduling / tick': ms(audio.schedulingMs),
    'Audio generation rate': `${generationRate.toFixed(0)} sample/s`,
    'Live real-time factor': rate ? `${(generationRate / rate).toFixed(2)}x` : '0',
    'Note-on latency': ms(noteLatency),
    'PCM format': engine ? (engine.readback.float ? 'RGBA32F' : 'RGBA8 PCM16') : '-',
    'Renderer': engine?.renderer ?? '-',
  };
  ui.diagnostics.replaceChildren(...Object.entries(metrics).flatMap(([name, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (name === 'Underruns') dd.id = 'underruns';
    if (name === 'Consumed samples') dd.id = 'consumed';
    return [dt, dd];
  }));
  ui.levels.textContent = `RMS ${scope.rms.toFixed(3)} / Peak ${scope.peak.toFixed(3)} / Clip ${scope.clipping}`;
}, 250);

updateControls();
loader.play();
