// Player identity and the scoreboard. One entry per player (UUID) per fight length, keeping the best DPS.
// Entries live in localStorage; when SCORE_CONFIG.firebaseUrl is set they are also shared through Firebase's REST API.
import { SCORE_CONFIG } from './scoreconfig.js';
import { percentile } from './parse.js';

const PLAYER_KEY = 'cws.player.v1';
const SCORES_KEY = 'cws.scores.v1';
export const PAGE_SIZE = 100;

const uuid = () => (globalThis.crypto && crypto.randomUUID
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

export function getPlayer(storage = defaultStorage()) {
  try {
    const p = JSON.parse(storage.getItem(PLAYER_KEY));
    if (p && p.id) return { id: p.id, name: p.name || '' };
  } catch { /* ignore */ }
  const p = { id: uuid(), name: '' };
  savePlayer(p, storage);
  return p;
}

function savePlayer(p, storage = defaultStorage()) {
  try { storage.setItem(PLAYER_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function setPlayerName(name, storage = defaultStorage()) {
  const p = getPlayer(storage);
  p.name = String(name).trim().slice(0, 20);
  savePlayer(p, storage);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Local store: { "<id>:<length>": entry }
// ---------------------------------------------------------------------------------------------------------------
function loadLocal(storage) {
  try { return JSON.parse(storage.getItem(SCORES_KEY)) || {}; } catch { return {}; }
}

const better = (a, b) => a.dps > b.dps;

// Merge a pull into an entries map. Returns the entry now stored for that player and length.
export function mergeEntry(map, entry) {
  const key = `${entry.id}:${entry.length}`;
  const cur = map[key];
  if (!cur) map[key] = { ...entry };
  else if (better(entry, cur)) map[key] = { ...entry };
  else map[key] = { ...cur, name: entry.name };   // a rename always applies
  return map[key];
}

// Best DPS first (earlier score wins a tie), with each entry's parse set from where it landed on the board.
export function sortEntries(list) {
  const sorted = list.slice().sort((a, b) => (b.dps - a.dps) || (a.ts - b.ts));
  return sorted.map((e, i) => ({ ...e, parse: percentile(i + 1, sorted.length) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Firebase Realtime Database (REST, no SDK): /scores/<length>/<id>.json
// ---------------------------------------------------------------------------------------------------------------
const remoteUrl = () => (SCORE_CONFIG.firebaseUrl || '').replace(/\/+$/, '');
export const isShared = () => !!remoteUrl();

async function remoteList(length) {
  const res = await fetch(`${remoteUrl()}/scores/${length}.json`);
  if (!res.ok) throw new Error(`scoreboard HTTP ${res.status}`);
  return Object.values((await res.json()) || {});
}

async function remoteSubmit(entry) {
  const url = `${remoteUrl()}/scores/${entry.length}/${entry.id}.json`;
  const cur = await (await fetch(url)).json();
  const next = !cur || better(entry, cur) ? entry : { ...cur, name: entry.name };
  const res = await fetch(url, { method: 'PUT', body: JSON.stringify(next) });
  if (!res.ok) throw new Error(`scoreboard HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------
// Save a pull. Resolves with { best, improved, shared } where `shared` is false if the remote board was unreachable.
// Pass { shared: false } (tests do) to stay off the shared board even when a Firebase URL is configured.
export async function submitScore(entry, storage = defaultStorage(), { shared: useShared = isShared() } = {}) {
  const map = loadLocal(storage);
  const prev = map[`${entry.id}:${entry.length}`];
  const best = mergeEntry(map, entry);
  try { storage.setItem(SCORES_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  let shared = true;
  if (useShared) {
    try { await remoteSubmit(best); } catch { shared = false; }
  }
  return { best, improved: !prev || best.ts === entry.ts, shared };
}

// All entries for a fight length, best first. Falls back to local entries if the remote board can't be read.
export async function listScores(length, storage = defaultStorage(), { shared: useShared = isShared() } = {}) {
  const local = Object.values(loadLocal(storage)).filter((e) => e.length === length);
  if (!useShared) return { entries: sortEntries(local), shared: false };
  try {
    const map = {};
    for (const e of [...await remoteList(length), ...local]) mergeEntry(map, e);
    return { entries: sortEntries(Object.values(map)), shared: true };
  } catch {
    return { entries: sortEntries(local), shared: false, offline: true };
  }
}

// The entry just ahead of you (someone who beat you) and just behind you (someone you beat), with 1-based ranks.
export function neighbors(sorted, id) {
  const i = sorted.findIndex((e) => e.id === id);
  if (i < 0) return { rank: 0, above: null, below: null };
  return {
    rank: i + 1,
    above: i > 0 ? { ...sorted[i - 1], rank: i } : null,
    below: i < sorted.length - 1 ? { ...sorted[i + 1], rank: i + 2 } : null,
  };
}

export function paginate(rows, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, offset: (p - 1) * size };
}
