// Minimal, readable, and explicit Web Audio based mixer that uses Spotify-style analysis JSON

/**
 * Data models extracted from analysis JSON
 */
class AnalysisData {
  /**
   * @param {{track: any, beats: Array<{start:number,duration:number,confidence:number}>, bars?: any[], sections?: Array<any>}} json
   */
  constructor(json) {
    this.raw = json;
    this.tempo = json?.track?.tempo ?? null;
    this.key = json?.track?.key ?? null;
    this.mode = json?.track?.mode ?? null;
    this.timeSignature = json?.track?.time_signature ?? 4;
    this.beats = Array.isArray(json?.beats) ? json.beats : [];
    this.sections = Array.isArray(json?.sections) ? json.sections : [];
  }

  /** Return best downbeat candidates using bars start times (fallback to strong beats if no bars) */
  getDownbeats() {
    if (Array.isArray(this.raw?.bars) && this.raw.bars.length > 0) {
      return this.raw.bars.map(b => b.start);
    }
    // fallback: use every 4th beat as downbeat
    if (this.beats.length > 0) {
      return this.beats.map(b => b.start).filter((_, i) => i % this.timeSignature === 0);
    }
    return [0];
  }
}

/** Utility functions */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function createEqualPowerGains(t) {
  // Equal power crossfade: gA = cos(t * pi/2), gB = sin(t * pi/2)
  const gA = Math.cos(t * Math.PI * 0.5);
  const gB = Math.sin(t * Math.PI * 0.5);
  return { gA, gB };
}

function createLinearGains(t) {
  return { gA: 1 - t, gB: t };
}

function createRiseGains(t) {
  // Ease-in cubic for B, slightly quicker drop for A
  const gB = t * t * (3 - 2 * t); // smoothstep
  const gA = 1 - Math.pow(t, 0.8);
  return { gA, gB };
}

function chooseCurve(name) {
  switch (name) {
    case 'linear': return createLinearGains;
    case 'rise': return createRiseGains;
    case 'equal-power':
    default: return createEqualPowerGains;
  }
}

/**
 * Draw simple waveform previews (using decoded PCM, downsampled)
 */
function drawWaveform(canvas, audioBuffer) {
  if (!canvas || !audioBuffer) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0f1319';
  ctx.fillRect(0, 0, width, height);

  const channel = audioBuffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
  ctx.strokeStyle = '#1db954';
  ctx.beginPath();
  const mid = height / 2;
  for (let x = 0; x < width; x++) {
    const start = x * samplesPerPixel;
    let min = 1.0;
    let max = -1.0;
    for (let i = 0; i < samplesPerPixel; i++) {
      const v = channel[start + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x, mid + min * mid);
    ctx.lineTo(x, mid + max * mid);
  }
  ctx.stroke();
}

/**
 * Transition planner: choose downbeat-aligned points and compute duration by beats
 */
function planTransition(analysisA, analysisB, beatsLength, tempoStrategy) {
  const downbeatsA = analysisA.getDownbeats();
  const downbeatsB = analysisB.getDownbeats();

  const tempoA = analysisA.tempo || 120;
  const tempoB = analysisB.tempo || 120;

  let targetTempoA = tempoA;
  let targetTempoB = tempoB;
  if (tempoStrategy === 'matchBtoA') {
    targetTempoB = tempoA;
  } else if (tempoStrategy === 'matchAtoB') {
    targetTempoA = tempoB;
  } else if (tempoStrategy === 'average') {
    const avg = (tempoA + tempoB) / 2;
    targetTempoA = avg;
    targetTempoB = avg;
  }

  const secondsPerBeatA = 60 / targetTempoA;
  const secondsPerBeatB = 60 / targetTempoB;
  const xfadeDuration = beatsLength * Math.max(secondsPerBeatA, secondsPerBeatB);

  // Choose near-outro downbeat in A and near-intro downbeat in B
  const totalA = analysisA?.raw?.track?.duration || (analysisA.beats.at(-1)?.start || 180);
  const safeMargin = 5; // seconds
  const startA = [...downbeatsA].reverse().find(t => t < (totalA - xfadeDuration - safeMargin)) ?? Math.max(0, totalA - xfadeDuration - safeMargin);
  const startB = downbeatsB[0] ?? 0;

  return {
    startA,
    startB,
    xfadeDuration,
    targetTempoA,
    targetTempoB,
  };
}

/**
 * Web Audio Mixer: preview and offline render
 */
class MixerEngine {
  constructor() {
    this.context = null;
    this.offlineRendering = false;
  }

  async createContext({ sampleRate }) {
    if (this.context) this.context.close().catch(() => {});
    this.context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    return this.context;
  }

  schedulePreview(plan, buffers, options) {
    const ctx = this.context;
    if (!ctx) throw new Error('AudioContext fehlt');

    const { bufferA, bufferB } = buffers;
    const { curve, eqEnable, eqLowDuckDb, eqHighBoostDb } = options;

    const g = ctx.createGain();
    g.connect(ctx.destination);

    // Sources with playbackRate for tempo matching (naive time-stretch via resample)
    const srcA = ctx.createBufferSource();
    srcA.buffer = bufferA;
    srcA.playbackRate.value = (plan.targetTempoA || 120) / (buffers.metaA.tempo || 120);

    const srcB = ctx.createBufferSource();
    srcB.buffer = bufferB;
    srcB.playbackRate.value = (plan.targetTempoB || 120) / (buffers.metaB.tempo || 120);

    // Per-track gains
    const gainA = ctx.createGain();
    const gainB = ctx.createGain();

    // Optional gentle EQ: duck lows of A, boost highs of B during xfade
    let nodeA = srcA;
    let nodeB = srcB;
    let lowShelfA, highShelfB;
    if (eqEnable) {
      lowShelfA = ctx.createBiquadFilter();
      lowShelfA.type = 'lowshelf';
      lowShelfA.frequency.value = 150;
      lowShelfA.gain.value = 0; // automated later
      highShelfB = ctx.createBiquadFilter();
      highShelfB.type = 'highshelf';
      highShelfB.frequency.value = 6000;
      highShelfB.gain.value = 0; // automated later
      nodeA.connect(lowShelfA);
      nodeA = lowShelfA;
      nodeB.connect(highShelfB);
      nodeB = highShelfB;
    }

    nodeA.connect(gainA).connect(g);
    nodeB.connect(gainB).connect(g);

    const now = ctx.currentTime + 0.1;
    const startAInBuffer = plan.startA;
    const startBInBuffer = plan.startB;
    const xfade = plan.xfadeDuration;

    const t0 = now; // A starts
    const tX = t0 + xfade; // end of crossfade

    srcA.start(t0, startAInBuffer);
    srcB.start(t0, startBInBuffer);

    // Automate gains according to curve
    gainA.gain.setValueAtTime(1, t0);
    gainB.gain.setValueAtTime(0, t0);
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const tt = i / steps;
      const { gA, gB } = curve(tt);
      const t = t0 + tt * xfade;
      gainA.gain.linearRampToValueAtTime(clamp(gA, 0, 1), t);
      gainB.gain.linearRampToValueAtTime(clamp(gB, 0, 1), t);
      if (eqEnable) {
        lowShelfA.gain.linearRampToValueAtTime(eqLowDuckDb * tt, t);
        highShelfB.gain.linearRampToValueAtTime(eqHighBoostDb * tt, t);
      }
    }

    // After crossfade, fade out A quickly and keep B
    gainA.gain.linearRampToValueAtTime(0, tX + 0.01);
    gainB.gain.linearRampToValueAtTime(1, tX + 0.01);

    return { ctx, srcA, srcB, stopAt: tX + 1.0 };
  }

  async renderOffline(plan, buffers, options) {
    const sampleRate = 44100;
    const renderDuration = plan.xfadeDuration + 8; // seconds
    const oac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(renderDuration * sampleRate), sampleRate });

    const { bufferA, bufferB } = buffers;
    const { curve, eqEnable, eqLowDuckDb, eqHighBoostDb } = options;

    const srcA = oac.createBufferSource();
    srcA.buffer = bufferA;
    srcA.playbackRate.value = (plan.targetTempoA || 120) / (buffers.metaA.tempo || 120);

    const srcB = oac.createBufferSource();
    srcB.buffer = bufferB;
    srcB.playbackRate.value = (plan.targetTempoB || 120) / (buffers.metaB.tempo || 120);

    const gainA = oac.createGain();
    const gainB = oac.createGain();

    let nodeA = srcA;
    let nodeB = srcB;
    let lowShelfA, highShelfB;
    if (eqEnable) {
      lowShelfA = oac.createBiquadFilter();
      lowShelfA.type = 'lowshelf';
      lowShelfA.frequency.value = 150;
      lowShelfA.gain.value = 0;
      highShelfB = oac.createBiquadFilter();
      highShelfB.type = 'highshelf';
      highShelfB.frequency.value = 6000;
      highShelfB.gain.value = 0;
      nodeA.connect(lowShelfA);
      nodeA = lowShelfA;
      nodeB.connect(highShelfB);
      nodeB = highShelfB;
    }

    nodeA.connect(gainA).connect(oac.destination);
    nodeB.connect(gainB).connect(oac.destination);

    const t0 = 0.05;
    const xfade = plan.xfadeDuration;

    srcA.start(t0, plan.startA);
    srcB.start(t0, plan.startB);

    gainA.gain.setValueAtTime(1, t0);
    gainB.gain.setValueAtTime(0, t0);
    const steps = 128;
    for (let i = 0; i <= steps; i++) {
      const tt = i / steps;
      const { gA, gB } = curve(tt);
      const t = t0 + tt * xfade;
      gainA.gain.linearRampToValueAtTime(clamp(gA, 0, 1), t);
      gainB.gain.linearRampToValueAtTime(clamp(gB, 0, 1), t);
      if (eqEnable) {
        lowShelfA.gain.linearRampToValueAtTime(eqLowDuckDb * tt, t);
        highShelfB.gain.linearRampToValueAtTime(eqHighBoostDb * tt, t);
      }
    }

    gainA.gain.linearRampToValueAtTime(0, t0 + xfade + 0.01);
    gainB.gain.linearRampToValueAtTime(1, t0 + xfade + 0.01);

    const rendered = await oac.startRendering();
    return rendered;
  }
}

// DOM wiring
const els = {
  audioA: document.getElementById('audioA'),
  jsonA: document.getElementById('jsonA'),
  audioB: document.getElementById('audioB'),
  jsonB: document.getElementById('jsonB'),
  metaA: document.getElementById('metaA'),
  metaB: document.getElementById('metaB'),
  waveA: document.getElementById('waveA'),
  waveB: document.getElementById('waveB'),
  curvePreset: document.getElementById('curvePreset'),
  beatsLength: document.getElementById('beatsLength'),
  tempoStrategy: document.getElementById('tempoStrategy'),
  eqEnable: document.getElementById('eqEnable'),
  eqLowDuckDb: document.getElementById('eqLowDuckDb'),
  eqHighBoostDb: document.getElementById('eqHighBoostDb'),
  autoPlan: document.getElementById('autoPlan'),
  planInfo: document.getElementById('planInfo'),
  previewPlay: document.getElementById('previewPlay'),
  previewStop: document.getElementById('previewStop'),
  renderExport: document.getElementById('renderExport'),
  status: document.getElementById('status'),
};

const state = {
  fileA: null,
  fileB: null,
  analysisA: null,
  analysisB: null,
  bufferA: null,
  bufferB: null,
  engine: new MixerEngine(),
  currentPlan: null,
  playing: false,
  previewNodes: null,
};

function setStatus(text) {
  els.status.textContent = text || '';
}

function enableTransport(enable) {
  els.previewPlay.disabled = !enable;
  els.previewStop.disabled = !enable;
  els.renderExport.disabled = !enable;
}

function updateMeta(side, analysis) {
  const el = side === 'A' ? els.metaA : els.metaB;
  if (!analysis) { el.textContent = ''; return; }
  const tempo = analysis.tempo ? `${analysis.tempo.toFixed(1)} BPM` : '– BPM';
  const key = Number.isFinite(analysis.key) ? `Key ${analysis.key}` : '– Key';
  const sig = analysis.timeSignature ? `${analysis.timeSignature}/4` : '–/–';
  el.textContent = `${tempo} • ${key} • ${sig}`;
}

async function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(fr.result);
    fr.readAsArrayBuffer(file);
  });
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(fr.result);
    fr.readAsText(file);
  });
}

async function decodeAudio(arrayBuffer) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(arrayBuffer.slice(0));
  await ac.close();
  return buf;
}

async function handleAudio(side, file) {
  if (!file) return;
  setStatus('Dekodiere Audio …');
  const ab = await readFileAsArrayBuffer(file);
  const buffer = await decodeAudio(ab);
  if (side === 'A') {
    state.bufferA = buffer;
    drawWaveform(els.waveA, buffer);
  } else {
    state.bufferB = buffer;
    drawWaveform(els.waveB, buffer);
  }
  setStatus('');
  maybeEnablePlan();
}

async function handleJSON(side, file) {
  if (!file) return;
  const txt = await readFileAsText(file);
  const json = JSON.parse(txt);
  const analysis = new AnalysisData(json);
  if (side === 'A') {
    state.analysisA = analysis;
    updateMeta('A', analysis);
  } else {
    state.analysisB = analysis;
    updateMeta('B', analysis);
  }
  maybeEnablePlan();
}

function maybeEnablePlan() {
  const ready = !!(state.bufferA && state.bufferB && state.analysisA && state.analysisB);
  els.autoPlan.disabled = !ready;
  if (ready) enableTransport(true);
}

function getCurveFn() {
  const name = els.curvePreset.value;
  return chooseCurve(name);
}

function getTempoStrategy() {
  return els.tempoStrategy.value;
}

function getBeatsLength() {
  const val = parseInt(els.beatsLength.value, 10);
  return clamp(isNaN(val) ? 16 : val, 1, 128);
}

els.audioA.addEventListener('change', e => handleAudio('A', e.target.files?.[0] || null));
els.audioB.addEventListener('change', e => handleAudio('B', e.target.files?.[0] || null));
els.jsonA.addEventListener('change', e => handleJSON('A', e.target.files?.[0] || null));
els.jsonB.addEventListener('change', e => handleJSON('B', e.target.files?.[0] || null));

els.autoPlan.addEventListener('click', () => {
  if (!state.analysisA || !state.analysisB) return;
  const beats = getBeatsLength();
  const plan = planTransition(state.analysisA, state.analysisB, beats, getTempoStrategy());
  state.currentPlan = plan;
  const text = `Start A: ${plan.startA.toFixed(2)}s • Start B: ${plan.startB.toFixed(2)}s • Dauer: ${plan.xfadeDuration.toFixed(2)}s • Zieltempi: A ${plan.targetTempoA.toFixed(1)}, B ${plan.targetTempoB.toFixed(1)}`;
  els.planInfo.textContent = text;
});

els.previewPlay.addEventListener('click', async () => {
  if (!state.currentPlan || !state.bufferA || !state.bufferB) return;
  if (!state.engine.context) await state.engine.createContext({ sampleRate: 44100 });
  const nodes = state.engine.schedulePreview(
    state.currentPlan,
    {
      bufferA: state.bufferA,
      bufferB: state.bufferB,
      metaA: { tempo: state.analysisA.tempo || 120 },
      metaB: { tempo: state.analysisB.tempo || 120 },
    },
    {
      curve: getCurveFn(),
      eqEnable: els.eqEnable.checked,
      eqLowDuckDb: Number(els.eqLowDuckDb.value) || 0,
      eqHighBoostDb: Number(els.eqHighBoostDb.value) || 0,
    }
  );
  state.previewNodes = nodes;
  state.playing = true;
  setStatus('Spiele Vorschau …');
  setTimeout(() => setStatus(''), (state.currentPlan.xfadeDuration + 1) * 1000);
});

els.previewStop.addEventListener('click', () => {
  try { state.engine?.context?.close(); } catch {}
  state.engine.context = null;
  state.playing = false;
  setStatus('');
});

els.renderExport.addEventListener('click', async () => {
  if (!state.currentPlan || !state.bufferA || !state.bufferB) return;
  setStatus('Rendern …');
  const rendered = await state.engine.renderOffline(
    state.currentPlan,
    {
      bufferA: state.bufferA,
      bufferB: state.bufferB,
      metaA: { tempo: state.analysisA.tempo || 120 },
      metaB: { tempo: state.analysisB.tempo || 120 },
    },
    {
      curve: getCurveFn(),
      eqEnable: els.eqEnable.checked,
      eqLowDuckDb: Number(els.eqLowDuckDb.value) || 0,
      eqHighBoostDb: Number(els.eqHighBoostDb.value) || 0,
    }
  );
  // Export WAV
  const wav = audioBufferToWav(rendered);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mix-transition.wav';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus('');
});

// WAV encoding (stereo, 16-bit PCM)
function audioBufferToWav(buffer) {
  const numOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const samples = buffer.length * numOfChannels;
  const blockAlign = numOfChannels * bitDepth / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const bufferSize = 44 + dataSize;
  const ab = new ArrayBuffer(bufferSize);
  const dv = new DataView(ab);
  let offset = 0;

  function writeString(s) {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
    offset += s.length;
  }
  function writeUint32(v) { dv.setUint32(offset, v, true); offset += 4; }
  function writeUint16(v) { dv.setUint16(offset, v, true); offset += 2; }

  // RIFF header
  writeString('RIFF');
  writeUint32(36 + dataSize);
  writeString('WAVE');

  // fmt chunk
  writeString('fmt ');
  writeUint32(16);
  writeUint16(format);
  writeUint16(numOfChannels);
  writeUint32(sampleRate);
  writeUint32(byteRate);
  writeUint16(blockAlign);
  writeUint16(bitDepth);

  // data chunk
  writeString('data');
  writeUint32(dataSize);

  // interleave channels
  const channels = [];
  for (let i = 0; i < numOfChannels; i++) channels.push(buffer.getChannelData(i));
  let sampleIndex = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numOfChannels; ch++) {
      const v = clamp(channels[ch][i], -1, 1);
      dv.setInt16(44 + sampleIndex * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      sampleIndex++;
    }
  }
  return ab;
}

// Enable export when files ready
const observer = new MutationObserver(() => {
  const ready = !!(state.bufferA && state.bufferB && state.analysisA && state.analysisB && state.currentPlan);
  els.renderExport.disabled = !ready;
});
observer.observe(els.planInfo, { childList: true });


