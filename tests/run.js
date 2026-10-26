// Plain-node tests: node tests/run.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildConfig, sheetStats, parseTalents, applyGearSet } from '../src/config.js';
import { Sim, STANCE, rageConversion } from '../src/engine.js';
import { runBotFight, simAverage } from '../src/bot.js';
import { buildReport, gradeFor } from '../src/score.js';
import { percentile, parseDisplay, parseTier } from '../src/parse.js';
import { getPlayer, setPlayerName, submitScore, listScores, neighbors, paginate } from '../src/scores.js';
import { comboFromKeyEvent, prettyCombo, findConflict, reverseMap } from '../src/keybinds.js';

const gd = JSON.parse(readFileSync(new URL('../src/data/gamedata.json', import.meta.url), 'utf8'));
const json = JSON.parse(readFileSync(new URL('../example.json', import.meta.url), 'utf8'));
const { cfg, warnings } = buildConfig(json, gd);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('ok   ', name); } catch (err) { console.error('FAIL ', name, '\n', err.message); process.exitCode = 1; }
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} ± ${eps}, got ${a}`);

test('talent string decodes the Fury build', () => {
  const t = parseTalents(json.player.talentsString);
  assert.equal(t.improvedHeroicStrike, 3);
  assert.equal(t.tacticalMastery, 5);
  assert.equal(t.deepWounds, 3);
  assert.equal(t.impale, 2);
  assert.equal(t.cruelty, 5);
  assert.equal(t.dualWieldSpecialization, 5);
  assert.equal(t.improvedExecute, 2);
  assert.equal(t.flurry, 5);
  assert.equal(t.bloodthirst, 1);
  assert.equal(t.deathWish, 1);
});

test('import resolves every item and enchant', () => {
  assert.deepEqual(warnings.filter((w) => /^(Unknown|No main-hand)/.test(w)), []);
  assert.equal(cfg.equipped.filter(Boolean).length, 17);
  assert.equal(cfg.mh.name, 'Gressil, Dawn of Ruin');
  assert.equal(cfg.oh.name, 'The Hungering Cold');
  assert.ok(cfg.crusaderMH && cfg.crusaderOH && cfg.windfury);
});

const gearSets = JSON.parse(readFileSync(new URL('../src/data/gearsets.json', import.meta.url), 'utf8'));

test('default gear sets cover Pre-BiS, P1 and P6', () => {
  assert.deepEqual(gearSets.map((s) => s.key), ['p0', 'p1', 'p6']);
});

test('every default gear set resolves cleanly and keeps the rest of the character', () => {
  const before = JSON.stringify(json);
  for (const set of gearSets) {
    const applied = applyGearSet(json, set);
    const built = buildConfig(applied, gd);
    // "no modeled effect" notes are fine; unknown ids and missing weapons are not.
    assert.deepEqual(built.warnings.filter((w) => /^(Unknown|No main-hand)/.test(w)), [], set.label);
    assert.equal(built.cfg.equipped.length, 17, set.label);
    assert.ok(built.cfg.mh && built.cfg.oh, `${set.label} has both weapons`);
    assert.equal(applied.player.talentsString, json.player.talentsString);
    assert.deepEqual(applied.player.rotation, json.player.rotation);
  }
  assert.equal(JSON.stringify(json), before, 'input not mutated');
});

test('boss armor after debuffs (Expose beats Sunder, then Recklessness and Faerie Fire)', () => {
  assert.equal(cfg.boss.armor, 3731 - 2550 - 640 - 505);
});

test('character sheet regression', () => {
  const s = sheetStats(cfg);
  near(s.ap, 2411.8, 1, 'AP');
  near(s.crit, 58.02, 0.05, 'crit');
  near(s.hit, 12, 0.01, 'hit');
});

test('rage conversion constants', () => {
  near(rageConversion(), 230.6, 0.1);
});

test('attack table vs a level 63 boss', () => {
  const sim = new Sim(cfg, { mode: 'bot', duration: 60 });
  near(sim.tab.mh.baseMiss, 0.059, 1e-9, 'MH miss (skill 306 from The Hungering Cold)');
  near(sim.tab.oh.baseMiss, 0.059, 1e-9, 'OH miss (skill 306)');
  near(sim.tab.oh.hitSupp, 0, 1e-9, 'OH hit suppression');
  near(sim.tab.mh.baseGlance, 0.4, 1e-9, 'glance chance');
  near(sim.tab.mh.critSupp, 0.048, 1e-9, 'crit suppression');
});

test('weapon skill from a sword applies to every sword wielded, plus the Orc axe racial', () => {
  const withWeapons = (mhId, ohId) => {
    const j = JSON.parse(JSON.stringify(json));
    j.player.equipment.items[14] = { id: mhId };
    j.player.equipment.items[15] = { id: ohId };
    return buildConfig(j, gd).cfg;
  };
  const gressil = 23054, coldId = 23577, hatchet = 22816, maladath = 19351;
  assert.equal(cfg.skillMH, 306, 'Gressil benefits from The Hungering Cold');
  assert.equal(cfg.skillOH, 306);
  const swordAxe = withWeapons(gressil, hatchet);
  assert.equal(swordAxe.skillMH, 300, 'no sword skill gear, axe in the other hand');
  assert.equal(swordAxe.skillOH, 305, 'Orc axe racial');
  const twoSwords = withWeapons(maladath, coldId);
  assert.equal(twoSwords.skillMH, 310);
  assert.equal(twoSwords.skillOH, 310, 'skill from both swords stacks on both swords');
  const axeSword = withWeapons(hatchet, coldId);
  assert.equal(axeSword.skillMH, 305, 'sword skill does not apply to axes');
  assert.equal(axeSword.skillOH, 306);
});

test("Edgemaster's Handguards add +7 to axes, swords and daggers", () => {
  const j = JSON.parse(JSON.stringify(json));
  j.player.equipment.items[6] = { id: 14551 };
  const c = buildConfig(j, gd).cfg;
  assert.equal(c.skillMH, 313, 'Gressil: 300 + 6 (The Hungering Cold) + 7');
  assert.equal(c.skillOH, 313);
  j.player.equipment.items[14] = { id: 22816 };
  assert.equal(buildConfig(j, gd).cfg.skillMH, 312, 'Hatchet: 300 + 5 Orc racial + 7');
});

test('same seed gives the same fight', () => {
  const a = runBotFight(cfg, { seed: 99 });
  const b = runBotFight(cfg, { seed: 99 });
  assert.equal(a.dps, b.dps);
  const c = runBotFight(cfg, { seed: 100 });
  assert.notEqual(a.dps, c.dps);
});

test('abilities spend rage, share the GCD and respect cooldowns', () => {
  const sim = new Sim(cfg, { mode: 'player', seed: 3, startRage: 100 });
  assert.ok(sim.cast('bt').ok);
  near(sim.rage, 70, 25, 'rage after BT (a miss refunds 24)');
  assert.equal(sim.cast('bt').ok, false);
  const ww = sim.cast('ww');
  assert.equal(ww.ok, false);
  assert.equal(ww.reason, 'gcd');
  for (let i = 0; i < 320; i++) sim.step();       // 1.6s: GCD over, BT still on its 6s CD
  assert.equal(sim.status('bt').reason, 'cd');
  assert.equal(sim.status('ww').ready, true);
});

test('Overpower needs a dodge and Battle Stance; swapping keeps 25 rage', () => {
  const sim = new Sim(cfg, { mode: 'player', seed: 4, startRage: 80 });
  assert.equal(sim.status('op').reason, 'stance');
  sim.cast('stBattle');
  assert.equal(sim.stance, STANCE.BATTLE);
  assert.equal(sim.rage, 25);
  assert.equal(sim.status('op').reason, 'notready');
  sim.onMeleeHit({ name: 'x', hand: 'mh', white: true, outcome: 'dodge', landed: false });
  assert.equal(sim.status('op').ready, true);
  assert.ok(sim.cast('op').ok);
  assert.notEqual(sim.status('op').reason, null);
});

test('queued Heroic Strike removes the dual-wield penalty for off-hand swings', () => {
  const sim = new Sim(cfg, { mode: 'bot', duration: 60, seed: 5 });
  while (sim.t < 60) {
    sim.rage = 100;
    if (!sim.hsQueued) sim.cast('hs');
    sim.step();
  }
  const ratio = sim.metrics.ohPenaltyFree / sim.metrics.ohSwings;
  assert.ok(ratio > 0.85, `penalty-free OH ratio ${ratio}`);
  assert.ok(sim.metrics.hsCast > 15);
});

test('Heroic Strike drops to a white hit when rage is gone at swing time', () => {
  const sim = new Sim(cfg, { mode: 'bot', duration: 60, seed: 6, startRage: 20 });
  sim.cast('hs');
  assert.equal(sim.hsQueued, true);
  sim.rage = 0;
  while (sim.t < 4) sim.step();
  assert.equal(sim.hsQueued, false);
  assert.ok(sim.metrics.hsCancelled >= 1);
  assert.equal(sim.metrics.hsCast, 0);
});

test('Execute only works in the execute phase and spends all rage', () => {
  const sim = new Sim(cfg, { mode: 'player', seed: 7, hpMax: 1e9, startHpFrac: 0.5, startRage: 60 });
  assert.equal(sim.status('exec').reason, 'notready');
  const low = new Sim(cfg, { mode: 'player', seed: 7, hpMax: 1e9, startHpFrac: 0.15, startRage: 60 });
  assert.ok(low.cast('exec').ok);
  assert.equal(low.rage, 0);
});

test('Death Wish multiplies damage by 1.2 while active', () => {
  const sim = new Sim(cfg, { mode: 'player', seed: 8, startRage: 50 });
  const before = sim.st.dmg;
  sim.cast('dw');
  near(sim.st.dmg / before, 1.2, 1e-9);
});

test('bot DPS lands in a sane range and the reference runs', () => {
  const avg = simAverage(cfg, 20);
  assert.ok(avg.mean > 1200 && avg.mean < 3200, `mean ${avg.mean}`);
  assert.ok(avg.execMean > avg.mean * 0.8, `exec ${avg.execMean}`);
});

test('report builds for a finished fight', () => {
  const sim = new Sim(cfg, { mode: 'player', seed: 11, hpMax: 60000, record: true });
  while (!sim.dead && sim.t < 200) {
    for (const id of ['exec', 'bt', 'ww']) if (sim.status(id).ready) sim.cast(id);
    if (!sim.hsQueued && sim.rage > 40) sim.cast('hs');
    sim.step();
  }
  assert.ok(sim.dead);
  const rep = buildReport(sim, { mean: 2000, sd: 100 });
  assert.ok(rep.dps > 0 && rep.rows.length > 5);
  assert.equal(gradeFor(1.01), 'S');
  assert.equal(gradeFor(0.5), 'F');
});

test('keybind helpers', () => {
  assert.equal(comboFromKeyEvent({ code: 'Digit1', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }), 'Shift+Digit1');
  assert.equal(comboFromKeyEvent({ code: 'ShiftLeft' }), null);
  assert.equal(prettyCombo('Ctrl+KeyQ'), 'Ctrl+Q');
  assert.equal(findConflict({ bt: 'KeyQ', ww: 'KeyE' }, 'KeyE', 'bt'), 'ww');          // two GCD abilities conflict
  assert.equal(findConflict({ dw: 'KeyZ', trinket1: 'KeyE' }, 'KeyZ', 'trinket1'), null);  // GCD + off-GCD can share
  assert.equal(findConflict({ trinket1: 'KeyZ', trinket2: 'KeyE' }, 'KeyE', 'trinket1'), null);
  assert.equal(findConflict({ pull: 'Space', hs: 'KeyE' }, 'Space', 'hs'), 'pull');
  assert.deepEqual(reverseMap({ dw: 'KeyZ', trinket1: 'KeyZ', br: 'KeyZ' }).get('KeyZ'), ['trinket1', 'br', 'dw']);
});

// ---- parse and scoreboard ----
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('percentile: first place is 100, last is 0, a lone score is 100', () => {
  assert.equal(percentile(1, 1), 100);
  assert.equal(percentile(1, 5), 100);
  assert.equal(percentile(5, 5), 0);
  assert.equal(percentile(3, 5), 50);
  assert.equal(parseDisplay(percentile(2, 101)), 99);
  assert.equal(parseDisplay(percentile(1, 101)), 100);
});

test('parse tiers follow the Warcraft Logs colors', () => {
  const key = (n) => parseTier(n).key;
  for (const [n, k] of [[0, 'gray'], [24, 'gray'], [25, 'green'], [49, 'green'], [50, 'blue'], [74, 'blue'],
    [75, 'purple'], [94, 'purple'], [95, 'orange'], [98, 'orange'], [99, 'pink'], [100, 'gold']]) assert.equal(key(n), k, `parse ${n}`);
  assert.equal(parseDisplay(99.9), 99);
  assert.equal(parseDisplay(100), 100);
});

const LOCAL = { shared: false };   // never touch the real shared board from tests
const atest = async (name, fn) => {
  try { await fn(); passed++; console.log('ok   ', name); } catch (err) { console.error('FAIL ', name, '\n', err.message); process.exitCode = 1; }
};

await atest('scoreboard keeps one entry per pull, and parses come from rank', async () => {
  const st = memStore();
  const e = (id, name, length, dps, ts) => ({ id, name, length, dps, ts });
  const first = await submitScore(e('a', 'Ann', 120, 1000, 1), st, LOCAL);
  assert.equal(first.improved, true);
  assert.equal((await listScores(120, st, LOCAL)).entries[0].parse, 100);     // alone on the board
  const worse = await submitScore(e('a', 'Ann', 120, 900, 2), st, LOCAL);
  assert.equal(worse.improved, false);
  assert.equal(worse.best.dps, 1000);
  await submitScore(e('a', 'Ann', 60, 800, 3), st, LOCAL);
  await submitScore(e('b', 'Ann', 120, 700, 4), st, LOCAL);                    // same name, different UUID
  await submitScore(e('c', 'Cy', 120, 500, 5), st, LOCAL);
  const l120 = (await listScores(120, st, LOCAL)).entries;
  assert.deepEqual(l120.map((x) => x.dps), [1000, 900, 700, 500]);            // both of Ann's pulls are listed
  assert.deepEqual(l120.map((x) => x.parse), [100, 67, 33, 0]);
  assert.equal((await listScores(60, st, LOCAL)).entries.length, 1);
});

test('player identity persists and neighbors find who beat you and who you beat', () => {
  const st = memStore();
  const p = getPlayer(st);
  assert.ok(p.id.length >= 16);
  assert.equal(getPlayer(st).id, p.id);
  assert.equal(setPlayerName('  Bob  ', st).name, 'Bob');
  const list = [{ id: 'x', parse: 90 }, { id: 'y', parse: 80 }, { id: 'z', parse: 70 }];
  const mid = neighbors(list, 'y');
  assert.equal(mid.above.id, 'x'); assert.equal(mid.below.id, 'z'); assert.equal(mid.rank, 2);
  assert.equal(neighbors(list, 'x').above, null);
  assert.equal(neighbors(list, 'z').below, null);
  assert.deepEqual(neighbors([list[0]], 'x'), { rank: 1, above: null, below: null });
  assert.equal(neighbors(list, 'q').rank, 0);
});

test('paginate splits 100 per page and clamps', () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);
  const p1 = paginate(rows, 1), p3 = paginate(rows, 3);
  assert.equal(p1.rows.length, 100); assert.equal(p1.pages, 3);
  assert.equal(p3.rows.length, 50); assert.equal(p3.offset, 200);
  assert.equal(paginate(rows, 99).page, 3);
  assert.equal(paginate(rows, -4).page, 1);
  assert.deepEqual(paginate([], 1), { rows: [], page: 1, pages: 1, offset: 0 });
});

console.log(`\n${passed} passed`);

test('auto stance swaps before casting', () => {
  const sim = new Sim(cfg, { mode: 'player', seed: 12, startRage: 80 });
  sim.onMeleeHit({ name: 'x', hand: 'mh', white: true, outcome: 'dodge', landed: false });
  assert.equal(sim.cast('op').ok, false);
  const r = sim.cast('op', { autoStance: true });
  assert.ok(r.ok);
  assert.equal(sim.stance, STANCE.BATTLE);
  assert.ok(sim.rage <= 25);
  for (let i = 0; i < 320; i++) sim.step();
  sim.rage = 60;
  assert.ok(sim.cast('ww', { autoStance: true }).ok);
  assert.equal(sim.stance, STANCE.BERSERKER);
});

test('comparison with the ideal run finds where a lazy rotation lost damage', async () => {
  const { idealRun } = await import('../src/bot.js');
  const { compareRuns, explainWindow } = await import('../src/score.js');
  const sim = new Sim(cfg, { mode: 'bot', duration: 60, seed: 21, record: true });
  while (sim.t < 60) {                                 // only Heroic Strike: no Bloodthirst or Whirlwind
    sim.rage = Math.max(sim.rage, 30);
    if (!sim.hsQueued && sim.status('hs').ready) sim.cast('hs');
    sim.step();
  }
  const ideal = idealRun(cfg, { duration: 60, n: 4 });
  const cmp = compareRuns(sim, ideal.sim, { youEnd: 60, idealEnd: 60 });
  assert.ok(cmp.dpsIdeal > cmp.dpsYou, `ideal ${cmp.dpsIdeal} you ${cmp.dpsYou}`);
  assert.ok(cmp.windows.length >= 1);
  assert.ok(cmp.castRows.find((r) => r.name === 'Bloodthirst').delta < 0);
  assert.ok(explainWindow(cmp.windows[0]).some((n) => /Bloodthirst/.test(n)), explainWindow(cmp.windows[0]).join('|'));
  assert.ok(cmp.idle.you.idle > cmp.idle.ideal.idle);
});
