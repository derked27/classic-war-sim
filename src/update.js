// Reload once when the deployed site is newer than the copy this page loaded, so nobody keeps playing on a stale build.
import { VERSION } from './version.js';

const FILES = ['index.html', 'scoreboard.html', 'style.css', ...[
  'board', 'bot', 'config', 'engine', 'keybinds', 'parse', 'score', 'scoreconfig', 'scores', 'ui', 'update', 'version',
].map((n) => `src/${n}.js`)];
const GUARD_KEY = 'cws.updated.v1';

export async function checkForUpdate() {
  try {
    const res = await fetch(`${new URL('version.js', import.meta.url)}?t=${Date.now()}`, { cache: 'no-store' });
    const latest = ((await res.text()).match(/VERSION\s*=\s*'([^']+)'/) || [])[1];
    if (!latest || latest === VERSION) return;
    if (sessionStorage.getItem(GUARD_KEY) === latest) return;   // already tried once; don't loop if something stays cached
    sessionStorage.setItem(GUARD_KEY, latest);
    // Refresh the HTTP cache entries first, otherwise the reload can hand back the same stale files.
    await Promise.all(FILES.map((f) => fetch(new URL(`../${f}`, import.meta.url), { cache: 'reload' }).catch(() => {})));
    location.reload();
  } catch { /* offline or storage blocked: carry on with the loaded version */ }
}
