import { checkForUpdate } from './update.js';
import { parseDisplay, parseTier } from './parse.js';
import { getPlayer, listScores, paginate } from './scores.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 0) => Number(x).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

const me = getPlayer();
let entries = [];
let page = 1;

function render() {
  const pg = paginate(entries, page);
  page = pg.page;
  $('boardTable').innerHTML = pg.rows.map((e, i) => {
    const shown = parseDisplay(e.parse);
    const cls = `p-${parseTier(shown).key}`;
    return `<tr${e.id === me.id ? ' class="me"' : ''}><td class="rk">${pg.offset + i + 1}</td><td class="${cls}">${esc(e.name)}</td><td class="${cls} pv">${shown}</td><td class="dv">${fmt(e.dps)} DPS</td></tr>`;
  }).join('') || '<tr><td class="sub">No parses yet for this fight length.</td></tr>';
  $('pageLabel').textContent = `Page ${pg.page} of ${pg.pages} · ${entries.length} parse${entries.length === 1 ? '' : 's'}`;
  $('btnPrev').disabled = pg.page <= 1;
  $('btnNext').disabled = pg.page >= pg.pages;
}

async function load() {
  const length = Number($('lenSel').value);
  $('boardNote').textContent = 'Loading…';
  const res = await listScores(length);
  entries = res.entries;
  page = 1;
  $('boardNote').textContent = res.shared ? 'Shared scoreboard. One entry per pull.'
    : res.offline ? 'Shared scoreboard unreachable; showing scores saved in this browser.'
      : 'Scores are saved in this browser only. One entry per pull.';
  render();
  try { history.replaceState(null, '', `?length=${length}`); } catch { /* ignore */ }
}

const wanted = new URLSearchParams(location.search).get('length');
if (wanted && [...$('lenSel').options].some((o) => o.value === wanted)) $('lenSel').value = wanted;
$('lenSel').addEventListener('change', load);
$('btnPrev').addEventListener('click', () => { page--; render(); });
$('btnNext').addEventListener('click', () => { page++; render(); });
load();

checkForUpdate();
