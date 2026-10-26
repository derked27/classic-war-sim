// Ability sounds, played through WebAudio so rapid presses never wait on decoding.
// sounds/manifest.json (from tools/build_sounds.mjs) maps an action to layers; each layer is a list of files and one is picked at random.
let ctx = null;
let gain = null;
let manifest = {};
const buffers = {};
let loading = null;
let volume = 0.2;
let muted = false;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  return ctx;
}

async function loadAll() {
  if (loading) return loading;
  loading = (async () => {
    try {
      manifest = await (await fetch('sounds/manifest.json')).json();
    } catch { return; }
    const names = new Set(Object.values(manifest).flat(2));
    await Promise.all([...names].map(async (n) => {
      try {
        const res = await fetch(`sounds/${n}.ogg`);
        if (res.ok) buffers[n] = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch { /* missing or undecodable file: that layer stays silent */ }
    }));
  })();
  return loading;
}

// Browsers keep audio locked until a user gesture, so call this from one (a click or keypress).
export function unlockSound() {
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume();
  loadAll();
}

export function setSound({ volume: v, muted: m }) {
  if (v !== undefined) volume = Math.max(0, Math.min(1, v));
  if (m !== undefined) muted = !!m;
  if (gain) gain.gain.value = volume;
}

const ready = () => !muted && ctx && ctx.state === 'running';

function playLayers(layers, level = 1) {
  if (!layers) return;
  const out = ctx.createGain();
  out.gain.value = level;
  out.connect(gain);
  for (const files of layers) {
    const buf = buffers[files[Math.floor(Math.random() * files.length)]];
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    src.start();
  }
}

export function playAbility(id) {
  if (!ready()) return;
  playLayers(manifest[id] || (id.startsWith('item_') ? manifest.item : null));
}

// White swings come constantly, so they sit well under the ability sounds.
export function playSwing(outcome) {
  if (!ready()) return;
  const key = outcome === 'crit' ? 'swingCrit' : outcome === 'miss' || outcome === 'dodge' ? 'swingMiss' : 'swingHit';
  playLayers(manifest[key], 0.45);
}

// Synthesized lightsaber swing: a detuned saw hum that sweeps up and back down, with a filtered whoosh of noise.
export function playLightsaber() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const dur = 0.7;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.4);
  lp.frequency.exponentialRampToValueAtTime(400, t + dur);
  lp.connect(out);
  out.connect(gain);
  // 28 Hz tremolo gives the characteristic saber buzz
  const trem = ctx.createGain();
  trem.gain.value = 0.7;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 28;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.3;
  lfo.connect(lfoDepth).connect(trem.gain);
  trem.connect(lp);
  for (const detune of [-14, 0, 14]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(260, t + dur * 0.4);
    osc.frequency.exponentialRampToValueAtTime(110, t + dur);
    osc.connect(trem);
    osc.start(t);
    osc.stop(t + dur);
  }
  lfo.start(t);
  lfo.stop(t + dur);
  const noise = ctx.createBufferSource();
  const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noise.buffer = nb;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.exponentialRampToValueAtTime(3000, t + dur * 0.4);
  bp.frequency.exponentialRampToValueAtTime(500, t + dur);
  const ng = ctx.createGain();
  ng.gain.value = 0.35;
  noise.connect(bp).connect(ng).connect(out);
  noise.start(t);
}
