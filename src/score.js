// Post-pull analysis: DPS vs the sim reference, rotation metrics, cooldown timing, mistake markers for the replay.

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');

export function gradeFor(ratio) {
  if (ratio >= 1.0) return 'S';
  if (ratio >= 0.95) return 'A';
  if (ratio >= 0.88) return 'B';
  if (ratio >= 0.78) return 'C';
  if (ratio >= 0.65) return 'D';
  return 'F';
}

// Cooldowns tracked on the scorecard: id -> {label, dur (effect length), cd}
function trackedCooldowns(sim) {
  const c = {
    dw: { label: 'Death Wish', dur: 30, cd: 180 },
    reck: { label: 'Recklessness', dur: 15, cd: 1800 },
    bf: { label: 'Blood Fury', dur: 15, cd: 120 },
    pot: { label: sim.cfg.potion ? sim.cfg.potion.name : 'Potion', dur: 20, cd: 120 },
    sap: { label: 'Goblin Sapper', dur: 0, cd: 300 },
  };
  for (const tr of sim.cfg.trinkets) c['item_' + tr.id] = { label: tr.name, dur: tr.dur, cd: tr.cd };
  return Object.fromEntries(Object.entries(c).filter(([id]) => sim.abilities.includes(id)));
}

export function cooldownReport(sim) {
  const T = sim.tKill ?? sim.t;
  const out = [];
  for (const [id, c] of Object.entries(trackedCooldowns(sim))) {
    const uses = sim.metrics.cdUses[id] || [];
    const maxUses = c.dur > 0 && T >= c.dur ? Math.floor((T - c.dur) / c.cd) + 1 : (T >= 0 ? Math.floor(T / c.cd) + 1 : 0);
    const row = { id, label: c.label, uses, maxUses, notes: [], status: 'good' };
    if (!uses.length) {
      row.status = 'bad';
      row.notes.push('Never used this pull.');
    } else {
      uses.forEach((u) => {
        const end = u + c.dur;
        if (c.dur > 0 && end > T) {
          const lost = Math.min(c.dur, end - T);
          row.notes.push(`Used at ${fmt(u)}s; ${fmt(lost)}s of its ${c.dur}s was wasted when the boss died.`);
          row.status = lost > c.dur * 0.3 ? 'bad' : 'warn';
        } else {
          row.notes.push(`Used at ${fmt(u)}s${c.dur > 0 ? ` (ran ${fmt(c.dur, 0)}s, fully inside the fight)` : ''}.`);
        }
      });
      if (uses.length < maxUses) {
        row.notes.push(`Only ${uses.length} of ${maxUses} possible uses.`);
        if (row.status === 'good') row.status = 'warn';
      }
    }
    out.push(row);
  }
  return out;
}

// Bloodthirst lateness per cast from recorded events (needs sim.record).
export function castMistakes(sim) {
  const marks = [];
  const lastReady = { Bloodthirst: 0, Whirlwind: 0 };
  const cds = { Bloodthirst: 6, Whirlwind: 10 };
  for (const e of sim.events) {
    if (e.type === 'cast' && cds[e.name]) {
      const late = e.t - lastReady[e.name];
      if (late > 0.35) marks.push({ t: e.t, name: e.name, late });
      lastReady[e.name] = e.t + cds[e.name];
    }
  }
  return marks;
}

export function buildReport(sim, simRef) {
  const T = sim.tKill ?? sim.t;
  const m = sim.metrics;
  const dps = sim.total / Math.max(T, 0.001);
  const ratio = simRef ? dps / simRef.mean : NaN;
  const withinNoise = simRef ? Math.abs(dps - simRef.mean) <= simRef.sd : false;

  const btMax = sim.tal.bloodthirst ? Math.floor(T / 6) + 1 : 0;
  const hsPenaltyFreePct = m.ohSwings ? (m.ohPenaltyFree / m.ohSwings) * 100 : 0;
  const rageGained = sim.rageGained + sim.rageWasted;

  const rows = [];
  const add = (label, value, status, note) => rows.push({ label, value, status, note });

  const btLate = m.btDelay.late, btGcd = m.btDelay.gcd, btRage = m.btDelay.rage;
  if (sim.tal.bloodthirst) {
    add('Bloodthirst casts', `${sim.casts.bt || 0} / ${btMax}`,
      (sim.casts.bt || 0) >= btMax - 1 ? 'good' : (sim.casts.bt || 0) >= btMax - 3 ? 'warn' : 'bad',
      'Casts versus the maximum possible on a 6s cooldown.');
    add('BT delayed: your reaction', `${fmt(btLate)}s`, btLate < 1 ? 'good' : btLate < 3 ? 'warn' : 'bad',
      'Time Bloodthirst was ready, you had the rage and the GCD was free, but it was not pressed.');
    add('BT delayed: GCD busy', `${fmt(btGcd)}s`, btGcd < 6 ? 'good' : btGcd < 12 ? 'warn' : 'bad',
      'Ready but the GCD was still running from another ability. Some of this is unavoidable.');
    add('BT delayed: no rage', `${fmt(btRage)}s`, btRage < 6 ? 'good' : btRage < 14 ? 'warn' : 'bad',
      'Ready but under 30 rage. Spending rage on Heroic Strike or Overpower too early causes this.');
  }
  add('Whirlwind casts', `${sim.casts.ww || 0}`, 'info', `Delay: ${fmt(m.wwDelay.late)}s late, ${fmt(m.wwDelay.gcd)}s GCD, ${fmt(m.wwDelay.rage)}s no rage.`);
  add('Heroic Strike', `${m.hsCast} cast`, m.hsCancelled > 1 ? 'warn' : 'good',
    m.hsCancelled ? `${m.hsCancelled} queued Heroic Strike(s) dropped because rage fell below the cost before the swing.` : 'None dropped for lack of rage.');
  add('Off-hand without miss penalty', `${fmt(hsPenaltyFreePct, 0)}%`, hsPenaltyFreePct >= 55 ? 'good' : hsPenaltyFreePct >= 35 ? 'warn' : 'bad',
    'Share of off-hand swings that landed while Heroic Strike was queued (no 19% dual-wield miss penalty).');
  add('Heroic Strike queued uptime', `${fmt((m.hsQueuedTime / T) * 100, 0)}%`, 'info', 'Fraction of the fight with Heroic Strike queued.');
  add('Rage wasted at cap', `${fmt(sim.rageWasted, 0)} (${fmt(rageGained ? (sim.rageWasted / rageGained) * 100 : 0, 0)}%)`,
    sim.rageWasted < 30 ? 'good' : sim.rageWasted < 100 ? 'warn' : 'bad', 'Rage lost because you were at 100.');
  if (m.opWindows) {
    add('Overpower windows', `${m.opUsed} used / ${m.opWindows}`, m.opMissed > m.opUsed ? 'warn' : 'info',
      `${m.opMissed} dodge window(s) expired unused. Overpower needs Battle Stance (you keep up to ${sim.maxKeptRage} rage when swapping).`);
  }
  add('Windfury procs', `${m.wfProcs}`, 'info', 'Random: 20% per mainhand hit, 1.5s internal cooldown.');
  add('Crusader procs', `${m.crusaderProcs}`, 'info', 'Random: 1 PPM per weapon.');
  add('Flurry uptime', `${fmt((m.flurryUp / T) * 100, 0)}%`, 'info', 'Time spent with the Flurry haste buff active.');

  const breakdown = Object.entries(sim.bySource)
    .map(([name, dmg]) => ({ name, dmg, dps: dmg / T, pct: dmg / sim.total }))
    .sort((a, b) => b.dmg - a.dmg);

  return {
    killTime: T, dps, total: sim.total, ratio, grade: simRef ? gradeFor(ratio) : '–',
    simDps: simRef ? simRef.mean : NaN, simSd: simRef ? simRef.sd : NaN, withinNoise,
    rows, cooldowns: cooldownReport(sim), breakdown, mistakes: castMistakes(sim),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Compare your pull with the ideal (bot) run
// ---------------------------------------------------------------------------------------------------------------
const GCD_NAMES = new Set(['Bloodthirst', 'Whirlwind', 'Overpower', 'Execute', 'Hamstring', 'Death Wish', 'Recklessness', 'Blood Fury']);
const TRACKED = ['Bloodthirst', 'Whirlwind', 'Overpower', 'Execute', 'Heroic Strike', 'Hamstring'];

function castTimes(sim, name) {
  const out = [];
  for (const e of sim.events) {
    if (name === 'Heroic Strike') { if (e.type === 'hit' && e.name === name) out.push(e.t); }
    else if (e.type === 'cast' && e.name === name) out.push(e.t);
  }
  return out;
}

function cumulative(sim, T) {
  const n = Math.ceil(T) + 1;
  const buckets = new Array(n).fill(0);
  for (const e of sim.events) if (e.type === 'hit' && e.dmg) buckets[Math.min(n - 1, Math.floor(e.t))] += e.dmg;
  const out = [0];
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += buckets[i]; out.push(acc); }   // out[k] = damage dealt before second k
  return out;
}
const at = (series, t) => {
  const i = Math.min(series.length - 1, Math.max(0, t));
  const lo = Math.floor(i), hi = Math.min(series.length - 1, lo + 1);
  return series[lo] + (series[hi] - series[lo]) * (i - lo);
};

function idleGcd(events, T) {
  const times = [];
  for (const e of events) if (e.type === 'cast' && GCD_NAMES.has(e.name) && e.t <= T) times.push(e.t);
  times.sort((a, b) => a - b);
  let idle = 0, gaps = 0, prevEnd = 0;
  for (const t of times) {
    const gap = t - prevEnd;
    if (gap > 0.35) { idle += gap; gaps++; }
    prevEnd = t + 1.5;
  }
  const tail = T - prevEnd;
  if (tail > 0.35) idle += tail;
  return { idle, gaps };
}

export function compareRuns(you, ideal, { youEnd, idealEnd }) {
  const Tcmp = Math.min(youEnd, idealEnd);          // window where both fights are still running
  const Taxis = Math.max(youEnd, idealEnd);
  const cumYou = cumulative(you, youEnd);
  const cumIdeal = cumulative(ideal, idealEnd);

  const castRows = TRACKED.map((name) => {
    const a = castTimes(you, name).length, b = castTimes(ideal, name).length;
    return { name, you: a, ideal: b, delta: a - b };
  }).filter((r) => r.you || r.ideal);

  const cdNames = new Set();
  for (const sim of [you, ideal]) {
    for (const e of sim.events) {
      if (e.type === 'cast' && e.outcome === 'cd' && !['Bloodrage', 'Battle Stance', 'Berserker Stance'].includes(e.name)) cdNames.add(e.name);
    }
  }
  const cdRows = [...cdNames].map((name) => ({ name, you: castTimes(you, name), ideal: castTimes(ideal, name) }));

  // worst stretches: 10s windows (stepping by 5s) where you fell furthest behind the ideal
  const cand = [];
  for (let w0 = 0; w0 + 5 <= Tcmp; w0 += 5) {
    const w1 = Math.min(Tcmp, w0 + 10);
    const y = at(cumYou, w1) - at(cumYou, w0);
    const i = at(cumIdeal, w1) - at(cumIdeal, w0);
    cand.push({ w0, w1, you: y, ideal: i, loss: i - y });
  }
  cand.sort((a, b) => b.loss - a.loss);
  const windows = [];
  for (const c of cand) {
    if (c.loss < 400) break;
    if (windows.some((w) => c.w0 < w.w1 && c.w1 > w.w0)) continue;
    windows.push(c);
    if (windows.length === 3) break;
  }
  windows.sort((a, b) => a.w0 - b.w0);
  for (const w of windows) {
    const inWin = (t) => t >= w.w0 && t < w.w1;
    w.casts = TRACKED.map((name) => ({
      name,
      you: castTimes(you, name).filter(inWin).length,
      ideal: castTimes(ideal, name).filter(inWin).length,
    })).filter((c) => c.you || c.ideal);
    const slice = (sim) => sim.events.filter(inWin).map((e) => ({ ...e, t: e.t - w.w0 }));
    w.idleYou = idleGcd(slice(you), w.w1 - w.w0).idle;
    w.idleIdeal = idleGcd(slice(ideal), w.w1 - w.w0).idle;
    const rageAt = (sim) => {
      const smp = sim.samples.filter((x) => inWin(x.t));
      return smp.length ? smp.reduce((a, x) => a + x.rage, 0) / smp.length : NaN;
    };
    w.rageYou = rageAt(you);
    w.rageIdeal = rageAt(ideal);
    w.cdYou = Object.fromEntries([...cdNames].map((n) => [n, castTimes(you, n).filter(inWin).length]));
    w.cdIdeal = Object.fromEntries([...cdNames].map((n) => [n, castTimes(ideal, n).filter(inWin).length]));
  }

  return {
    Taxis, Tcmp, youEnd, idealEnd, cumYou, cumIdeal, castRows, cdRows, windows,
    idle: { you: idleGcd(you.events, youEnd), ideal: idleGcd(ideal.events, idealEnd) },
    dpsYou: you.total / youEnd, dpsIdeal: ideal.total / idealEnd,
    rageWastedYou: you.rageWasted, rageWastedIdeal: ideal.rageWasted,
    flurryYou: (you.metrics.flurryUp / youEnd) * 100, flurryIdeal: (ideal.metrics.flurryUp / idealEnd) * 100,
    wfYou: (you.metrics.wfProcs / youEnd) * 60, wfIdeal: (ideal.metrics.wfProcs / idealEnd) * 60,
  };
}

// Plain-language notes for a losing window.
export function explainWindow(w) {
  const notes = [];
  for (const c of w.casts) {
    if (c.ideal - c.you >= 1 && ['Bloodthirst', 'Whirlwind', 'Execute'].includes(c.name)) notes.push(`${c.ideal - c.you} fewer ${c.name}`);
    if (c.you - c.ideal >= 2 && c.name === 'Overpower') notes.push(`${c.you - c.ideal} extra Overpower (it can starve rage for Bloodthirst)`);
    if (c.ideal - c.you >= 3 && c.name === 'Heroic Strike') notes.push(`${c.ideal - c.you} fewer Heroic Strikes (rage went unspent or the queue was dropped)`);
  }
  for (const [name, idealN] of Object.entries(w.cdIdeal)) {
    if (idealN > (w.cdYou[name] || 0)) notes.push(`the ideal used ${name} here and you did not`);
  }
  if (w.idleYou - w.idleIdeal > 0.7) notes.push(`${(w.idleYou - w.idleIdeal).toFixed(1)}s more idle global cooldown`);
  if (Number.isFinite(w.rageYou) && w.rageYou - w.rageIdeal > 25) notes.push('you were sitting on much more rage (unspent)');
  if (Number.isFinite(w.rageYou) && w.rageIdeal - w.rageYou > 25) notes.push('you were low on rage (spent too early, or too many Heroic Strikes)');
  return notes.length ? notes : ['No single clear cause: probably RNG (crits, Windfury) or small timing slips.'];
}
