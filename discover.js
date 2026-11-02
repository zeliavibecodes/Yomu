// Discover: find books on Aozora Bunko, read about them, see how much you'll
// understand, and add them to the library. Books are fetched from a public copy
// of Aozora on GitHub (aozorahack), which web pages are allowed to read.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SOURCE = 'https://raw.githubusercontent.com/aozorahack/aozorabunko_text/master/';
const LEVELS = {
  easy: ['Easy', 'Short, plain language, mostly everyday words'],
  intermediate: ['Intermediate', 'Classic short stories, some literary vocabulary'],
  advanced: ['Advanced', 'Longer works and richer, older Japanese'],
};

let catalog = null;   // id -> entry
let list = null;      // entries in popularity order
let data = null;      // shelves, popular, plots
const filters = { modern: true, length: '' };
const texts = new Map();

// Catalog entry: [id, title, titleKana, subtitle, author, authorKana, romaji, path, modern, year, rank, length]
const W = (a) => ({ id: a[0], title: a[1], kana: a[2], subtitle: a[3], author: a[4], authorKana: a[5], romaji: a[6], path: a[7], modern: !!a[8], year: a[9], rank: a[10], length: a[11] });

export async function load() {
  if (catalog) return;
  const [c, d] = await Promise.all([fetch('discover/catalog.json').then((r) => r.json()), fetch('discover/data.json').then((r) => r.json())]);
  list = c.map(W);
  catalog = new Map(list.map((w) => [w.id, w]));
  data = d;
}

// The same quiet cover tones as the library, picked from the title.
const toneOf = (t) => { let h = 0; for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0; return `tone-${h % 6}`; };
const plotOf = (w) => data.plots[w.id];
const levelOf = (w) => Object.keys(data.shelves).find((k) => data.shelves[k].includes(w.id));
function minutes(chars) { return Math.max(1, Math.round(chars / (Y().speed.cpm || 150))); }
function timeLabel(chars) {
  if (!chars) return '';
  const m = minutes(chars);
  return m < 60 ? `${m} min` : m < 600 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m / 60)} h`;
}
function lengthOk(w) {
  if (!filters.length) return true;
  if (!w.length) return false;
  const m = minutes(w.length);
  return filters.length === 'short' ? m <= 30 : filters.length === 'medium' ? m > 30 && m <= 180 : m > 180;
}
const passes = (w) => (!filters.modern || w.modern) && lengthOk(w);

/* ---------- Screen ---------- */

// Classics (Aozora) or web novels, remembered between visits.
let source = 'aozora';
try { source = localStorage.getItem('yomu.dsrc') || 'aozora'; } catch {}
let webMod = null;

export async function render() {
  document.querySelectorAll('#dSrc button').forEach((b) => b.classList.toggle('on', b.dataset.src === source));
  $('aozoraView').hidden = source !== 'aozora';
  $('webView').hidden = source !== 'web';
  if (source === 'web') {
    if (!webMod) { webMod = await import(`./webdiscover.js${new URL(import.meta.url).search}`); webMod.init(); }
    return webMod.render();
  }
  const root = $('discoverBody');
  if (!catalog) {
    root.innerHTML = '<p class="hint d-loading">Loading the Aozora Bunko catalog…</p>';
    try { await load(); } catch { root.innerHTML = '<p class="hint d-loading">The catalog couldn’t load. Check your connection and try again.</p>'; return; }
  }
  const q = $('dSearch').value.trim();
  root.innerHTML = q ? searchHtml(q) : shelvesHtml();
  observeCards();
}

function card(w) {
  const p = plotOf(w);
  const fit = cachedFit(w.id);
  return `<button class="d-card" data-w="${w.id}">
    <div class="book-cover"><div class="book-spine ${toneOf(w.title)}">${esc(w.title)}<span class="sa">${esc(w.author)}</span></div></div>
    <div class="t">${esc(w.title)}</div>
    ${p ? `<div class="en">${esc(p[0])}</div>` : ''}
    <div class="m">${timeLabel(w.length)}</div>
    <div class="fit" ${fit ? '' : 'hidden'}><i><b style="width:${fit?.pct || 0}%"></b></i><span>${fit ? fit.pct + '%' : ''}</span></div>
  </button>`;
}
function shelf(title, sub, ids) {
  const works = ids.map((i) => catalog.get(i)).filter((w) => w && passes(w));
  if (!works.length) return '';
  return `<section class="d-shelf"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
    <div class="d-row">${works.map(card).join('')}</div></section>`;
}
function shelvesHtml() {
  const out = Object.entries(LEVELS).map(([k, [t, s]]) => shelf(t, s, data.shelves[k])).join('')
    + shelf('Most read on Aozora', 'What other readers open most', data.popular);
  return out || '<p class="hint d-loading">Nothing matches these filters.</p>';
}

const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const norm = (s) => kata2hira(String(s || '').toLowerCase()).replace(/[\s・　]/g, '');
function searchHtml(q) {
  const n = norm(q);
  // Best matches first: titles starting with the search, then titles containing it,
  // then authors, then anything else; most-read books first within each group.
  const scored = [];
  for (const w of list) {
    if (!passes(w)) continue;
    const p = plotOf(w);
    const t = [norm(w.title), norm(w.kana), norm(p?.[0])], a = [norm(w.author), norm(w.authorKana), norm(w.romaji)];
    let s = t.some((h) => h.startsWith(n)) ? 0 : t.some((h) => h.includes(n)) ? 1 : a.some((h) => h.startsWith(n)) ? 2 : a.some((h) => h.includes(n)) ? 3 : norm(w.subtitle).includes(n) ? 4 : -1;
    if (s >= 0) scored.push([s, w.rank || 1e6, w]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const hits = scored.slice(0, 60).map((x) => x[2]);
  if (!hits.length) return `<p class="hint d-loading">No books match “${esc(q)}”${filters.modern ? '. Try turning off “Modern spelling”.' : '.'}</p>`;
  return `<ul class="d-list">${hits.map((w) => {
    const p = plotOf(w);
    return `<li><button data-w="${w.id}">
      <span class="lt">${esc(w.title)}</span>
      <span class="la">${esc(w.author)}${p ? ' · ' + esc(p[0]) : ''}</span>
      <span class="lm">${[timeLabel(w.length), w.modern ? '' : 'Old spelling'].filter(Boolean).join(' · ')}</span>
    </button></li>`;
  }).join('')}</ul>`;
}

/* ---------- Book details ---------- */

let currentWork = null;
export async function openWork(id) {
  const w = catalog.get(+id);
  if (!w) return;
  currentWork = w;
  const p = plotOf(w);
  const lv = levelOf(w);
  const inLib = await Y().findAozoraBook(w.id);
  $('dDetail').innerHTML = `
    <div class="dhead">
      <div class="book-cover"><div class="book-spine ${toneOf(w.title)}">${esc(w.title)}<span class="sa">${esc(w.author)}</span></div></div>
      <div>
        <div class="dt">${esc(w.title)}</div>
        ${p ? `<div class="de">${esc(p[0])}</div>` : w.subtitle ? `<div class="de">${esc(w.subtitle)}</div>` : ''}
        <div class="da">${esc([w.author, w.romaji, w.year || ''].filter(Boolean).join(' · '))}</div>
        <div class="tags">
          ${lv ? `<span class="tag">${LEVELS[lv][0]}</span>` : ''}
          <span class="tag" id="dTime" ${w.length ? '' : 'hidden'}>${timeLabel(w.length)}</span>
          <span class="tag">${w.modern ? 'Modern spelling' : 'Old spelling'}</span>
        </div>
      </div>
    </div>
    <div class="fitbox" id="dFit">${fitHtml(w)}</div>
    ${p ? `<p class="lbl">Story</p><p class="plot">${esc(p[1])}</p>` : ''}
    <p class="lbl">Opening lines</p>
    <div class="first" id="dFirst"><span class="hint">Loading…</span></div>
    <div class="acts">
      <button class="btn primary" id="dAdd">${inLib ? 'Open' : 'Add to library'}</button>
      <button class="btn" id="dSample">Read sample</button>
    </div>
    <p class="hint" id="dMsg"></p>`;
  Y().openSheet('bookSheet');
  $('dAdd').onclick = () => (inLib ? Y().openBook(inLib) : addToLibrary(w));
  $('dSample').onclick = () => toggleSample(w);
  try {
    const t = await getText(w);
    if (currentWork !== w) return;
    $('dFirst').textContent = opening(t.plain, 100);
    if (!w.length) { w.length = t.plain.length; $('dTime').textContent = timeLabel(w.length); $('dTime').hidden = false; }
    if (Y().settings.key && !cachedFit(w.id)) computeFit(w, t).then(() => { if (currentWork === w) $('dFit').innerHTML = fitHtml(w); refreshCard(w.id); });
  } catch {
    if (currentWork === w) $('dFirst').innerHTML = '<span class="hint">Couldn’t load the text. Check your connection.</span>';
  }
}
function opening(plain, n) {
  const s = plain.replace(/\n+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 40);
  const end = Math.max(cut.lastIndexOf('。', n + 39), cut.lastIndexOf('」', n + 39));
  return end > 40 ? cut.slice(0, end + 1) : s.slice(0, n) + '…';
}
async function toggleSample(w) {
  const t = await getText(w);
  const el = $('dFirst');
  const long = el.classList.toggle('sample');
  el.textContent = long ? opening(t.plain, 1600) : opening(t.plain, 100);
  $('dSample').textContent = long ? 'Show less' : 'Read sample';
}
function fitHtml(w) {
  if (!Y().settings.key) return '<p>Add your jpdb key in Settings to see how many of this book’s words you already know.</p>';
  const f = cachedFit(w.id);
  if (!f) return '<p>Checking how many of the words you already know…</p>';
  return `<div class="big">${f.pct}%<small>of the words you already know</small></div>
    <div class="bar"><b style="width:${f.pct}%"></b></div>
    <p>${f.newWords < 5 ? 'Almost no new words.' : `About ${f.newWords.toLocaleString()} new words${f.sampled ? ', estimated from a sample of the book' : ''}.`}</p>`;
}

async function addToLibrary(w) {
  const btn = $('dAdd');
  btn.disabled = true;
  $('dMsg').textContent = 'Adding…';
  try {
    const t = await getText(w);
    const blob = await makeEpub(w, t);
    const id = await Y().addBookBuffer(await blob.arrayBuffer(), { aozora: w.id });
    btn.textContent = 'Open';
    btn.onclick = () => Y().openBook(id);
    $('dMsg').textContent = 'Added to your library.';
  } catch (e) {
    $('dMsg').textContent = 'Couldn’t add this book: ' + (e.message || 'unknown error');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- How much will I understand? ---------- */

function cachedFit(id) {
  try {
    const all = JSON.parse(localStorage.getItem('yomu.fit') || '{}');
    const f = all[id];
    return f && Date.now() - f.at < 7 * 864e5 ? f : null;
  } catch { return null; }
}
function saveFit(id, f) {
  try {
    const all = JSON.parse(localStorage.getItem('yomu.fit') || '{}');
    all[id] = { ...f, at: Date.now() };
    localStorage.setItem('yomu.fit', JSON.stringify(all));
  } catch {}
}
const KNOWN = new Set(['known', 'never-forget', 'blacklisted']);
const isKnown = (st) => !!st && (KNOWN.has(st[0]) || ((st[0] === 'redundant' || st[0] === 'locked') && KNOWN.has(st[1])));

// Reads up to about 10,000 characters spread across the book and asks jpdb
// which of those words you know. Long books are estimated from that sample.
const fitting = new Map();
function computeFit(w, t) {
  if (fitting.has(w.id)) return fitting.get(w.id);
  const job = (async () => {
    const plain = t.plain.replace(/\s+/g, '');
    const SAMPLE = 10000, PIECE = 800;
    let chunks;
    if (plain.length <= SAMPLE) chunks = plain.match(/[\s\S]{1,2400}/g) || [];
    else {
      const n = Math.ceil(SAMPLE / PIECE), step = (plain.length - PIECE) / (n - 1);
      chunks = Array.from({ length: n }, (_, i) => plain.slice(Math.round(i * step), Math.round(i * step) + PIECE));
    }
    const batches = [];
    for (let i = 0; i < chunks.length; i += 3) batches.push(chunks.slice(i, i + 3));
    let total = 0, known = 0;
    const unknown = new Set();
    for (const b of batches) {
      const tokens = await Y().parseTexts(b);
      for (const list of tokens) for (const tk of list) {
        const v = Y().vocab.get(tk.key);
        total++;
        if (isKnown(v?.state)) known++; else unknown.add(tk.key);
      }
    }
    const sampled = plain.length > SAMPLE;
    const ratio = plain.length / Math.max(1, chunks.join('').length);
    const f = { pct: total ? Math.round((known / total) * 100) : 0, newWords: Math.round(unknown.size * (sampled ? Math.pow(ratio, 0.6) : 1)), sampled };
    saveFit(w.id, f);
    return f;
  })().finally(() => fitting.delete(w.id));
  fitting.set(w.id, job);
  return job;
}

// Work out scores for the books you can see on the shelves, one at a time.
let cardObserver = null;
const fitQueue = [];
let fitRunning = false;
function observeCards() {
  cardObserver?.disconnect();
  if (!Y().settings.key) return;
  cardObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      cardObserver.unobserve(e.target);
      const id = +e.target.dataset.w;
      if (!cachedFit(id) && !fitQueue.includes(id)) fitQueue.push(id);
    }
    runFitQueue();
  }, { rootMargin: '100px' });
  document.querySelectorAll('#discoverBody .d-card').forEach((c) => cardObserver.observe(c));
}
async function runFitQueue() {
  if (fitRunning) return;
  fitRunning = true;
  while (fitQueue.length && !$('discoverView').hidden) {
    const w = catalog.get(fitQueue.shift());
    try { await computeFit(w, await getText(w)); refreshCard(w.id); } catch { break; }
  }
  fitRunning = false;
}
function refreshCard(id) {
  const f = cachedFit(id);
  if (!f) return;
  document.querySelectorAll(`.d-card[data-w="${id}"] .fit`).forEach((el) => {
    el.hidden = false;
    el.querySelector('b').style.width = f.pct + '%';
    el.querySelector('span').textContent = f.pct + '%';
  });
}

/* ---------- Aozora text → book ---------- */

async function getText(w) {
  if (texts.has(w.id)) return texts.get(w.id);
  const res = await fetch(SOURCE + w.path);
  if (!res.ok) throw new Error('The book’s text couldn’t be downloaded.');
  const buf = await res.arrayBuffer();
  const t = parseAozora(new TextDecoder('shift_jis').decode(buf));
  texts.set(w.id, t);
  return t;
}

const KANJI = '々〆ヵヶ\\u3400-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{2ffff}';
function lineToHtml(line) {
  let s = line.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // Characters outside the standard set: use the Unicode one when given, otherwise a placeholder.
  s = s.replace(/※［＃[^］]*?U\+([0-9A-Fa-f]{4,5})[^］]*］/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  s = s.replace(/※［＃[^］]*］/g, '〓');
  // Emphasis dots: ［＃「X」に傍点］ marks the X just before it.
  const EM = /［＃「([^」]+)」に(?:白ゴマ)?傍点］/;
  for (let m; (m = EM.exec(s)); ) {
    const before = s.slice(0, m.index), x = m[1], i = before.lastIndexOf(x);
    const marked = i < 0 ? before : before.slice(0, i) + `<em class="sesame_dot">${x}</em>` + before.slice(i + x.length);
    s = marked + s.slice(m.index + m[0].length);
  }
  // Readings: ｜base《reading》 or kanji《reading》
  s = s.replace(/｜([^｜《]+)《([^》]+)》/g, '<ruby>$1<rt>$2</rt></ruby>');
  s = s.replace(new RegExp(`([${KANJI}]+)《([^》]+)》`, 'gu'), '<ruby>$1<rt>$2</rt></ruby>');
  s = s.replace(/《[^》]*》/g, '').replace(/｜/g, '');
  s = s.replace(/［＃[^］]*］/g, '');
  return s;
}
const plainOf = (html) => html.replace(/<rt>[^<]*<\/rt>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function parseAozora(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const dash = [];
  for (let i = 0; i < Math.min(lines.length, 80); i++) if (/^-{20,}/.test(lines[i])) dash.push(i);
  let start = dash.length >= 2 ? dash[1] + 1 : lines.findIndex((l, i) => i > 1 && !l.trim()) + 1;
  let end = lines.findIndex((l) => /^底本[：:]/.test(l));
  if (end < 0) end = lines.length;
  const chapters = [{ heading: '', paras: [] }];
  for (const line of lines.slice(start, end)) {
    if (/［＃改(ページ|丁|頁)］/.test(line)) { if (chapters.at(-1).paras.some((p) => p)) chapters.push({ heading: '', paras: [] }); continue; }
    const h1 = line.match(/［＃「([^」]+)」は(大|中|小)見出し］/);
    const h2 = !h1 && line.match(/［＃(大|中|小)見出し］(.+?)［＃\1見出し終わり］/);
    if (h1 || h2) {
      const text = plainOf(lineToHtml(h1 ? h1[1] : h2[2]));
      const level = h1 ? h1[2] : h2[1];
      if (level !== '小' && chapters.at(-1).paras.some((p) => p)) chapters.push({ heading: '', paras: [] });
      if (level !== '小' && !chapters.at(-1).heading) chapters.at(-1).heading = text;
      else chapters.at(-1).paras.push(`<h3>${text}</h3>`);
      continue;
    }
    chapters.at(-1).paras.push(lineToHtml(line));
  }
  for (const c of chapters) {
    while (c.paras.length && !c.paras[0].trim()) c.paras.shift();
    while (c.paras.length && !c.paras.at(-1).trim()) c.paras.pop();
  }
  const real = chapters.filter((c) => c.paras.length);
  return { chapters: real, plain: real.map((c) => c.paras.map(plainOf).join('\n')).join('\n') };
}

async function makeEpub(w, t) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/style.css', '.sesame_dot{text-emphasis-style:sesame;-webkit-text-emphasis-style:sesame;font-style:normal}');
  const files = t.chapters.map((c, i) => {
    const body = (i === 0 ? `<h1>${esc(w.title)}</h1><p>${esc(w.author)}</p><p><br/></p>` : '')
      + (c.heading ? `<h2>${esc(c.heading)}</h2>` : '')
      + c.paras.map((p) => (p.startsWith('<h3>') ? p : p.trim() ? `<p>${p}</p>` : '<p><br/></p>')).join('');
    const name = `ch${String(i + 1).padStart(3, '0')}.xhtml`;
    zip.file('OEBPS/' + name, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja"><head><meta charset="UTF-8"/><title>${esc(c.heading || w.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`);
    return { name, title: c.heading || (t.chapters.length > 1 ? `${i + 1}` : w.title) };
  });
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head><body><nav epub:type="toc"><ol>${files.map((f) => `<li><a href="${f.name}">${esc(f.title)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid" xml:lang="ja"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">aozora-${w.id}</dc:identifier><dc:title>${esc(w.title)}</dc:title><dc:creator>${esc(w.author)}</dc:creator><dc:language>ja</dc:language><dc:publisher>青空文庫</dc:publisher><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${files.map((f, i) => `<item id="c${i}" href="${f.name}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine page-progression-direction="rtl">${files.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

/* ---------- Wiring ---------- */

export function init() {
  $('dSrc').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b || b.dataset.src === source) return;
    source = b.dataset.src;
    try { localStorage.setItem('yomu.dsrc', source); } catch {}
    render();
  });
  let timer;
  $('dSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 200); });
  document.querySelectorAll('#dChips [data-f]').forEach((chip) => chip.addEventListener('click', () => {
    const [k, v] = chip.dataset.f.split(':');
    if (k === 'modern') filters.modern = !filters.modern;
    else filters.length = filters.length === v ? '' : v;
    document.querySelectorAll('#dChips [data-f]').forEach((c) => {
      const [ck, cv] = c.dataset.f.split(':');
      c.classList.toggle('on', ck === 'modern' ? filters.modern : filters.length === cv);
    });
    render();
  }));
  $('discoverBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (b) openWork(b.dataset.w);
  });
}
