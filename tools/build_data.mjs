// Builds src/data/gamedata.json from the WoWSims classic item database.
//   node tools/build_data.mjs            (downloads raw/db.json if missing)
// Keeps only the fields the practice sim needs, stats stored sparsely as {statIndex: value}.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawPath = join(root, 'raw', 'db.json');
const outPath = join(root, 'src', 'data', 'gamedata.json');
const DB_URL = 'https://raw.githubusercontent.com/wowsims/classic/master/assets/database/db.json';

if (!existsSync(rawPath)) {
  mkdirSync(dirname(rawPath), { recursive: true });
  console.log('Downloading', DB_URL);
  const res = await fetch(DB_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(rawPath, Buffer.from(await res.arrayBuffer()));
}

const db = JSON.parse(readFileSync(rawPath, 'utf8'));

const sparse = (arr) => {
  const o = {};
  arr.forEach((v, i) => { if (v) o[i] = v; });
  return o;
};

const items = {};
for (const it of db.items) {
  const o = { n: it.name, i: it.icon, t: it.type, s: sparse(it.stats) };
  if (it.weaponSpeed) {
    o.sp = it.weaponSpeed;
    o.mn = it.weaponDamageMin;
    o.mx = it.weaponDamageMax;
    o.wt = it.weaponType;
    o.ht = it.handType;
  }
  if (it.weaponSkills && it.weaponSkills.some(Boolean)) o.sk = sparse(it.weaponSkills);
  if (it.setName) o.set = it.setName;
  items[it.id] = o;
}

const enchants = {};
for (const e of db.enchants) {
  enchants[e.effectId] = { n: e.name, s: sparse(e.stats), t: e.type };
}

const spells = {};
for (const s of db.spellIcons) spells[s.id] = s.icon;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ items, enchants, spells }));
console.log(`wrote ${outPath}: ${Object.keys(items).length} items, ${Object.keys(enchants).length} enchants`);
