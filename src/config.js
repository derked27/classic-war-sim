// Turns a WoWSims JSON export + the trimmed item database into the plain config object the combat engine uses.
// Pure functions only (works in the browser and in Node tests).

// Stat indices used by the WoWSims database (see wowsims/classic proto Stat).
export const STAT = {
  STR: 0, AGI: 1, STA: 2, INT: 3, SPI: 4,
  AP: 17, HIT: 18, CRIT: 19, HASTE: 20, ARMOR: 26, RAP: 27,
};

const ARMS = ['improvedHeroicStrike', 'deflection', 'improvedRend', 'improvedCharge', 'tacticalMastery',
  'improvedThunderClap', 'improvedOverpower', 'angerManagement', 'deepWounds', 'twoHandedWeaponSpecialization',
  'impale', 'axeSpecialization', 'sweepingStrikes', 'maceSpecialization', 'swordSpecialization',
  'polearmSpecialization', 'improvedHamstring', 'mortalStrike'];
const FURY = ['boomingVoice', 'cruelty', 'improvedDemoralizingShout', 'unbridledWrath', 'improvedCleave',
  'piercingHowl', 'bloodCraze', 'improvedBattleShout', 'dualWieldSpecialization', 'improvedExecute', 'enrage',
  'improvedSlam', 'deathWish', 'improvedIntercept', 'improvedBerserkerRage', 'flurry', 'bloodthirst'];
const PROT = ['shieldSpecialization', 'anticipation', 'improvedBloodrage', 'toughness', 'ironWill', 'lastStand',
  'improvedShieldBlock', 'improvedRevenge', 'defiance', 'improvedSunderArmor', 'improvedDisarm', 'improvedTaunt',
  'improvedShieldWall', 'concussionBlow', 'improvedShieldBash', 'oneHandedWeaponSpecialization', 'shieldSlam'];

export function parseTalents(str) {
  const trees = (str || '').split('-');
  const out = {};
  [ARMS, FURY, PROT].forEach((names, t) => {
    const digits = trees[t] || '';
    names.forEach((name, i) => { out[name] = Number(digits[i] || 0); });
  });
  return out;
}

// Weapon type / hand ids from the database (WeaponType and HandType enums).
const WT_AXE = 1, WT_DAGGER = 2, WT_FIST = 3, WT_MACE = 4, WT_SWORD = 9, HAND_TWO = 4;

// Index into an item's weapon-skill array (`sk`) for the skill that governs a weapon.
function weaponSkillIndex(w) {
  if (!w) return -1;
  const two = w.hand === HAND_TWO;
  switch (w.type) {
    case WT_AXE: return two ? 6 : 1;
    case WT_SWORD: return two ? 7 : 2;
    case WT_MACE: return two ? 8 : 3;
    case WT_DAGGER: return 4;
    case WT_FIST: return 5;
    default: return -1;
  }
}

// Item effects the engine knows how to model. Anything else is "stats only" and gets a warning.
export const ITEM_EFFECTS = {
  22954: { use: { key: 'kiss', name: 'Kiss of the Spider', cd: 120, dur: 15, haste: 1.2, shared: 15 } },
  20130: { use: { key: 'flask', name: 'Diamond Flask', cd: 360, dur: 60, stats: { str: 75 }, shared: 60 } },
  21180: { use: { key: 'earthstrike', name: 'Earthstrike', cd: 120, dur: 20, stats: { ap: 280 }, shared: 20 } },
  23041: { use: { key: 'crest', name: "Slayer's Crest", cd: 120, dur: 20, stats: { ap: 260 }, shared: 20 } },
  23206: { passive: 'markOfTheChampion' },
};

// Enchants that carry a proc rather than (or as well as) stats.
const PROC_ENCHANTS = { 1900: 'crusader' };

const tri = (v) => (v === 'TristateEffectImproved' ? 2 : v === 'TristateEffectRegular' ? 1 : 0);

// Returns a copy of a WoWSims export with its gear swapped for a default set; everything else is kept.
export function applyGearSet(json, set) {
  const out = JSON.parse(JSON.stringify(json));
  out.player.equipment = { ...out.player.equipment, items: JSON.parse(JSON.stringify(set.items)) };
  return out;
}

// Every parse runs with the same buffs, consumes, debuffs and target, whatever the imported profile had set, so
// scores are comparable. Only the character itself (race, gear, enchants, talents, rotation) comes from the import.
const STANDARD = {
  raidBuffs: {
    giftOfTheWild: 'TristateEffectImproved', strengthOfEarthTotem: 'TristateEffectImproved',
    graceOfAirTotem: 'TristateEffectImproved', battleShout: 'TristateEffectImproved',
    trueshotAura: true, leaderOfThePack: true,
  },
  debuffs: {
    faerieFire: true, improvedScorch: true, exposeArmor: 'TristateEffectImproved', sunderArmor: true,
    curseOfRecklessness: true, giftOfArthas: true,
  },
  buffs: {
    rallyingCryOfTheDragonslayer: true, saygesFortune: 'SaygesDamage', spiritOfZandalar: true,
    songflowerSerenade: true, warchiefsBlessing: true, fengusFerocity: true, moldarsMoxie: true,
  },
  consumes: {
    food: 'FoodSmokedDesertDumpling', agilityElixir: 'ElixirOfTheMongoose', strengthBuff: 'JujuPower',
    attackPowerBuff: 'JujuMight', mainHandImbue: 'Windfury', offHandImbue: 'ElementalSharpeningStone',
    defaultPotion: 'MightyRagePotion', sapperExplosive: 'SapperGoblinSapper', hitConsumable: 'DarkDesire',
  },
  encounter: {
    duration: 120, durationVariation: 15, executeProportion20: 0.2, executeProportion25: 0.25, executeProportion35: 0.35,
    targets: [{
      id: 213336, name: 'Level 60', level: 63, mobType: 'MobTypeUndead',
      stats: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,805,0,0,0,0,0,0,0,0,3731,0,0,0,0,0,0,0,127393,0,0,0,0,0,0,0,0,0],
      minBaseDamage: 3000, damageSpread: 0.3333, swingSpeed: 2, parryHaste: true,
    }],
  },
};

export function buildConfig(importedJson, gd) {
  const warnings = [];
  const json = { ...importedJson, raidBuffs: STANDARD.raidBuffs, debuffs: STANDARD.debuffs, encounter: STANDARD.encounter };
  const p = importedJson.player && {
    ...importedJson.player, buffs: STANDARD.buffs, consumes: STANDARD.consumes, profession1: 'Engineering',
  };
  json.player = p;
  if (!p || p.class !== 'ClassWarrior') warnings.push('This tool only supports warriors; the imported character is not one.');

  const talents = parseTalents(p.talentsString);
  const eq = p.equipment?.items || [];
  const gear = {};
  const add = (idx, v) => { gear[idx] = (gear[idx] || 0) + v; };
  const equipped = [];
  const setCounts = {};
  const skillBonus = {};   // weapon skill from gear, by skill index; applies to every weapon of that type

  eq.forEach((slot, i) => {
    if (!slot || !slot.id) { equipped.push(null); return; }
    const it = gd.items[slot.id];
    if (!it) {
      warnings.push(`Unknown item id ${slot.id} in slot ${i}; its stats are ignored.`);
      equipped.push({ id: slot.id, name: `Item ${slot.id}`, unknown: true });
      return;
    }
    for (const [k, v] of Object.entries(it.s)) add(Number(k), v);
    for (const [k, v] of Object.entries(it.sk || {})) skillBonus[k] = (skillBonus[k] || 0) + v;
    if (it.set) setCounts[it.set] = (setCounts[it.set] || 0) + 1;
    let enchantName = null;
    if (slot.enchant) {
      const en = gd.enchants[slot.enchant];
      if (en) {
        for (const [k, v] of Object.entries(en.s)) add(Number(k), v);
        enchantName = en.n;
        if (!Object.keys(en.s).length && !PROC_ENCHANTS[slot.enchant]) {
          warnings.push(`Enchant "${en.n}" has no modeled effect.`);
        }
      } else {
        warnings.push(`Unknown enchant id ${slot.enchant}; ignored.`);
      }
    }
    equipped.push({ id: slot.id, name: it.n, icon: it.i, slot: i, enchant: slot.enchant || 0, enchantName });
    const fx = ITEM_EFFECTS[slot.id];
    if (!fx && i >= 12 && i <= 13) warnings.push(`Trinket "${it.n}" is modeled as stats only (no use/proc effect).`);
  });

  // Weapons: slot 14 = main hand, 15 = off hand.
  const weapon = (slot) => {
    const e = equipped[slot];
    if (!e || e.unknown) return null;
    const it = gd.items[e.id];
    if (!it.sp) return null;
    return {
      id: e.id, name: it.n, icon: it.i, speed: it.sp, min: it.mn, max: it.mx,
      type: it.wt, hand: it.ht, enchant: e.enchant,
    };
  };
  const mh = weapon(14);
  const oh = weapon(15);
  if (!mh) warnings.push('No main-hand weapon found; using fists.');

  const race = p.race;
  const isOrc = race === 'RaceOrc';
  const raceOff = {
    RaceOrc: { str: 3, agi: -3, sta: 2 }, RaceHuman: { str: 0, agi: 0, sta: 0 },
    RaceDwarf: { str: 2, agi: -4, sta: 3 }, RaceNightElf: { str: -3, agi: 5, sta: -1 },
    RaceUndead: { str: -1, agi: -2, sta: 1 }, RaceTauren: { str: 5, agi: -5, sta: 2 },
    RaceGnome: { str: -5, agi: 3, sta: 0 }, RaceTroll: { str: 1, agi: 2, sta: 0 },
  }[race] || { str: 0, agi: 0, sta: 0 };

  // Additive flat stats from buffs/consumes; crit/hit in percent.
  const flat = { str: 0, agi: 0, ap: 0, crit: 0, hit: 0 };
  const mult = { stats: 1, damage: 1, speed: 1 };
  const buffList = [];
  const note = (name, desc) => buffList.push({ name, desc });

  const rb = json.raidBuffs || {};
  const gotw = tri(rb.giftOfTheWild);
  if (gotw) {
    const v = gotw === 2 ? Math.floor(12 * 1.35) : 12;
    flat.str += v; flat.agi += v; note('Gift of the Wild', `+${v} all stats`);
  }
  const soe = tri(rb.strengthOfEarthTotem);
  if (soe) {
    const v = Math.floor(77 * (soe === 2 ? 1.15 : 1));
    flat.str += v; note('Strength of Earth', `+${v} Str`);
  }
  const goa = tri(rb.graceOfAirTotem);
  if (goa) {
    const v = Math.floor(77 * (goa === 2 ? 1.15 : 1));
    flat.agi += v; note('Grace of Air', `+${v} Agi`);
  }
  if (rb.trueshotAura) { flat.ap += 100; note('Trueshot Aura', '+100 AP'); }
  const bs = tri(rb.battleShout);
  let battleShoutPermanent = false;
  if (bs) {
    const v = Math.floor(232 * (1 + 0.05 * (bs === 2 ? talents.improvedBattleShout : 0)));
    flat.ap += v; battleShoutPermanent = true; note('Battle Shout', `+${v} AP`);
  }
  if (rb.leaderOfThePack) { flat.crit += 3; note('Leader of the Pack', '+3% crit'); }

  const b = p.buffs || {};
  if (b.rallyingCryOfTheDragonslayer) { flat.crit += 5; flat.ap += 140; note('Rallying Cry', '+5% crit, +140 AP'); }
  if (b.songflowerSerenade) { flat.str += 15; flat.agi += 15; flat.crit += 5; note('Songflower', '+15 Str/Agi, +5% crit'); }
  if (b.fengusFerocity) { flat.ap += 200; note("Fengus' Ferocity", '+200 AP'); }
  if (b.spiritOfZandalar) { mult.stats *= 1.15; note('Spirit of Zandalar', '+15% stats'); }
  if (b.warchiefsBlessing) { mult.speed *= 1.15; note("Warchief's Blessing", '+15% melee haste'); }
  if (b.saygesFortune === 'SaygesDamage') { mult.damage *= 1.1; note("Sayge's Fortune", '+10% damage'); }
  else if (b.saygesFortune === 'SaygesAgility') { flat.agi += Math.floor((80 + raceOff.agi) * 0.1); }

  const c = p.consumes || {};
  if (c.food === 'FoodSmokedDesertDumpling') { flat.str += 20; note('Smoked Desert Dumpling', '+20 Str'); }
  else if (c.food === 'FoodGrilledSquid') { flat.agi += 10; }
  if (c.agilityElixir === 'ElixirOfTheMongoose') { flat.agi += 25; flat.crit += 2; note('Elixir of the Mongoose', '+25 Agi, +2% crit'); }
  else if (c.agilityElixir === 'ElixirOfGreaterAgility') { flat.agi += 25; }
  if (c.strengthBuff === 'JujuPower') { flat.str += 30; note('Juju Power', '+30 Str'); }
  else if (c.strengthBuff === 'ElixirOfGiants') { flat.str += 25; }
  if (c.attackPowerBuff === 'JujuMight') { flat.ap += 40; note('Juju Might', '+40 AP'); }
  if (c.offHandImbue === 'ElementalSharpeningStone' || c.mainHandImbue === 'ElementalSharpeningStone') {
    flat.crit += 2; note('Elemental Sharpening Stone', '+2% crit');
  }
  if (c.hitConsumable === 'DarkDesire' || c.hitConsumable === 'FireToastedBun') {
    flat.hit += 2; note(c.hitConsumable === 'DarkDesire' ? 'Dark Desire' : 'Fire-toasted Bun', '+2% hit');
  }
  const windfury = c.mainHandImbue === 'Windfury';
  if (windfury) note('Windfury Totem', '20% chance on MH hit for an extra attack');

  const potion = { MightyRagePotion: { name: 'Mighty Rage Potion', min: 45, max: 75, str: 60 },
    GreatRagePotion: { name: 'Great Rage Potion', min: 30, max: 60, str: 0 },
    RagePotion: { name: 'Rage Potion', min: 20, max: 40, str: 0 } }[c.defaultPotion] || null;
  const engineering = [p.profession1, p.profession2].includes('Engineering');
  const sapper = c.sapperExplosive === 'SapperGoblinSapper' && engineering;

  // Static talent contributions
  flat.crit += talents.cruelty;
  const axeSpec = talents.axeSpecialization;

  // Debuffs
  const d = json.debuffs || {};
  const tgt = json.encounter?.targets?.[0] || {};
  const bossLevel = tgt.level || 63;
  const baseArmor = tgt.stats?.[STAT.ARMOR] ?? 3731;
  const mobType = tgt.mobType || 'MobTypeUndead';
  const eaMult = [1, 1.25, 1.5][tri(d.exposeArmor) === 2 ? 2 : 0];
  const major = Math.max(d.exposeArmor ? 1700 * eaMult : 0, d.sunderArmor ? 450 * 5 : 0);
  let armor = baseArmor - major;
  if (d.curseOfRecklessness) armor -= 640;
  if (d.faerieFire) armor -= 505;
  armor = Math.max(0, armor);

  // Item passives
  let apVsBoss = 0;
  const trinkets = [];
  for (const slot of [12, 13]) {
    const e = equipped[slot];
    if (!e || e.unknown) continue;
    const fx = ITEM_EFFECTS[e.id];
    if (fx?.passive === 'markOfTheChampion' && /Undead|Demon/.test(mobType)) { apVsBoss += 150; }
    if (fx?.use) trinkets.push({ id: e.id, icon: e.icon, ...fx.use });
  }

  const skillFor = (w) => 300 + (isOrc && w && w.type === WT_AXE ? 5 : 0) + (skillBonus[weaponSkillIndex(w)] || 0);

  const cfg = {
    level: 60,
    race, isOrc,
    talents,
    gear: {
      str: gear[STAT.STR] || 0, agi: gear[STAT.AGI] || 0, ap: gear[STAT.AP] || 0,
      hit: gear[STAT.HIT] || 0, crit: gear[STAT.CRIT] || 0,
    },
    raceOff,
    flat, mult,
    apFromBoss: apVsBoss,
    mh, oh,
    skillMH: skillFor(mh), skillOH: skillFor(oh),
    axeSpec,
    windfury,
    crusaderMH: !!mh && mh.enchant === 1900,
    crusaderOH: !!oh && oh.enchant === 1900,
    trinkets,
    potion, sapper, engineering,
    battleShoutPermanent,
    boss: { level: bossLevel, armor, baseArmor, mobType, name: tgt.name || 'Target Dummy' },
    armorCor: !!d.curseOfRecklessness, armorFf: !!d.faerieFire,
    debuffs: { giftOfArthas: !!d.giftOfArthas, sunder: !!d.sunderArmor, expose: !!d.exposeArmor },
    encounter: {
      duration: json.encounter?.duration || 120,
      variation: json.encounter?.durationVariation || 0,
      execute20: json.encounter?.executeProportion20 ?? 0.2,
    },
    rotation: p.rotation?.priorityList || [],
    startStance: p.warrior?.options?.stance === 'WarriorStanceBattle' ? 'battle' : 'berserker',
    equipped, setCounts, buffList,
    name: p.name || 'Player',
  };

  return { cfg, warnings };
}

// Static character-sheet values (no temporary auras) for display and sanity-checking against the in-game sheet.
export function sheetStats(cfg) {
  const strBase = 120 + cfg.raceOff.str;
  const agiBase = 80 + cfg.raceOff.agi;
  const str = (strBase + cfg.gear.str + cfg.flat.str) * cfg.mult.stats;
  const agi = (agiBase + cfg.gear.agi + cfg.flat.agi) * cfg.mult.stats;
  const ap = 160 + 2 * str + cfg.gear.ap + cfg.flat.ap + cfg.apFromBoss;
  const crit = agi * 0.05 + cfg.gear.crit + cfg.flat.crit + 3; // +3 berserker stance
  const hit = cfg.gear.hit + cfg.flat.hit;
  return { str, agi, ap, crit, hit };
}
