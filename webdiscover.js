// Discover → Web novels: browse Kakuyomu and Narou by mood and genre, with each
// story's difficulty measured against your own jpdb words.

import { search, firstEpisode, addStory, SITES } from './webnovel.js';

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A mood is a group of tags authors put on their stories.
const MOODS = {
  gentle: ['Gentle', ['ほのぼの', '日常', 'スローライフ']],
  funny: ['Funny', ['コメディ', 'ギャグ']],
  moving: ['Moving', ['ヒューマンドラマ', '感動', '切ない']],
  gripping: ['Gripping', ['シリアス', 'サスペンス']],
};
// Each genre, as Kakuyomu and Narou name it.
const GENRES = {
  fantasy: ['Fantasy', ['fantasy', 'action'], [201, 202]],
  scifi: ['Sci-fi', ['sf'], [401, 402, 403, 404]],
  romance: ['Romance', ['love_story', 'romance'], [101, 102]],
  drama: ['Drama', ['drama'], [301, 302]],
  mystery: ['Mystery', ['mystery'], [304]],
  horror: ['Horror', ['horror'], [305]],
  history: ['History', ['history'], [303]],
};
const MAX = 40;   // stories per list

const state = { mood: '', genre: '', length: '', stories: [], loading: false, key: '' };
try { Object.assign(state, JSON.parse(localStorage.getItem('yomu.web') || '{}'), { stories: [], loading: false, key: '' }); } catch {}
const saveState = () => { try { localStorage.setItem('yomu.web', JSON.stringify({ mood: state.mood, genre: state.genre, length: state.length })); } catch {} };

/* ---------- Reading time and difficulty ---------- */

const minutes = (chars) => Math.max(1, Math.round(chars / (Y().speed.cpm || 150)));
function timeLabel(chars) {
  if (!chars) return '';
  const m = minutes(chars);
  return m < 60 ? `${m} min` : m < 600 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m / 60)} h`;
}
const SHORT = 120;   // minutes: anything you can read in an evening or two

// Labels go by the share of words in the first episode you already know on jpdb.
const level = (pct) => (pct >= 90 ? 'Comfortable' : pct >= 80 ? 'A stretch' : 'Hard');

const FIT_KEY = 'yomu.webfit';
const fitId = (s) => s.site + ':' + s.id;
function cachedFit(s) {
  try {
    const f = JSON.parse(localStorage.getItem(FIT_KEY) || '{}')[fitId(s)];
    return f && Date.now() - f.at < 14 * 864e5 ? f : null;   // words you know change, so check again after two weeks
  } catch { return null; }
}
function saveFit(s, f) {
  try {
    const all = JSON.parse(localStorage.getItem(FIT_KEY) || '{}');
    all[fitId(s)] = { ...f, at: Date.now() };
    localStorage.setItem(FIT_KEY, JSON.stringify(all));
  } catch {}
}
const KNOWN = new Set(['known', 'never-forget', 'blacklisted']);
const isKnown = (st) => !!st && (KNOWN.has(st[0]) || ((st[0] === 'redundant' || st[0] === 'locked') && KNOWN.has(st[1])));

const fitting = new Map();
function computeFit(s) {
  const id = fitId(s);
  if (fitting.has(id)) return fitting.get(id);
  const job = (async () => {
    const text = (await firstEpisode(s)).replace(/\s+/g, '').slice(0, 6000);
    const chunks = text.match(/[\s\S]{1,2000}/g) || [];
    let total = 0, known = 0;
    const unknown = new Set();
    const tokens = await Y().parseTexts(chunks);
    for (const list of tokens) for (const tk of list) {
      total++;
      if (isKnown(Y().vocab.get(tk.key)?.state)) known++; else unknown.add(tk.key);
    }
    const f = { pct: total ? Math.round((known / total) * 100) : 0, newWords: unknown.size };
    saveFit(s, f);
    return f;
  })().finally(() => fitting.delete(id));
  fitting.set(id, job);
  return job;
}

/* ---------- The list ---------- */

function chips() {
  const row = (group, items, current) => items.map(([k, label]) => `<button class="chip${current === k ? ' on' : ''}" data-${group}="${k}">${label}</button>`).join('');
  return `<p class="w-lbl">Mood</p><div class="d-chips w-chips">${row('mood', Object.entries(MOODS).map(([k, v]) => [k, v[0]]), state.mood)}</div>
    <p class="w-lbl">Genre</p><div class="d-chips w-chips">${row('genre', Object.entries(GENRES).map(([k, v]) => [k, v[0]]), state.genre)}</div>
    <div class="d-chips w-chips">${row('length', [['short', 'Short reads'], ['long', 'Long series']], state.length)}</div>`;
}

const lengthOk = (s) => !state.length || (state.length === 'short' ? minutes(s.chars) <= SHORT : minutes(s.chars) > SHORT);

function sorted() {
  const list = state.stories.filter(lengthOk);
  if (!Y().settings.key) return list;
  // Easiest first; stories not checked yet keep their place after the checked ones.
  const scored = list.filter(cachedFit).sort((a, b) => cachedFit(b).pct - cachedFit(a).pct);
  return [...scored, ...list.filter((s) => !cachedFit(s))];
}

function row(s) {
  const f = cachedFit(s);
  const meta = [s.genre, timeLabel(s.chars), s.short ? 'Short story' : s.finished ? 'Finished' : 'Ongoing'].filter(Boolean).join(' · ');
  return `<li><button data-s="${esc(fitId(s))}">
    <span class="lt">${esc(s.title)}</span>
    ${s.pitch ? `<span class="wp">${esc(s.pitch)}</span>` : ''}
    <span class="la">${esc(s.author)} · ${SITES[s.site]}</span>
    <span class="lm">${esc(meta)}</span>
    <span class="fit w-fit" ${f ? '' : 'hidden'}><i><b style="width:${f?.pct || 0}%"></b></i><span>${f ? `${f.pct}% · ${level(f.pct)}` : ''}</span></span>
  </button></li>`;
}

function statusLine() {
  if (!Y().settings.key) return 'Add your jpdb key in Settings to see how hard each story is for you.';
  const list = state.stories.filter(lengthOk);
  const left = list.filter((s) => !cachedFit(s)).length;
  if (left) return `Checking how many words you know in each story… ${list.length - left} of ${list.length}`;
  return 'Easiest for you first';
}

export async function render() {
  const root = $('webBody');
  const key = [state.mood, state.genre].join('|');
  if (key !== state.key) return load(key);
  root.innerHTML = chips() + (state.loading
    ? '<p class="hint d-loading">Finding stories…</p>'
    : state.error ? `<p class="hint d-loading">${esc(state.error)}</p>`
    : !sorted().length ? '<p class="hint d-loading">Nothing matches. Try another mood or genre.</p>'
    : `<p class="hint w-status" id="wnStatus">${statusLine()}</p><ul class="d-list w-list">${sorted().map(row).join('')}</ul>`);
  if (!state.loading) queueFits();
}

async function load(key) {
  state.key = key;
  state.loading = true;
  state.error = '';
  render();
  const mood = MOODS[state.mood], genre = GENRES[state.genre];
  try {
    const stories = await search({ tags: mood ? mood[1] : [], kk: genre ? genre[1] : [], nr: genre ? genre[2] : [] });
    if (state.key !== key) return;
    state.stories = stories.filter((s) => s.first !== null).slice(0, MAX);
    if (!stories.length) state.error = 'The stories couldn’t be loaded. Check your connection and try again.';
  } catch (e) {
    if (state.key !== key) return;
    state.stories = [];
    state.error = e.message || 'The stories couldn’t be loaded.';
  }
  state.loading = false;
  render();
}

// Check stories one at a time, in the order shown, then sort them easiest first.
let running = false;
async function queueFits() {
  if (running || !Y().settings.key) return;
  running = true;
  const key = state.key;
  let changed = false;
  for (const s of state.stories.filter(lengthOk)) {
    if (state.key !== key || $('webView').hidden || $('discoverView').hidden) break;
    if (cachedFit(s)) continue;
    try { await computeFit(s); changed = true; } catch { continue; }
    refreshRow(s);
    await new Promise((r) => setTimeout(r, 600));   // a short pause between stories, to go easy on the sites
  }
  running = false;
  if (changed && state.key === key && !$('webView').hidden) render();
}
function refreshRow(s) {
  const f = cachedFit(s);
  const st = $('wnStatus');
  if (st) st.textContent = statusLine();
  if (!f) return;
  document.querySelectorAll(`.w-list [data-s="${CSS.escape(fitId(s))}"] .w-fit`).forEach((el) => {
    el.hidden = false;
    el.querySelector('b').style.width = f.pct + '%';
    el.querySelector('span').textContent = `${f.pct}% · ${level(f.pct)}`;
  });
}

/* ---------- Story details ---------- */

let current = null;
function fitHtml(s) {
  if (!Y().settings.key) return '<p>Add your jpdb key in Settings to see how many of this story’s words you already know.</p>';
  const f = cachedFit(s);
  if (!f) return '<p>Checking how many of the words you already know…</p>';
  return `<div class="big">${level(f.pct)}<small>${f.pct}% of the words you already know</small></div>
    <div class="bar"><b style="width:${f.pct}%"></b></div>
    <p>${f.newWords < 5 ? 'Almost no new words in the first episode.' : `About ${f.newWords.toLocaleString()} new words in the first episode.`}</p>`;
}
function opening(text, n) {
  const s = text.replace(/\n+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 40);
  const end = Math.max(cut.lastIndexOf('。', n + 39), cut.lastIndexOf('」', n + 39));
  return end > 40 ? cut.slice(0, end + 1) : s.slice(0, n) + '…';
}

async function openStory(id) {
  const s = state.stories.find((x) => fitId(x) === id);
  if (!s) return;
  current = s;
  const inLib = await Y().findWebBook(s.site, s.id);
  const tags = [s.genre, timeLabel(s.chars), s.short ? 'Short story' : `${s.count} episodes`, s.short ? '' : s.finished ? 'Finished' : 'Ongoing', SITES[s.site]].filter(Boolean);
  $('dDetail').innerHTML = `
    <div class="w-head">
      <div class="dt">${esc(s.title)}</div>
      ${s.pitch ? `<div class="de">${esc(s.pitch)}</div>` : ''}
      <div class="da">${esc(s.author)}</div>
      <div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="fitbox" id="wnFit">${fitHtml(s)}</div>
    ${s.intro ? `<p class="lbl">About</p><p class="w-intro" id="wnIntro">${esc(s.intro.trim())}</p>` : ''}
    <p class="lbl">Opening lines</p>
    <div class="first" id="wnFirst"><span class="hint">Loading…</span></div>
    <div class="acts">
      <button class="btn primary" id="wnAdd">${inLib ? 'Open' : 'Add to library'}</button>
      <button class="btn" id="wnSample">Read sample</button>
    </div>
    <p class="hint" id="wnMsg"></p>
    <p class="hint"><a href="${esc(s.url)}" target="_blank" rel="noopener">Open on ${SITES[s.site]}</a></p>`;
  Y().openSheet('bookSheet');
  $('wnIntro')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));
  $('wnAdd').onclick = () => (inLib ? Y().openBook(inLib) : add(s));
  $('wnSample').onclick = () => toggleSample(s);
  try {
    const text = await firstEpisode(s);
    if (current !== s) return;
    $('wnFirst').textContent = opening(text, 100);
    if (Y().settings.key && !cachedFit(s)) computeFit(s).then(() => { if (current === s) $('wnFit').innerHTML = fitHtml(s); refreshRow(s); });
  } catch {
    if (current === s) $('wnFirst').innerHTML = '<span class="hint">Couldn’t load the first episode. Check your connection.</span>';
  }
}
async function toggleSample(s) {
  const text = await firstEpisode(s);
  const el = $('wnFirst');
  const long = el.classList.toggle('sample');
  el.textContent = long ? opening(text, 1600) : opening(text, 100);
  $('wnSample').textContent = long ? 'Show less' : 'Read sample';
}
async function add(s) {
  const btn = $('wnAdd'), say = (t) => { if (current === s) $('wnMsg').textContent = t; };
  btn.disabled = true;
  try {
    const { id } = await addStory(s, say);
    if (current !== s) return;
    btn.textContent = 'Open';
    btn.onclick = () => Y().openBook(id);
    say('Added to your library. More episodes download when you reach the end.');
  } catch (e) {
    say('Couldn’t add this story: ' + (e.message || 'unknown error'));
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Wiring ---------- */

export function init() {
  $('webBody').addEventListener('click', (e) => {
    const c = e.target.closest('[data-mood],[data-genre],[data-length]');
    if (c) {
      for (const k of ['mood', 'genre', 'length']) if (c.dataset[k] !== undefined) state[k] = state[k] === c.dataset[k] ? '' : c.dataset[k];
      saveState();
      return render();
    }
    const b = e.target.closest('[data-s]');
    if (b) openStory(b.dataset.s);
  });
}
