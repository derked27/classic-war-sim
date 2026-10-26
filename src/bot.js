// Autoplay bot that executes the priority list exported by WoWSims (player.rotation.priorityList).
// It gives the reference "sim DPS" the practice scorecard compares you against.
import { Sim } from './engine.js';

const SPELL_TO_ABILITY = {
  1680: 'ww', 23894: 'bt', 20662: 'exec', 25286: 'hs', 7373: 'ham', 2687: 'br',
  2458: 'stBerserker', 2457: 'stBattle', 12328: 'dw', 1719: 'reck', 20572: 'bf', 11585: 'op',
  24427: 'item_20130',
};
const ITEM_TO_ABILITY = { 10646: 'sap', 21180: 'item_21180', 23041: 'item_23041', 22954: 'item_22954', 20130: 'item_20130' };

function parseVal(v) {
  if (typeof v === 'number') return v;
  if (v === 'true') return 1;
  if (v === 'false') return 0;
  const m = /^(-?[\d.]+)s?$/.exec(String(v));
  return m ? parseFloat(m[1]) : NaN;
}

function abilityOf(spellId) {
  if (!spellId) return null;
  if (spellId.otherId === 'OtherActionPotion') return 'pot';
  if (spellId.itemId) return ITEM_TO_ABILITY[spellId.itemId] || null;
  if (spellId.spellId) return SPELL_TO_ABILITY[spellId.spellId] || null;
  return null;
}

// Compile a WoWSims APL condition tree into a closure once, so the per-tick cost is tiny.
function compile(e) {
  if (!e) return () => 1;
  if ('const' in e) { const v = parseVal(e.const.val); return () => v; }
  if ('and' in e) { const fs = e.and.vals.map(compile); return (s) => { for (const f of fs) if (!f(s)) return 0; return 1; }; }
  if ('or' in e) { const fs = e.or.vals.map(compile); return (s) => { for (const f of fs) if (f(s)) return 1; return 0; }; }
  if ('not' in e) { const f = compile(e.not.val); return (s) => (f(s) ? 0 : 1); }
  if ('cmp' in e) {
    const a = compile(e.cmp.lhs), b = compile(e.cmp.rhs);
    switch (e.cmp.op) {
      case 'OpEq': return (s) => (a(s) === b(s) ? 1 : 0);
      case 'OpNe': return (s) => (a(s) !== b(s) ? 1 : 0);
      case 'OpGe': return (s) => (a(s) >= b(s) ? 1 : 0);
      case 'OpGt': return (s) => (a(s) > b(s) ? 1 : 0);
      case 'OpLe': return (s) => (a(s) <= b(s) ? 1 : 0);
      case 'OpLt': return (s) => (a(s) < b(s) ? 1 : 0);
      default: return () => 0;
    }
  }
  if ('remainingTime' in e) return (s) => s.remaining();
  if ('isExecutePhase' in e) return (s) => (s.isExecute() ? 1 : 0);
  if ('currentRage' in e) return (s) => s.rage;
  if ('numberTargets' in e) return () => 1;
  if ('spellTimeToReady' in e) {
    const id = abilityOf(e.spellTimeToReady.spellId);
    return (s) => (!id || !s.abilities.includes(id) ? 9999 : s.status(id).cdLeft);
  }
  if ('auraNumStacks' in e) {
    const sid = e.auraNumStacks.auraId?.spellId;
    return (s) => {
      const d = s.cfg.debuffs;
      if (sid === 11597) return d.sunder ? 5 : 0;
      if (sid === 11198) return d.expose ? 1 : 0;
      return 0;
    };
  }
  if ('auraIsActive' in e) {
    const sid = e.auraIsActive.auraId?.spellId;
    const onTarget = e.auraIsActive.sourceUnit?.type === 'CurrentTarget';
    return (s) => {
      if (onTarget) return s.cfg.debuffs.expose && sid === 11198 ? 1 : 0;
      if (sid === 25289) return s.cfg.battleShoutPermanent ? 1 : 0;
      if (sid === 2458) return s.stance === 4 ? 1 : 0;
      if (sid === 2457) return s.stance === 1 ? 1 : 0;
      return 0;
    };
  }
  return () => 0;
}

export class Bot {
  // opts.autoStance lets the bot swap stance as part of a cast; tools/rotation_test.mjs uses it to try Overpower.
  constructor(cfg, opts = {}) {
    this.autoStance = !!opts.autoStance;
    this.actions = (cfg.rotation || []).map((entry) => entry.action).filter(Boolean).map((act) => ({
      cond: compile(act.condition),
      auto: !!act.autocastOtherCooldowns,
      id: act.castSpell ? abilityOf(act.castSpell.spellId) : null,
    }));
  }

  // Cast as many ready actions as the list allows at this instant (GCD limits it naturally).
  act(sim) {
    for (let pass = 0; pass < 6; pass++) {
      let cast = false;
      for (const act of this.actions) {
        if (!act.cond(sim)) continue;
        const ids = act.auto ? sim.abilities.filter((x) => x.startsWith('item_')) : [act.id];
        for (const id of ids) {
          if (!id || !sim.abilities.includes(id)) continue;
          if (id === 'hs' && sim.hsQueued) continue;
          const st = sim.status(id);
          const ok = st.ready || (this.autoStance && st.reason === 'stance');
          if (ok && sim.cast(id, { autoStance: this.autoStance }).ok) { cast = true; break; }
        }
        if (cast) break;
      }
      if (!cast) return;
    }
  }
}

export { compile, abilityOf };

export function runBotFight(cfg, { seed = 1, duration, record = false, startRage = 0, alwaysExecute = false } = {}) {
  const d = duration || cfg.encounter.duration;
  const sim = new Sim(cfg, { mode: 'bot', duration: d, seed, record, startRage, alwaysExecute });
  const bot = new Bot(cfg);
  while (sim.t < d) {
    bot.act(sim);
    sim.step();
  }
  const execTime = sim.execStartT === null ? 0 : d - sim.execStartT;
  return { dps: sim.total / d, execDps: execTime > 0 ? sim.execDmg / execTime : NaN, sim, duration: d };
}

// Average bot DPS across many randomized-duration iterations (like a WoWSims run).
export function simAverage(cfg, iterations = 100, { seed = 1000 } = {}) {
  const acc = newAccumulator();
  for (let i = 0; i < iterations; i++) simStep(cfg, acc, i, { seed });
  return finishAccumulator(acc);
}

// Incremental pieces so the UI can run the reference in small chunks without freezing the page.
export function newAccumulator() {
  return { dps: [], exec: [] };
}
// A fixed `duration` (the fight length picked in the UI) skips the export's length and variation.
export function simStep(cfg, acc, i, { seed = 1000, duration } = {}) {
  const v = cfg.encounter.variation;
  const d = duration || cfg.encounter.duration + (v ? (((i * 7919 + seed) % 1000) / 1000 * 2 - 1) * v : 0);
  const r = runBotFight(cfg, { seed: seed + i, duration: d });
  acc.dps.push(r.dps);
  if (Number.isFinite(r.execDps)) acc.exec.push(r.execDps);
}
export function finishAccumulator(acc) {
  const stat = (arr) => {
    const mean = arr.reduce((a, x) => a + x, 0) / Math.max(1, arr.length);
    const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, arr.length));
    return { mean, sd };
  };
  const all = stat(acc.dps);
  const ex = stat(acc.exec);
  return { mean: all.mean, sd: all.sd, execMean: ex.mean, execSd: ex.sd, n: acc.dps.length };
}

// The "ideal" run for a post-pull comparison: the bot plays the same fight length and starting rage. One bot run is
// noisy (crits, Windfury), so play several and keep the one with the median DPS, recorded for the timeline.
export function idealRun(cfg, { duration, startRage = 0, alwaysExecute = false, n = 12, seed = 9000 } = {}) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const r = runBotFight(cfg, { seed: seed + i, duration, startRage, alwaysExecute });
    runs.push({ seed: seed + i, dps: r.dps });
  }
  runs.sort((a, b) => a.dps - b.dps);
  const pick = runs[Math.floor(n / 2)];
  const r = runBotFight(cfg, { seed: pick.seed, duration, startRage, alwaysExecute, record: true });
  return { sim: r.sim, dps: r.dps, duration, n, spread: [runs[0].dps, runs[n - 1].dps] };
}
