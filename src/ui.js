import { checkForUpdate } from './update.js';
import { VERSION } from './version.js';
import { Sim, STEP, STANCE } from './engine.js';
import { buildConfig, sheetStats, applyGearSet } from './config.js';
import { newAccumulator, simStep, finishAccumulator, runBotFight, idealRun } from './bot.js';
import { buildReport, compareRuns, explainWindow } from './score.js';
import { percentile, parseDisplay, parseTier } from './parse.js';
import { getPlayer, setPlayerName, submitScore, listScores, neighbors } from './scores.js';
import {
  BIND_ACTIONS, DEFAULT_BINDS, loadBinds, saveBinds, comboFromKeyEvent, comboFromMouseEvent, comboFromWheelEvent,
  prettyCombo, findConflict, reverseMap,
} from './keybinds.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 0) => Number(x).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const iconUrl = (name) => `https://wow.zamimg.com/images/wow/icons/medium/${name}.jpg`;

const SETTINGS_KEY = 'cws.settings.v1';
const JSON_KEY = 'cws.character.v1';
const PROFILES_KEY = 'cws.profiles.v1';
const ACTIVE_KEY = 'cws.activeProfile.v1';
const GEAR_KEY = 'cws.gearSet.v1';

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY)) || {}; } catch { return {}; }
}
function saveProfiles(p) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
function saveUnnamedProfile(text) {
  const profiles = loadProfiles();
  const base = (app.cfg.name || 'Imported character').trim();
  let name = base;
  for (let n = 2; profiles[name] && profiles[name] !== text; n++) name = `${base} (${n})`;
  profiles[name] = text;
  saveProfiles(profiles);
  setActiveProfile(name);
  renderProfiles(name);
}
function setActiveProfile(name) {
  try { localStorage.setItem(ACTIVE_KEY, name || ''); } catch { /* ignore */ }
}
function renderProfiles(active) {
  const profiles = loadProfiles();
  const sel = $('profileSel');
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Unsaved character</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = names.includes(active) ? active : '';
  $('btnProfileDelete').disabled = !sel.value;
  gearUi.profile = sel.value;
  renderGearSelect();
}

const app = {
  gd: null,
  gearSets: [],
  jsonText: '',          // the last successfully imported character JSON
  cfg: null,
  warnings: [],
  simRef: null,          // {mean, sd, execMean, execSd, n}
  refToken: 0,
  settings: { countdown: 3, startRage: 0, autoStance: false, length: 60, speed: 1, hints: true, seed: '', runs: 100, mode: 'full' },
  binds: loadBinds(),
  rev: null,
  state: 'idle',         // idle | running | paused | finished
  sim: null,
  preview: null,         // idle Sim used to know the available abilities
  acc: 0,
  last: 0,
  logIdx: 0,
  failed: { cd: 0, gcd: 0, rage: 0, stance: 0, notready: 0 },
  actionEls: {},
  auraEls: new Map(),
  meterAt: 0,
  hpMax: 0,
  report: null,
  listening: null,
};

// ---------------------------------------------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------------------------------------------
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(app.settings, JSON.parse(raw));
  } catch { /* ignore */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------------------
function importFromText(text, { persist = true, profile = null, gearKey = '' } = {}) {
  const msg = $('importMsg');
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    msg.innerHTML = `<div class="e">That isn't valid JSON: ${esc(err.message)}</div>`;
    return false;
  }
  if (!json.player || !json.player.equipment) {
    msg.innerHTML = '<div class="e">This does not look like a WoWSims export (no player.equipment).</div>';
    return false;
  }
  let built;
  try {
    built = buildConfig(json, app.gd);
  } catch (err) {
    msg.innerHTML = `<div class="e">Could not read that character: ${esc(err.message)}</div>`;
    console.error(err);
    return false;
  }
  app.cfg = built.cfg;
  app.jsonText = text;
  try {
    // A default set stays selected until the character is imported some other way.
    if (persist) localStorage.setItem(GEAR_KEY, gearKey);
    else gearKey = localStorage.getItem(GEAR_KEY) || '';
  } catch { /* ignore */ }
  syncGearSelect(gearKey);
  app.warnings = built.warnings;
  if (persist) {
    try { localStorage.setItem(JSON_KEY, text); } catch { /* ignore */ }
  }
  if (profile) {
    const profiles = loadProfiles();
    profiles[profile] = text;
    saveProfiles(profiles);
    setActiveProfile(profile);
  }
  renderProfiles(profile || (persist ? '' : localStorage.getItem(ACTIVE_KEY)));
  const items = built.cfg.equipped.filter(Boolean).length;
  msg.innerHTML = `<div class="ok">Imported ${esc(built.cfg.name)}: ${items} items, ${built.cfg.buffList.length} buffs/consumes.</div>`
    + built.warnings.map((w) => `<div class="w">• ${esc(w)}</div>`).join('');
  onCharacterChanged();
  return true;
}

// First run: start from the example character in the P6 default set.
async function loadDefaultCharacter() {
  const set = app.gearSets.find((s) => s.key === 'p6');
  if (!set) return false;
  try {
    const example = await (await fetch('example.json')).text();
    return importFromText(JSON.stringify(applyGearSet(JSON.parse(example), set)), { gearKey: set.key });
  } catch (err) {
    console.error(err);
    return false;
  }
}

// The pull-panel Gear dropdown lists the default sets and your saved characters; "Custom" appears only while
// imported gear that isn't saved is in use.
const gearUi = { key: '', profile: '', setsHtml: '' };
const PROFILE_PREFIX = 'profile:';

function renderGearSelect() {
  const sel = $('pullGearSel');
  const names = Object.keys(loadProfiles()).sort((a, b) => a.localeCompare(b));
  const value = gearUi.key || (gearUi.profile ? PROFILE_PREFIX + gearUi.profile : '');
  sel.innerHTML = (value ? '' : '<option value="">Custom</option>') + gearUi.setsHtml
    + (names.length ? `<optgroup label="Saved characters">${names.map((n) => `<option value="${esc(PROFILE_PREFIX + n)}">${esc(n)}</option>`).join('')}</optgroup>` : '');
  sel.value = value;
}

function syncGearSelect(key) {
  gearUi.key = key;
  renderGearSelect();
}

function onCharacterChanged() {
  const cfg = app.cfg;
  app.preview = new Sim(cfg, { mode: 'player', seed: 1 });
  buildActionBar();
  renderHeader();
  resetToIdle();
  startReference();
}

function renderHeader() {
  const cfg = app.cfg;
  const s = sheetStats(cfg);
  $('charLine').textContent = `${cfg.name} · ${cfg.race.replace('Race', '')} Warrior · ${cfg.mh ? cfg.mh.name : 'no weapon'}${cfg.oh ? ' / ' + cfg.oh.name : ''}`;
  const chips = [
    ['Attack power', fmt(s.ap)], ['Crit', fmt(s.crit, 2) + '%'], ['Hit', fmt(s.hit, 2) + '%'],
    ['Str', fmt(s.str)], ['Agi', fmt(s.agi)], ['Boss armor', fmt(cfg.boss.armor)],
  ];
  if (cfg.windfury) chips.push(['Windfury', 'on']);
  $('statChips').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('')
    + '<span class="chip" id="refChip">Sim reference <b>…</b></span>';
  $('bossName').textContent = `${cfg.boss.name} (lvl ${cfg.boss.level})`;
  $('meName').textContent = cfg.name;
  $('mhName').textContent = cfg.mh ? `· ${cfg.mh.name} ${cfg.mh.speed.toFixed(1)}` : '';
  $('ohName').textContent = cfg.oh ? `· ${cfg.oh.name} ${cfg.oh.speed.toFixed(1)}` : '';
  $('execTick').style.left = `${cfg.encounter.execute20 * 100}%`;
}

// Run the bot against your imported character in small chunks so the page stays responsive.
function startReference() {
  const token = ++app.refToken;
  app.simRef = null;
  $('btnPull').disabled = true;
  const total = app.settings.runs;
  const acc = newAccumulator();
  let i = 0;
  const label = (txt) => { const el = $('refChip'); if (el) el.innerHTML = `Sim reference <b>${txt}</b>`; };
  $('simRefLine').textContent = 'Sim reference: calculating…';
  $('startMsg').textContent = 'Calculating sim reference DPS…';
  const chunk = () => {
    if (token !== app.refToken) return;
    const end = Math.min(total, i + 10);
    for (; i < end; i++) simStep(app.cfg, acc, i);
    label(`${Math.round((i / total) * 100)}%`);
    if (i < total) { setTimeout(chunk, 0); return; }
    app.simRef = finishAccumulator(acc);
    label(`${fmt(app.simRef.mean)} DPS`);
    $('simRefLine').textContent = `Sim reference: ${fmt(app.simRef.mean)} ± ${fmt(app.simRef.sd)} DPS (${app.simRef.n} runs)`;
    if (app.state === 'idle') showStart();
  };
  setTimeout(chunk, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------------------------------------------
const ORDER = ['bt', 'ww', 'hs', 'op', 'exec', 'ham', 'dw', 'reck', 'bf', 'br', 'pot', 'sap'];

function bindForAction(id) {
  if (id.startsWith('item_')) {
    const idx = app.cfg.trinkets.findIndex((t) => 'item_' + t.id === id);
    return app.binds['trinket' + (idx + 1)] || '';
  }
  return app.binds[id] || '';
}

function setIcon(el, name) {
  if (!name) return;
  const img = new Image();
  img.onload = () => { el.style.backgroundImage = `url(${iconUrl(name)})`; el.classList.add('hasicon'); };
  img.src = iconUrl(name);
}

function buildActionBar() {
  const bar = $('actionbar');
  bar.innerHTML = '';
  app.actionEls = {};
  const ids = app.preview.abilities.slice().sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    const ra = ia < 0 ? (a.startsWith('item_') ? 50 : 100) : ia;
    const rb = ib < 0 ? (b.startsWith('item_') ? 50 : 100) : ib;
    return ra - rb;
  });
  for (const id of ids) {
    const info = app.preview.abilityInfo(id);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'act';
    el.title = info.name;
    el.innerHTML = `<div class="fallback">${esc(info.name)}</div><span class="key"></span><div class="cdov"></div><div class="cdn"></div>`;
    el.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); dispatchAction(id); } });
    bar.appendChild(el);
    setIcon(el, info.icon);
    app.actionEls[id] = { el, key: el.querySelector('.key'), cdov: el.querySelector('.cdov'), cdn: el.querySelector('.cdn') };
  }
  refreshKeyLabels();
}

function refreshKeyLabels() {
  if (!app.cfg) return;
  for (const [id, refs] of Object.entries(app.actionEls)) refs.key.textContent = prettyCombo(bindForAction(id)).replace('—', '');
  app.rev = reverseMap(app.binds);
}

const REASONS = {
  cd: 'Ability is not ready yet', gcd: 'Another ability is still on the global cooldown', rage: 'Not enough rage',
  stance: 'Must be in a different stance', notready: "You can't use that right now", unavailable: 'Not available',
  already: 'Already active',
};

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 900);
}

function dispatchAction(action) {
  if (action === 'pull') { if (app.state === 'idle' || app.state === 'finished') startPull(); return; }
  if (action === 'pause') { togglePause(); return; }
  if (app.state !== 'running') return;
  if (action === 'hsCancel') {
    if (!app.sim.cancelHeroicStrike()) toast('No Heroic Strike queued');
    return;
  }
  let id = action;
  if (action === 'trinket1' || action === 'trinket2') {
    const tr = app.cfg.trinkets[action === 'trinket1' ? 0 : 1];
    if (!tr) return;
    id = 'item_' + tr.id;
  }
  if (!app.sim.abilities.includes(id)) return;
  const refs = app.actionEls[id];
  if (refs) { refs.el.classList.add('press'); setTimeout(() => refs.el.classList.remove('press'), 80); }
  const res = app.sim.cast(id, { autoStance: !!app.settings.autoStance });
  if (!res.ok) {
    if (app.failed[res.reason] !== undefined) app.failed[res.reason]++;
    toast(REASONS[res.reason] || 'Cannot do that');
    if (refs) { refs.el.classList.remove('fail'); void refs.el.offsetWidth; refs.el.classList.add('fail'); }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fight lifecycle
// ---------------------------------------------------------------------------------------------------------------
const hasName = () => $('nameIn').value.trim().length > 0;

// Pull needs the sim reference and a name for the scoreboard.
function syncPull() {
  if (app.state !== 'idle' && app.state !== 'finished') return;
  $('btnPull').disabled = !(app.simRef && hasName());
  if (app.simRef) {
    $('startMsg').textContent = hasName()
      ? `Ready. Press ${prettyCombo(app.binds.pull)} or click Pull.`
      : 'Enter your name to pull.';
  }
}

function showStart() {
  $('startZone').classList.remove('hidden');
  const ready = !!app.simRef;
  $('btnPull').disabled = !(ready && hasName());
  $('btnPull').textContent = app.state === 'finished' ? 'Pull again' : 'Pull';
  $('startMsg').textContent = !ready
    ? 'Calculating sim reference DPS…'
    : hasName() ? `Ready. Press ${prettyCombo(app.binds.pull)} or click Pull.` : 'Enter your name to pull.';
  $('pullHint').textContent = ready ? 'The boss dies when its (hidden) health runs out, like a real fight. The boss dies when its health runs out; the fight is sized for the length you picked, so watch the health bar to time your cooldowns.' : '';
}

function resetToIdle() {
  app.state = 'idle';
  app.sim = null;
  $('log').innerHTML = '';
  $('meter').innerHTML = '';
  $('dpsNow').textContent = '0';
  $('fightTime').textContent = '0:00.0';
  $('bossHp').style.width = '100%';
  $('bossHpText').textContent = '100%';
  $('rageFill').style.width = '0%';
  $('rageText').textContent = '0';
  $('auras').innerHTML = '';
  app.auraEls.clear();
  showStart();
}

function startPull() {
  if (!app.cfg || !app.simRef) return;
  if (!hasName()) { $('nameIn').focus(); return; }
  setPlayerName($('nameIn').value);
  $('nameIn').blur();   // a focused input would swallow the ability keybinds
  const s = app.settings;
  const cfg = app.cfg;
  const seed = s.seed !== '' && Number.isFinite(Number(s.seed)) ? Number(s.seed) : Math.floor(Math.random() * 1e9);
  const drill = $('modeSel').value === 'execute';
  const startRage = Math.max(0, Math.min(100, Number($('rageIn').value) || 0));
  const countdown = Number($('cdSel').value) || 0;
  s.startRage = startRage;
  s.countdown = countdown;
  // The boss's health is what the bot would deal over the chosen length, so the fight ends near that time
  // if you play like the sim.
  const chosen = Number($('lenSel').value) || 60;
  const dur = drill ? cfg.encounter.duration : chosen;
  app.fightLen = dur;
  s.length = chosen;
  const acc = newAccumulator();
  for (let i = 0; i < 30; i++) {
    const r = runBotFight(cfg, { seed: 5000 + i, duration: dur });
    acc.dps.push(r.dps);
    if (Number.isFinite(r.execDps)) acc.exec.push(r.execDps);
  }
  app.pullRef = finishAccumulator(acc);
  app.pullRef.duration = dur;
  app.hpMax = app.pullRef.mean * dur;
  app.settings.mode = $('modeSel').value;
  saveSettings();
  app.sim = new Sim(cfg, {
    mode: 'player', seed, record: true, hpMax: app.hpMax,
    startHpFrac: drill ? 0.25 : 1, startRage,
  });
  app.sim.seed = seed;
  app.sim.drill = drill;
  app.sim.fightLen = dur;
  app.failed = { cd: 0, gcd: 0, rage: 0, stance: 0, notready: 0 };
  app.logIdx = 0;
  if ($('fct')) $('fct').innerHTML = '';
  $('fctDps').textContent = '0 DPS';
  app.acc = 0;
  app.countLeft = countdown;
  app.state = countdown > 0 ? 'countdown' : 'running';
  $('startZone').classList.add('hidden');
  $('log').innerHTML = '';
  app.auraEls.clear();
  $('auras').innerHTML = '';
  app.last = performance.now();
}

function togglePause() {
  if (app.state === 'countdown') { $('countdown').classList.add('hidden'); resetToIdle(); return; }
  if (app.state === 'running') { app.state = 'paused'; $('startZone').classList.remove('hidden'); $('startMsg').textContent = 'Paused'; $('btnPull').disabled = true; $('pullHint').textContent = `Press ${prettyCombo(app.binds.pause)} to resume.`; }
  else if (app.state === 'paused') { app.state = 'running'; $('startZone').classList.add('hidden'); app.last = performance.now(); }
}

function finishFight() {
  app.state = 'finished';
  const sim = app.sim;
  const report = buildReport(sim, app.pullRef || app.simRef);
  // Execute-phase comparison and failed-press info
  const execTime = sim.execStartT === null ? 0 : sim.tKill - sim.execStartT;
  report.execDps = execTime > 0 ? sim.execDmg / execTime : NaN;
  report.execRef = (app.pullRef || app.simRef).execMean;
  report.failed = app.failed;
  // Only full pulls at real-time speed count for the scoreboard.
  const ref = app.pullRef || app.simRef;
  report.eligible = !sim.drill && Number(app.settings.speed) === 1 && Number.isFinite(report.ratio);
  report.length = Math.round(ref.duration || app.fightLen);
  app.report = report;
  showReport(report, sim);
  showStart();
  if (report.eligible) recordScore(report);
}

async function recordScore(report) {
  const player = getPlayer();
  const entry = {
    id: player.id, name: player.name, length: report.length,
    dps: Math.round(report.dps * 10) / 10,
    ratio: Math.round(report.ratio * 1000) / 1000, ts: Date.now(),
  };
  let result = null;
  try { result = await submitScore(entry); } catch { /* ignore */ }
  const { entries, shared, offline } = await listScores(report.length);
  renderBoard(report, entries, { player, entry, result, shared, offline });
}

// "Beaten by" / "You beat" lines plus the top of the board for this fight length, inside the open report.
function renderBoard(report, entries, { player, entry, result, shared, offline }) {
  const el = $('boardBody');
  if (!el || app.report !== report) return;
  const best = entries.find((e) => e.id === player.id) || entry;   // entries are sorted, so the first is your best
  // This pull's parse: where its DPS would land among every other pull on the board.
  const others = entries.filter((e) => !(e.id === player.id && e.ts === entry.ts));
  const pullParse = parseDisplay(percentile(others.filter((e) => e.dps > entry.dps).length + 1, others.length + 1));
  const pullTier = parseTier(pullParse);
  const pe = $('parseNow');
  if (pe) pe.innerHTML = `Parse <b class="p-${pullTier.key}">${pullParse}</b> <span class="sub">${pullTier.label}</span>`;
  const nb = neighbors(entries, player.id, entry.ts);
  const row = (e, rank) => {
    const shown = parseDisplay(e.parse);
    return `<tr${e.id === player.id ? ' class="me"' : ''}><td class="rk">${rank}</td><td class="p-${parseTier(shown).key}">${esc(e.name)}</td><td class="p-${parseTier(shown).key} pv">${shown}</td><td class="dv">${fmt(e.dps)} DPS</td></tr>`;
  };
  const who = (e, verb) => {
    if (!e) return '';
    const shown = parseDisplay(e.parse);
    return `<div>${verb} <b class="p-${parseTier(shown).key}">${esc(e.name)}</b> (#${e.rank}) with a <b class="p-${parseTier(shown).key}">${shown}</b> parse, ${fmt(e.dps)} DPS.</div>`;
  };
  const pb = parseDisplay(best.parse);
  const top = entries.slice(0, 5);
  const note = result && !result.improved
    ? `Your best for ${report.length}s is still <b class="p-${parseTier(pb).key}">${pb}</b> (${fmt(best.dps)} DPS).`
    : `New personal best for ${report.length}s fights.`;
  el.innerHTML = `
    <div>${note} You are rank <b>#${nb.rank}</b> of ${entries.length}.</div>
    ${who(nb.above, 'Beaten by')}${who(nb.below, 'You beat')}
    ${!nb.above && entries.length > 1 ? '<div>Nobody has beaten you — you are #1.</div>' : ''}
    <table class="rep board">${top.map((e, i) => row(e, i + 1)).join('')}</table>
    <div class="sub">${shared ? 'Shared scoreboard.' : offline ? 'Shared scoreboard unreachable; showing scores saved in this browser.' : 'Scores are saved in this browser only.'}
      <a href="scoreboard.html?length=${report.length}" target="_blank" rel="noopener">Full scoreboard</a></div>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Frame loop and HUD
// ---------------------------------------------------------------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - app.last) / 1000);
  app.last = now;
  if (app.state === 'countdown') {
    app.countLeft -= dt;
    const cd = $('countdown');
    if (app.countLeft <= 0) {
      cd.classList.add('hidden');
      app.state = 'running';
    } else {
      cd.classList.remove('hidden');
      const n = Math.ceil(app.countLeft);
      if (cd.textContent !== String(n)) { cd.textContent = String(n); cd.classList.remove('tick'); void cd.offsetWidth; cd.classList.add('tick'); }
    }
  }
  if (app.state === 'running') {
    app.acc += dt * Number(app.settings.speed);
    const sim = app.sim;
    while (app.acc >= STEP && !sim.dead) { sim.step(); app.acc -= STEP; }
    if (!sim.dead && sim.t > app.cfg.encounter.duration * 2.5) {
      sim.dead = true; sim.tKill = sim.t;
    }
    if (sim.dead) { render(true); finishFight(); return; }
  }
  if (app.sim) render(false);
}

function floatText(e) {
  if (e.type !== 'hit') return;
  const zone = $('fct');
  if (!zone) return;
  const el = document.createElement('div');
  const miss = e.outcome === 'miss' || e.outcome === 'dodge';
  let cls = 'ft';
  if (miss) cls += ' ft-miss';
  else if (e.outcome === 'tick') cls += ' ft-dot';
  else if (e.white) cls += ' ft-white';
  else cls += ' ft-yellow';
  if (e.outcome === 'crit') cls += ' ft-crit';
  if (e.outcome === 'glance') cls += ' ft-glance';
  el.className = cls;
  el.textContent = miss ? (e.outcome === 'miss' ? 'Miss' : 'Dodge') : fmt(e.dmg) + (e.outcome === 'crit' ? '!' : '');
  const base = e.hand === 'oh' ? 62 : e.hand === 'mh' ? 38 : 50;
  el.style.left = `${base + (Math.random() * 18 - 9)}%`;
  zone.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  while (zone.children.length > 30) zone.firstChild.remove();
}

function logLine(e) {
  const f = (n) => fmt(n);
  switch (e.type) {
    case 'hit': {
      if (e.outcome === 'tick') return { c: '', t: `${e.name} ticks for ${f(e.dmg)}` };
      if (e.outcome === 'miss') return { c: 'miss', t: `${e.name} missed` };
      if (e.outcome === 'dodge') return { c: 'miss', t: `${e.name} was dodged` };
      if (e.outcome === 'crit') return { c: 'crit', t: `${e.name} crits for ${f(e.dmg)}` };
      if (e.outcome === 'glance') return { c: '', t: `${e.name} glances for ${f(e.dmg)}` };
      return { c: '', t: `${e.name} hits for ${f(e.dmg)}` };
    }
    case 'proc': return { c: 'proc', t: `${e.name} procs!` };
    case 'queue': return { c: 'note', t: `${e.name} queued` };
    case 'note': return { c: 'note', t: e.text };
    case 'aura': return e.on && e.key !== 'dw_dot' ? { c: 'proc', t: `+ ${e.name}` } : null;
    default: return null;
  }
}

function render(final) {
  const sim = app.sim;
  const cfg = app.cfg;

  // log
  const log = $('log');
  const evs = sim.events;
  while (app.logIdx < evs.length) {
    const ev = evs[app.logIdx++];
    if (app.state === 'running') floatText(ev);
    const l = logLine(ev);
    if (!l) continue;
    const d = document.createElement('div');
    d.className = l.c;
    d.textContent = l.t;
    log.prepend(d);
    if (log.children.length > 40) log.lastChild.remove();
  }

  // frames
  const hp = sim.hpFrac();
  $('bossHp').style.width = `${hp * 100}%`;
  $('bossHpText').textContent = `${(hp * 100).toFixed(1)}%`;
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'm' : (n / 1e3).toFixed(1) + 'k');
  $('bossHpNum').textContent = `${short(sim.hp)} / ${short(sim.hpMax)}`;
  const exec = sim.isExecute();
  $('bossHp').style.background = exec ? 'linear-gradient(#d87a3a, #b0541e)' : '';
  if (app.settings.hints && sim.t > 5) {
    const dpsNow = sim.total / sim.t;
    const left = (sim.hp / Math.max(dpsNow, 1));
    $('bossHint').textContent = `Hint: ~${left.toFixed(0)}s until the boss dies at your current DPS.`;
  } else {
    $('bossHint').textContent = '';
  }
  $('rageFill').style.width = `${sim.rage}%`;
  $('rageText').textContent = Math.floor(sim.rage);
  $('stanceText').textContent = sim.stance === STANCE.BERSERKER ? 'Berserker Stance' : 'Battle Stance';
  const gcdLeft = Math.max(0, sim.gcdEnd - sim.t);
  $('gcdFill').style.width = `${(gcdLeft / 1.5) * 100}%`;

  // swing timers
  const mhDur = sim.weapons.mh.speed / sim.speed;
  const mhFrac = 1 - Math.min(1, Math.max(0, (sim.mhAt - sim.t) / mhDur));
  $('mhFill').style.width = `${mhFrac * 100}%`;
  $('mhTime').textContent = Math.max(0, sim.mhAt - sim.t).toFixed(1);
  $('mhFill').closest('.swing').classList.toggle('queued', sim.hsQueued);
  if (cfg.oh) {
    const ohDur = cfg.oh.speed / sim.speed;
    $('ohTime').textContent = Math.max(0, sim.ohAt - sim.t).toFixed(1);
    $('ohFill').style.width = `${(1 - Math.min(1, Math.max(0, (sim.ohAt - sim.t) / ohDur))) * 100}%`;
  }

  // action bar
  for (const [id, refs] of Object.entries(app.actionEls)) {
    const st = sim.status(id);
    const info = st.info;
    let frac = 0, txt = '';
    const cdTotal = info.trinket ? info.cd : (info.cd || 0);
    if (st.cdLeft > 0 && st.reason !== 'stance') {
      frac = Math.min(1, st.cdLeft / Math.max(cdTotal, st.cdLeft, 1));
      txt = st.cdLeft >= 3 ? String(Math.ceil(st.cdLeft)) : st.cdLeft.toFixed(1);
    } else if (info.gcd && st.gcdLeft > 0) {
      frac = st.gcdLeft / 1.5;
    }
    refs.cdov.style.height = `${frac * 100}%`;
    refs.cdn.style.display = txt ? 'grid' : 'none';
    refs.cdn.textContent = txt;
    refs.el.classList.toggle('norage', st.reason === 'rage');
    refs.el.classList.toggle('nostance', st.reason === 'stance' && !app.settings.autoStance);
    refs.el.classList.toggle('queued', id === 'hs' && sim.hsQueued);
    const opOpen = id === 'op' && sim.t < sim.opUntil && sim.rage >= 5 && st.reason !== 'cd' && (st.ready || (app.settings.autoStance && st.reason === 'stance'));
    const glow = (id === 'exec' && st.ready) || opOpen;
    refs.el.classList.toggle('glow', glow);
  }

  // auras
  updateAuras(sim);

  // meter
  const nowMs = performance.now();
  if (final || nowMs - app.meterAt > 250) {
    app.meterAt = nowMs;
    const t = Math.max(sim.t, 0.5);
    $('dpsNow').textContent = fmt(sim.total / t);
    $('fctDps').textContent = `${fmt(sim.total / t)} DPS`;
    const m = Math.floor(sim.t / 60), sec = (sim.t % 60).toFixed(1).padStart(4, '0');
    const L = app.fightLen || 0;
    $('fightTime').textContent = `${m}:${sec}` + (L && !sim.drill ? ` / ${Math.floor(L / 60)}:${String(Math.round(L % 60)).padStart(2, '0')}` : '');
    const rows = Object.entries(sim.bySource).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const top = rows.length ? rows[0][1] : 1;
    $('meter').innerHTML = rows.map(([n, d]) =>
      `<div class="mrow"><div class="f" style="width:${(d / top) * 100}%"></div><span><b>${esc(n)}</b><em>${fmt(d / t)} · ${((d / sim.total) * 100).toFixed(0)}%</em></span></div>`).join('');
  }
}

function updateAuras(sim) {
  const wrap = $('auras');
  const live = new Set();
  for (const a of sim.auras.values()) {
    if (!sim.auraActive(a)) continue;
    live.add(a.key);
    let refs = app.auraEls.get(a.key);
    if (!refs) {
      const el = document.createElement('div');
      el.className = 'aura';
      el.title = a.name;
      el.innerHTML = `<div class="tx">${esc(a.name)}</div><span class="s"></span><span class="t"></span>`;
      wrap.appendChild(el);
      setIcon(el, a.icon);
      refs = { el, s: el.querySelector('.s'), t: el.querySelector('.t') };
      app.auraEls.set(a.key, refs);
    }
    const left = a.until - sim.t;
    refs.t.textContent = left < 100 ? (left >= 10 ? Math.ceil(left) : left.toFixed(1)) : '';
    refs.s.textContent = a.stacks !== undefined && a.stacks > 1 ? a.stacks : '';
  }
  for (const [key, refs] of app.auraEls) {
    if (!live.has(key)) { refs.el.remove(); app.auraEls.delete(key); }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------
function showReport(r, sim) {
  const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '–');
  const simPos = Math.min(100, (r.simDps / (Math.max(r.dps, r.simDps) * 1.15)) * 100);
  const youPos = Math.min(100, (r.dps / (Math.max(r.dps, r.simDps) * 1.15)) * 100);
  const gradeNote = r.withinNoise ? 'Within normal sim variance.' : (r.ratio >= 1 ? 'Above the sim average.' : 'Below the sim average.');
  const drill = sim.drill;
  const execRatio = r.execRef ? r.execDps / r.execRef : NaN;

  const rows = r.rows.map((x) => `<tr><td>${esc(x.label)}</td><td class="st-${x.status}">${esc(x.value)}</td><td class="note">${esc(x.note)}</td></tr>`).join('');
  const f = r.failed;
  const failRow = `<tr><td>Early key presses</td><td class="st-info">${f.cd + f.gcd + f.rage + f.notready + f.stance}</td><td class="note">Presses that did nothing: ${f.cd} on cooldown, ${f.gcd} on GCD, ${f.rage} without rage, ${f.stance} wrong stance, ${f.notready} unavailable.</td></tr>`;
  const cds = r.cooldowns.map((c) => `<tr><td>${esc(c.label)}</td><td class="st-${c.status}">${c.uses.length} / ${c.maxUses}</td><td class="note">${c.notes.map(esc).join(' ')}</td></tr>`).join('');
  const breakdown = r.breakdown.slice(0, 10).map((b) => `<tr><td>${esc(b.name)}</td><td>${fmt(b.dps)} DPS</td><td class="note">${(b.pct * 100).toFixed(1)}% of damage</td></tr>`).join('');

  $('reportBody').innerHTML = `
  <div class="report">
    <h2>${drill ? 'Execute drill' : 'Pull'} result · killed in ${r.killTime.toFixed(1)}s</h2>
    <div class="rephead">
      <div class="grade ${r.grade}">${r.grade}</div>
      <div class="repnums">
        <div class="big">${fmt(r.dps)} DPS <span class="sub">(${fmt(r.total)} damage)</span></div>
        <div class="parsebig">${r.eligible ? '<span id="parseNow" class="sub">Parse: ranking…</span>' : '<span class="sub">Not scored: only full pulls at 1× speed count for the scoreboard.</span>'}</div>
        <div>Sim reference: <b>${fmt(r.simDps)}</b> ± ${fmt(r.simSd)} · you did <b>${pct(r.ratio)}</b> of it. ${gradeNote}</div>
        <div class="sub">${Number.isFinite(r.execDps) ? `Execute phase: ${fmt(r.execDps)} DPS vs sim ${fmt(r.execRef)} (${pct(execRatio)}). ` : ''}Seed ${sim.seed} — set it in Settings to replay the same RNG. ${drill ? 'The full-fight sim reference is not directly comparable to a 25% drill; use the execute-phase line.' : ''}</div>
      </div>
    </div>
    <div class="vsbar"><div class="you" style="width:${youPos}%"></div><div class="sim" style="left:${simPos}%" title="Sim average"></div></div>

    ${r.eligible ? '<h2>Scoreboard</h2><div id="boardBody" class="boardbody sub">Saving your score…</div>' : ''}

    <h2>Rotation</h2>
    <table class="rep">${rows}${failRow}</table>

    <h2>Cooldowns</h2>
    <table class="rep">${cds}</table>

    <h2>Damage breakdown</h2>
    <table class="rep">${breakdown}</table>

    <h2>Replay</h2>
    <div class="legend">
      <span><i style="background:#e0614f"></i>Bloodthirst</span><span><i style="background:#6aa8e0"></i>Whirlwind</span>
      <span><i style="background:#e8913a"></i>Heroic Strike</span><span><i style="background:#b57edc"></i>Execute</span>
      <span><i style="background:#6fbf73"></i>Overpower / Hamstring</span><span><i style="background:#f0c05a"></i>Crit</span>
      <span><i style="background:#9aa"></i>Miss / dodge</span><span><i style="background:#7fd3ff"></i>Windfury proc</span>
      <span><i style="background:#ff4d4d"></i>Late press</span>
    </div>
    <canvas id="timeline" class="timeline"></canvas>
    <div id="tlinfo" class="tlinfo">Hover the timeline to inspect events.</div>

    <h2>Compare with the ideal rotation</h2>
    <div id="cmpBody" class="sub">Playing the same fight with the sim rotation…</div>
  </div>`;
  $('reportDlg').showModal();
  requestAnimationFrame(() => {
    drawTimeline(sim, r);
    setTimeout(() => renderComparison(sim, r), 20);
  });
}

const LANES = [
  { key: 'Bloodthirst', label: 'Bloodthirst', color: '#e0614f' },
  { key: 'Whirlwind', label: 'Whirlwind', color: '#6aa8e0' },
  { key: 'Heroic Strike', label: 'Heroic Strike', color: '#e8913a' },
  { key: 'Execute', label: 'Execute', color: '#b57edc' },
  { key: 'other', label: 'Overpower / Ham', color: '#6fbf73' },
  { key: 'auto', label: 'Auto attacks', color: '#a89a78' },
];
const AURA_COLORS = { dw: '#d94f4f', reck: '#ff7a5a', bf: '#d98a3d', pot: '#c44', br: '#b04040', flurry: '#e8a33d', wfbuff: '#7fd3ff', crusadermh: '#ffe38a', crusaderoh: '#ffe38a' };

function collectAuraIntervals(sim, T) {
  const intervals = {};
  const open = {};
  for (const e of sim.events) {
    if (e.type !== 'aura' || e.key === 'dw_dot') continue;
    const tracked = AURA_COLORS[e.key] || e.key.startsWith('item_');
    if (!tracked) continue;
    if (e.on) open[e.key] = e.t;
    else if (open[e.key] !== undefined) { (intervals[e.key] = intervals[e.key] || []).push([open[e.key], e.t, e.name]); delete open[e.key]; }
  }
  for (const [k, t0] of Object.entries(open)) {
    const name = sim.events.find((e) => e.type === 'aura' && e.key === k)?.name || k;
    (intervals[k] = intervals[k] || []).push([t0, T, name]);
  }
  return intervals;
}

function drawTimeline(sim, report, opts = {}) {
  const { canvasId = 'timeline', infoId = 'tlinfo', T: Tover = null, end: endOver = null, bands = [], mistakes = report.mistakes || [] } = opts;
  const canvas = $(canvasId);
  if (!canvas) return;
  const T = Tover || report.killTime;
  const end = Math.min(T, endOver ?? report.killTime ?? T);   // where this fight's data stops
  const intervals = collectAuraIntervals(sim, end);
  const auraKeys = Object.keys(intervals);
  const chartH = 90, top = 8, laneH = 20;
  const needed = top + chartH + 4 + 22 + auraKeys.length * 13 + 8 + LANES.length * laneH + 10;
  canvas.style.height = `${needed}px`;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = needed;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const L = 110, R = 10;
  const x = (t) => L + (t / T) * (W - L - R);
  ctx.fillStyle = '#0c0a08'; ctx.fillRect(0, 0, W, H);
  ctx.font = '11px Segoe UI, sans-serif';
  ctx.textBaseline = 'middle';

  // rage + HP chart
  ctx.fillStyle = '#9a8f7c'; ctx.fillText('Rage (red)', 8, top + 12); ctx.fillText('Boss HP (green)', 8, top + 30);
  ctx.strokeStyle = '#2a241b';
  for (const v of [0, 50, 100]) { const y = top + chartH - (v / 100) * chartH; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); }
  ctx.beginPath(); ctx.fillStyle = 'rgba(88,176,92,0.18)';
  ctx.moveTo(x(0), top + chartH);
  for (const s of sim.samples) ctx.lineTo(x(s.t), top + chartH - s.hp * chartH);
  ctx.lineTo(x(end), top + chartH); ctx.fill();
  ctx.beginPath(); ctx.strokeStyle = '#d0453a'; ctx.lineWidth = 1.5;
  sim.samples.forEach((s, i) => { const px = x(s.t), py = top + chartH - s.rage / 100 * chartH; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.stroke(); ctx.lineWidth = 1;

  // time axis
  const axisY = top + chartH + 4;
  ctx.fillStyle = '#7d7260';
  const stepT = T > 90 ? 20 : 10;
  for (let t = 0; t <= T; t += stepT) { ctx.fillText(`${t}s`, x(t) - 8, axisY + 8); ctx.strokeStyle = '#1d1914'; ctx.beginPath(); ctx.moveTo(x(t), top); ctx.lineTo(x(t), H); ctx.stroke(); }

  // aura intervals
  let y = axisY + 22;
  auraKeys.forEach((k) => {
    ctx.fillStyle = '#9a8f7c';
    const nm = intervals[k][0][2];
    ctx.fillText(nm.length > 17 ? nm.slice(0, 16) + '…' : nm, 8, y + 5);
    ctx.fillStyle = AURA_COLORS[k] || '#c9a0ff';
    ctx.globalAlpha = 0.75;
    intervals[k].forEach(([a, b]) => ctx.fillRect(x(a), y, Math.max(2, x(Math.min(b, T)) - x(a)), 9));
    ctx.globalAlpha = 1;
    y += 13;
  });
  y += 8;

  // ability lanes
  const laneOf = (name) => {
    if (name === 'Bloodthirst' || name === 'Whirlwind' || name === 'Heroic Strike' || name === 'Execute') return name;
    if (name === 'Overpower' || name === 'Hamstring') return 'other';
    if (name.startsWith('Auto Attack')) return 'auto';
    return null;
  };
  const laneY = {};
  LANES.forEach((ln, i) => {
    laneY[ln.key] = y + i * laneH;
    ctx.fillStyle = '#9a8f7c'; ctx.fillText(ln.label, 8, laneY[ln.key] + 9);
    ctx.strokeStyle = '#1d1914'; ctx.beginPath(); ctx.moveTo(L, laneY[ln.key] + laneH - 1); ctx.lineTo(W - R, laneY[ln.key] + laneH - 1); ctx.stroke();
  });
  const marks = [];
  for (const e of sim.events) {
    if (e.type === 'proc' && e.name === 'Windfury') {
      ctx.strokeStyle = 'rgba(127,211,255,.55)'; ctx.beginPath(); ctx.moveTo(x(e.t), top); ctx.lineTo(x(e.t), y + LANES.length * laneH); ctx.stroke();
      marks.push({ t: e.t, text: 'Windfury proc' });
      continue;
    }
    if (e.type !== 'hit' || e.outcome === 'tick') continue;
    const lane = laneOf(e.name);
    if (!lane) continue;
    const ln = LANES.find((l) => l.key === lane);
    const ly = laneY[lane];
    const hollow = e.outcome === 'miss' || e.outcome === 'dodge';
    const isCrit = e.outcome === 'crit';
    ctx.strokeStyle = hollow ? '#9aa' : (isCrit ? '#f0c05a' : ln.color);
    ctx.fillStyle = ctx.strokeStyle;
    const px = x(e.t);
    if (hollow) { ctx.strokeRect(px - 1.5, ly + 5, 3, 9); }
    else { ctx.fillRect(px - 1, ly + (isCrit ? 2 : 5), 2.5, isCrit ? 15 : 9); }
    marks.push({ t: e.t, text: `${e.name} ${e.outcome}${e.dmg ? ' ' + fmt(e.dmg) : ''}` });
  }
  // cast markers for cooldowns
  for (const e of sim.events) if (e.type === 'cast' && e.outcome === 'cd') marks.push({ t: e.t, text: `Cast ${e.name}` });

  // late presses
  for (const m of mistakes) {
    const ly = laneY[m.name];
    if (ly === undefined) continue;
    ctx.fillStyle = '#ff4d4d';
    const px = x(m.t);
    ctx.beginPath(); ctx.moveTo(px, ly + 1); ctx.lineTo(px - 4, ly - 5); ctx.lineTo(px + 4, ly - 5); ctx.closePath(); ctx.fill();
    marks.push({ t: m.t, text: `${m.name} pressed ${m.late.toFixed(2)}s after it was ready` });
  }

  if (end < T - 0.5) {
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(x(end), top, x(T) - x(end), H - top);
    ctx.strokeStyle = '#6b5f4b';
    ctx.beginPath(); ctx.moveTo(x(end), top); ctx.lineTo(x(end), H); ctx.stroke();
    ctx.fillStyle = '#8a7e68';
    ctx.fillText('fight over', x(end) + 6, top + 8);
  }
  for (const b of bands) {
    ctx.fillStyle = 'rgba(224,97,79,0.13)';
    ctx.fillRect(x(b.w0), top, x(b.w1) - x(b.w0), H - top);
  }

  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const t = ((ev.clientX - rect.left - L) / (W - L - R)) * T;
    const near = marks.filter((m) => Math.abs(m.t - t) < 0.4).slice(0, 4);
    $(infoId).textContent = `${Math.max(0, t).toFixed(1)}s` + (near.length ? ' — ' + near.map((m) => `${m.t.toFixed(2)}s ${m.text}`).join(' | ') : '');
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogs: keybinds, settings, import
// ---------------------------------------------------------------------------------------------------------------
function renderKeysList() {
  const list = $('keysList');
  list.innerHTML = '';
  for (const a of BIND_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keyrow';
    row.innerHTML = `<span>${esc(a.label)}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn kb';
    btn.textContent = prettyCombo(app.binds[a.id]);
    btn.addEventListener('click', () => {
      app.listening = a.id;
      document.querySelectorAll('.kb.listen').forEach((b) => b.classList.remove('listen'));
      btn.classList.add('listen');
      btn.textContent = 'press a key…';
      btn.focus();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function assignBind(id, combo) {
  if (combo) {
    const other = findConflict(app.binds, combo, id);
    if (other) app.binds[other] = app.binds[id] || '';   // swap
  }
  app.binds[id] = combo || '';
  saveBinds(app.binds);
  app.listening = null;
  renderKeysList();
  refreshKeyLabels();
}

function anyDialogOpen() {
  return [...document.querySelectorAll('dialog')].some((d) => d.open);
}

window.addEventListener('keydown', (e) => {
  if (app.listening) {
    e.preventDefault();
    if (e.code === 'Escape') { app.listening = null; renderKeysList(); return; }
    if (e.code === 'Backspace') { assignBind(app.listening, ''); return; }
    const combo = comboFromKeyEvent(e);
    if (combo) assignBind(app.listening, combo);
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
  if (anyDialogOpen() && !(e.code === app.binds.pause)) return;
  // Like WoW, Esc always drops a queued Heroic Strike (not rebindable).
  if (e.code === 'Escape' && app.state === 'running') app.sim.cancelHeroicStrike();
  const combo = comboFromKeyEvent(e);
  if (!combo || !app.rev) return;
  const actions = app.rev.get(combo);
  if (!actions) return;
  e.preventDefault();
  if (e.repeat) return;
  actions.forEach(dispatchAction);
});

// Mouse buttons are caught in the capture phase so nothing on the page can swallow them.
window.addEventListener('mousedown', (e) => {
  if (app.listening) {
    const combo = comboFromMouseEvent(e);
    if (combo) { e.preventDefault(); assignBind(app.listening, combo); }
    return;
  }
  if (anyDialogOpen() || e.button < 1 || e.button === 2) return;
  const combo = comboFromMouseEvent(e);
  const actions = combo && app.rev && app.rev.get(combo);
  if (actions) { e.preventDefault(); actions.forEach(dispatchAction); }
}, true);
// Middle and side buttons also act on release (browser Back/Forward, autoscroll). Block those, and let a bind be
// picked on release too for browsers that don't report the side buttons on press.
const onMouseRelease = (e) => {
  if (e.button !== 1 && e.button !== 3 && e.button !== 4) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (!app.listening && (tag === 'textarea' || tag === 'input')) return;
  e.preventDefault();
  if (app.listening) {
    const combo = comboFromMouseEvent(e);
    if (combo) assignBind(app.listening, combo);
  }
};
['mouseup', 'auxclick', 'pointerup'].forEach((type) => window.addEventListener(type, onMouseRelease, true));
let lastWheel = 0;
window.addEventListener('wheel', (e) => {
  const combo = comboFromWheelEvent(e);
  if (!combo) return;
  if (app.listening) {
    e.preventDefault();
    assignBind(app.listening, combo);
    return;
  }
  if (anyDialogOpen() || app.state !== 'running') return;
  const actions = app.rev && app.rev.get(combo);
  if (!actions) return;
  e.preventDefault();
  const now = performance.now();
  if (now - lastWheel < 30) return;   // one wheel notch can emit several events
  lastWheel = now;
  actions.forEach(dispatchAction);
}, { passive: false });

document.addEventListener('visibilitychange', () => { if (document.hidden && app.state === 'running') togglePause(); });

function bindDialogs() {
  $('btnImport').addEventListener('click', () => {
    if (app.state === 'running') togglePause();
    // Start empty so nobody imports (or re-saves) someone else's character by accident.
    $('importText').value = '';
    $('profileName').value = '';
    $('importMsg').innerHTML = '';
    $('importDlg').showModal();
  });
  $('btnImportPull').addEventListener('click', () => $('btnImport').click());
  const loadProfile = (name) => {
    const text = name && loadProfiles()[name];
    if (text && importFromText(text, { profile: name })) { $('profileName').value = name; toast(`${name} loaded`); }
  };
  $('profileSel').addEventListener('change', () => loadProfile($('profileSel').value));
  $('btnProfileDelete').addEventListener('click', () => {
    const name = $('profileSel').value;
    if (!name || !confirm(`Delete saved profile "${name}"?`)) return;
    const profiles = loadProfiles();
    delete profiles[name];
    saveProfiles(profiles);
    setActiveProfile('');
    renderProfiles('');
  });
  $('btnImportCancel').addEventListener('click', () => $('importDlg').close());
  $('btnImportGo').addEventListener('click', () => {
    const name = $('profileName').value.trim();
    const text = $('importText').value;
    if (importFromText(text, { profile: name || null })) {
      // An unnamed import is saved under the character's own name so it shows up in the Gear dropdown.
      if (!name) saveUnnamedProfile(text);
      setTimeout(() => $('importDlg').close(), 600);
    }
  });

  // Both gear dropdowns (import dialog and pull panel) swap the current character's gear for a default set.
  const applyDefaultGear = async (sel) => {
    if (sel.value.startsWith(PROFILE_PREFIX)) { loadProfile(sel.value.slice(PROFILE_PREFIX.length)); return; }
    const set = app.gearSets.find((s) => s.key === sel.value);
    if (!set) { sel.value = ''; return; }
    try {
      const base = app.jsonText || await (await fetch('example.json')).text();
      const text = JSON.stringify(applyGearSet(JSON.parse(base), set));
      if (importFromText(text, { gearKey: set.key })) toast(`${set.label} gear loaded`);
    } catch (err) {
      $('importMsg').innerHTML = `<div class="e">Could not apply ${esc(set.label)} gear: ${esc(err.message)}</div>`;
      toast(`Could not apply ${set.label} gear`);
    }
  };
  $('gearSetSel').addEventListener('change', () => applyDefaultGear($('gearSetSel')));
  $('pullGearSel').addEventListener('change', () => applyDefaultGear($('pullGearSel')));

  $('btnKeys').addEventListener('click', () => { if (app.state === 'running') togglePause(); renderKeysList(); $('keysDlg').showModal(); });
  $('btnKeysClose').addEventListener('click', () => { app.listening = null; $('keysDlg').close(); });
  $('btnKeysReset').addEventListener('click', () => { app.binds = { ...DEFAULT_BINDS }; saveBinds(app.binds); renderKeysList(); refreshKeyLabels(); });
  $('btnKeysExport').addEventListener('click', () => {
    $('keysJson').classList.remove('hidden');
    $('keysJson').value = JSON.stringify(app.binds, null, 2);
    $('keysJson').select();
  });
  $('btnKeysImport').addEventListener('click', () => {
    const box = $('keysJson');
    if (box.classList.contains('hidden')) { box.classList.remove('hidden'); box.value = ''; box.focus(); return; }
    try {
      const obj = JSON.parse(box.value);
      app.binds = { ...DEFAULT_BINDS, ...obj };
      saveBinds(app.binds); renderKeysList(); refreshKeyLabels();
      box.classList.add('hidden');
    } catch { toast('Keybind JSON is invalid'); }
  });

  $('btnSettings').addEventListener('click', () => {
    if (app.state === 'running') togglePause();
    const s = app.settings;
    $('setSpeed').value = String(s.speed);
    $('setHints').checked = !!s.hints;
    $('setSeed').value = s.seed;
    $('setRuns').value = s.runs;
    $('setAutoStance').checked = !!s.autoStance;
    $('settingsDlg').showModal();
  });
  $('btnSettingsClose').addEventListener('click', () => {
    const s = app.settings;
    const oldRuns = s.runs;
    s.speed = Number($('setSpeed').value);
    s.hints = $('setHints').checked;
    s.seed = $('setSeed').value.trim();
    s.autoStance = $('setAutoStance').checked;
    s.runs = Math.max(20, Math.min(1000, Number($('setRuns').value) || 100));
    saveSettings();
    $('settingsDlg').close();
    if (app.cfg && oldRuns !== s.runs) startReference();
  });

  $('btnReportClose').addEventListener('click', () => $('reportDlg').close());
  $('btnReportRetry').addEventListener('click', () => { $('reportDlg').close(); startPull(); });
  $('btnPull').addEventListener('click', () => { if (app.state === 'idle' || app.state === 'finished') startPull(); else if (app.state === 'paused') togglePause(); });
  $('startZone').addEventListener('mousedown', (e) => { if (app.state === 'paused' && e.target === $('startZone')) togglePause(); });
}

// ---------------------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------------------
async function boot() {
  loadSettings();
  $('modeSel').value = app.settings.mode || 'full';
  $('lenSel').value = String(app.settings.length || 60);
  $('cdSel').value = String(app.settings.countdown ?? 3);
  $('rageIn').value = String(app.settings.startRage ?? 0);
  bindDialogs();
  $('btnKeysPull').addEventListener('click', () => $('btnKeys').click());
  $('btnSettingsPull').addEventListener('click', () => $('btnSettings').click());
  $('nameIn').value = getPlayer().name;
  $('nameIn').addEventListener('input', syncPull);
  $('nameIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!$('btnPull').disabled) startPull(); } });
  app.rev = reverseMap(app.binds);
  try {
    const res = await fetch('src/data/gamedata.json');
    app.gd = await res.json();
  } catch (err) {
    $('startMsg').textContent = 'Could not load src/data/gamedata.json. Serve this folder over http (see README).';
    console.error(err);
    return;
  }
  try {
    app.gearSets = await (await fetch('src/data/gearsets.json')).json();
    const opts = app.gearSets.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
    $('gearSetSel').innerHTML = `<option value="">Choose a phase…</option>${opts}`;
    gearUi.setsHtml = opts;
    renderGearSelect();
  } catch (err) {
    console.error(err);
  }
  renderProfiles(localStorage.getItem(ACTIVE_KEY) || '');
  let saved = null;
  try {
    const active = localStorage.getItem(ACTIVE_KEY);
    saved = (active && loadProfiles()[active]) || localStorage.getItem(JSON_KEY);
  } catch { /* ignore */ }
  if (saved && importFromText(saved, { persist: false })) {
    // loaded last character
  } else if (!(await loadDefaultCharacter())) {
    $('importDlg').showModal();
  }
  app.last = performance.now();
  requestAnimationFrame(frame);
}

boot();


// ---------------------------------------------------------------------------------------------------------------
// Compare with ideal
// ---------------------------------------------------------------------------------------------------------------
function renderComparison(sim, report) {
  const box = $('cmpBody');
  if (!box) return;
  const youEnd = sim.tKill ?? sim.t;
  const drill = sim.drill;
  const idealLen = drill ? youEnd : (sim.fightLen || youEnd);
  const ideal = idealRun(app.cfg, {
    duration: idealLen, startRage: sim.startRage, alwaysExecute: drill,
  });
  const cmp = compareRuns(sim, ideal.sim, { youEnd, idealEnd: idealLen });
  const mm = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const diff = cmp.dpsYou - cmp.dpsIdeal;

  const castRows = cmp.castRows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.you}</td><td>${r.ideal}</td><td class="${r.delta < 0 ? 'st-bad' : r.delta > 0 ? 'st-info' : 'st-good'}">${r.delta > 0 ? '+' : ''}${r.delta}</td></tr>`).join('');
  const cdRows = cmp.cdRows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.you.length ? r.you.map(mm).join(', ') : '—'}</td><td>${r.ideal.length ? r.ideal.map(mm).join(', ') : '—'}</td></tr>`).join('');
  const wins = cmp.windows.length ? cmp.windows.map((w) => {
    const casts = w.casts.map((c) => `${esc(c.name)} ${c.you} vs ${c.ideal}`).join(' · ');
    const rg = (v) => (Number.isFinite(v) ? v.toFixed(0) : '–');
    return `<div class="cmpwin"><b>${mm(w.w0)}–${mm(w.w1)}</b> you did ${fmt(w.you)} damage, the ideal did ${fmt(w.ideal)} <span class="st-bad">(−${fmt(w.loss)})</span>
      <div class="sub">Casts (you vs ideal): ${casts}</div>
      <div class="sub">Idle global cooldown: ${w.idleYou.toFixed(1)}s vs ${w.idleIdeal.toFixed(1)}s · average rage ${rg(w.rageYou)} vs ${rg(w.rageIdeal)}</div>
      <div>Likely: ${explainWindow(w).map(esc).join('; ')}.</div></div>`;
  }).join('') : '<div class="sub">No stretch where you fell clearly behind. Your damage tracked the ideal closely.</div>';

  box.className = '';
  box.innerHTML = `
    <div class="cmpsum">Ideal run (median of ${ideal.n}, ${ideal.spread[0].toFixed(0)}–${ideal.spread[1].toFixed(0)} DPS spread): <b>${fmt(cmp.dpsIdeal)} DPS</b> over ${mm(idealLen)}.
      You: <b>${fmt(cmp.dpsYou)} DPS</b> over ${mm(youEnd)} (<span class="${diff < 0 ? 'st-bad' : 'st-good'}">${diff >= 0 ? '+' : ''}${fmt(diff)}</span>).
      Idle global cooldown: you ${cmp.idle.you.idle.toFixed(1)}s vs ideal ${cmp.idle.ideal.idle.toFixed(1)}s.
      Rage wasted at cap: you ${fmt(cmp.rageWastedYou)} vs ideal ${fmt(cmp.rageWastedIdeal)}.
      Flurry uptime: you ${cmp.flurryYou.toFixed(0)}% vs ideal ${cmp.flurryIdeal.toFixed(0)}%. Windfury procs per minute: you ${cmp.wfYou.toFixed(1)} vs ideal ${cmp.wfIdeal.toFixed(1)}.</div>
    <div class="sub">The ideal is the rotation from your WoWSims export played by the sim bot with your gear, starting rage and the same fight length. Crits and procs differ between runs, so small gaps are noise. Red bands mark your three biggest slumps.</div>
    <h3>Damage dealt over time</h3>
    <div class="legend"><span><i style="background:#f0c05a"></i>You</span><span><i style="background:#9fd0ff"></i>Ideal</span><span><i style="background:rgba(224,97,79,.5)"></i>Where you fell behind</span></div>
    <canvas id="cmpCum" class="timeline" style="height:200px"></canvas>
    <div id="cmpCumInfo" class="tlinfo">Hover the chart to compare totals at a moment.</div>
    <h3>Where you lost the most</h3>
    ${wins}
    <div class="cmpcols">
      <div><h3>Casts</h3><table class="rep cmptab"><tr><td></td><td>You</td><td>Ideal</td><td>Diff</td></tr>${castRows}</table></div>
      <div><h3>Cooldown timing</h3><table class="rep cmptab"><tr><td></td><td>You</td><td>Ideal</td></tr>${cdRows}</table></div>
    </div>
    <h3>Your timeline</h3>
    <canvas id="cmpYou" class="timeline"></canvas><div id="cmpYouInfo" class="tlinfo"></div>
    <h3>Ideal timeline</h3>
    <canvas id="cmpIdeal" class="timeline"></canvas><div id="cmpIdealInfo" class="tlinfo"></div>`;

  requestAnimationFrame(() => {
    drawCumulative(cmp);
    const bands = cmp.windows;
    drawTimeline(sim, report, { canvasId: 'cmpYou', infoId: 'cmpYouInfo', T: cmp.Taxis, end: youEnd, bands });
    drawTimeline(ideal.sim, { killTime: idealLen }, { canvasId: 'cmpIdeal', infoId: 'cmpIdealInfo', T: cmp.Taxis, end: idealLen, bands, mistakes: [] });
  });
}

function drawCumulative(cmp) {
  const canvas = $('cmpCum');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = 200;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const L = 110, R = 10, top = 10, bot = 24;
  const T = cmp.Taxis;
  const maxV = Math.max(cmp.cumYou[cmp.cumYou.length - 1], cmp.cumIdeal[cmp.cumIdeal.length - 1], 1);
  const x = (t) => L + (t / T) * (W - L - R);
  const y = (v) => top + (1 - v / maxV) * (H - top - bot);
  ctx.fillStyle = '#0c0a08'; ctx.fillRect(0, 0, W, H);
  ctx.font = '11px Segoe UI, sans-serif'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#2a241b'; ctx.fillStyle = '#7d7260';
  for (let k = 0; k <= 4; k++) {
    const v = (maxV * k) / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
    ctx.fillText(fmt(v / 1000, 0) + 'k', 8, yy);
  }
  const stepT = T > 90 ? 20 : 10;
  for (let t = 0; t <= T; t += stepT) ctx.fillText(`${t}s`, x(t) - 8, H - 10);
  for (const w of cmp.windows) { ctx.fillStyle = 'rgba(224,97,79,0.18)'; ctx.fillRect(x(w.w0), top, x(w.w1) - x(w.w0), H - top - bot); }
  const line = (series, end, color) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
    for (let i = 0; i < series.length; i++) {
      const t = Math.min(i, end);
      const px = x(t), py = y(series[i]);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      if (i >= end) break;
    }
    ctx.stroke(); ctx.lineWidth = 1;
  };
  line(cmp.cumIdeal, cmp.idealEnd, '#9fd0ff');
  line(cmp.cumYou, cmp.youEnd, '#f0c05a');
  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(T, ((ev.clientX - rect.left - L) / (W - L - R)) * T));
    const a = cmp.cumYou[Math.min(cmp.cumYou.length - 1, Math.round(t))], b = cmp.cumIdeal[Math.min(cmp.cumIdeal.length - 1, Math.round(t))];
    $('cmpCumInfo').textContent = `${t.toFixed(0)}s — you ${fmt(a)}, ideal ${fmt(b)} (${a - b >= 0 ? '+' : ''}${fmt(a - b)})`;
  };
}

// Build stamp YYYYMMDDHHMMSS -> "v2026.10.26-1910"
$('verTag').textContent = VERSION.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2}).*$/, 'v$1.$2.$3-$4$5');
checkForUpdate();
