// Quick CLI check: node tools/bot_run.mjs [file.json] [iterations]
import { readFileSync } from 'node:fs';
import { buildConfig, sheetStats } from '../src/config.js';
import { simAverage, runBotFight } from '../src/bot.js';

const file = process.argv[2] || 'example.json';
const iters = Number(process.argv[3] || 50);
const gd = JSON.parse(readFileSync(new URL('../src/data/gamedata.json', import.meta.url), 'utf8'));
const json = JSON.parse(readFileSync(file, 'utf8'));
const { cfg, warnings } = buildConfig(json, gd);
console.log('warnings:', warnings);
console.log('sheet:', sheetStats(cfg));
console.log('armor:', cfg.boss.armor, 'mh', cfg.mh?.name, 'oh', cfg.oh?.name);
const t0 = Date.now();
const avg = simAverage(cfg, iters);
console.log(`avg DPS ${avg.mean.toFixed(1)} +- ${avg.sd.toFixed(1)} over ${iters} runs (${Date.now() - t0}ms)`);
const one = runBotFight(cfg, { seed: 7 });
const s = one.sim;
console.log('casts', s.casts, 'wf', s.metrics.wfProcs, 'crusader', s.metrics.crusaderProcs);
console.log('by source', Object.fromEntries(Object.entries(s.bySource).map(([k, v]) => [k, Math.round(v / one.duration)])));
console.log('rage wasted', s.rageWasted.toFixed(0), 'gained', s.rageGained.toFixed(0));
console.log('bt delay', s.metrics.btDelay, 'ww delay', s.metrics.wwDelay);
