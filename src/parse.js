// Warcraft Logs style parse: where you land on the scoreboard for a fight length, as a 0-100 percentile.
// First place is 100, last place is 0, and a board with a single score is 100.

// rank is 1-based, n is the number of players on the board.
export function percentile(rank, n) {
  if (n <= 1) return 100;
  return ((n - rank) / (n - 1)) * 100;
}

// The integer shown to the player: floored like Warcraft Logs, so 100 is reserved for first place.
export function parseDisplay(p) {
  if (!Number.isFinite(p) || p <= 0) return 0;
  return p >= 100 ? 100 : Math.floor(p);
}

const TIERS = [
  { min: 100, key: 'gold', label: 'Gold' },
  { min: 99, key: 'pink', label: 'Pink' },
  { min: 95, key: 'orange', label: 'Orange' },
  { min: 75, key: 'purple', label: 'Purple' },
  { min: 50, key: 'blue', label: 'Blue' },
  { min: 25, key: 'green', label: 'Green' },
  { min: 0, key: 'gray', label: 'Gray' },
];

// Tier for a displayed (integer) parse.
export function parseTier(display) {
  return TIERS.find((t) => display >= t.min) || TIERS[TIERS.length - 1];
}
