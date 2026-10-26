// Compare rotation variants against the priority list from a WoWSims export, using the same RNG seeds for each.
//   node tools/rotation_test.mjs [file.json] [iterations] [durationSeconds]
import { readFileSync } from 'node:fs';
import { buildConfig } from '../src/config.js';
import { Sim } from '../src/engine.js';
import { Bot } from '../src/bot.js';

const file = process.argv[2] || 'example.json';
const iters = Number(process.argv[3] || 300);
const durations = process.argv[4] ? [Number(process.argv[4])] : [60, 120];
const gd = JSON.parse(readFileSync(new URL('../src/data/gamedata.json', import.meta.url), 'utf8'));
const { cfg } = buildConfig(JSON.parse(readFileSync(file, 'utf8')), gd);

const baseActions = new Bot(cfg).actions;
const idx = (id) => baseActions.findIndex((a) => a.id === id);
const insertAt = (list, i, ...extra) => [...list.slice(0, i), ...extra, ...list.slice(i)];
const without = (list, i) => list.filter((_, k) => k !== i);

const gcdIdle = (s) => s.status('bt').cdLeft > 1.5 && s.status('ww').cdLeft > 1.5;
const mk = (id, cond) => ({ id, auto: false, cond });
const hamAt = (rage) => mk('ham', (s) => gcdIdle(s) && s.rage >= rage && s.stance === 4);

// fraction of the main-hand swing still to come: ~1 right after the MH swing landed, ~0 just before the next one
const swingLeft = (s) => Math.max(0, (s.mhAt - s.t) / (s.weapons.mh.speed / s.speed));
const hamFresh = (rage, minLeft) => mk('ham', (s) => gcdIdle(s) && s.rage >= rage && s.stance === 4 && swingLeft(s) >= minLeft);
const hamStale = (rage, maxLeft) => mk('ham', (s) => gcdIdle(s) && s.rage >= rage && s.stance === 4 && swingLeft(s) <= maxLeft);

const variants = [
  { name: 'Your list (baseline)', actions: baseActions },
  { name: 'Hamstring 30+ rage, any time', actions: insertAt(baseActions, idx('ham'), hamAt(30)) },
  { name: 'Hamstring 30+ rage, only right AFTER an MH swing (60%+ of swing left)', actions: insertAt(baseActions, idx('ham'), hamFresh(30, 0.6)) },
  { name: 'Hamstring 30+ rage, only right BEFORE an MH swing (40% or less left)', actions: insertAt(baseActions, idx('ham'), hamStale(30, 0.4)) },
  { name: 'Hamstring 50+ rage, only right AFTER an MH swing', actions: insertAt(baseActions, idx('ham'), hamFresh(50, 0.6)) },
  { name: 'Hamstring 20+ rage, only right AFTER an MH swing', actions: insertAt(baseActions, idx('ham'), hamFresh(20, 0.6)) },
];
const unused = [
  { name: 'Your list (baseline)', actions: baseActions },
  { name: 'Hamstring filler at 50+ rage', actions: insertAt(baseActions, idx('ham'), hamAt(50)) },
  { name: 'Hamstring filler at 65+ rage', actions: insertAt(baseActions, idx('ham'), hamAt(65)) },
  { name: 'Hamstring filler at 30+ rage', actions: insertAt(baseActions, idx('ham'), hamAt(30)) },
  { name: 'No Hamstring at all', actions: without(baseActions, idx('ham')) },
  {
    name: 'Overpower after a dodge when rage <= 25 (stance swap loses nothing)', autoStance: true,
    actions: insertAt(baseActions, idx('bt'), mk('op', (s) => s.t < s.opUntil && s.rage <= 25 && s.status('bt').cdLeft > 1.5)),
  },
  {
    name: 'Overpower after a dodge when rage <= 40 (swap loses a little rage)', autoStance: true,
    actions: insertAt(baseActions, idx('bt'), mk('op', (s) => s.t < s.opUntil && s.rage <= 40 && s.status('bt').cdLeft > 1.5)),
  },
];

const stats = (arr) => {
  const m = arr.reduce((a, x) => a + x, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1));
  return { m, se: sd / Math.sqrt(arr.length) };
};

for (const dur of durations) {
  console.log(`\n=== ${dur}s fights, ${iters} paired runs ===`);
  const results = variants.map((v) => {
    const dps = [], flurry = [], wf = [], white = [];
    for (let i = 0; i < iters; i++) {
      const sim = new Sim(cfg, { mode: 'bot', duration: dur, seed: 777 + i });
      const bot = new Bot(cfg, { autoStance: v.autoStance });
      bot.actions = v.actions;
      while (sim.t < dur) { bot.act(sim); sim.step(); }
      dps.push(sim.total / dur);
      flurry.push(sim.metrics.flurryUp / dur * 100);
      wf.push(sim.metrics.wfProcs / dur * 60);
      white.push(((sim.bySource['Auto Attack (MH)'] || 0) + (sim.bySource['Auto Attack (OH)'] || 0)) / dur);
    }
    return { v, dps, flurry, wf, white };
  });
  const base = results[0].dps;
  for (const { v, dps, flurry, wf, white } of results) {
    const s = stats(dps);
    const diff = stats(dps.map((x, i) => x - base[i]));
    const tag = v === variants[0] ? '' : `  diff ${diff.m >= 0 ? '+' : ''}${diff.m.toFixed(0)} ± ${(diff.se * 1.96).toFixed(0)} (95%)`;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`${v.name.padEnd(70)} ${s.m.toFixed(0).padStart(5)} DPS${tag}`);
    console.log(`${' '.repeat(70)} flurry up ${avg(flurry).toFixed(1)}%, Windfury ${avg(wf).toFixed(1)}/min, white-hit DPS ${avg(white).toFixed(0)}`);
  }
}
