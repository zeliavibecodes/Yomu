// Discover → Web novels: browse Kakuyomu and Narou by mood and genre, with each
// story's difficulty measured against your own jpdb words.

// Loaded with the same version as the rest of the app, so there's only ever one copy of it.
const { search, firstEpisode, addStory, readerDetails, SITES, relayReady } = await import(`./webnovel.js${new URL(import.meta.url).search}`);

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

const state = { view: 'foryou', mood: '', genre: '', length: '', sort: 'easy', stories: [], loading: false, key: '' };
try { Object.assign(state, JSON.parse(localStorage.getItem('yomu.web') || '{}'), { stories: [], loading: false, key: '' }); } catch {}
const saveState = () => { try { localStorage.setItem('yomu.web', JSON.stringify({ view: state.view, mood: state.mood, genre: state.genre, length: state.length, sort: state.sort })); } catch {} };

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

/* ---------- Saved stories ---------- */

const SAVED_KEY = 'yomu.saved';
const savedAll = () => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch { return {}; } };
const isSaved = (s) => !!savedAll()[fitId(s)];
function toggleSaved(s) {
  const all = savedAll();
  if (all[fitId(s)]) delete all[fitId(s)];
  else { all[fitId(s)] = { ...s, savedAt: Date.now() }; addInterest(s, 2); }
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(all)); } catch {}
  return !!all[fitId(s)];
}
const savedList = () => Object.values(savedAll()).sort((a, b) => b.savedAt - a.savedAt);

/* ---------- What you like ---------- */

// Built from the stories you save (counts 2) and add to your library (counts 3), and the
// moods and genres you browse (counts 1). Only tags Yomu can name in English are counted.
const INTEREST_KEY = 'yomu.interests';
const GENRE_OF = { 'Other-world fantasy': 'fantasy', 'Modern fantasy': 'fantasy', 'High fantasy': 'fantasy', 'Action': 'fantasy', 'Sci-fi': 'scifi', 'Space': 'scifi', 'VR game': 'scifi', 'Disaster': 'scifi', 'Romance': 'romance', 'Romantic comedy': 'romance', 'Other-world romance': 'romance', 'Drama': 'drama', 'Literary': 'drama', 'Mystery': 'mystery', 'Horror': 'horror', 'History': 'history' };
const interests = () => { try { return { tags: {}, genres: {}, ...JSON.parse(localStorage.getItem(INTEREST_KEY) || '{}') }; } catch { return { tags: {}, genres: {} }; } };
function bump(change) {
  const p = interests();
  for (const [t, w] of Object.entries(change.tags || {})) p.tags[t] = (p.tags[t] || 0) + w;
  for (const [g, w] of Object.entries(change.genres || {})) p.genres[g] = (p.genres[g] || 0) + w;
  try { localStorage.setItem(INTEREST_KEY, JSON.stringify(p)); } catch {}
}
function addInterest(s, w) {
  const tags = {};
  for (const t of s.tags || []) if (TAGS[t]) tags[t] = w;
  bump({ tags, genres: GENRE_OF[s.genre] ? { [GENRE_OF[s.genre]]: w } : {} });
}
const topOf = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
const hasInterests = () => Object.keys(interests().tags).length > 0;

// How well a story matches what you like, from 0 to 1, and the tags that matched.
function interestMatch(s) {
  const p = interests();
  const top = Object.values(p.tags).sort((a, b) => b - a).slice(0, 4).reduce((a, b) => a + b, 0);
  if (!top) return { score: 0.5, tags: [] };
  const hits = [...new Set(s.tags || [])].filter((t) => p.tags[t]).sort((a, b) => p.tags[b] - p.tags[a]);
  const raw = hits.reduce((a, t) => a + p.tags[t], 0) + (p.genres[GENRE_OF[s.genre]] || 0) * 0.5;
  return { score: Math.min(1, raw / top), tags: hits };
}
// The recommendation: how easy it is for you, how well it matches your interests, and how much readers like it.
function recScore(s) {
  const f = cachedFit(s);
  const ease = f ? Math.max(0, Math.min(1, (f.pct - 65) / 30)) : 0.4;
  const love = Math.max(0, Math.min(1, Math.log10(loveScore(s) + 1) / 4.3));
  return 0.45 * ease + 0.35 * interestMatch(s).score + 0.2 * love;
}
function whyHtml(s) {
  // Difficulty and reader labels are already on the card, so this only says which interests matched.
  const m = [...new Set(interestMatch(s).tags.map((t) => TAGS[t]).filter(Boolean))].slice(0, 2);
  return m.length ? `<span class="w-why">Because you like ${esc(m.join(' and ').toLowerCase())}</span>` : '';
}

/* ---------- The list ---------- */

const VIEWS = [['foryou', 'For you'], ['browse', 'Browse'], ['saved', 'Saved']];
function viewTabs() {
  const n = Object.keys(savedAll()).length;
  return `<div class="w-views" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" class="${state.view === k ? 'on' : ''}" data-view="${k}">${l}${k === 'saved' && n ? ` <span>${n}</span>` : ''}</button>`).join('')}</div>`;
}


function chips() {
  const row = (group, items, current) => items.map(([k, label]) => `<button class="chip${current === k ? ' on' : ''}" data-${group}="${k}">${label}</button>`).join('');
  return `<p class="w-lbl">Mood</p><div class="d-chips w-chips">${row('mood', Object.entries(MOODS).map(([k, v]) => [k, v[0]]), state.mood)}</div>
    <p class="w-lbl">Genre</p><div class="d-chips w-chips">${row('genre', Object.entries(GENRES).map(([k, v]) => [k, v[0]]), state.genre)}</div>
    <div class="d-chips w-chips">${row('length', [['short', 'Short reads'], ['long', 'Long series']], state.length)}</div>
    <div class="w-sort" role="group" aria-label="Order">${[['easy', 'Easiest for me'], ['loved', 'Most loved']].map(([k, l]) => `<button class="${state.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}</div>`;
}

/* ---------- What other readers think ---------- */

// How much readers like a story: Kakuyomu stars or Narou bookmarks, weighed against length,
// so a short story with a devoted following can rank with a long, well-known series.
function loveScore(s) {
  const n = s.site === 'kakuyomu' ? s.stars : s.bookmarks;
  return (n || 0) / Math.max(1, Math.sqrt((s.chars || 0) / 100000));
}
// Thresholds set from real Kakuyomu numbers: in the all-time popular lists, about a fifth reach 'Loved by many'.
const loveLabel = (s) => { const v = loveScore(s); return v >= 10000 ? 'Loved by many' : v >= 3000 ? 'Popular' : v >= 500 ? 'Liked' : v >= 50 ? 'Some readers' : 'Few readers yet'; };
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

const lengthOk = (s) => !state.length || (state.length === 'short' ? minutes(s.chars) <= SHORT : minutes(s.chars) > SHORT);

function sorted() {
  if (state.view === 'saved') return state.stories;
  if (state.view === 'foryou') return [...state.stories].sort((a, b) => recScore(b) - recScore(a));
  const list = state.stories.filter(lengthOk);
  if (state.sort === 'loved') return [...list].sort((a, b) => loveScore(b) - loveScore(a));
  if (!Y().settings.key) return list;
  // Easiest first; stories not checked yet keep their place after the checked ones.
  const scored = list.filter(cachedFit).sort((a, b) => cachedFit(b).pct - cachedFit(a).pct);
  return [...scored, ...list.filter((s) => !cachedFit(s))];
}

/* ---------- Making stories easy to judge at a glance ---------- */

// Web novel titles often carry extras: 【書籍化】 notices, (Web版), and a long subtitle after 〜.
export function shortTitle(t) {
  let s = String(t || '').replace(/[【\[［][^】\]］]*[】\]］]/g, ' ').replace(/[（(]\s*(?:web|ｗｅｂ)[^）)]*[）)]/gi, ' ');
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
const EN_KEY = 'yomu.english2';
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
const enHtml = (e) => (e?.title ? `<span class="w-en-t">${esc(e.title)}</span>${e.line ? `<span class="w-en-l">${esc(e.line)}</span>` : ''}${e.quote ? `<span class="w-quote">“${esc(e.quote)}” <em>— a reader</em></span>` : ''}` : '');

// English titles and one-line descriptions for the stories on screen, in one request.
let englishBusy = false;
async function fillEnglish() {
  if (englishBusy || englishOff) return;
  const visible = sorted().slice(0, state.shown).filter((s) => !english(s)?.title || (english(s).quote === undefined && s.headlines?.length));
  if (!visible.length) return;
  englishBusy = true;
  const out = await askEnglish({ mode: 'list', stories: visible.map((s) => ({ id: fitId(s), title: s.title, pitch: s.pitch, tags: s.tags, review: s.headlines?.[0] || '' })) });
  englishBusy = false;
  for (const x of out?.stories || []) {
    const s = visible.find((v) => fitId(v) === x.id);
    if (!s) continue;
    saveEnglish(s, { title: x.title, line: x.line, quote: x.quote || '' });
    document.querySelectorAll(`.w-list [data-s="${CSS.escape(x.id)}"] .w-en`).forEach((el) => { el.innerHTML = enHtml(english(s)); el.hidden = false; });
  }
}

const BOOKMARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.5-6.5 4.5v-16a1 1 0 0 1 1-1z"/></svg>';
const saveBtn = (s) => `<button class="w-save${isSaved(s) ? ' on' : ''}" data-save="${esc(fitId(s))}" aria-label="${isSaved(s) ? 'Remove from saved' : 'Save'}" aria-pressed="${isSaved(s)}">${BOOKMARK}</button>`;

function row(s) {
  const t = topics(s);
  return `<li class="w-item">${saveBtn(s)}<button class="w-card" data-s="${esc(fitId(s))}">
    ${state.view === 'foryou' ? whyHtml(s) : ''}
    <span class="w-top"><span class="w-diff">${Y().settings.key ? diffHtml(cachedFit(s)) : ''}</span><span class="w-love">${loveLabel(s)}</span></span>
    <span class="w-title">${esc(shortTitle(s.title))}</span>
    <span class="w-en" ${english(s)?.title ? '' : 'hidden'}>${enHtml(english(s))}</span>
    ${t.length ? `<span class="w-topics">${t.map((x) => `<span>${esc(x)}</span>`).join('')}</span>` : ''}
    <span class="w-meta">${esc([s.genre, timeLabel(s.chars), status(s), s.book ? 'Became a book' : ''].filter(Boolean).join(' · '))}</span>
  </button></li>`;
}

function statusLine() {
  if (!Y().settings.key) return 'Add your jpdb key in Settings to see how hard each story is for you.';
  const list = state.stories.filter(lengthOk);
  const left = list.filter((s) => !cachedFit(s)).length;
  if (left) return `Checking how hard each story is for you… ${list.length - left} of ${list.length}`;
  if (state.view === 'foryou') return hasInterests() ? 'Picked from what you like, how easy each story is for you, and what readers think' : 'Save stories or add them to your library, and these picks will follow your taste';
  if (state.view === 'saved') return 'Stories you saved';
  return state.sort === 'loved' ? 'Most loved first' : 'Easiest for you first';
}

export async function render() {
  const root = $('webBody');
  if (!relayReady) {
    root.innerHTML = '<p class="hint d-loading">Web novels work in the Mac version for now. The online version needs its relay set up first.</p>';
    return;
  }
  if (state.view === 'saved') {
    state.stories = savedList();
    state.key = 'saved';
    state.shown = Math.max(state.shown || 0, state.stories.length);
    root.innerHTML = viewTabs() + (state.stories.length
      ? `<p class="hint w-status" id="wnStatus">${statusLine()}</p><ul class="w-list">${state.stories.map(row).join('')}</ul>`
      : '<p class="hint d-loading">Tap the bookmark on any story to keep it here.</p>');
    queueFits(); fillEnglish();
    return;
  }
  // For you is gathered once per visit, so saving a story doesn't reshuffle the list under your finger.
  const key = state.view === 'foryou' ? 'foryou|' + (state.forStamp || 0) : ['browse', state.mood, state.genre].join('|');
  if (key !== state.key) return load(key);
  root.innerHTML = viewTabs() + (state.view === 'browse' ? chips() : '') + (state.loading
    ? '<p class="hint d-loading">Finding stories…</p>'
    : state.error ? `<p class="hint d-loading">${esc(state.error)}</p><p class="d-loading w-retry"><button class="btn" data-retry>Try again</button></p>`
    : !sorted().length ? `<p class="hint d-loading">${state.view === 'foryou' ? 'No new picks right now. Try Browse.' : 'Nothing matches. Try another mood or genre.'}</p>`
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
    const stories = state.view === 'foryou' ? await candidates() : await search({ tags: mood ? mood[1] : [], kk: genre ? genre[1] : [], nr: genre ? genre[2] : [] });
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

// Stories to recommend: searches for your favourite tags and genre, leaving out what you've
// already saved or added. The 30 that best match your interests and readers' ratings are
// then checked for difficulty, which decides the final order.
async function candidates() {
  const p = interests();
  const tags = hasInterests() ? topOf(p.tags, 3) : ['ほのぼの', 'コメディ', 'ヒューマンドラマ'];
  const g = GENRES[topOf(p.genres, 1)[0]];
  const lists = await Promise.all([
    search({ tags }),
    g ? search({ kk: g[1], nr: g[2] }).catch(() => []) : [],
  ]);
  const seen = new Set(Object.keys(savedAll())), out = [];
  for (const s of lists.flat()) {
    if (seen.has(fitId(s))) continue;
    seen.add(fitId(s));
    if (await Y().findWebBook(s.site, s.id)) continue;
    out.push(s);
  }
  const prelim = (s) => 0.6 * interestMatch(s).score + 0.4 * Math.min(1, Math.log10(loveScore(s) + 1) / 4.3);
  return out.sort((a, b) => prelim(b) - prelim(a)).slice(0, 30);
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
// Ratings, followers and a few translated reviews for the story that's open.
async function showReaders(s) {
  const el = () => (current === s ? $('wnReaders') : null);
  let d = null;
  try { d = await readerDetails(s); } catch {}
  if (!el()) return;
  const facts = [];
  if (d?.average) facts.push(`<div><b>${d.average.toFixed(1)}</b><span>average of ${d.outOf} ${d.outOf === 3 ? 'stars' : 'points'}</span></div>`);
  if (d?.ratings) facts.push(`<div><b>${compact(d.ratings)}</b><span>readers rated it</span></div>`);
  if (d?.followers) facts.push(`<div><b>${compact(d.followers)}</b><span>follow it</span></div>`);
  if (d?.bookmarks) facts.push(`<div><b>${compact(d.bookmarks)}</b><span>bookmarked it</span></div>`);
  if (d?.reads) facts.push(`<div><b>${compact(d.reads)}</b><span>episode reads</span></div>`);
  el().innerHTML = `<p class="w-love-lg">${loveLabel(s)}${s.book ? ' · Became a book' : ''}</p>`
    + (facts.length ? `<div class="w-facts">${facts.join('')}</div>` : '')
    + (d?.reviews?.length ? '<div class="w-reviews" id="wnReviews"><p class="hint">Translating reviews…</p></div>' : '');
  if (!d?.reviews?.length) return;
  const cached = english(s)?.reviews;
  const tr = cached || (await askEnglish({ mode: 'reviews', reviews: d.reviews.map((r) => ({ title: r.title, body: r.body })) }))?.reviews;
  if (tr?.length && !cached) saveEnglish(s, { reviews: tr });
  const box = current === s ? $('wnReviews') : null;
  if (!box) return;
  const list = d.reviews.map((r, i) => ({ stars: r.stars, title: tr?.[i]?.title || r.title, body: tr?.[i]?.body || r.body }));
  box.innerHTML = list.map((r) => `<div class="w-review">
    <p class="w-review-t">${'★'.repeat(Math.max(0, Math.min(3, r.stars)))}<span>${esc(r.title)}</span></p>
    <p class="w-review-b">${esc(r.body)}</p></div>`).join('');
}

function opening(text, n) {
  const s = text.replace(/\n+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 40);
  const end = Math.max(cut.lastIndexOf('。', n + 39), cut.lastIndexOf('」', n + 39));
  return end > 40 ? cut.slice(0, end + 1) : s.slice(0, n) + '…';
}

async function openStory(id) {
  const s = state.stories.find((x) => fitId(x) === id) || savedAll()[id];
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
    <p class="lbl">What readers say</p>
    <div class="w-readers" id="wnReaders"><p class="hint">Loading…</p></div>
    <p class="lbl">Opening lines</p>
    <div class="first" id="wnFirst"><span class="hint">Loading…</span></div>
    <div class="acts">
      <button class="btn primary" id="wnAdd">${inLib ? 'Open' : 'Add to library'}</button>
      <button class="btn" id="wnSample">Read sample</button>
    </div>
    <button class="btn w-save-lg${isSaved(s) ? ' on' : ''}" id="wnSave">${BOOKMARK}<span>${isSaved(s) ? 'Saved' : 'Save for later'}</span></button>
    <p class="hint" id="wnMsg"></p>
    <p class="hint"><a href="${esc(s.url)}" target="_blank" rel="noopener">Open on ${SITES[s.site]}</a></p>`;
  Y().openSheet('bookSheet');
  showReaders(s);
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
  $('wnSave').onclick = () => {
    const on = toggleSaved(s);
    $('wnSave').classList.toggle('on', on);
    $('wnSave').querySelector('span').textContent = on ? 'Saved' : 'Save for later';
    syncSaveButtons(s);
  };
  try {
    const text = await firstEpisode(s);
    if (current !== s) return;
    $('wnFirst').textContent = opening(text, 100);
    if (Y().settings.key && !cachedFit(s)) computeFit(s).then(() => { if (current === s) $('wnFit').innerHTML = fitHtml(s); refreshRow(s); });
  } catch {
    if (current === s) $('wnFirst').innerHTML = '<span class="hint">Couldn’t load the first episode. Check your connection.</span>';
  }
}
function syncSaveButtons(s) {
  document.querySelectorAll(`[data-save="${CSS.escape(fitId(s))}"]`).forEach((b) => {
    b.classList.toggle('on', isSaved(s));
    b.setAttribute('aria-pressed', isSaved(s));
    b.setAttribute('aria-label', isSaved(s) ? 'Remove from saved' : 'Save');
  });
  const tab = document.querySelector('[data-view="saved"]');
  if (tab) { const n = Object.keys(savedAll()).length; tab.innerHTML = `Saved${n ? ` <span>${n}</span>` : ''}`; }
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
    addInterest(s, 3);
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
    const sv = e.target.closest('[data-save]');
    if (sv) {
      const s = state.stories.find((x) => fitId(x) === sv.dataset.save) || savedAll()[sv.dataset.save];
      if (s) { toggleSaved(s); syncSaveButtons(s); }
      return;
    }
    const v = e.target.closest('[data-view]');
    if (v) { if (v.dataset.view !== state.view) { state.view = v.dataset.view; state.key = ''; state.shown = PAGE; state.forStamp = Date.now(); saveState(); render(); } return; }
    const so = e.target.closest('[data-sort]');
    if (so) { state.sort = so.dataset.sort; state.shown = PAGE; saveState(); return render(); }
    const c = e.target.closest('[data-mood],[data-genre],[data-length]');
    if (c) {
      for (const k of ['mood', 'genre', 'length']) if (c.dataset[k] !== undefined) state[k] = state[k] === c.dataset[k] ? '' : c.dataset[k];
      // Browsing a mood or genre counts a little towards your interests.
      if (c.dataset.mood && state.mood) bump({ tags: Object.fromEntries(MOODS[state.mood][1].map((t) => [t, 1])) });
      if (c.dataset.genre && state.genre) bump({ genres: { [state.genre]: 1 } });
      saveState();
      return render();
    }
    if (e.target.closest('[data-retry]')) { state.key = ''; return render(); }
    if (e.target.closest('[data-more]')) { state.shown += PAGE; return render(); }
    const b = e.target.closest('[data-s]');
    if (b) openStory(b.dataset.s);
  });
}
