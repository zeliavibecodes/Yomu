// Discover → Web novels: browse Kakuyomu and Narou by mood and genre, with each
// story's difficulty measured against your own jpdb words.

// Loaded with the same version as the rest of the app, so there's only ever one copy of it.
const { search, firstEpisode, addStory, SITES, relayReady } = await import(`./webnovel.js${new URL(import.meta.url).search}`);

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
const MAX = 40;   // stories gathered per list
const PAGE = 10;  // stories shown at a time

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

/* ---------- Making stories easy to judge at a glance ---------- */

// Web novel titles often carry extras: 【書籍化】 notices, (Web版), and a long subtitle after 〜.
export function shortTitle(t) {
  let s = String(t || '').replace(/[【\[［][^】\]］]*[】\]］]/g, ' ').replace(/[（(](?:web|Web|WEB)[^）)]*[）)]/g, ' ');
  s = s.replace(/[\s　]*[〜～~][^〜～~]*[〜～~]?[\s　]*$/, '').replace(/[\s　]*[―—－-]{1,2}[^―—－-]+[―—－-]{0,2}[\s　]*$/, '');
  s = s.replace(/[\s　]+/g, ' ').trim();
  return s.length >= 2 ? s : String(t || '').trim();
}

// The most common tags authors use, in plain English.
const TAGS = {
  '異世界転生': 'Reborn in another world', '異世界転移': 'Transported to another world', '転生': 'Reincarnation', '異世界': 'Another world',
  '剣と魔法': 'Swords and magic', '魔法': 'Magic', '現代ファンタジー': 'Magic in modern times', '現代': 'Modern day', '現代日本': 'Modern Japan',
  'ほのぼの': 'Gentle', '日常': 'Everyday life', 'スローライフ': 'Slow life', '癒し': 'Comforting', 'まったり': 'Relaxed',
  'コメディ': 'Comedy', 'コメディー': 'Comedy', 'ギャグ': 'Gags', 'ラブコメ': 'Romantic comedy', '恋愛': 'Romance', '純愛': 'Pure love',
  '両片思い': 'Mutual crush', 'じれじれ': 'Slow-burn romance', '青春': 'Youth', '学園': 'School', '学校': 'School', '高校生': 'High school',
  '大学生': 'University', '社会人': 'Working adults', 'お仕事': 'Work life', '職業もの': 'Work life', '料理': 'Cooking', 'グルメ': 'Food',
  '飯テロ': 'Food', 'ご飯': 'Food', '動物': 'Animals', '猫': 'Cats', '犬': 'Dogs', 'もふもふ': 'Fluffy animals', 'ペット': 'Pets',
  '家族': 'Family', '子育て': 'Raising a child', '友情': 'Friendship', 'ヒューマンドラマ': 'Human drama', '感動': 'Moving', '切ない': 'Bittersweet',
  'シリアス': 'Serious', 'ダーク': 'Dark', '復讐': 'Revenge', 'ざまぁ': 'Payback', '成り上がり': 'Rise to the top', '主人公最強': 'Overpowered hero',
  'チート': 'Special powers', '無双': 'Unbeatable hero', '追放': 'Cast out', '勘違い': 'Misunderstandings', '悪役令嬢': 'Villainess',
  '悪役転生': 'Reborn as the villain', '婚約破棄': 'Broken engagement', '聖女': 'Saint', '貴族': 'Nobility', '王子': 'Prince', '王女': 'Princess',
  '冒険': 'Adventure', '冒険者': 'Adventurers', 'ダンジョン': 'Dungeons', 'ゲーム': 'Game world', 'VRMMO': 'VR game', 'ステータス': 'Game stats',
  'スキル': 'Skills', '魔王': 'Demon lord', '勇者': 'Hero', '戦記': 'War story', '戦争': 'War', 'バトル': 'Battles', 'アクション': 'Action',
  '宇宙': 'Space', 'SF': 'Sci-fi', 'ロボット': 'Robots', 'AI': 'AI', 'タイムリープ': 'Time loop', 'タイムトラベル': 'Time travel', '近未来': 'Near future',
  '歴史': 'History', '戦国': 'Samurai era', '江戸': 'Edo period', 'ミステリー': 'Mystery', '推理': 'Detective', '謎解き': 'Puzzles',
  'サスペンス': 'Suspense', 'ホラー': 'Horror', '怪談': 'Ghost stories', 'オカルト': 'Occult', '妖怪': 'Yokai', '神様': 'Gods', '幽霊': 'Ghosts',
  '吸血鬼': 'Vampires', 'ハーレム': 'Harem', '百合': 'Girls’ love', 'BL': 'Boys’ love', '幼馴染': 'Childhood friends', 'ヤンデレ': 'Obsessive love',
  '女主人公': 'Female lead', '男主人公': 'Male lead', 'おっさん': 'Middle-aged hero', '内政': 'Running a kingdom', '領地経営': 'Running an estate',
  '商売': 'Running a shop', '錬金術': 'Alchemy', '薬師': 'Herbalist', '医療': 'Medicine', '農業': 'Farming', '生産': 'Crafting', '旅': 'Travel',
  '温泉': 'Hot springs', '田舎': 'Countryside', '喫茶店': 'Café', 'カフェ': 'Café', '本': 'Books', '書店': 'Bookshop', '音楽': 'Music',
  'スポーツ': 'Sports', '部活': 'School clubs', '探偵': 'Detective', '警察': 'Police', '刑事': 'Detective', '短編': 'Short story', 'エッセイ': 'Essay',
};
function topics(s) {
  let list = [...new Set(s.tags.map((t) => TAGS[t]).filter(Boolean))];
  // "Another world" adds nothing next to "Reborn in another world" and the like.
  if (list.some((x) => /another world/.test(x) && x !== 'Another world')) list = list.filter((x) => x !== 'Another world');
  return list.slice(0, 3);
}
const status = (s) => (s.short ? 'Short story' : s.finished ? 'Finished' : 'Ongoing');

function diffHtml(f) {
  return f ? `<span class="w-lv">${level(f.pct)}</span><span class="w-bar"><b style="width:${f.pct}%"></b></span><span class="w-pct">${f.pct}%</span>`
    : '<span class="w-lv w-wait">Checking…</span>';
}
/* ---------- English titles and summaries (Gemini, through the Vercel relay) ---------- */

const ENGLISH_URL = 'https://yomu-vercel.vercel.app/api/summary';
const EN_KEY = 'yomu.english';
let englishOff = false;   // set when the relay has no Gemini key, so Yomu stops asking
function english(s) {
  try { return JSON.parse(localStorage.getItem(EN_KEY) || '{}')[fitId(s)] || null; } catch { return null; }
}
function saveEnglish(s, data) {
  try {
    const all = JSON.parse(localStorage.getItem(EN_KEY) || '{}');
    all[fitId(s)] = { ...(all[fitId(s)] || {}), ...data };
    localStorage.setItem(EN_KEY, JSON.stringify(all));
  } catch {}
}
async function askEnglish(body) {
  if (englishOff) return null;
  try {
    const res = await fetch(ENGLISH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 503) { englishOff = true; return null; }
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
const enHtml = (e) => (e?.title ? `<span class="w-en-t">${esc(e.title)}</span>${e.line ? `<span class="w-en-l">${esc(e.line)}</span>` : ''}` : '');

// English titles and one-line descriptions for the stories on screen, in one request.
let englishBusy = false;
async function fillEnglish() {
  if (englishBusy || englishOff) return;
  const visible = sorted().slice(0, state.shown).filter((s) => !english(s)?.title);
  if (!visible.length) return;
  englishBusy = true;
  const out = await askEnglish({ mode: 'list', stories: visible.map((s) => ({ id: fitId(s), title: s.title, pitch: s.pitch, tags: s.tags })) });
  englishBusy = false;
  for (const x of out?.stories || []) {
    const s = visible.find((v) => fitId(v) === x.id);
    if (!s) continue;
    saveEnglish(s, { title: x.title, line: x.line });
    document.querySelectorAll(`.w-list [data-s="${CSS.escape(x.id)}"] .w-en`).forEach((el) => { el.innerHTML = enHtml(english(s)); el.hidden = false; });
  }
}

function row(s) {
  const t = topics(s);
  return `<li><button class="w-card" data-s="${esc(fitId(s))}">
    <span class="w-diff">${Y().settings.key ? diffHtml(cachedFit(s)) : ''}</span>
    <span class="w-title">${esc(shortTitle(s.title))}</span>
    <span class="w-en" ${english(s)?.title ? '' : 'hidden'}>${enHtml(english(s))}</span>
    ${t.length ? `<span class="w-topics">${t.map((x) => `<span>${esc(x)}</span>`).join('')}</span>` : ''}
    <span class="w-meta">${esc([s.genre, timeLabel(s.chars), status(s)].filter(Boolean).join(' · '))}</span>
  </button></li>`;
}

function statusLine() {
  if (!Y().settings.key) return 'Add your jpdb key in Settings to see how hard each story is for you.';
  const list = state.stories.filter(lengthOk);
  const left = list.filter((s) => !cachedFit(s)).length;
  if (left) return `Checking how hard each story is for you… ${list.length - left} of ${list.length}`;
  return 'Easiest for you first';
}

export async function render() {
  const root = $('webBody');
  if (!relayReady) {
    root.innerHTML = '<p class="hint d-loading">Web novels work in the Mac version for now. The online version needs its relay set up first.</p>';
    return;
  }
  const key = [state.mood, state.genre].join('|');
  if (key !== state.key) return load(key);
  root.innerHTML = chips() + (state.loading
    ? '<p class="hint d-loading">Finding stories…</p>'
    : state.error ? `<p class="hint d-loading">${esc(state.error)}</p><p class="d-loading w-retry"><button class="btn" data-retry>Try again</button></p>`
    : !sorted().length ? '<p class="hint d-loading">Nothing matches. Try another mood or genre.</p>'
    : `<p class="hint w-status" id="wnStatus">${statusLine()}</p><ul class="w-list">${sorted().slice(0, state.shown).map(row).join('')}</ul>`
      + (sorted().length > state.shown ? '<p class="w-more"><button class="btn" data-more>Show more</button></p>' : ''));
  if (!state.loading) { queueFits(); fillEnglish(); }
}

async function load(key) {
  state.key = key;
  state.shown = PAGE;
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
  document.querySelectorAll(`.w-list [data-s="${CSS.escape(fitId(s))}"] .w-diff`).forEach((el) => { el.innerHTML = diffHtml(f); });
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
function summaryHtml(s) {
  const e = english(s);
  if (!e?.summary) return '<p class="w-sum-wait">Writing an English summary…</p>';
  return `${e.title ? `<p class="w-sum-t">${esc(e.title)}</p>` : ''}<p class="w-sum-p">${esc(e.summary)}</p>`;
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
  const tags = [s.genre, timeLabel(s.chars), s.short ? '' : `${s.count} episodes`, status(s), SITES[s.site]].filter(Boolean);
  const short = shortTitle(s.title), t = topics(s);
  $('dDetail').innerHTML = `
    <div class="w-head">
      <div class="dt">${esc(short)}</div>
      ${short !== s.title.trim() ? `<div class="w-full">${esc(s.title)}</div>` : ''}
      <div class="da">${esc(s.author)}</div>
      ${t.length ? `<div class="w-topics w-topics-lg">${t.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="tags">${tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
    </div>
    <div class="w-sum" id="wnSum" ${englishOff ? 'hidden' : ''}>${summaryHtml(s)}</div>
    <div class="fitbox" id="wnFit">${fitHtml(s)}</div>
    ${s.pitch ? `<p class="lbl">In one line</p><p class="w-pitch">${esc(s.pitch)}</p>` : ''}
    ${s.intro ? `<p class="lbl">About</p><p class="w-intro" id="wnIntro">${esc(s.intro.replace(/[ \t　]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim())}</p>` : ''}
    <p class="lbl">Opening lines</p>
    <div class="first" id="wnFirst"><span class="hint">Loading…</span></div>
    <div class="acts">
      <button class="btn primary" id="wnAdd">${inLib ? 'Open' : 'Add to library'}</button>
      <button class="btn" id="wnSample">Read sample</button>
    </div>
    <p class="hint" id="wnMsg"></p>
    <p class="hint"><a href="${esc(s.url)}" target="_blank" rel="noopener">Open on ${SITES[s.site]}</a></p>`;
  Y().openSheet('bookSheet');
  if (!englishOff && !english(s)?.summary) {
    askEnglish({ mode: 'story', story: { title: s.title, pitch: s.pitch, intro: s.intro, tags: s.tags } }).then((out) => {
      if (out?.summary) saveEnglish(s, { title: out.title || english(s)?.title, summary: out.summary });
      if (current !== s) return;
      const el = $('wnSum');
      if (out?.summary) el.innerHTML = summaryHtml(s); else el.hidden = true;
    });
  }
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
    if (e.target.closest('[data-retry]')) { state.key = ''; return render(); }
    if (e.target.closest('[data-more]')) { state.shown += PAGE; return render(); }
    const b = e.target.closest('[data-s]');
    if (b) openStory(b.dataset.s);
  });
}
