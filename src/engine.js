// Classic Era Fury warrior combat engine. Rules follow the WoWSims classic sim (wowsims/classic) so numbers
// line up with what the sim tells you to expect: attack tables, rage generation, Heroic Strike queueing,
// Windfury / Crusader / Flurry / Deep Wounds, cooldowns. Time advances in fixed 5ms steps.

export const STEP = 0.005;
export const GCD = 1.5;
export const STANCE = { BATTLE: 1, BERSERKER: 4 };
const ANY = 7;

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rage conversion for a level-60 attacker (the in-game value, ~230.6). WoWSims evaluates `level^2` with Go's XOR
// operator, which gives a smaller divisor (~198, more rage); we deliberately use the real game formula instead.
export function rageConversion() {
  return 0.0091107836 * 60 * 60 + 3.225598133 * 60 + 4.2652911;
}

function makeTable(skill, bossLevel) {
  const def = bossLevel * 5;
  const diff = def - skill;
  const t = {};
  if (diff > 10) {
    t.hitSupp = (diff - 10) * 0.002;
    t.baseMiss = 0.05 + diff * 0.002;
  } else {
    t.hitSupp = 0;
    t.baseMiss = 0.05 + diff * 0.001;
  }
  t.baseDodge = 0.05 + diff * 0.001;
  t.baseGlance = 0.1 + (def - 300) * 0.02;
  t.glMin = Math.max(Math.min(1.3 - 0.05 * diff, 0.91), 0.01);
  t.glMax = Math.max(Math.min(1.2 - 0.03 * diff, 0.99), 0.2);
  t.critSupp = def > 300 ? (def - 300) * 0.002 : (def - 300) * 0.0004;
  if (bossLevel - 60 >= 3) t.critSupp += 0.018;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Ability definitions. `gcd` abilities share the 1.5s global cooldown; `cd` is the ability's own cooldown.
// ---------------------------------------------------------------------------------------------------------------
export const ABILITIES = {
  bt:   { name: 'Bloodthirst',   icon: 'spell_nature_bloodlust',       gcd: true,  cd: 6,    stance: ANY },
  ww:   { name: 'Whirlwind',     icon: 'ability_whirlwind',            gcd: true,  cd: 10,   stance: STANCE.BERSERKER },
  op:   { name: 'Overpower',     icon: 'ability_meleedamage',          gcd: true,  cd: 5,    stance: STANCE.BATTLE },
  exec: { name: 'Execute',       icon: 'inv_sword_48',                 gcd: true,  cd: 0,    stance: STANCE.BATTLE | STANCE.BERSERKER },
  hs:   { name: 'Heroic Strike', icon: 'ability_rogue_ambush',         gcd: false, cd: 0,    stance: ANY, queue: true },
  ham:  { name: 'Hamstring',     icon: 'ability_shockwave',            gcd: true,  cd: 0,    stance: STANCE.BATTLE | STANCE.BERSERKER },
  dw:   { name: 'Death Wish',    icon: 'spell_shadow_deathpact',       gcd: true,  cd: 180,  stance: ANY },
  reck: { name: 'Recklessness',  icon: 'ability_criticalstrike',       gcd: true,  cd: 1800, stance: STANCE.BERSERKER },
  br:   { name: 'Bloodrage',     icon: 'ability_racial_bloodrage',     gcd: false, cd: 60,   stance: ANY },
  bf:   { name: 'Blood Fury',    icon: 'racial_orc_berserkerstrength', gcd: true,  cd: 120,  stance: ANY },
  pot:  { name: 'Rage Potion',   icon: 'inv_potion_41',                gcd: false, cd: 120,  stance: ANY },
  sap:  { name: 'Goblin Sapper', icon: 'spell_fire_selfdestruct',      gcd: false, cd: 300,  stance: ANY },
  sunder: { name: 'Sunder Armor', icon: 'ability_warrior_sunder',      gcd: true,  cd: 0,    stance: ANY },
  stBattle:   { name: 'Battle Stance',   icon: 'ability_warrior_offensivestance', gcd: false, cd: 1, cdKey: 'stance', stance: ANY },
  stBerserker: { name: 'Berserker Stance', icon: 'ability_racial_avatar',         gcd: false, cd: 1, cdKey: 'stance', stance: ANY },
};

export class Sim {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.mode = opts.mode || 'player';        // 'player' (boss dies at 0 HP) | 'bot' (fixed duration)
    this.rng = mulberry32(opts.seed ?? 1);
    this.record = !!opts.record;
    this.rageConv = rageConversion();
    this.tal = cfg.talents;

    this.weapons = {
      mh: cfg.mh || { name: 'Fists', speed: 2, min: 1, max: 2, type: 0 },
      oh: cfg.oh || null,
    };
    this.dual = !!cfg.oh;
    this.tab = {
      mh: makeTable(cfg.skillMH, cfg.boss.level),
      oh: makeTable(cfg.skillOH, cfg.boss.level),
    };
    this.armorMod = 1 - cfg.boss.armor / (cfg.boss.armor + 400 + 85 * 60);
    this.hsCost = 15 - this.tal.improvedHeroicStrike;
    this.execCost = 15 - [0, 2, 5][this.tal.improvedExecute];
    this.maxKeptRage = 5 * this.tal.tacticalMastery;
    this.abilities = this.availableAbilities();

    this.n = 0;
    this.t = 0;
    this.rage = opts.startRage || 0;
    this.startRage = this.rage;
    this.alwaysExecute = !!opts.alwaysExecute;
    this.stance = cfg.startStance === 'battle' ? STANCE.BATTLE : STANCE.BERSERKER;
    this.gcdEnd = 0;
    this.cdReady = {};
    this.auras = new Map();
    this.pending = [];
    this.hsQueued = false;
    this.opUntil = 0;
    this.wfIcd = 0;
    this.flurryIcd = 0;
    this.dwSnap = null;            // Deep Wounds {ticksLeft, dmg}
    this.dead = false;
    this.tKill = null;

    // Fight setup
    this.duration = opts.duration || cfg.encounter.duration;
    this.hpMax = opts.hpMax || Infinity;
    this.hp = this.hpMax * (opts.startHpFrac ?? 1);
    this.executeFrac = cfg.encounter.execute20;

    // stats
    this.total = 0;
    this.execDmg = 0;
    this.execStartT = null;
    this.bySource = {};
    this.rageWasted = 0;
    this.rageGained = 0;
    this.casts = {};
    this.metrics = {
      btDelay: { rage: 0, gcd: 0, late: 0 }, wwDelay: { rage: 0, gcd: 0, late: 0 },
      opWindows: 0, opUsed: 0, opMissed: 0, hsQueuedTime: 0, hsCancelled: 0, hsCast: 0,
      ohSwings: 0, ohPenaltyFree: 0, whiteMH: 0, wfProcs: 0, crusaderProcs: 0, flurryUp: 0,
      cdUses: {}, bossDeathAt: null,
    };
    this.events = [];
    this.samples = [];
    this.lastSample = -1;

    this.recalc(true);
    this.speed = this.st.speed;

    // swing timers (random half-swing offset for one hand when dual wielding, like WoWSims)
    this.mhAt = 0;
    this.ohAt = this.dual ? 0 : Infinity;
    if (this.dual) {
      const d = this.rng() * this.weapons.mh.speed / this.speed / 2;
      if (this.rng() < 0.5) this.mhAt = d; else this.ohAt = d;
    }

    if (this.tal.angerManagement) this.schedulePeriodic(3, Infinity, () => this.gainRage(1, 'Anger Management'));
    if (cfg.battleShoutPermanent) {
      // permanent raid buff, already in flat AP
    }
  }

  availableAbilities() {
    const c = this.cfg;
    const list = [];
    if (this.tal.bloodthirst) list.push('bt');
    list.push('ww', 'op', 'exec', 'hs', 'ham');
    if (this.tal.deathWish) list.push('dw');
    list.push('reck', 'br');
    if (c.isOrc) list.push('bf');
    if (c.potion) list.push('pot');
    if (c.sapper) list.push('sap');
    list.push('stBattle', 'stBerserker');
    c.trinkets.forEach((tr) => list.push('item_' + tr.id));
    return list;
  }

  abilityInfo(id) {
    if (!this.infoCache) this.infoCache = {};
    let a = this.infoCache[id];
    if (a !== undefined) return a;
    a = null;
    if (ABILITIES[id]) {
      a = { ...ABILITIES[id], id };
      if (id === 'pot') a.name = this.cfg.potion.name;
    } else {
      const tr = this.cfg.trinkets.find((x) => 'item_' + x.id === id);
      if (tr) a = { id, name: tr.name, icon: tr.icon, gcd: false, cd: tr.cd, stance: ANY, trinket: tr };
    }
    this.infoCache[id] = a;
    return a;
  }

  cost(id) {
    switch (id) {
      case 'bt': return 30;
      case 'ww': return 25;
      case 'op': return 5;
      case 'exec': return this.execCost;
      case 'hs': return this.hsCost;
      case 'ham': return 10;
      case 'dw': return 10;
      case 'sunder': return 15;
      default: return 0;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------------------------------------
  recalc(initial) {
    const c = this.cfg;
    let str = 0, agi = 0, ap = 0, crit = 0, speed = c.mult.speed, dmg = c.mult.damage;
    for (const a of this.auras.values()) {
      if (!this.auraActive(a)) continue;
      const m = a.mod;
      if (!m) continue;
      str += m.str || 0; agi += m.agi || 0; ap += m.ap || 0; crit += m.crit || 0;
      if (m.speed) speed *= m.speed;
      if (m.dmg) dmg *= m.dmg;
    }
    const totStr = (120 + c.raceOff.str + c.gear.str + c.flat.str + str) * c.mult.stats;
    const totAgi = (80 + c.raceOff.agi + c.gear.agi + c.flat.agi + agi) * c.mult.stats;
    const stanceCrit = this.stance === STANCE.BERSERKER ? 3 : 0;
    const prev = this.st;
    this.st = {
      str: totStr, agi: totAgi,
      ap: 160 + 2 * totStr + c.gear.ap + c.flat.ap + c.apFromBoss + ap,
      crit: totAgi * 0.05 + c.gear.crit + c.flat.crit + stanceCrit + crit,
      hit: c.gear.hit + c.flat.hit,
      speed, dmg,
    };
    if (!initial && prev && prev.speed !== speed) this.rescaleSwings(prev.speed, speed);
  }

  rescaleSwings(oldSpeed, newSpeed) {
    const f = oldSpeed / newSpeed;
    if (this.mhAt > this.t) this.mhAt = this.t + (this.mhAt - this.t) * f;
    if (this.dual && this.ohAt > this.t) this.ohAt = this.t + (this.ohAt - this.t) * f;
    this.speed = newSpeed;
  }

  auraActive(a) {
    return a.until > this.t && (a.stacks === undefined || a.stacks > 0);
  }
  hasAura(key) {
    const a = this.auras.get(key);
    return !!a && this.auraActive(a);
  }
  auraStacks(key) {
    const a = this.auras.get(key);
    return a && this.auraActive(a) ? (a.stacks === undefined ? 1 : a.stacks) : 0;
  }

  setAura(key, def) {
    const was = this.hasAura(key);
    const a = { key, name: def.name, icon: def.icon, mod: def.mod, until: this.t + def.dur, dur: def.dur,
      stacks: def.stacks, maxStacks: def.stacks, color: def.color, since: this.t };
    this.auras.set(key, a);
    this.recalc();
    if (!was) this.ev('aura', { key, name: def.name, on: true });
    return a;
  }

  removeAura(key) {
    const a = this.auras.get(key);
    if (!a) return;
    const was = this.auraActive(a);
    a.until = 0;
    this.auras.delete(key);
    this.recalc();
    if (was) this.ev('aura', { key, name: a.name, on: false });
  }

  removeStack(key) {
    const a = this.auras.get(key);
    if (!a || !this.auraActive(a)) return;
    if (a.stacks !== undefined) {
      a.stacks--;
      if (a.stacks <= 0) this.removeAura(key);
    }
  }

  expireAuras() {
    for (const a of this.auras.values()) {
      if (a.until <= this.t) {
        this.auras.delete(a.key);
        this.recalc();
        this.ev('aura', { key: a.key, name: a.name, on: false });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Scheduling helpers
  // ---------------------------------------------------------------------------------------------------------
  schedule(delay, fn) {
    this.pending.push({ at: this.t + delay, fn });
  }
  schedulePeriodic(period, count, fn) {
    let left = count;
    const tick = () => {
      fn();
      if (--left > 0) this.schedule(period, tick);
    };
    this.schedule(period, tick);
  }

  ev(type, data) {
    if (!this.record) return;
    this.events.push({ t: this.t, type, ...data });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rage
  // ---------------------------------------------------------------------------------------------------------
  gainRage(x, source) {
    const before = this.rage;
    this.rage = Math.min(100, this.rage + x);
    this.rageGained += this.rage - before;
    this.rageWasted += x - (this.rage - before);
  }
  spendRage(x) {
    this.rage = Math.max(0, this.rage - x);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase info
  // ---------------------------------------------------------------------------------------------------------
  hpFrac() {
    if (this.mode === 'bot') return 1 - this.t / this.duration;
    return Math.max(0, this.hp / this.hpMax);
  }
  isExecute() {
    if (this.alwaysExecute) return true;
    return this.mode === 'bot' ? this.t >= this.duration * (1 - this.executeFrac) : this.hp / this.hpMax <= this.executeFrac;
  }
  remaining() {
    return this.mode === 'bot' ? this.duration - this.t : NaN;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Attack resolution
  // ---------------------------------------------------------------------------------------------------------
  critChance(hand) {
    const t = this.tab[hand];
    const w = this.weapons[hand];
    let c = this.st.crit + (w && w.type === 1 ? this.cfg.axeSpec : 0);
    if (this.hasAura('reck')) c += 100;
    return Math.max(0, c / 100 - t.critSupp);
  }

  hitChance(hand) {
    return Math.max(this.st.hit / 100 - this.tab[hand].hitSupp, 0);
  }

  weaponRoll(hand) {
    const w = this.weapons[hand];
    return w.min + this.rng() * (w.max - w.min);
  }

  attackerMult(hand, white) {
    let m = this.st.dmg;
    if (hand === 'oh') m *= 1 + 0.05 * this.tal.dualWieldSpecialization;
    return m;
  }

  critMult(white) {
    return white ? 2 : 1 + (2 - 1) * (1 + 0.1 * this.tal.impale);
  }

  // White swing outcome: single roll over miss, dodge, glance, crit.
  rollWhite(hand, penalty) {
    const t = this.tab[hand];
    const miss = Math.max(0, t.baseMiss - this.hitChance(hand) + (this.dual && penalty ? 0.19 : 0));
    const dodge = Math.max(0, t.baseDodge);
    const roll = this.rng();
    let acc = miss;
    if (roll < acc) return 'miss';
    acc += dodge;
    if (roll < acc) return 'dodge';
    acc += t.baseGlance;
    if (roll < acc) return 'glance';
    acc += this.critChance(hand);
    if (roll < acc) return 'crit';
    return 'hit';
  }

  // Yellow attack outcome: miss/dodge on one roll (no dual-wield penalty), crit on a separate roll.
  rollSpecial(hand, { canDodge = true, bonusCrit = 0 } = {}) {
    const t = this.tab[hand];
    const miss = Math.max(0, t.baseMiss - this.hitChance(hand));
    const roll = this.rng();
    if (roll < miss) return 'miss';
    if (canDodge && roll < miss + Math.max(0, t.baseDodge)) return 'dodge';
    if (this.rng() < this.critChance(hand) + bonusCrit) return 'crit';
    return 'hit';
  }

  // Resolve damage + side effects for one landed/unlanded melee attack.
  // kind: 'white' | 'special'. base: pre-multiplier damage. Returns {outcome, dmg, landed}.
  resolve(name, hand, kind, base, outcome) {
    const white = kind === 'white';
    const c = this.cfg;
    base += c.debuffs.giftOfArthas ? 8 : 0;
    const pre = base * this.attackerMult(hand, white) * this.armorMod;
    let dmg = 0;
    switch (outcome) {
      case 'miss': case 'dodge': dmg = 0; break;
      case 'glance': {
        const t = this.tab[hand];
        dmg = pre * (t.glMin + this.rng() * (t.glMax - t.glMin));
        break;
      }
      case 'crit': dmg = pre * this.critMult(white); break;
      default: dmg = pre;
    }
    const landed = outcome !== 'miss' && outcome !== 'dodge';

    if (dmg > 0) this.addDamage(name, dmg);
    if (white && outcome !== 'miss') {
      const rageDmg = outcome === 'dodge' ? pre : dmg;
      this.gainRage(rageDmg * 7.5 / this.rageConv, name);
    }
    this.ev('hit', { name, hand, outcome, dmg: Math.round(dmg), white });

    this.onMeleeHit({ name, hand, white, outcome, landed, pre });
    return { outcome, dmg, landed };
  }

  addDamage(name, dmg) {
    if (this.dead) return;
    this.total += dmg;
    if (this.execStartT !== null) this.execDmg += dmg;
    this.bySource[name] = (this.bySource[name] || 0) + dmg;
    if (this.mode === 'player' && !this.dead) {
      this.hp -= dmg;
      if (this.hp <= 0) {
        this.hp = 0;
        this.dead = true;
        this.tKill = this.t;
        this.metrics.bossDeathAt = this.t;
      }
    }
  }

  // Procs and on-hit triggers
  onMeleeHit(r) {
    const c = this.cfg;
    const { hand, white, outcome, landed } = r;

    // Windfury buff stacks are consumed by every white swing, hit or not.
    if (white) this.removeStack('wfbuff');

    if (outcome === 'dodge') {
      if (this.t >= this.opUntil) this.metrics.opWindows++;
      this.opUntil = this.t + 5;
      this.opWindowOpenedAt = this.t;
    }

    // Flurry: white hits consume a charge (0.5s ICD); any melee crit refreshes to 3 charges.
    if (c.talents.flurry && white && this.hasAura('flurry') && this.t >= this.flurryIcd) {
      this.flurryIcd = this.t + 0.5;
      this.removeStack('flurry');
    }
    if (c.talents.flurry && outcome === 'crit') {
      const mod = 1 + [0.1, 0.15, 0.2, 0.25, 0.3][c.talents.flurry - 1];
      this.setAura('flurry', { name: 'Flurry', icon: 'ability_ghoulfrenzy', dur: 1e9, stacks: 3, mod: { speed: mod }, color: '#e8a33d' });
    }

    if (!landed) return;

    // Deep Wounds on crit
    if (outcome === 'crit' && c.talents.deepWounds) this.applyDeepWounds(hand);

    // Windfury (MH hits only, 1.5s ICD)
    if (c.windfury && hand === 'mh' && this.t >= this.wfIcd && this.rng() < 0.2) {
      this.wfIcd = this.t + 1.5;
      this.metrics.wfProcs++;
      this.setAura('wfbuff', { name: 'Windfury', icon: 'spell_nature_windfury', dur: 1.5, stacks: white ? 1 : 2, mod: { ap: 315 }, color: '#7fd3ff' });
      this.mhAt = this.t + 0.01;           // extra attack: advances the MH swing
      this.ev('proc', { name: 'Windfury' });
    }

    // Crusader (1 PPM per weapon)
    const w = this.weapons[hand];
    if ((hand === 'mh' ? c.crusaderMH : c.crusaderOH) && this.rng() < w.speed / 60) {
      this.metrics.crusaderProcs++;
      this.setAura('crusader' + hand, { name: 'Crusader', icon: 'spell_holy_weaponmastery', dur: 15, mod: { str: 100 }, color: '#ffe38a' });
      this.ev('proc', { name: 'Crusader' });
    }
  }

  applyDeepWounds(hand) {
    const w = this.weapons[hand];
    const avg = (w.min + w.max) / 2 + w.speed * this.st.ap / 14;
    let dmg = avg * (hand === 'oh' ? 0.5 : 1) * this.attackerMult(hand, false);
    dmg = dmg * 0.2 * this.tal.deepWounds / 4;
    const had = this.dwSnap;
    this.dwSnap = { dmg, ticksLeft: 4, token: {} };
    const snap = this.dwSnap;
    const tick = () => {
      if (this.dwSnap !== snap) return;
      const d = snap.dmg * this.st.dmg;
      this.addDamage('Deep Wounds', d);
      this.ev('hit', { name: 'Deep Wounds', hand, outcome: 'tick', dmg: Math.round(d), white: false });
      if (--snap.ticksLeft > 0) this.schedule(3, tick); else this.dwSnap = null;
    };
    this.schedule(3, tick);
    if (!had) this.ev('aura', { key: 'dw_dot', name: 'Deep Wounds', on: true });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Swings
  // ---------------------------------------------------------------------------------------------------------
  swingMH() {
    const w = this.weapons.mh;
    // Heroic Strike replaces the white hit if queued and affordable at swing time.
    if (this.hsQueued) {
      this.hsQueued = false;
      if (this.rage >= this.hsCost) {
        this.mhAt = this.t + w.speed / this.speed;
        this.castHeroicStrike();
        return;
      }
      this.metrics.hsCancelled++;
      this.ev('note', { text: 'Heroic Strike dropped: not enough rage at swing' });
    }
    this.mhAt = this.t + w.speed / this.speed;
    this.metrics.whiteMH++;
    const base = this.weaponRoll('mh') + w.speed * this.st.ap / 14;
    const outcome = this.rollWhite('mh', true);
    this.resolve('Auto Attack (MH)', 'mh', 'white', base, outcome);
  }

  swingOH() {
    const w = this.weapons.oh;
    this.ohAt = this.t + w.speed / this.speed;
    this.metrics.ohSwings++;
    const penalty = !this.hsQueued;
    if (!penalty) this.metrics.ohPenaltyFree++;
    const base = 0.5 * (this.weaponRoll('oh') + w.speed * this.st.ap / 14);
    const outcome = this.rollWhite('oh', penalty);
    this.resolve('Auto Attack (OH)', 'oh', 'white', base, outcome);
  }

  castHeroicStrike() {
    const w = this.weapons.mh;
    this.spendRage(this.hsCost);
    this.metrics.hsCast++;
    this.bump('hs');
    const base = 157 + this.weaponRoll('mh') + w.speed * this.st.ap / 14;
    const outcome = this.rollSpecial('mh');
    const r = this.resolve('Heroic Strike', 'mh', 'special', base, outcome);
    if (!r.landed) this.gainRage(this.hsCost * 0.8);
  }

  // Stop-casting macro: drops a queued Heroic Strike without spending rage.
  cancelHeroicStrike() {
    if (!this.hsQueued) return false;
    this.hsQueued = false;
    this.metrics.hsUnqueued = (this.metrics.hsUnqueued || 0) + 1;
    this.ev('note', { text: 'Heroic Strike cancelled' });
    return true;
  }

  bump(id) {
    this.casts[id] = (this.casts[id] || 0) + 1;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Casting (player or bot input)
  // ---------------------------------------------------------------------------------------------------------
  status(id) {
    const a = this.abilityInfo(id);
    if (!a) return { ready: false, reason: 'unknown' };
    const cdKey = a.cdKey || id;
    const cdLeft = Math.max(0, (this.cdReady[cdKey] || 0) - this.t);
    const gcdLeft = a.gcd ? Math.max(0, this.gcdEnd - this.t) : 0;
    const cost = this.cost(id);
    let reason = null;
    if (this.dead) reason = 'dead';
    else if (cdLeft > 0) reason = 'cd';
    else if (gcdLeft > 0) reason = 'gcd';
    else if (!(a.stance & this.stance)) reason = 'stance';
    else if (id === 'op' && this.t >= this.opUntil) reason = 'notready';
    else if (id === 'exec' && !this.isExecute()) reason = 'notready';
    else if (id === 'bf' && !this.cfg.isOrc) reason = 'unavailable';
    else if (id === 'reck' && false) reason = 'unavailable';
    else if (a.trinket && this.t < (this.cdReady.trinketShared || 0)) reason = 'cd';
    else if (id === 'hs' && this.hsQueued) reason = 'already';
    else if (this.rage < cost) reason = 'rage';
    return { ready: reason === null, reason, cdLeft: Math.max(cdLeft, a.trinket ? Math.max(0, (this.cdReady.trinketShared || 0) - this.t) : 0), gcdLeft, cost, info: a };
  }

  // opts.autoStance: like a /cast Stance + /cast Ability macro. If the ability needs another stance, swap first
  // (rage above the Tactical Mastery limit is lost, same as in game), then cast.
  cast(id, opts = {}) {
    let s = this.status(id);
    if (!s.ready && s.reason === 'stance' && opts.autoStance) {
      const need = s.info.stance;
      const target = need & STANCE.BATTLE ? 'stBattle' : 'stBerserker';
      const sw = this.status(target);
      if (!sw.ready) return { ok: false, reason: sw.reason === 'cd' ? 'cd' : sw.reason };
      this.cast(target);
      s = this.status(id);
    }
    if (!s.ready) return { ok: false, reason: s.reason };
    const a = s.info;
    const t = this.t;
    const cdKey = a.cdKey || id;
    if (a.gcd) this.gcdEnd = t + GCD;
    if (a.cd) this.cdReady[cdKey] = t + a.cd;
    if (id !== 'hs' && !a.trinket) this.bump(id);
    if (id !== 'hs') (this.metrics.cdUses[id] = this.metrics.cdUses[id] || []).push(t);

    switch (id) {
      case 'hs':
        this.hsQueued = true;
        this.ev('queue', { name: 'Heroic Strike' });
        return { ok: true };
      case 'bt': {
        this.spendRage(30);
        const outcome = this.rollSpecial('mh');
        const r = this.resolve('Bloodthirst', 'mh', 'special', 0.45 * this.st.ap, outcome);
        if (!r.landed) this.gainRage(24);
        this.ev('cast', { name: 'Bloodthirst', outcome: r.outcome });
        break;
      }
      case 'ww': {
        this.spendRage(25);
        const w = this.weapons.mh;
        const base = this.weaponRoll('mh') + 2.4 * this.st.ap / 14;
        const r = this.resolve('Whirlwind', 'mh', 'special', base, this.rollSpecial('mh'));
        this.ev('cast', { name: 'Whirlwind', outcome: r.outcome });
        break;
      }
      case 'op': {
        this.spendRage(5);
        this.metrics.opUsed++;
        const base = 35 + this.weaponRoll('mh') + 2.4 * this.st.ap / 14;
        const r = this.resolve('Overpower', 'mh', 'special', base, this.rollSpecial('mh', { canDodge: false }));
        this.opUntil = 0;
        if (!r.landed) this.gainRage(4);
        this.ev('cast', { name: 'Overpower', outcome: r.outcome });
        break;
      }
      case 'exec': {
        this.spendRage(this.execCost);
        const extra = this.rage;
        this.rage = 0;
        const base = 600 + 15 * extra;
        const r = this.resolve('Execute', 'mh', 'special', base, this.rollSpecial('mh'));
        if (!r.landed) this.gainRage(this.execCost * 0.8);
        this.ev('cast', { name: 'Execute', outcome: r.outcome });
        break;
      }
      case 'ham': {
        this.spendRage(10);
        const r = this.resolve('Hamstring', 'mh', 'special', 45, this.rollSpecial('mh'));
        if (!r.landed) this.gainRage(8);
        this.ev('cast', { name: 'Hamstring', outcome: r.outcome });
        break;
      }
      case 'sunder':
        this.spendRage(15);
        this.ev('cast', { name: 'Sunder Armor', outcome: 'hit' });
        break;
      case 'dw':
        this.spendRage(10);
        this.setAura('dw', { name: 'Death Wish', icon: 'spell_shadow_deathpact', dur: 30, mod: { dmg: 1.2 }, color: '#d94f4f' });
        this.ev('cast', { name: 'Death Wish', outcome: 'cd' });
        break;
      case 'reck':
        this.setAura('reck', { name: 'Recklessness', icon: 'ability_criticalstrike', dur: 15, mod: {}, color: '#d94f4f' });
        this.ev('cast', { name: 'Recklessness', outcome: 'cd' });
        break;
      case 'br':
        this.gainRage(10 + [0, 2, 5][this.tal.improvedBloodrage || 0]);
        this.setAura('br', { name: 'Bloodrage', icon: 'ability_racial_bloodrage', dur: 10, mod: {}, color: '#b04040' });
        this.schedulePeriodic(1, 10, () => this.gainRage(1));
        this.ev('cast', { name: 'Bloodrage', outcome: 'cd' });
        break;
      case 'bf': {
        const bonus = (160 + 2 * this.st.str) * 0.25;
        this.setAura('bf', { name: 'Blood Fury', icon: 'racial_orc_berserkerstrength', dur: 15, mod: { ap: bonus }, color: '#d98a3d' });
        this.ev('cast', { name: 'Blood Fury', outcome: 'cd' });
        break;
      }
      case 'pot': {
        const p = this.cfg.potion;
        this.gainRage(p.min + this.rng() * (p.max - p.min));
        if (p.str) this.setAura('pot', { name: p.name, icon: 'inv_potion_41', dur: 20, mod: { str: p.str }, color: '#c44' });
        this.ev('cast', { name: p.name, outcome: 'cd' });
        break;
      }
      case 'sap': {
        const roll = 450 + this.rng() * 300;
        if (this.rng() > 0.17) {
          this.addDamage('Goblin Sapper', roll * this.st.dmg);
          this.ev('hit', { name: 'Goblin Sapper', outcome: 'hit', dmg: Math.round(roll * this.st.dmg), white: false });
        }
        this.ev('cast', { name: 'Goblin Sapper', outcome: 'cd' });
        break;
      }
      case 'stBattle': case 'stBerserker': {
        const to = id === 'stBattle' ? STANCE.BATTLE : STANCE.BERSERKER;
        if (this.stance === to) { this.cdReady.stance = 0; return { ok: false, reason: 'already' }; }
        this.stance = to;
        if (this.rage > this.maxKeptRage) this.rage = this.maxKeptRage;
        this.recalc();
        this.ev('cast', { name: a.name, outcome: 'cd' });
        break;
      }
      default:
        if (a.trinket) {
          const tr = a.trinket;
          this.cdReady.trinketShared = t + tr.shared;
          this.setAura(id, { name: tr.name, icon: tr.icon, dur: tr.dur, mod: { ap: tr.stats?.ap, str: tr.stats?.str, speed: tr.haste }, color: '#c9a0ff' });
          this.ev('cast', { name: tr.name, outcome: 'cd' });
          this.bump(id);
        }
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------------------------------------
  step() {
    this.n++;
    this.t = this.n * STEP;
    const t = this.t;

    this.expireAuras();
    if (this.execStartT === null && this.isExecute()) this.execStartT = t;

    if (this.pending.length) {
      for (let guard = 0; guard < 16; guard++) {
        let idx = -1, best = Infinity;
        for (let i = 0; i < this.pending.length; i++) {
          if (this.pending[i].at <= t && this.pending[i].at < best) { best = this.pending[i].at; idx = i; }
        }
        if (idx < 0) break;
        const [p] = this.pending.splice(idx, 1);
        p.fn();
      }
    }

    // OP window bookkeeping
    if (this.opUntil > 0 && t >= this.opUntil) {
      this.metrics.opMissed++;
      this.opUntil = 0;
    }

    if (!this.dead) {
      if (this.mhAt <= t) this.swingMH();
      if (this.dual && this.ohAt <= t) this.swingOH();
    }

    // Rotation metrics
    if (!this.dead) {
      if (this.hsQueued) this.metrics.hsQueuedTime += STEP;
      if (this.hasAura('flurry')) this.metrics.flurryUp += STEP;
      if (this.tal.bloodthirst) this.trackReady('bt', 30, this.metrics.btDelay);
      this.trackReady('ww', 25, this.metrics.wwDelay);
    }

    if (this.record && t - this.lastSample >= 0.1) {
      this.lastSample = t;
      this.samples.push({ t, rage: this.rage, hp: this.hpFrac() });
    }
  }

  trackReady(id, cost, bucket) {
    if (id === 'ww' && !(this.stance & STANCE.BERSERKER)) return;
    if (this.t < (this.cdReady[id] || 0)) return;
    if (id === 'bt' && false) return;
    if (this.rage < cost) bucket.rage += STEP;
    else if (this.t < this.gcdEnd) bucket.gcd += STEP;
    else bucket.late += STEP;
  }

  runUntil(tEnd, onTick) {
    while (this.t < tEnd && !this.dead) {
      this.step();
      if (onTick) onTick(this);
    }
  }
}
