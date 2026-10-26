// Customizable keybinds. A binding is a combo string: optional modifiers + a KeyboardEvent.code or mouse button,
// e.g. "Digit1", "Shift+KeyQ", "Ctrl+Alt+F3", "Mouse4", "WheelUp". Stored in localStorage.

export const BIND_ACTIONS = [
  { id: 'bt', label: 'Bloodthirst' },
  { id: 'ww', label: 'Whirlwind' },
  { id: 'hs', label: 'Heroic Strike (queue)' },
  { id: 'hsCancel', label: 'Cancel queued Heroic Strike (Esc always does)' },
  { id: 'op', label: 'Overpower' },
  { id: 'exec', label: 'Execute' },
  { id: 'ham', label: 'Hamstring' },
  { id: 'dw', label: 'Death Wish' },
  { id: 'reck', label: 'Recklessness' },
  { id: 'bf', label: 'Blood Fury' },
  { id: 'br', label: 'Bloodrage' },
  { id: 'pot', label: 'Rage Potion' },
  { id: 'sap', label: 'Goblin Sapper' },
  { id: 'trinket1', label: 'Trinket 1 (on-use)' },
  { id: 'trinket2', label: 'Trinket 2 (on-use)' },
  { id: 'stBattle', label: 'Battle Stance' },
  { id: 'stBerserker', label: 'Berserker Stance' },
  { id: 'pull', label: 'Pull / Restart' },
  { id: 'pause', label: 'Pause' },
];

export const DEFAULT_BINDS = {
  bt: 'Digit1', ww: 'Digit2', hs: 'Digit3', hsCancel: 'KeyF', op: 'Digit4', exec: 'Digit5', ham: 'Digit6',
  dw: 'KeyZ', reck: 'KeyX', bf: 'KeyC', br: 'KeyV', pot: 'KeyG', sap: 'KeyB',
  trinket1: 'F1', trinket2: 'F2', stBattle: 'KeyQ', stBerserker: 'KeyE',
  pull: 'Space', pause: 'KeyP',
};

const STORE_KEY = 'cws.binds.v1';
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

export function isModifierCode(code) {
  return MODIFIER_CODES.has(code);
}

function withMods(e, base) {
  const m = [];
  if (e.ctrlKey) m.push('Ctrl');
  if (e.altKey) m.push('Alt');
  if (e.shiftKey) m.push('Shift');
  if (e.metaKey) m.push('Meta');
  return [...m, base].join('+');
}

export function comboFromKeyEvent(e) {
  if (isModifierCode(e.code)) return null;
  return withMods(e, e.code);
}

export function comboFromMouseEvent(e) {
  // 0 left, 1 middle, 2 right: reserved for the page. 3 / 4 are the side buttons.
  if (e.button < 3) return e.button === 1 ? withMods(e, 'Mouse3') : null;
  return withMods(e, 'Mouse' + (e.button + 1));
}

export function comboFromWheelEvent(e) {
  if (!e.deltaY) return null;
  return withMods(e, e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
}

const NICE = { WheelUp: 'Wheel ↑', WheelDown: 'Wheel ↓', Space: 'Space', Escape: 'Esc', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Tab: 'Tab', CapsLock: 'Caps',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

export function prettyCombo(combo) {
  if (!combo) return '—';
  return combo.split('+').map((p) => {
    if (NICE[p]) return NICE[p];
    if (/^Key[A-Z]$/.test(p)) return p.slice(3);
    if (/^Digit\d$/.test(p)) return p.slice(5);
    if (/^Numpad/.test(p)) return 'Num' + p.slice(6);
    return p;
  }).join('+');
}

export function loadBinds() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const binds = { ...DEFAULT_BINDS, ...JSON.parse(raw) };
      if (binds.pause === 'Escape') binds.pause = DEFAULT_BINDS.pause;   // Esc used to pause; it no longer does
      return binds;
    }
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_BINDS };
}

export function saveBinds(binds) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(binds)); } catch { /* ignore */ }
}

// Abilities that trigger the global cooldown. A key may be shared by at most one of these plus any number of
// off-GCD actions (trinkets, potion, Bloodrage, Heroic Strike queue...), like a WoW macro.
export const GCD_ACTIONS = new Set(['bt', 'ww', 'op', 'exec', 'ham', 'dw', 'reck', 'bf']);
const EXCLUSIVE = new Set(['pull', 'pause']);

// Returns an action that cannot share `combo` with `id`, or null when sharing is fine.
export function findConflict(binds, combo, id) {
  return Object.keys(binds).find((other) => {
    if (other === id || binds[other] !== combo) return false;
    if (EXCLUSIVE.has(id) || EXCLUSIVE.has(other)) return true;
    return GCD_ACTIONS.has(id) && GCD_ACTIONS.has(other);
  }) || null;
}

// combo -> actions bound to it, off-GCD actions first so a rage potion or Bloodrage lands before the GCD ability.
export function reverseMap(binds) {
  const m = new Map();
  for (const [id, combo] of Object.entries(binds)) {
    if (!combo) continue;
    if (!m.has(combo)) m.set(combo, []);
    m.get(combo).push(id);
  }
  for (const list of m.values()) list.sort((a, b) => Number(GCD_ACTIONS.has(a)) - Number(GCD_ACTIONS.has(b)));
  return m;
}
