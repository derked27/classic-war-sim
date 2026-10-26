// Pull checks that this page is on the deployed build; if not, the player is offered a hard refresh.
import { VERSION } from './version.js';

const FILES = ['index.html', 'scoreboard.html', 'style.css', ...[
  'board', 'bot', 'config', 'engine', 'keybinds', 'parse', 'score', 'scoreconfig', 'scores', 'ui', 'update', 'version',
].map((n) => `src/${n}.js`)];

// True only when the deployed version is known and differs from the loaded one.
export async function isOutdated() {
  try {
    const res = await fetch(`${new URL('version.js', import.meta.url)}?t=${Date.now()}`, { cache: 'no-store' });
    const latest = ((await res.text()).match(/VERSION\s*=\s*'([^']+)'/) || [])[1];
    return !!latest && latest !== VERSION;
  } catch { return false; }   // offline: carry on with the loaded version
}

export async function hardRefresh() {
  // Refresh the HTTP cache entries first, otherwise the reload can hand back the same stale files.
  await Promise.all(FILES.map((f) => fetch(new URL(`../${f}`, import.meta.url), { cache: 'reload' }).catch(() => {})));
  location.reload();
}
