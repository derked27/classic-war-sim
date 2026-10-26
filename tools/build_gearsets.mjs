// Builds src/data/gearsets.json from the WoWSims classic warrior gear presets (Pre-BiS, P1-P6).
//   node tools/build_gearsets.mjs
// Each set is {key, label, items:[{id, enchant?}]} in the same slot order as player.equipment.items.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'src', 'data', 'gearsets.json');
const BASE = 'https://raw.githubusercontent.com/wowsims/classic/master/ui/warrior/gear_sets/';
const SETS = [
  { key: 'p0', label: 'Pre-BiS', file: 'p0.bis.gear.json' },
  { key: 'p1', label: 'P1', file: 'phase_1.gear.json' },
  { key: 'p6', label: 'P6', file: 'phase_6.gear.json' },
];

const gd = JSON.parse(readFileSync(join(root, 'src', 'data', 'gamedata.json'), 'utf8'));

const out = [];
for (const { key, label, file } of SETS) {
  const res = await fetch(BASE + file);
  if (!res.ok) throw new Error(`download failed for ${file}: ${res.status}`);
  const { items } = await res.json();
  for (const slot of items) {
    if (slot.id && !gd.items[slot.id]) console.warn(`${label}: item ${slot.id} missing from gamedata.json`);
    if (slot.enchant && !gd.enchants[slot.enchant]) console.warn(`${label}: enchant ${slot.enchant} missing from gamedata.json`);
  }
  out.push({ key, label, items });
}

writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath}: ${out.map((s) => `${s.label}(${s.items.length})`).join(' ')}`);
