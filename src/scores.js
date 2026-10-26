// Player identity and the scoreboard. One entry per pull.
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
// Local store: { "<id>:<length>:<ts>": entry }
// ---------------------------------------------------------------------------------------------------------------
function loadLocal(storage) {
  try { return JSON.parse(storage.getItem(SCORES_KEY)) || {}; } catch { return {}; }
}

const entryKey = (e) => `${e.id}:${e.length}:${e.ts}`;

// Add a pull to an entries map. Returns the stored entry.
export function mergeEntry(map, entry) {
  return (map[entryKey(entry)] = { ...entry });
}

// Best DPS first (earlier score wins a tie), with each entry's parse set from where it landed on the board.
export function sortEntries(list) {
  const sorted = list.slice().sort((a, b) => (b.dps - a.dps) || (a.ts - b.ts));
  return sorted.map((e, i) => ({ ...e, parse: percentile(i + 1, sorted.length) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Firebase Realtime Database (REST, no SDK): /scores/<length>/<id>-<ts>.json
// ---------------------------------------------------------------------------------------------------------------
const remoteUrl = () => (SCORE_CONFIG.firebaseUrl || '').replace(/\/+$/, '');
export const isShared = () => !!remoteUrl();

async function remoteList(length) {
  const res = await fetch(`${remoteUrl()}/scores/${length}.json`);
  if (!res.ok) throw new Error(`scoreboard HTTP ${res.status}`);
  return Object.values((await res.json()) || {});
}

async function remoteSubmit(entry) {
  const url = `${remoteUrl()}/scores/${entry.length}/${entry.id}-${entry.ts}.json`;
  const res = await fetch(url, { method: 'PUT', body: JSON.stringify(entry) });
  if (!res.ok) throw new Error(`scoreboard HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------
// Save a pull. Resolves with { best, improved, shared } (best: the player's top entry for that length, improved: this pull is it) where `shared` is false if the remote board was unreachable.
// Pass { shared: false } (tests do) to stay off the shared board even when a Firebase URL is configured.
export async function submitScore(entry, storage = defaultStorage(), { shared: useShared = isShared() } = {}) {
  const map = loadLocal(storage);
  const mine = Object.values(map).filter((e) => e.id === entry.id && e.length === entry.length);
  const improved = mine.every((e) => entry.dps > e.dps);
  mergeEntry(map, entry);
  try { storage.setItem(SCORES_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  let shared = true;
  if (useShared) {
    try { await remoteSubmit(entry); } catch { shared = false; }
  }
  const best = improved ? entry : mine.reduce((a, b) => (b.dps > a.dps ? b : a));
  return { best, improved, shared };
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
export function neighbors(sorted, id, ts) {
  const i = sorted.findIndex((e) => e.id === id && (ts === undefined || e.ts === ts));
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
