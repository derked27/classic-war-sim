// Downloads the Classic WoW ability sounds from Wowhead Classic's sound CDN into sounds/, plus sounds/manifest.json.
// Usage: node tools/build_sounds.mjs   (re-runnable; add --force to re-download)
import { mkdirSync, existsSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds');
const FORCE = process.argv.includes('--force');

// action key -> { spell: Classic spell whose Wowhead page lists the sounds it plays (or search: a sound name), layers: [[file names]] }.
// Every layer plays together; within a layer one file is picked at random (the game rotates its grunts the same way).
const WARRIOR_GRUNTS = ['SwingWeaponSpecialWarriorA', 'SwingWeaponSpecialWarriorB', 'SwingWeaponSpecialWarriorC', 'SwingWeaponSpecialWarriorD', 'SwingWeaponSpecialWarriorE'];
const SOUNDS = {
  bt: { spell: 23881, layers: [WARRIOR_GRUNTS, ['RendTarget']] },
  ww: { spell: 1680, layers: [['WhirlwindShort']] },
  hs: { spell: 78, layers: [WARRIOR_GRUNTS, ['DecisiveStrike']] },
  op: { spell: 7384, layers: [WARRIOR_GRUNTS, ['DecisiveStrike']] },
  exec: { spell: 5308, layers: [WARRIOR_GRUNTS, ['RendTarget']] },
  ham: { spell: 1715, layers: [WARRIOR_GRUNTS, ['RendTarget']] },
  dw: { spell: 12292, layers: [['InnerFireA', 'InnerFireB', 'InnerFireC']] },
  reck: { spell: 1719, layers: [['RecklessnessTarget']] },
  br: { spell: 18499, layers: [['Cower']] },
  bf: { spell: 23234, layers: [['Cower']] },
  pot: { spell: 17528, layers: [['iDrinking1']] },
  sap: { spell: 13241, layers: [['FireCast']] },
  stBattle: { spell: 2457, layers: [['BattleShoutTarget']] },
  stBerserker: { spell: 2458, layers: [['BattleShoutTarget']] },
  item: { spell: 21180, layers: [['BurningSpirit']] },
  // White swings: 1H sword vs plate hit sounds and the 1H miss whoosh, found by sound name rather than spell.
  swingHit: { search: 'Sword1H_ArmorPlate', layers: [['m1hSwordHitPlate1a', 'm1hSwordHitPlate1b', 'm1hSwordHitPlate1c']] },
  swingCrit: { search: 'Sword1H_ArmorPlate', layers: [['m1hSwordHitPlateCrit']] },
  swingMiss: { search: 'Combat%20Miss', layers: [['MissWhoosh1Handed']] },
};

const UA = { 'User-Agent': 'Mozilla/5.0' };
mkdirSync(OUT, { recursive: true });
if (FORCE) for (const f of readdirSync(OUT)) if (f.endsWith('.ogg')) unlinkSync(join(OUT, f));

const urls = {};
const pages = new Set(Object.values(SOUNDS).map((s) => (s.spell ? `spell=${s.spell}` : `sounds/name:${s.search}`)));
for (const page of pages) {
  const html = await (await fetch(`https://www.wowhead.com/classic/${page}`, { headers: UA })).text();
  for (const m of html.matchAll(/https:\\?\/\\?\/wow\.zamimg\.com\\?\/sound-ids\\?\/classic[^"']+?\/([^\/"'\\]+)\.ogg/g)) {
    urls[m[1]] ??= m[0].replace(/\\\//g, '/');
  }
}

const manifest = {};
for (const [key, { layers }] of Object.entries(SOUNDS)) {
  manifest[key] = layers;
  for (const name of layers.flat()) {
    const file = join(OUT, name + '.ogg');
    if (existsSync(file)) continue;
    if (!urls[name]) { console.error('NO URL for', name); continue; }
    const res = await fetch(urls[name], { headers: UA });
    if (!res.ok) { console.error('FAIL', name, res.status); continue; }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('got', name, urls[name]);
  }
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
