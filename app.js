// Yomu — a Japanese EPUB reader with jpdb readings and deck saving.

// The app's version (from app.js?v=… in index.html). Added to every file the app loads,
// so phones always get matching, up-to-date files instead of old saved copies.
const V = new URL(import.meta.url).search;
// Everything runs on the phone. The only network calls go to jpdb.io.

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================
   Settings (small values, kept in localStorage)
   ========================================================= */
const DEFAULTS = { key: '', deck: '', furigana: 'unknown', direction: 'vertical', size: 19, sentence: true, theme: 'auto', font: 'mincho', underline: false, animate: true, awake: true, ghToken: '', gistId: '' };
const settings = { ...DEFAULTS };
if (matchMedia('(prefers-reduced-motion: reduce)').matches) settings.animate = false;
try { Object.assign(settings, JSON.parse(localStorage.getItem('yomu.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('yomu.settings', JSON.stringify(settings)); } catch {}
  applySettings();
}
function applySettings() {
  document.body.classList.remove('furi-all', 'furi-unknown', 'furi-none', 'dir-vertical', 'dir-horizontal', 'font-mincho', 'font-gothic');
  document.body.classList.add('furi-' + settings.furigana, 'dir-' + settings.direction, 'font-' + settings.font);
  document.body.classList.toggle('no-marks', !settings.underline);
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => { m.content = paper; m.removeAttribute('media'); });
  document.documentElement.style.setProperty('--text-size', settings.size + 'px');
  $('sizeVal').textContent = settings.size + ' px';
  document.querySelectorAll('.seg').forEach((seg) => {
    const v = settings[seg.dataset.setting];
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === v));
  });
  $('sentenceToggle').checked = settings.sentence;
  $('marksToggle').checked = settings.underline;
  $('animateToggle').checked = settings.animate;
  $('awakeToggle').checked = settings.awake;
  $('keyNotice').hidden = !!settings.key;
}

/* =========================================================
   Storage for books (IndexedDB)
   ========================================================= */
const db = {
  _p: null,
  open() {
    if (!this._p) this._p = new Promise((res, rej) => {
      const r = indexedDB.open('yomu', 2);
      r.onupgradeneeded = () => {
        const d = r.result, has = (n) => d.objectStoreNames.contains(n);
        if (!has('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!has('files')) d.createObjectStore('files');
        if (!has('progress')) d.createObjectStore('progress');
        if (!has('parsed')) d.createObjectStore('parsed');   // jpdb results, one record per chapter
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._p;
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  get: (s, k) => db.tx(s, 'readonly', (o) => o.get(k)),
  all: (s) => db.tx(s, 'readonly', (o) => o.getAll()),
  put: (s, v, k) => db.tx(s, 'readwrite', (o) => o.put(v, k)),
  del: (s, k) => db.tx(s, 'readwrite', (o) => o.delete(k)),
  delPrefix: (s, prefix) => db.tx(s, 'readwrite', (o) => o.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'))),
};

/* =========================================================
   EPUB reading
   ========================================================= */
function resolvePath(base, rel) {
  rel = rel.split('#')[0];
  try { rel = decodeURIComponent(rel); } catch {}
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = (base ? base.split('/').slice(0, -1) : []).concat(rel.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}
function parseXml(text, type = 'application/xhtml+xml') {
  let doc = new DOMParser().parseFromString(text, type);
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}
const byLocal = (root, name) => Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === name);

class CopyProtectedError extends Error {}

async function openEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = (p) => zip.file(p) || zip.file(Object.keys(zip.files).find((k) => k.toLowerCase() === p.toLowerCase()) || '');
  if (zip.file('META-INF/rights.xml')) throw new CopyProtectedError();
  const enc = zip.file('META-INF/encryption.xml');
  if (enc) {
    const t = await enc.async('string');
    // Font obfuscation is harmless; anything else means the text is locked.
    const algos = [...t.matchAll(/Algorithm="([^"]+)"/g)].map((m) => m[1]);
    if (algos.some((a) => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a))) throw new CopyProtectedError();
  }
  const container = parseXml(await file('META-INF/container.xml').async('string'), 'application/xml');
  const opfPath = byLocal(container, 'rootfile')[0].getAttribute('full-path');
  const opf = parseXml(await file(opfPath).async('string'), 'application/xml');

  const manifest = {};
  for (const it of byLocal(opf, 'item')) {
    manifest[it.getAttribute('id')] = {
      href: resolvePath(opfPath, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    };
  }
  const spineEl = byLocal(opf, 'spine')[0];
  const spine = byLocal(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest[r.getAttribute('idref')])
    .filter((m) => m && /html|xml/.test(m.type))
    .map((m) => m.href);

  const meta = (n) => (byLocal(opf, n)[0]?.textContent || '').trim();
  const title = meta('title') || 'Untitled';
  const author = meta('creator');

  let coverHref = Object.values(manifest).find((m) => m.props.includes('cover-image'))?.href;
  if (!coverHref) {
    const coverMeta = byLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const id = coverMeta?.getAttribute('content');
    if (id && manifest[id]) coverHref = manifest[id].href;
  }

  // Table of contents: EPUB 3 nav first, then the older NCX file.
  let toc = [];
  const nav = Object.values(manifest).find((m) => m.props.split(' ').includes('nav'));
  if (nav && file(nav.href)) {
    const d = parseXml(await file(nav.href).async('string'));
    const navEl = byLocal(d, 'nav').find((n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || byLocal(d, 'nav')[0];
    if (navEl) toc = byLocal(navEl, 'a').map((a) => ({ label: a.textContent.trim(), href: resolvePath(nav.href, a.getAttribute('href') || ''), frag: (a.getAttribute('href') || '').split('#')[1] || '' }));
  }
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx = ncxId && manifest[ncxId] ? manifest[ncxId] : Object.values(manifest).find((m) => m.type.includes('dtbncx'));
    if (ncx && file(ncx.href)) {
      const d = parseXml(await file(ncx.href).async('string'), 'application/xml');
      toc = byLocal(d, 'navPoint').map((np) => {
        const src = byLocal(np, 'content')[0]?.getAttribute('src') || '';
        return { label: (byLocal(np, 'text')[0]?.textContent || '').trim(), href: resolvePath(ncx.href, src), frag: src.split('#')[1] || '' };
      });
    }
  }
  toc = toc.filter((t) => t.label && spine.includes(t.href));

  return { zip, file, title, author, spine, toc, coverHref };
}

async function coverBlob(epub) {
  if (!epub.coverHref) return null;
  const f = epub.file(epub.coverHref);
  return f ? new Blob([await f.async('uint8array')], { type: guessType(epub.coverHref) }) : null;
}
// How many characters of text each chapter has, so progress can be shown
// for the whole book rather than just the current chapter.
async function chapterLengths(epub) {
  const out = [];
  for (const href of epub.spine) {
    const f = epub.file(href);
    const t = f ? await f.async('string') : '';
    const body = t.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<(rt|rp)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, 'x').replace(/\s+/g, '');
    out.push(body.length);
  }
  return out;
}
function guessType(p) {
  const ext = p.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream';
}

/* =========================================================
   jpdb
   ========================================================= */
const TOKEN_FIELDS = ['vocabulary_index', 'position', 'length', 'furigana'];
const VOCAB_FIELDS = ['vid', 'sid', 'spelling', 'reading', 'meanings_chunks', 'meanings_part_of_speech', 'card_state', 'frequency_rank'];

class JpdbError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function jpdb(endpoint, body) {
  if (!settings.key) throw new JpdbError('no_key', 'No jpdb key yet');
  let res;
  try {
    res = await fetch('https://jpdb.io/api/v1/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + settings.key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new JpdbError('offline', 'Could not reach jpdb. Check your connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new JpdbError(data?.error || 'http_' + res.status, data?.error_message || 'jpdb returned an error');
  return data;
}

// Each word jpdb knows about, keyed "vid/sid". Spans in the text point here.
const vocab = new Map();

function stateClass(state) {
  if (!state) return 'st-none';
  const s = state[0] === 'redundant' || state[0] === 'locked' ? state[1] || state[0] : state[0];
  if (['known', 'never-forget', 'blacklisted'].includes(s)) return 'st-known';
  return 'st-learning';
}
function stateLabel(state) {
  if (!state) return 'Not in your decks';
  const s = state[0] === 'redundant' || state[0] === 'locked' ? state[1] || state[0] : state[0];
  return { new: 'In a deck, not studied yet', learning: 'Learning', known: 'Known', 'never-forget': 'Known', due: 'Due for review', failed: 'Learning', suspended: 'Suspended', blacklisted: 'Hidden' }[s] || 'In a deck';
}

async function parseTexts(texts) {
  const data = await jpdb('parse', {
    text: texts,
    position_length_encoding: 'utf16',
    token_fields: TOKEN_FIELDS,
    vocabulary_fields: VOCAB_FIELDS,
  });
  const keys = data.vocabulary.map((v) => {
    const [vid, sid, spelling, reading, chunks, pos, card_state, freq] = v;
    const key = vid + '/' + sid;
    vocab.set(key, { key, vid, sid, spelling, reading, meanings: chunks.map((g, i) => ({ g, pos: pos[i] || [] })), state: card_state, freq: freq ?? null });
    return key;
  });
  return data.tokens.map((list) =>
    list.map(([vi, position, length, furigana]) => {
      let off = position;
      const rubies = [];
      for (const part of furigana || []) {
        if (typeof part === 'string') off += part.length;
        else { rubies.push({ start: off, end: off + part[0].length, text: part[1] }); off += part[0].length; }
      }
      return { key: keys[vi], start: position, end: position + length, rubies };
    }),
  );
}

/* =========================================================
   Turning a paragraph into plain text and back
   ========================================================= */
const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dd', 'dt', 'blockquote', 'td', 'th', 'figcaption', 'section', 'article', 'aside', 'header', 'footer', 'table', 'ul', 'ol', 'dl', 'figure', 'body']);
const JP = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;

// Read a paragraph's text without changing it. Remembers where each piece of
// text lives in the page, and the readings the book itself prints.
function extract(el) {
  let text = '';
  const rubies = [];
  const segs = [];
  const addText = (n, inRuby) => {
    segs.push({ node: n, start: text.length, end: text.length + n.nodeValue.length, inRuby });
    text += n.nodeValue;
  };
  const walk = (node, inRuby) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) addText(n, inRuby);
      else if (n.nodeType !== 1) continue;
      else if (n.localName === 'br') text += '\n';
      else if (n.localName === 'rt' || n.localName === 'rp' || n.localName === 'rtc') continue;
      else if (n.localName === 'ruby') {
        let baseStart = text.length;
        for (const c of n.childNodes) {
          if (c.nodeType === 3) addText(c, true);
          else if (c.localName === 'rt') {
            if (text.length > baseStart) rubies.push({ start: baseStart, end: text.length, text: c.textContent, book: !n.classList.contains('jf') });
            baseStart = text.length;
          } else if (c.localName === 'rp') continue;
          else if (c.nodeType === 1) walk(c, true);
        }
      } else walk(n, inRuby);
    }
  };
  walk(el, false);
  return { text, rubies, segs };
}

function textWithRubies(text, a, b, rubies, cls) {
  let html = '';
  let pos = a;
  const piece = (s) => esc(s).replace(/\n/g, '<br>');
  for (const r of rubies) {
    if (r.start < pos || r.end > b) continue;
    html += piece(text.slice(pos, r.start));
    html += `<ruby class="${cls}">${piece(text.slice(r.start, r.end))}<rt>${esc(r.text)}</rt></ruby>`;
    pos = r.end;
  }
  return html + piece(text.slice(pos, b));
}

// Mark each word jpdb found, in place, so the book's own formatting
// (emphasis dots, upright numbers, its printed readings) stays intact.
// Words jpdb leaves out (mostly names like 悠人) still get a tappable span,
// so tapping them opens a card instead of turning the page.
const GAP_RUN = /[\u3400-\u9fff\uf900-\ufaff々〆ヵヶ\u30a1-\u30fa\u30fc]+/g;
function gapTokens(text, tokens) {
  const covered = new Uint8Array(text.length);
  for (const t of tokens) covered.fill(1, t.start, t.end);
  const out = [];
  for (const m of text.matchAll(GAP_RUN)) {
    let i = m.index;
    const end = m.index + m[0].length;
    while (i < end) {
      while (i < end && covered[i]) i++;
      let j = i;
      while (j < end && !covered[j]) j++;
      const surface = text.slice(i, j);
      if (j > i && /[^ー]/.test(surface)) {
        const key = 'gap:' + surface;
        if (!vocab.has(key)) vocab.set(key, { key, spelling: surface, reading: '', meanings: [], state: null, gap: true });
        out.push({ key, start: i, end: j, rubies: [] });
      }
      i = j;
    }
  }
  return out;
}

function wrapTokens(data, tokens) {
  const { text, segs, rubies } = data;
  tokens = [...tokens, ...gapTokens(text, tokens)].sort((x, y) => x.start - y.start);
  for (let ti = tokens.length - 1; ti >= 0; ti--) {
    const t = tokens[ti];
    const parts = segs.filter((sg) => sg.start < t.end && sg.end > t.start);
    const bookReading = rubies.some((r) => r.book && r.start < t.end && r.end > t.start);
    // Add jpdb's reading only when the word sits in one plain piece of text.
    // Skip it where the book uses emphasis dots, which sit in the same place as readings.
    const single = parts.length === 1 && !parts[0].inRuby && !bookReading && !parts[0].node.parentElement?.closest('[style*="emphasis"]');
    const v = vocab.get(t.key);
    for (let pi = parts.length - 1; pi >= 0; pi--) {
      const sg = parts[pi];
      const node = sg.node;
      if (!node.parentNode) continue;
      const a = Math.max(t.start, sg.start) - sg.start;
      const b = Math.min(t.end, sg.end) - sg.start;
      if (b < node.nodeValue.length) node.splitText(b);
      const mid = a > 0 ? node.splitText(a) : node;
      const span = document.createElement('span');
      span.className = 'w ' + (v?.gap ? 'st-gap' : stateClass(v?.state));
      span.dataset.k = t.key;
      span.dataset.s = t.start;
      span.dataset.e = t.end;
      mid.replaceWith(span);
      if (single && t.rubies.length) span.innerHTML = textWithRubies(text, t.start, t.end, t.rubies, 'jf');
      else span.appendChild(mid);
    }
  }
}

// Two-digit numbers and "!?" stand upright inside a vertical line (縦中横),
// as Japanese print does. Applied only where the book hasn't done it already.
const TCY = /(?<![0-9A-Za-z.,:])([0-9]{1,2}|[!?]{2})(?![0-9A-Za-z.,:%])/g;
function addTateChuYoko(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const p = n.parentElement;
    if (!p || p.closest('rt, .tcy') || p.style.textCombineUpright || !/[0-9!?]/.test(n.nodeValue)) continue;
    const matches = [...n.nodeValue.matchAll(TCY)].reverse();
    for (const m of matches) {
      if (m[0].length === 1 && /[!?]/.test(m[0])) continue;
      if (m.index + m[0].length < n.nodeValue.length) n.splitText(m.index + m[0].length);
      const mid = n.splitText(m.index);
      const span = document.createElement('span');
      span.className = 'tcy';
      mid.replaceWith(span);
      span.appendChild(mid);
    }
  }
}

/* =========================================================
   The book's own styling: keep only what carries meaning
   (emphasis dots, upright numbers, bold, gothic, alignment,
   indents and relative sizes). Colors, fonts and page
   geometry stay under the reader's control.
   ========================================================= */
const cssCache = new Map();
function readBookRules(cssText) {
  const rules = [];
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText.replace(/@import[^;]*;/g, '').replace(/@namespace[^;]*;/g, ''));
  } catch { return rules; }
  const take = (list) => {
    for (const r of list) {
      if (r.cssRules && !r.selectorText) { take(r.cssRules); continue; }
      if (!r.selectorText || !r.style) continue;
      const decls = keepDecls(r.style);
      if (!Object.keys(decls).length) continue;
      for (const sel of r.selectorText.split(',')) {
        const last = sel.trim().split(/[\s>+~]+/).pop();
        const m = /^([a-z0-9]*)((?:\.[\w-]+)*)$/i.exec(last);
        if (!m || (!m[1] && !m[2])) continue;
        rules.push({ tag: m[1].toLowerCase(), classes: m[2] ? m[2].slice(1).split('.') : [], decls });
      }
    }
  };
  take(sheet.cssRules);
  return rules;
}
function keepDecls(st) {
  const d = {};
  const get = (...names) => names.map((n) => st.getPropertyValue(n).trim()).find(Boolean) || '';
  const em = get('text-emphasis-style', '-webkit-text-emphasis-style') || get('text-emphasis', '-webkit-text-emphasis');
  if (em && em !== 'none' && !/url\(/.test(em)) d.emphasis = em.replace(/\s*(#|rgb|hsl|currentcolor).*$/i, '');
  const tcy = get('text-combine-upright', '-webkit-text-combine');
  if (/all|horizontal|digits/.test(tcy)) d.tcy = true;
  const orient = get('text-orientation', '-webkit-text-orientation');
  if (/upright|sideways/.test(orient)) d.orient = orient.includes('upright') ? 'upright' : 'sideways';
  const fw = get('font-weight');
  if (fw === 'bold' || +fw >= 600) d.bold = true;
  const ff = get('font-family');
  if (/gothic|sans|ゴシック|ｺﾞｼｯｸ/i.test(ff)) d.gothic = true;
  const ta = get('text-align');
  if (/^(center|right|left|end|start)$/.test(ta)) d.align = ta;
  const ti = get('text-indent');
  if (/^-?[0-9.]+em$/.test(ti) && Math.abs(parseFloat(ti)) <= 6) d.indent = ti;
  const fs = get('font-size');
  let ratio = /^[0-9.]+em$|^[0-9.]+rem$/.test(fs) ? parseFloat(fs) : /^[0-9.]+%$/.test(fs) ? parseFloat(fs) / 100 : 0;
  if (ratio && ratio !== 1) d.size = Math.max(0.6, Math.min(2.5, ratio)) + 'em';
  return d;
}
async function bookRulesFor(doc, chapterHref) {
  const rules = [];
  for (const link of byLocal(doc, 'link')) {
    if (!/stylesheet/i.test(link.getAttribute('rel') || '')) continue;
    const path = resolvePath(chapterHref, link.getAttribute('href') || '');
    if (!cssCache.has(path)) {
      const f = reader.epub.file(path);
      cssCache.set(path, f ? readBookRules(await f.async('string')) : []);
    }
    rules.push(...cssCache.get(path));
  }
  for (const st of byLocal(doc, 'style')) rules.push(...readBookRules(st.textContent));
  return rules;
}
function applyBookRules(root, rules) {
  if (!rules.length) return;
  for (const el of root.querySelectorAll('*')) {
    const tag = el.localName;
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const d = {};
    for (const r of rules) {
      if (r.tag && r.tag !== tag) continue;
      if (!r.tag && !r.classes.length) continue;
      if (r.classes.some((c) => !cls.includes(c))) continue;
      if (r.tag && !r.classes.length && !['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 'b'].includes(tag)) continue;
      Object.assign(d, r.decls);
    }
    const s = el.style;
    if (d.emphasis) { s.setProperty('text-emphasis-style', d.emphasis); s.setProperty('-webkit-text-emphasis-style', d.emphasis); }
    if (d.tcy) { s.setProperty('text-combine-upright', 'all'); s.setProperty('-webkit-text-combine', 'horizontal'); }
    if (d.orient) s.setProperty('text-orientation', d.orient);
    if (d.bold) s.setProperty('font-weight', '600');
    if (d.gothic) s.setProperty('font-family', 'var(--gothic)');
    if (d.align) s.setProperty('text-align', d.align);
    if (d.indent) s.setProperty('text-indent', d.indent);
    if (d.size) s.setProperty('font-size', d.size);
  }
}

/* =========================================================
   Reader
   ========================================================= */
const reader = {
  book: null,      // stored record
  epub: null,      // opened zip
  chapter: 0,
  blocks: [],
  urls: [],
  queue: [],
  running: false,
  observer: null,
  stopped: false,
};

async function openBook(id) {
  if (openSheetId) closeSheet();
  const rec = await db.get('books', id);
  const buf = await db.get('files', id);
  if (!rec || !buf) return toast('This book is missing. Try adding it again.');
  try {
    reader.epub = await openEpub(buf);
  } catch (e) {
    return toast('This book could not be opened.');
  }
  reader.book = rec;
  if (!rec.lengths || rec.lengths.length !== reader.epub.spine.length) rec.lengths = await chapterLengths(reader.epub);
  rec.lastOpened = Date.now();
  db.put('books', rec);
  $('readerTitle').textContent = rec.title;
  show('reader');
  let prog = (await db.get('progress', id)) || { chapter: 0, block: 0 };
  const remote = await newerRemote(rec, prog.at);
  if (remote) prog = { chapter: remote.chapter, block: remote.block };
  await loadChapter(Math.min(prog.chapter, reader.epub.spine.length - 1), { block: prog.block || 0, page: prog.page ?? null, sig: prog.sig || '' });
  if (remote) toast('Picked up where you left off on your other device.');
}

function closeBook() {
  cssCache.clear();
  reader.stopped = true;
  reader.observer?.disconnect();
  reader.urls.forEach((u) => URL.revokeObjectURL(u));
  reader.urls = [];
  reader.book = null;
  reader.epub = null;
  $('text').innerHTML = '';
  show('library');
  renderShelf();
}

async function imageUrl(path) {
  const f = reader.epub.file(path);
  if (!f) return '';
  const u = URL.createObjectURL(new Blob([await f.async('uint8array')], { type: guessType(path) }));
  reader.urls.push(u);
  return u;
}

/* =========================================================
   Saved jpdb results
   Each chapter's readings and meanings are kept on the phone, so a
   chapter you've opened before shows its readings straight away, with
   no waiting, no internet, and no text moving as readings arrive.
   Whether you know a word can change on jpdb, so that part is
   refreshed in the background whenever you're online.
   ========================================================= */
const cache = { key: '', data: null, timer: null };

function hashText(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + t.length;
}
async function openCache(bookId, chapter) {
  clearTimeout(cache.timer);
  if (cache.key && cache.data && cache.dirty) await db.put('parsed', cache.data, cache.key);
  cache.key = bookId + '/' + chapter;
  cache.data = (await db.get('parsed', cache.key)) || { blocks: {}, vocab: {} };
  cache.dirty = false;
  for (const [k, v] of Object.entries(cache.data.vocab)) if (!vocab.has(k)) vocab.set(k, v);
  return cache.data;
}
function saveCacheSoon() {
  cache.dirty = true;
  clearTimeout(cache.timer);
  const key = cache.key, data = cache.data;
  cache.timer = setTimeout(() => { db.put('parsed', data, key).catch(() => {}); cache.dirty = false; }, 1200);
}
function storeTokens(record, b, text, tokens) {
  record.blocks[b] = { h: hashText(text), t: tokens.map((t) => [t.key, t.start, t.end, t.rubies.map((r) => [r.start, r.end, r.text])]) };
  for (const t of tokens) { const v = vocab.get(t.key); if (v) record.vocab[t.key] = v; }
}
function rememberTokens(b, text, tokens) {
  if (!cache.data) return;
  storeTokens(cache.data, b, text, tokens);
  saveCacheSoon();
}

/* =========================================================
   Save a whole book for offline reading
   Goes through every chapter and asks jpdb for any paragraphs not saved
   yet. Takes a minute or two for a novel; you can keep reading meanwhile.
   ========================================================= */
const saving = { bookId: null, chapter: 0 };

async function saveWholeBook() {
  const book = reader.book;
  if (!book || saving.bookId) return;
  if (!settings.key) return toast('Add your jpdb key in Settings first.');
  saving.bookId = book.id;
  const n = reader.epub.spine.length;
  try {
    for (let i = 0; i < n; i++) {
      if (reader.book?.id !== book.id) return;   // book was closed: carry on next time
      saving.chapter = i;
      showOfflineState();
      const key = book.id + '/' + i;
      const isOpen = () => cache.key === key;
      const record = isOpen() ? cache.data : (await db.get('parsed', key)) || { blocks: {}, vocab: {} };
      const { blocks } = await buildChapter(i, { images: false });
      const missing = [];
      for (const el of blocks) {
        const text = extract(el).text;
        const e = record.blocks[el.dataset.b];
        if (!e || e.h !== hashText(text)) missing.push({ b: el.dataset.b, text });
      }
      while (missing.length) {
        const batch = [];
        let chars = 0;
        while (missing.length && batch.length < 40 && (!batch.length || chars + missing[0].text.length <= 2500)) {
          const m = missing.shift(); batch.push(m); chars += m.text.length;
        }
        let tokens;
        for (let tries = 0; ; tries++) {
          try { tokens = await parseTexts(batch.map((m) => m.text)); break; }
          catch (e) {
            if ((e.code === 'too_many_requests' || e.code === 'api_unavailable') && tries < 5) { await sleep(2000 * (tries + 1)); continue; }
            throw e;
          }
        }
        batch.forEach((m, j) => storeTokens(record, m.b, m.text, tokens[j]));
        await sleep(250);
      }
      if (isOpen()) saveCacheSoon(); else await db.put('parsed', record, key);
    }
    book.offline = true;
    await db.put('books', book);
    toast('The whole book is saved for offline reading.');
  } catch (e) {
    toast(e.code === 'offline' ? "You're offline. Saving will continue next time." : 'Saving stopped: ' + e.message);
  } finally {
    saving.bookId = null;
    showOfflineState();
  }
}
function showOfflineState() {
  const book = reader.book;
  if (!book) return;
  const btn = $('offlineBtn'), msg = $('offlineMsg');
  if (saving.bookId === book.id) {
    btn.hidden = true;
    msg.textContent = `Saving chapter ${saving.chapter + 1} of ${reader.epub.spine.length}…`;
  } else if (book.offline) {
    btn.hidden = true;
    msg.textContent = 'Readings and meanings for the whole book are saved on this phone.';
  } else {
    btn.hidden = false;
    msg.textContent = 'Chapters you open are saved automatically. Save the whole book to read anywhere without internet.';
  }
}

/* =========================================================
   Words added while offline
   They wait on the phone and go to jpdb as soon as you're back online.
   ========================================================= */
function pendingList() { try { return JSON.parse(localStorage.getItem('yomu.pending') || '[]'); } catch { return []; } }
function setPending(list) { try { localStorage.setItem('yomu.pending', JSON.stringify(list)); } catch {} }
function queueWord(item) { const l = pendingList(); l.push({ ...item, at: Date.now() }); setPending(l); }

let flushing = false;
async function flushPending() {
  if (flushing || !settings.key || !navigator.onLine) return;
  let list = pendingList();
  if (!list.length) return;
  flushing = true;
  let sent = 0;
  try {
    while (list.length) {
      const it = list[0];
      let { vid, sid } = it;
      if (!vid) {
        // Looked up with the offline dictionary: find the word in jpdb by its sentence.
        const [toks] = await parseTexts([it.sentence]);
        const hit = toks.find((t) => t.start <= it.offset && t.end > it.offset) || toks.find((t) => vocab.get(t.key)?.spelling === it.spelling);
        if (!hit) { list.shift(); setPending(list); continue; }
        ({ vid, sid } = vocab.get(hit.key));
      }
      await jpdb('deck/add-vocabulary', { id: it.deck, vocabulary: [[vid, sid]] });
      if (it.sentence && it.deck !== 'never-forget' && it.sentence.length <= 300) {
        try { await jpdb('set-card-sentence', { vid, sid, sentence: it.sentence }); } catch {}
      }
      // Words looked up offline get a jpdb id only now, so they join the words to learn here.
      if (!it.vid && it.deck !== 'never-forget') rememberForLearning(vocab.get(vid + '/' + sid), it.word ? { before: it.before || '', word: it.word, after: it.after || '' } : null);
      list.shift(); setPending(list); sent++;
    }
  } catch { /* still offline or jpdb unavailable: try again later */ }
  flushing = false;
  if (sent) toast(`Added ${sent} word${sent > 1 ? 's' : ''} you saved while offline.`);
}
function cachedTokens(b, text) {
  const e = cache.data?.blocks[b];
  if (!e || e.h !== hashText(text)) return null;
  return e.t.map(([key, start, end, rs]) => ({ key, start, end, rubies: rs.map(([s, en, tx]) => ({ start: s, end: en, text: tx })) }));
}
// Ask jpdb which of this chapter's words you now know, and update them.
async function refreshWordStates(chapterAtStart) {
  if (!settings.key || !cache.data) return;
  const list = Object.values(cache.data.vocab);
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    let res;
    try { res = await jpdb('lookup-vocabulary', { list: part.map((v) => [v.vid, v.sid]), fields: ['card_state'] }); }
    catch { return; }
    if (reader.chapter !== chapterAtStart) return;
    res.vocabulary_info.forEach((info, j) => {
      if (!info) return;
      const v = vocab.get(part[j].key) || part[j];
      const state = info[0] || null;
      if (JSON.stringify(state) !== JSON.stringify(v.state)) {
        v.state = state;
        cache.data.vocab[v.key] = v;
        updateWordEverywhere(v);
        saveCacheSoon();
      }
    });
  }
}

/* =========================================================
   Pages
   The chapter is laid out in page-sized columns, one per screen.
   Vertical books stack their pages downward; horizontal books
   place them side by side. Turning a page jumps exactly one screen,
   which also suits e-ink screens later.
   ========================================================= */
const pager = { page: 0, count: 1, w: 0, h: 0, vertical: true, sig: '' };

function layoutPages() {
  const el = $('page');
  const vertical = settings.direction === 'vertical';
  const w = el.clientWidth, h = el.clientHeight;
  const fs = settings.size;
  const safeTop = $('safeTop').offsetHeight, safeBottom = $('safeBottom').offsetHeight;
  let top = safeTop + 60, bottom = safeBottom + 40, side = vertical ? 26 : 22;
  if (vertical) {
    // Keep vertical lines to about 40 characters on tall screens.
    const extra = Math.max(0, (h - top - bottom) - 40 * fs);
    top += extra / 2; bottom += extra / 2;
  } else {
    // Keep horizontal lines to about 34 characters on wide screens.
    side = Math.max(side, (w - 34 * fs) / 2);
  }
  const r = document.documentElement.style;
  r.setProperty('--pg-top', top + 'px');
  r.setProperty('--pg-side', side + 'px');
  r.setProperty('--pg-col', (vertical ? h - top - bottom : h - top - bottom) + 'px');
  r.setProperty('--pg-colw', (w - 2 * side) + 'px');
  r.setProperty('--pg-gap', (vertical ? top + bottom : 2 * side) + 'px');
  Object.assign(pager, { w, h, vertical });
  pager.sig = [settings.direction, settings.size, settings.font, w, h].join('/');
  countPages();
}
function countPages() {
  const el = $('page');
  pager.count = pager.vertical
    ? Math.max(1, Math.ceil((el.scrollHeight - 2) / pager.h))
    : Math.max(1, Math.ceil((el.scrollWidth - 2) / pager.w));
}
function goToPage(n, { save = true } = {}) {
  countPages();
  pager.page = Math.max(0, Math.min(pager.count - 1, n));
  const el = $('page');
  if (pager.vertical) { el.scrollTop = pager.page * pager.h; el.scrollLeft = 0; }
  else { el.scrollLeft = pager.page * pager.w; el.scrollTop = 0; }
  showProgress();
  notePageTime();
  if (save) saveProgress();
}

/* =========================================================
   Progress through the book
   Percent of the whole book, and minutes left in the chapter based on
   how fast you actually read (it adjusts as you turn pages).
   ========================================================= */
const speed = { cpm: 150, shownAt: 0, page: -1, chapter: -1 };
try { speed.cpm = +localStorage.getItem('yomu.cpm') || 150; } catch {}

function bookPercent() {
  const L = reader.book?.lengths;
  if (!L) return 0;
  const total = L.reduce((a, b) => a + b, 0) || 1;
  const before = L.slice(0, reader.chapter).reduce((a, b) => a + b, 0);
  // Count the page you're on as read, so the last page of the book shows 100%.
  const within = (L[reader.chapter] || 0) * ((pager.page + 1) / Math.max(1, pager.count));
  return Math.min(100, Math.floor(((before + within) / total) * 100));
}
function showProgress() {
  const L = reader.book?.lengths;
  const len = L ? L[reader.chapter] || 0 : 0;
  const left = len * (1 - (pager.page + 1) / Math.max(1, pager.count));
  const mins = Math.ceil(left / speed.cpm);
  const time = pager.page >= pager.count - 1 ? 'Last page of the chapter' : mins <= 1 ? 'About a minute left in the chapter' : `${mins} min left in the chapter`;
  $('pageNum').textContent = L ? `${bookPercent()}%  ·  ${time}` : `${pager.page + 1} / ${pager.count}`;
  showFinishButton();
}
// Learn reading speed from how long you spend on each page you move past.
function notePageTime() {
  const now = Date.now();
  if (speed.chapter === reader.chapter && pager.page === speed.page + 1 && reader.book?.lengths) {
    const secs = (now - speed.shownAt) / 1000;
    if (secs > 6 && secs < 300) {
      const perPage = (reader.book.lengths[reader.chapter] || 0) / Math.max(1, pager.count);
      const sample = perPage / (secs / 60);
      if (sample > 20 && sample < 2000) {
        speed.cpm = Math.round(speed.cpm * 0.85 + sample * 0.15);
        try { localStorage.setItem('yomu.cpm', speed.cpm); } catch {}
      }
    }
  }
  speed.shownAt = now; speed.page = pager.page; speed.chapter = reader.chapter;
}
function pageOf(node) {
  if (!node) return 0;
  const r = (node.getClientRects && node.getClientRects()[0]) || node.getBoundingClientRect();
  const box = $('page').getBoundingClientRect();
  const el = $('page');
  return pager.vertical
    ? Math.floor((r.top - box.top + el.scrollTop) / pager.h)
    : Math.floor((r.left - box.left + el.scrollLeft) / pager.w);
}
function nextPage() {
  if (slide.busy) return;
  countPages();
  if (pager.page < pager.count - 1) turnAnimated(pager.page + 1);
  else if (reader.chapter < reader.epub.spine.length - 1) loadChapter(reader.chapter + 1);
  else toast('This is the end of the book.');
}
function prevPage() {
  if (slide.busy) return;
  if (pager.page > 0) turnAnimated(pager.page - 1);
  else if (reader.chapter > 0) loadChapter(reader.chapter - 1, { page: 'last' });
}

/* =========================================================
   Page slide
   A second, hidden copy of the chapter sits behind the page. When you
   swipe, it shows the next (or previous) page and both slide together
   under your finger, then settle. Vertical books slide in from the left,
   like turning a printed Japanese book.
   ========================================================= */
const slide = { busy: false, dirty: true, drag: null };
const EASE = 'cubic-bezier(0.22, 0.8, 0.2, 1)';

function markGhostDirty() { slide.dirty = true; }
function refreshGhost() {
  const copy = $('text').cloneNode(true);
  copy.id = 'ghostText';
  $('ghost').replaceChildren(copy);
  slide.dirty = false;
}
function showGhost(page) {
  if (slide.dirty) refreshGhost();
  const g = $('ghost');
  g.hidden = false;
  if (pager.vertical) { g.scrollTop = page * pager.h; g.scrollLeft = 0; }
  else { g.scrollLeft = page * pager.w; g.scrollTop = 0; }
}
function setX(el, x, ms = 0) {
  el.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none';
  el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
}
// Screen direction that means "forward": right for vertical books, left for horizontal.
const forwardSign = () => (pager.vertical ? 1 : -1);

function turnAnimated(target) {
  if (!settings.animate) return goToPage(target);
  const dir = target > pager.page ? forwardSign() : -forwardSign();   // where the current page goes
  const w = pager.w;
  showGhost(target);
  setX($('ghost'), -dir * w);          // the new page waits just off screen
  $('reader').classList.add('turning');
  slide.busy = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    setX($('page'), dir * w, 300);
    setX($('ghost'), 0, 300);
    setTimeout(() => {
      goToPage(target);
      setX($('page'), 0);
      $('ghost').hidden = true;
      setX($('ghost'), 0);
      $('reader').classList.remove('turning');
      slide.busy = false;
    }, 320);
  }));
}

function dragStart(x, y) {
  if (slide.busy || !reader.book) return;
  if (window.getSelection && !window.getSelection().isCollapsed) return;   // adjusting a text selection, not turning the page
  slide.drag = { x0: x, y0: y, t0: performance.now(), dx: 0, active: false, lastX: x, lastT: performance.now(), v: 0, target: null };
}
function dragMove(x, y, e) {
  const d = slide.drag;
  if (!d) return;
  const dx = x - d.x0, dy = y - d.y0;
  if (!d.active) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.2) { slide.drag = null; return; }   // mostly vertical: not a page turn
    d.active = true;
    $('reader').classList.add('turning');
  }
  e.preventDefault();
  const now = performance.now();
  d.v = (x - d.lastX) / Math.max(1, now - d.lastT);
  d.lastX = x; d.lastT = now;
  const forward = dx * forwardSign() > 0;
  const target = forward ? pager.page + 1 : pager.page - 1;
  countPages();
  if (target < 0 || target >= pager.count || !settings.animate) {
    // Next page is in another chapter (or animations are off): resist instead of sliding.
    d.target = null;
    setX($('page'), dx * 0.25);
    $('ghost').hidden = true;
  } else {
    if (d.target !== target) { showGhost(target); d.target = target; }
    setX($('page'), dx);
    setX($('ghost'), dx > 0 ? dx - pager.w : dx + pager.w);
  }
  d.dx = dx;
}
function dragEnd() {
  const d = slide.drag;
  slide.drag = null;
  if (!d || !d.active) return false;
  const w = pager.w, dx = d.dx;
  const fast = Math.abs(d.v) > 0.45 && Math.sign(d.v) === Math.sign(dx);
  const far = Math.abs(dx) > w * 0.22;
  const forward = dx * forwardSign() > 0;
  if (d.target === null) {
    setX($('page'), 0, 220);
    setTimeout(() => $('reader').classList.remove('turning'), 240);
    if (far || fast) forward ? nextPage() : prevPage();   // crosses into the next or previous chapter
    return true;
  }
  if (far || fast) {
    // Settle onto the new page; quicker when you flicked.
    const remaining = 1 - Math.abs(dx) / w;
    const ms = Math.round(Math.max(140, Math.min(320, remaining * (fast ? 260 : 340))));
    slide.busy = true;
    setX($('page'), Math.sign(dx) * w, ms);
    setX($('ghost'), 0, ms);
    setTimeout(() => {
      goToPage(d.target);
      setX($('page'), 0);
      $('ghost').hidden = true;
      setX($('ghost'), 0);
      $('reader').classList.remove('turning');
      slide.busy = false;
    }, ms + 20);
  } else {
    // Not far enough: spring back.
    slide.busy = true;
    setX($('page'), 0, 240);
    setX($('ghost'), dx > 0 ? -w : w, 240);
    setTimeout(() => {
      $('ghost').hidden = true;
      $('reader').classList.remove('turning');
      slide.busy = false;
    }, 260);
  }
  return true;
}
// The first paragraph that shows on the current page, used to keep your
// place when the text size, direction or screen size changes.
function currentBlock() {
  for (const el of reader.blocks) {
    for (const r of el.getClientRects()) {
      const box = $('page').getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right) return +el.dataset.b;
    }
  }
  return 0;
}
function relayoutKeeping(block) {
  if (!reader.book) return;
  markGhostDirty();
  requestAnimationFrame(() => {
    layoutPages();
    goToPage(pageOf(reader.blocks[block]));
  });
}

// Turn one chapter of the EPUB into page content, and find its paragraphs.
// Used both for reading and, without images, for saving a book offline.
async function buildChapter(index, { images = true } = {}) {
  const href = reader.epub.spine[index];
  const doc = parseXml(await reader.epub.file(href).async('string'));
  const body = doc.body || byLocal(doc, 'body')[0];
  const root = document.createElement('div');

  // Bring the chapter in, dropping anything that could run code or restyle the page.
  const frag2 = document.createDocumentFragment();
  for (const n of Array.from(body.childNodes)) frag2.appendChild(document.importNode(n, true));
  frag2.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,video,audio').forEach((e) => e.remove());
  for (const el of frag2.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'style') el.removeAttribute(attr.name);
    }
  }
  applyBookRules(frag2, await bookRulesFor(doc, href));
  for (const el of frag2.querySelectorAll('[class]')) el.removeAttribute('class');
  if (images) {
    for (const img of frag2.querySelectorAll('img')) img.setAttribute('src', await imageUrl(resolvePath(href, img.getAttribute('src') || '')));
    for (const im of frag2.querySelectorAll('image')) {
      const h = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      const u = await imageUrl(resolvePath(href, h));
      im.setAttribute('href', u);
      im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u);
    }
  } else {
    frag2.querySelectorAll('img').forEach((i) => i.removeAttribute('src'));
  }
  for (const a of frag2.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    a.dataset.target = /^[a-z]+:/i.test(h) ? h : resolvePath(href, h) + (h.includes('#') ? '#' + h.split('#')[1] : '');
    a.removeAttribute('href');
  }
  root.appendChild(frag2);

  // Web novels put a blank line between almost every paragraph, which suits scrolling on a
  // phone but becomes a wide empty column on a book page. Drop single blank lines and keep
  // one for longer runs, where the author means a scene break.
  if (reader.book?.web || reader.book?.kakuyomu) {
    const blank = (el) => el.localName === 'p' && !el.textContent.trim() && !el.querySelector('img,svg,image');
    let run = [];
    const flush = () => { if (run.length === 1) run[0].remove(); else run.slice(1).forEach((x) => x.remove()); run = []; };
    for (const el of Array.from(root.children)) { if (blank(el)) run.push(el); else flush(); }
    flush();
  }

  // Footer: next chapter
  const end = document.createElement('div');
  end.className = 'chapter-end';
  const kk = reader.book.web || reader.book.kakuyomu;
  if (index < reader.epub.spine.length - 1) end.innerHTML = '<button class="btn" id="nextChapter">Next chapter</button>';
  else if (kk && kk.have < kk.total) end.innerHTML = `<div class="more"><button class="btn" id="moreEpisodes">Get the next ${Math.min(10, kk.total - kk.have)} episodes</button><p class="hint" id="moreMsg">${kk.total - kk.have} more on ${(kk.site || 'kakuyomu') === 'narou' ? 'Narou' : 'Kakuyomu'}</p></div>`;
  else if (kk && !kk.finished) end.innerHTML = '<div class="more"><button class="btn" id="moreEpisodes">Check for new episodes</button><p class="hint" id="moreMsg">The author is still writing this story.</p></div>';
  else end.innerHTML = finishHtml(reader.book);
  // Learn the words added while reading, right after the chapter.
  const learnN = learnList().length;
  end.insertAdjacentHTML('afterbegin', `<button class="btn primary chapter-learn" id="chapterLearn" ${learnN ? '' : 'hidden'}>Learn ${learnN} new word${learnN === 1 ? '' : 's'}</button>`);
  root.appendChild(end);

  // Find the paragraphs worth sending to jpdb.
  const blocks = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (!BLOCKS.has(el.localName) || el.closest('.chapter-end')) return false;
    for (const c of el.querySelectorAll('*')) if (BLOCKS.has(c.localName) || c.localName === 'img' || c.localName === 'svg') return false;
    return JP.test(el.textContent);
  });
  blocks.forEach((el, i) => (el.dataset.b = i));
  blocks.forEach(addTateChuYoko);
  return { root, blocks };
}

async function loadChapter(index, { block = 0, frag = '', page: pageArg = null, sig = '' } = {}) {
  reader.stopped = true;
  reader.observer?.disconnect();
  reader.queue = [];
  reader.chapter = index;
  const { root: built, blocks } = await buildChapter(index, { images: true });
  const root = $('text');
  root.replaceChildren(...built.childNodes);
  reader.blocks = blocks;

  // Readings saved from an earlier visit go in before the page is laid out.
  await openCache(reader.book.id, index);
  for (const el of reader.blocks) {
    const ex = extract(el);
    const tokens = cachedTokens(el.dataset.b, ex.text);
    if (tokens) { wrapTokens(ex, tokens); el.dataset.parsed = 'yes'; }
  }

  // Lay out pages and go to the right one.
  const page = $('page');
  layoutPages();
  await new Promise((r) => requestAnimationFrame(r));
  layoutPages();
  if (frag) goToPage(pageOf(root.querySelector('#' + CSS.escape(frag))));
  else if (pageArg === 'last') goToPage(Infinity);
  else if (typeof pageArg === 'number' && sig === pager.sig) goToPage(pageArg);
  else goToPage(block > 0 ? pageOf(reader.blocks[block]) : 0);

  // Parse paragraphs as they come near the screen.
  reader.stopped = false;
  reader.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && (!e.target.dataset.parsed || e.target.dataset.parsed === 'prefetch')) {
        e.target.dataset.parsed = 'queued';
        reader.queue.push(e.target);
        reader.observer.unobserve(e.target);
      }
    }
    pump();
  }, { root: page, rootMargin: '150%' });
  reader.offline = !navigator.onLine;
  if (settings.key || dict.available) reader.blocks.forEach((b) => { if (!b.dataset.parsed) reader.observer.observe(b); });
  if (reader.blocks.every((b) => b.dataset.parsed)) pump();   // nothing to fetch on screen: go straight to saving the rest
  refreshWordStates(index);
  markGhostDirty();
  saveProgress();
}

/* =========================================================
   Offline dictionary (fallback)
   ========================================================= */
const dict = { available: false, mod: null };
async function dictModule() { return dict.mod || (dict.mod = await import(`./offline-dict.js${V}`)); }
async function refreshDictState() {
  try { dict.available = await (await dictModule()).isDownloaded(); } catch { dict.available = false; }
  showDictState();
}
function showDictState(msg) {
  const btn = $('dictBtn');
  if (msg) { $('dictMsg').textContent = msg; return; }
  btn.disabled = false;
  if (dict.available) { btn.textContent = 'Remove'; $('dictMsg').textContent = 'Downloaded. Pages without saved readings use it when jpdb can’t be reached.'; }
  else { btn.textContent = 'Download'; $('dictMsg').textContent = 'About 25 MB. Gives readings and meanings for any book with no internet, though less accurate than jpdb.'; }
}
async function toggleDict() {
  const od = await dictModule();
  const btn = $('dictBtn');
  btn.disabled = true;
  try {
    if (dict.available) { await od.remove(); dict.available = false; showDictState(); return; }
    await od.download((f) => showDictState(`Downloading… ${Math.round(f * 100)}%`));
    showDictState('Preparing…');
    await od.ready();
    dict.available = true;
    showDictState();
  } catch (e) {
    showDictState(e.message || 'Download failed.');
    btn.disabled = false;
  }
}
// Mark paragraphs using the offline dictionary instead of jpdb.
async function wrapOffline(batch) {
  const od = await dictModule();
  await od.ready();
  const known = new Map();
  for (const v of vocab.values()) if (!v.local && v.state) known.set(v.spelling, v.state);
  for (const b of batch) {
    if (!b.el.isConnected || b.el.dataset.parsed === 'yes') continue;
    const { tokens, words } = od.parse(b.text, (sp) => known.get(sp) || null);
    for (const w of Object.values(words)) if (!vocab.has(w.key)) vocab.set(w.key, w);
    wrapTokens(b, tokens);
    b.el.dataset.parsed = 'local';
  }
  countPages(); showProgress(); markGhostDirty();
}

async function pump() {
  const useDictOnly = !settings.key || reader.offline;
  if (reader.running || (useDictOnly && !dict.available) || (!settings.key && !dict.available)) return;
  reader.running = true;
  const chapterAtStart = reader.chapter;
  let errors = 0;
  while (!reader.stopped && reader.chapter === chapterAtStart) {
    // Take paragraphs in reading order, up to about 2,500 characters at a time.
    // Current page first, then the pages after it, then earlier ones.
    const cur = currentBlock();
    const rank = (el) => (+el.dataset.b >= cur ? +el.dataset.b - cur : 1e6 + cur - el.dataset.b);
    reader.queue.sort((a, b) => rank(a) - rank(b));
    const batch = [];
    let chars = 0;
    while (reader.queue.length && batch.length < 40) {
      const el = reader.queue[0];
      const ex = extract(el);
      // Already saved from the background pass: show it without asking jpdb again.
      const saved = cachedTokens(el.dataset.b, ex.text);
      if (saved) { reader.queue.shift(); wrapTokens(ex, saved); el.dataset.parsed = 'yes'; markGhostDirty(); continue; }
      if (batch.length && chars + ex.text.length > 2500) break;
      reader.queue.shift();
      batch.push({ el, ...ex });
      chars += ex.text.length;
    }
    if (!settings.key || reader.offline) {
      // No jpdb right now: use the offline dictionary for what's on screen, and stop there.
      if (!batch.length) break;
      try { await wrapOffline(batch); } catch { break; }
      continue;
    }
    // Nothing near the screen left: quietly fetch the rest of the chapter so it's saved.
    if (!batch.length && !reader.queue.length) {
      const rest = reader.blocks.filter((el) => !el.dataset.parsed && !cache.data?.blocks[el.dataset.b]);
      chars = 0;
      for (const el of rest) {
        const ex = extract(el);
        if (batch.length && (chars + ex.text.length > 2500 || batch.length >= 40)) break;
        el.dataset.parsed = 'prefetch';
        batch.push({ el, ...ex, prefetch: true });
        chars += ex.text.length;
      }
      if (!batch.length) break;
    }
    if (!batch.some((b) => b.prefetch)) setStatus('Adding readings…');
    try {
      const tokens = await parseTexts(batch.map((b) => b.text));
      if (reader.stopped || reader.chapter !== chapterAtStart) break;
      batch.forEach((b, i) => {
        rememberTokens(b.el.dataset.b, b.text, tokens[i]);
        if (b.prefetch) { delete b.el.dataset.parsed; return; }   // saved for later, page left as it is
        wrapTokens(b, tokens[i]);
        b.el.dataset.parsed = 'yes';
      });
      countPages();
      showProgress();
      markGhostDirty();
      errors = 0;
    } catch (e) {
      batch.forEach((b) => delete b.el.dataset.parsed);
      if (batch.every((b) => b.prefetch)) { if (e.code === 'offline' || e.code === 'bad_key') break; await sleep(2000); continue; }
      const onScreen = batch.filter((b) => !b.prefetch);
      if (e.code === 'offline' && dict.available) {
        reader.offline = true;   // until the next chapter opens or the connection returns
        try { await wrapOffline(onScreen); } catch {}
        continue;
      }
      if (e.code === 'too_many_requests' || e.code === 'api_unavailable') {
        reader.queue.unshift(...onScreen.map((b) => b.el));
        await sleep(2000);
      } else if (e.code === 'bad_key') {
        toast('jpdb did not accept your key. Check it in Settings.');
        reader.queue = [];
      } else {
        errors++;
        toast(e.message);
        if (errors >= 3) { reader.queue = []; break; }
        reader.queue.unshift(...onScreen.map((b) => b.el));
        await sleep(3000);
      }
    }
    await sleep(250);
  }
  reader.running = false;
  setStatus('');
}

function setStatus(msg) {
  $('status').textContent = msg;
  $('status').hidden = !msg;
}

let saveTimer;
function saveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!reader.book) return;
    db.put('progress', { chapter: reader.chapter, block: currentBlock(), page: pager.page, sig: pager.sig, at: Date.now() }, reader.book.id);
    pushPosition();
    reader.book.chapter = reader.chapter;
    reader.book.percent = bookPercent();
    db.put('books', reader.book);
  }, 400);
}


/* =========================================================
   Same place on every device
   Reading positions (never books) are kept in a private GitHub Gist.
   Each device writes its position a few seconds after you turn a page,
   and checks for a newer one when you open a book or come back to the app.
   ========================================================= */
const deviceId = (() => {
  try {
    let d = localStorage.getItem('yomu.device');
    if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem('yomu.device', d); }
    return d;
  } catch { return 'unknown'; }
})();
const bookKey = (rec) => 'k' + hashText(`${rec.title}|${rec.author || ''}|${rec.chapters}`).replace(':', '_');
const SYNC_FILE = 'yomu-sync.json';

async function gh(method, path, body, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + settings.ghToken, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  if (!res.ok) { const e = new Error(res.status === 401 ? 'GitHub did not accept this key.' : `GitHub returned an error (${res.status}).`); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json();
}
async function connectSync() {
  settings.ghToken = $('ghInput').value.trim();
  settings.gistId = '';
  saveSettings();
  if (!settings.ghToken) return showSyncState('Paste your GitHub key first.');
  showSyncState('Connecting…');
  try {
    const gists = await gh('GET', '/gists?per_page=100');
    let g = gists.find((x) => x.files && x.files[SYNC_FILE]);
    if (!g) g = await gh('POST', '/gists', { description: 'Yomu reading positions', public: false, files: { [SYNC_FILE]: { content: JSON.stringify({ books: {} }) } } });
    settings.gistId = g.id;
    saveSettings();
    showSyncState();
    if (reader.book) pushPosition(true);
  } catch (e) {
    showSyncState(e.message);
  }
}
function showSyncState(msg) {
  $('syncMsg').textContent = msg || (settings.gistId ? 'Connected. Your place in each book now follows you between devices.' : '');
}
async function readRemote() {
  const g = await gh('GET', '/gists/' + settings.gistId);
  try { return JSON.parse(g.files[SYNC_FILE]?.content || '{}'); } catch { return {}; }
}
let pushTimer;
function pushPosition(now = false) {
  if (!settings.gistId || !reader.book) return;
  clearTimeout(pushTimer);
  const rec = reader.book;
  const entry = { title: rec.title, chapter: reader.chapter, block: currentBlock(), percent: bookPercent(), at: Date.now(), device: deviceId };
  const send = async () => {
    try {
      const data = await readRemote();
      data.books = data.books || {};
      const old = data.books[bookKey(rec)];
      if (old && old.at > entry.at) return;   // another device moved on since
      data.books[bookKey(rec)] = entry;
      await gh('PATCH', '/gists/' + settings.gistId, { files: { [SYNC_FILE]: { content: JSON.stringify(data) } } }, { keepalive: true });
    } catch { /* offline: the next page turn will try again */ }
  };
  if (now) send(); else pushTimer = setTimeout(send, 8000);
}
// Returns a newer position saved by another device, if there is one.
async function newerRemote(rec, localAt) {
  if (!settings.gistId || !navigator.onLine) return null;
  try {
    const data = await Promise.race([readRemote(), sleep(3000).then(() => null)]);
    const e = data?.books?.[bookKey(rec)];
    if (e && e.device !== deviceId && e.at > (localAt || 0)) return e;
  } catch {}
  return null;
}
async function checkRemoteWhileReading() {
  if (!reader.book || slide.busy) return;
  const local = await db.get('progress', reader.book.id);
  const e = await newerRemote(reader.book, local?.at);
  if (!e || !reader.book) return;
  if (e.chapter === reader.chapter && Math.abs(e.block - currentBlock()) < 2) return;
  await loadChapter(Math.min(e.chapter, reader.epub.spine.length - 1), { block: e.block });
  toast('Picked up where you left off on your other device.');
}

/* =========================================================
   Word sheet
   ========================================================= */
let current = null; // { v, el }

function sentenceAround(el) {
  const block = el.closest('[data-b]');
  const { text } = extract(block);
  const s = +el.dataset.s, e = +el.dataset.e;
  const ends = /[。！？!?\n]/;
  let a = s;
  while (a > 0 && !ends.test(text[a - 1])) a--;
  let b = e;
  while (b < text.length && !ends.test(text[b])) b++;
  if (b < text.length && text[b] !== '\n') b++;
  while (b < text.length && /[」』）)]/.test(text[b])) b++;
  return { full: text.slice(a, b).trim(), before: text.slice(a, s).trimStart(), word: text.slice(s, e), after: text.slice(e, b).trimEnd() };
}

// How common a word is, from jpdb's ranking of words by how often they appear in Japanese media.
function freqHtml(v) {
  if (v.freq === undefined) return '';
  const r = v.freq;
  const [label, note] = !r ? ['Rare', 'Not among the 50,000 most used words']
    : r <= 1500 ? ['Very common', `One of the ${r <= 500 ? '500' : '1,500'} most used words`]
    : r <= 5000 ? ['Common', 'One of the 5,000 most used words']
    : r <= 15000 ? ['Less common', 'One of the 15,000 most used words']
    : r <= 30000 ? ['Uncommon', 'One of the 30,000 most used words']
    : ['Rare', 'Outside the 30,000 most used words'];
  const bars = !r ? 0 : r <= 1500 ? 4 : r <= 5000 ? 3 : r <= 15000 ? 2 : r <= 30000 ? 1 : 0;
  return `<span class="freq-bars" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i class="${i <= bars ? 'on' : ''}"></i>`).join('')}</span><b>${label}</b><span>${note}${r ? ` · #${r.toLocaleString()}` : ''}</span>`;
}
// Words saved on the phone before this existed have no ranking yet: ask jpdb for it once.
async function fillFreq(v) {
  if (v.freq !== undefined || !v.vid || !settings.key || !navigator.onLine) return;
  try {
    const data = await jpdb('lookup-vocabulary', { list: [[v.vid, v.sid]], fields: ['frequency_rank'] });
    v.freq = data.vocabulary_info?.[0]?.[0] ?? null;
    if (current?.v === v) { $('wFreq').innerHTML = freqHtml(v); $('wFreq').hidden = false; }
  } catch {}
}

/* ---------- Explain a sentence (Gemini, through the Vercel relay) ---------- */

const EXPLAIN_URL = 'https://yomu-vercel.vercel.app/api/summary';
const explained = new Map();   // this session's answers, so the same passage isn't asked twice
async function explain(text, context) {
  text = text.replace(/\s+/g, '').trim();
  if (!text) return;
  openSheet('explainSheet');
  $('exText').textContent = text;
  const body = $('exBody');
  if (!navigator.onLine) { body.innerHTML = '<p class="hint">You’re offline. Explanations need an internet connection.</p>'; return; }
  body.innerHTML = '<p class="hint ex-wait">Translating and explaining…</p>';
  let out = explained.get(text);
  if (!out) {
    try {
      const res = await fetch(EXPLAIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'explain', text, context: (context || '').replace(/\s+/g, '') }) });
      if (res.status === 503) throw new Error('Explanations need a Gemini key on the Vercel relay.');
      if (!res.ok) throw new Error('Gemini couldn’t answer right now. Try again in a moment.');
      out = await res.json();
      explained.set(text, out);
    } catch (e) {
      if ($('exText').textContent === text) body.innerHTML = `<p class="hint">${esc(e.message || 'Something went wrong.')}</p>`;
      return;
    }
  }
  if ($('exText').textContent !== text) return;
  body.innerHTML = `<p class="lbl">Translation</p><p class="ex-tr">${esc(out.translation)}</p>`
    + (out.literal && out.literal !== out.translation ? `<p class="ex-lit">Word for word: ${esc(out.literal)}</p>` : '')
    + (out.points?.length ? `<p class="lbl">How it works</p><ol class="ex-points">${out.points.map((p) => `<li><p class="ex-part">${esc(p.part)}${p.reading && p.reading !== p.part ? `<span>${esc(p.reading)}</span>` : ''}</p><p class="ex-exp">${esc(p.explanation)}</p></li>`).join('')}</ol>` : '');
}

// Selecting text in the book shows a small "Explain" button.
function selectedInBook() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !reader.book) return null;
  const range = sel.getRangeAt(0);
  if (!$('text').contains(range.commonAncestorContainer)) return null;
  // Leave out readings printed over the words.
  const frag = range.cloneContents();
  frag.querySelectorAll('rt, rp').forEach((x) => x.remove());
  const text = frag.textContent.replace(/\s+/g, '');
  if (text.length < 2 || !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return null;
  const block = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest('[data-b]');
  return { text, context: block ? extract(block).text : '' };
}
function onSelection() {
  const s = selectedInBook();
  $('explainPill').hidden = !s;
}

function openWord(el) {
  const v = vocab.get(el.dataset.k);
  if (!v) return;
  document.querySelectorAll('.w.sel').forEach((x) => x.classList.remove('sel'));
  el.classList.add('sel');
  current = { v, el, sentence: sentenceAround(el) };
  $('wSpelling').textContent = v.spelling;
  $('wReading').textContent = v.reading !== v.spelling ? v.reading : '';
  const st = $('wState');
  st.textContent = v.local && !v.state ? 'Offline dictionary' : stateLabel(v.state);
  st.className = 'word-state' + (v.state || v.local ? '' : ' none');
  $('wFreq').innerHTML = freqHtml(v);
  $('wFreq').hidden = v.freq === undefined;
  fillFreq(v);
  $('wMeanings').innerHTML = v.meanings.slice(0, 5).map((m) =>
    `<li>${esc(m.g.join('; '))}${m.pos.length ? `<span class="pos">${esc(m.pos.join(', '))}</span>` : ''}</li>`).join('');
  const s = current.sentence;
  $('wSentence').innerHTML = `${esc(s.before)}<b>${esc(s.word)}</b>${esc(s.after)}`;
  $('explainSentence').onclick = () => explain(s.full, extract(el.closest('[data-b]')).text);
  const deckName = $('deckSelect').selectedOptions[0]?.textContent;
  $('addBtn').textContent = settings.deck && deckName ? `Add to ${deckName}` : 'Add to deck';
  $('addBtn').disabled = false;
  $('knownBtn').disabled = false;
  $('wMsg').textContent = '';
  if (v.gap) openGap(v);
  openSheet('wordSheet');
}

// A word jpdb doesn't have, usually a name. Use the book's own reading and the
// offline dictionary when they help; it can't go into a jpdb deck.
async function openGap(v) {
  const el = current.el;
  const rt = el.closest('ruby')?.querySelector('rt') || el.querySelector('rt');
  $('wReading').textContent = rt?.textContent || '';
  $('wState').textContent = 'Not in jpdb · often a name';
  $('wState').className = 'word-state none';
  $('addBtn').disabled = true;
  $('knownBtn').disabled = true;
  $('wMeanings').innerHTML = '';
  if (!dict.available) {
    $('wMsg').textContent = 'jpdb has no entry for this word, so it can’t be added to a deck. “Explain this sentence” can tell you who or what it is.';
    return;
  }
  try {
    const od = await dictModule();
    await od.ready();
    const e = od.lookup(v.spelling);
    if (current?.v !== v) return;
    if (!e) { $('wMsg').textContent = 'jpdb and the offline dictionary have no entry for this word. “Explain this sentence” can tell you who or what it is.'; return; }
    if (!$('wReading').textContent && e.reading !== v.spelling) $('wReading').textContent = e.reading;
    $('wMeanings').innerHTML = e.meanings.slice(0, 5).map((m) =>
      `<li>${esc(m.g.join('; '))}${m.pos.length ? `<span class="pos">${esc(m.pos.join(', '))}</span>` : ''}</li>`).join('');
    $('wMsg').textContent = 'From the offline dictionary. jpdb has no entry, so it can’t be added to a deck.';
  } catch {}
}

function updateWordEverywhere(v) {
  markGhostDirty();
  if (current?.v !== v) {
    document.querySelectorAll(`.w[data-k="${CSS.escape(v.key)}"]`).forEach((el) => {
      el.classList.remove('st-none', 'st-learning', 'st-known');
      el.classList.add(stateClass(v.state));
    });
    return;
  }
  document.querySelectorAll(`.w[data-k="${CSS.escape(v.key)}"]`).forEach((el) => {
    el.classList.remove('st-none', 'st-learning', 'st-known');
    el.classList.add(stateClass(v.state));
  });
  $('wState').textContent = stateLabel(v.state);
  $('wState').className = 'word-state' + (v.state ? '' : ' none');
}

/* ---------- Words waiting to be learned ---------- */
// Words added to a deck from Yomu, kept with the sentence they came from, until you learn
// them in Yomu's Learn session (or they're learned on jpdb).
const LEARN_KEY = 'yomu.tolearn';
function learnList() { try { return JSON.parse(localStorage.getItem(LEARN_KEY) || '[]'); } catch { return []; } }
function setLearn(l) { try { localStorage.setItem(LEARN_KEY, JSON.stringify(l)); } catch {} }
function rememberForLearning(v, sentence) {
  if (!v?.vid) return;
  const l = learnList().filter((x) => !(x.vid === v.vid && x.sid === v.sid));
  l.push({ vid: v.vid, sid: v.sid, spelling: v.spelling, reading: v.reading, meanings: (v.meanings || []).slice(0, 3),
    sentence: sentence ? { before: sentence.before, word: sentence.word, after: sentence.after } : null,
    book: reader.book?.title ? shortTitle(reader.book.title) : '', at: Date.now() });
  setLearn(l);
  refreshLearn();
}
function learned(it) {
  setLearn(learnList().filter((x) => !(x.vid === it.vid && x.sid === it.sid)));
  const v = vocab.get(it.vid + '/' + it.sid);
  if (v) { v.state = ['learning']; updateWordEverywhere(v); }
  refreshLearn();
}
// The small "learn" button in the reading bar, and the one at the end of a chapter.
function refreshLearn() {
  const n = learnList().length;
  $('learnBtn').hidden = !n;
  $('learnCount').textContent = n;
  $('learnBtn').setAttribute('aria-label', `Learn ${n} new word${n === 1 ? '' : 's'}`);
  const end = $('chapterLearn');
  if (end) { end.hidden = !n; end.textContent = `Learn ${n} new word${n === 1 ? '' : 's'}`; }
}
async function startLearning() {
  (await import(`./learn.js${V}`)).start();
}

async function addCurrent(deckId, newState, doneMsg) {
  if (!current) return;
  if (!settings.key) return ($('wMsg').textContent = 'Add your jpdb key in Settings first.');
  if (deckId === null) return ($('wMsg').textContent = 'Choose a deck in Settings first.');
  const { v, sentence } = current;
  const queueIt = () => {
    queueWord({ vid: v.vid || null, sid: v.sid || null, deck: deckId, sentence: settings.sentence || !v.vid ? sentence.full : '', spelling: v.spelling, offset: sentence.before.length, before: sentence.before, word: sentence.word, after: sentence.after });
    if (deckId !== 'never-forget') rememberForLearning(v, sentence);
    v.state = newState;
    updateWordEverywhere(v);
    $('wMsg').textContent = "You're offline. It will go to your deck when you're back online.";
  };
  if (!v.vid || !navigator.onLine) return queueIt();
  $('addBtn').disabled = $('knownBtn').disabled = true;
  $('wMsg').textContent = 'Saving…';
  try {
    await jpdb('deck/add-vocabulary', { id: deckId, vocabulary: [[v.vid, v.sid]] });
    if (settings.sentence && deckId !== 'never-forget' && sentence.full.length <= 300) {
      try { await jpdb('set-card-sentence', { vid: v.vid, sid: v.sid, sentence: sentence.full }); } catch {}
    }
    v.state = newState;
    updateWordEverywhere(v);
    if (deckId !== 'never-forget') rememberForLearning(v, sentence);
    $('wMsg').textContent = doneMsg;
  } catch (e) {
    if (e.code === 'offline') queueIt();
    else $('wMsg').textContent = e.code === 'bad_deck' ? 'That deck no longer exists. Pick another in Settings.' : e.message;
  } finally {
    $('addBtn').disabled = $('knownBtn').disabled = false;
  }
}

/* =========================================================
   Sheets, toast, screens
   ========================================================= */
let openSheetId = null;
function openSheet(id) {
  if (openSheetId) $(openSheetId).hidden = true;
  openSheetId = id;
  $(id).hidden = false;
  $('scrim').hidden = false;
}
// Swipe a sheet down to close it, like the sheets in iOS. The drag only starts when the
// sheet is scrolled to the top, so scrolling its content still works normally.
function enableSheetSwipe(sheet) {
  let startY = 0, startT = 0, dy = 0, dragging = false, tracking = false;
  sheet.addEventListener('touchstart', (e) => {
    tracking = sheet.scrollTop <= 0 && e.touches.length === 1;
    dragging = false; dy = 0;
    startY = e.touches[0].clientY; startT = Date.now();
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    dy = e.touches[0].clientY - startY;
    if (!dragging && (dy <= 0 || sheet.scrollTop > 0)) { tracking = dy <= 0 ? tracking && dy > -4 : false; return; }
    dragging = true;
    e.preventDefault();
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
    $('scrim').style.opacity = String(Math.max(0.2, 1 - dy / 500));
  }, { passive: false });
  const end = () => {
    if (!dragging) { tracking = false; return; }
    dragging = tracking = false;
    const fast = dy / Math.max(1, Date.now() - startT) > 0.6;
    sheet.style.transition = 'transform 0.22s cubic-bezier(.2,.8,.2,1)';
    $('scrim').style.opacity = '';
    if (dy > 110 || (fast && dy > 30)) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => { closeSheet(); sheet.style.transition = ''; sheet.style.transform = ''; }, 200);
    } else {
      sheet.style.transform = '';
      setTimeout(() => { sheet.style.transition = ''; }, 230);
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

function closeSheet() {
  if (openSheetId) $(openSheetId).hidden = true;
  openSheetId = null;
  $('scrim').hidden = true;
  document.querySelectorAll('.w.sel').forEach((x) => x.classList.remove('sel'));
}
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
}
// Left and right thirds of the screen turn pages; the middle shows or hides the top bar.
function tapZone(x) {
  const w = window.innerWidth;
  if (x < w * 0.3) return pager.vertical ? nextPage() : prevPage();
  if (x > w * 0.7) return pager.vertical ? prevPage() : nextPage();
  $('readerBar').classList.toggle('hide');
}
// Library and Discover share the first screen; the large title switches between them.
let discoverMod = null;
let webMod = null;
async function showTab(tab) {
  const disc = tab === 'discover';
  $('libraryView').hidden = disc;
  $('discoverView').hidden = !disc;
  $('tabLibrary').classList.toggle('on', !disc);
  $('tabDiscover').classList.toggle('on', disc);
  $('editBtn').hidden = disc || !$('shelf').children.length;
  try { localStorage.setItem('yomu.tab', tab); } catch {}
  if (disc) {
    if (!discoverMod) { discoverMod = await import(`./discover.js${V}`); discoverMod.init(); }
    discoverMod.render();
  }
}
function show(screen) {
  $('library').hidden = screen !== 'library';
  $('reader').hidden = screen !== 'reader';
  $('readerBar').classList.remove('hide');
  keepAwake();
}

/* =========================================================
   Keep the screen on while reading
   The phone lets go of this whenever Yomu goes to the background,
   so it is asked for again each time you come back to the book.
   ========================================================= */
let wakeLock = null;
async function keepAwake() {
  const want = settings.awake && !$('reader').hidden && document.visibilityState === 'visible';
  if (!want) { wakeLock?.release().catch(() => {}); wakeLock = null; return; }
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', keepAwake);

/* =========================================================
   Library
   ========================================================= */
let editing = false;
const coverUrls = [];

// Web novel titles often carry extras: 【書籍化】 notices, (Web版), and a long subtitle after 〜.
function shortTitle(t) {
  let s = String(t || '').replace(/[【\[［][^】\]］]*[】\]］]/g, ' ').replace(/[（(]\s*(?:web|ｗｅｂ)[^）)]*[）)]/gi, ' ');
  s = s.replace(/[\s　]*[〜～~][^〜～~]*[〜～~]?[\s　]*$/, '').replace(/[\s　]*[―—－-]{1,2}[^―—－-]+[―—－-]{0,2}[\s　]*$/, '');
  s = s.replace(/[\s　]+/g, ' ').trim();
  return s.length >= 2 ? s : String(t || '').trim();
}
// A typeset cover for books without one: the title sized to fit, the author set apart,
// where the book came from, and one of a few quiet tones picked from the title.
function typesetCover(title, author, source, color) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const n = [...title].length;
  const size = n <= 4 ? 'xl' : n <= 8 ? 'l' : n <= 14 ? 'm' : n <= 22 ? 's' : 'xs';
  // Kakuyomu stories use the colour their author picked; other books get one of the quiet tones.
  const tinted = /^#[0-9a-f]{6}$/i.test(color || '');
  return `<div class="book-cover"><div class="book-spine ${tinted ? 'tinted' : `tone-${h % 6}`} size-${size}"${tinted ? ` style="--tint:${color}"` : ''}><span class="st">${esc(title)}</span>`
    + `${author ? `<span class="sa">${esc(author)}</span>` : ''}${source ? `<span class="ss">${esc(source)}</span>` : ''}</div></div>`;
}
const sourceOf = (b) => (b.aozora ? '青空文庫' : (b.web?.site || (b.kakuyomu ? 'kakuyomu' : '')) === 'kakuyomu' ? 'カクヨム' : b.web?.site === 'narou' ? '小説家になろう' : '');

// Kakuyomu books added before covers existed: look up their cover and colour once, quietly.
let coversRunning = false;
const coversTried = new Set();   // so a failed lookup isn't retried until the app is opened again
async function fillCovers(books) {
  if (coversRunning || !navigator.onLine) return;
  const todo = books.filter((b) => !b.coverChecked && !b.cover && !coversTried.has(b.id) && ((b.web?.site || (b.kakuyomu ? 'kakuyomu' : '')) === 'kakuyomu'));
  if (!todo.length) return;
  coversRunning = true;
  try {
    const wn = await import(`./webnovel.js${V}`);
    for (const b of todo) {
      coversTried.add(b.id);
      const info = await wn.coverFor('kakuyomu', (b.web || b.kakuyomu).work).catch(() => null);
      if (!info) continue;
      const rec = await db.get('books', b.id);
      if (!rec) continue;
      await db.put('books', { ...rec, color: info.color || rec.color || '', coverChecked: true, ...(info.cover ? { cover: info.cover } : {}) });
    }
  } finally { coversRunning = false; }
  renderShelf();
}

/* =========================================================
   Finished books
   Tapping "Mark as finished" on the last page saves the date, moves the book
   to the Finished part of the library, and logs it in Hibi (same GitHub key).
   ========================================================= */
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const niceDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
function finishHtml(rec) {
  return `<span class="finish hint">${rec?.finished ? 'Finished on ' + niceDate(rec.finished) : 'End of the book'}</span>`;
}
// The button sits on top of the page, outside the book text: pages get laid out again
// while readings load, and a button inside them could move under your finger.
function showFinishButton() {
  const btn = $('finishBtn');
  const atEnd = reader.book && pager.page >= pager.count - 1 && !!$('text').querySelector('.chapter-end .finish');
  btn.hidden = !atEnd;
  if (atEnd) btn.textContent = reader.book.finished ? 'Not finished yet' : 'Mark as finished';
  btn.classList.toggle('quiet', !!reader.book?.finished);
}
async function setFinished(on) {
  const rec = reader.book;
  if (!rec) return;
  if (on) { rec.finished = Date.now(); rec.percent = 100; } else delete rec.finished;
  rec.hibiPending = true;
  await db.put('books', rec);
  const end = $('text').querySelector('.chapter-end .finish');
  if (end) end.outerHTML = finishHtml(rec);
  showFinishButton();
  toast(on ? 'Finished. Nice work.' : 'Back to your reading list.');
  sendToHibi(rec);
}
// Hibi keeps its entries in its own private Gist; Yomu adds or removes one entry per book.
const HIBI_FILE = 'hibi-sync.json';
async function sendToHibi(rec) {
  if (!settings.ghToken || !navigator.onLine) return;
  try {
    let id = settings.hibiGistId;
    if (!id) {
      const gists = await gh('GET', '/gists?per_page=100');
      id = gists.find((x) => x.files && x.files[HIBI_FILE])?.id;
      if (!id) return;   // Hibi isn't connected to GitHub yet
      settings.hibiGistId = id; saveSettings();
    }
    const g = await gh('GET', '/gists/' + id);
    let data = {};
    try { data = JSON.parse(g.files[HIBI_FILE]?.content || '{}'); } catch {}
    data.entries = (data.entries || []).filter((e) => e.id !== 'yomu-' + rec.id);
    data.deleted = data.deleted || {};
    const now = Date.now();
    if (rec.finished) {
      data.entries.push({ id: 'yomu-' + rec.id, t: now, d: dayKey(rec.finished), c: 'jp-novel', title: rec.web || rec.kakuyomu ? shortTitle(rec.title) : rec.title });
      delete data.deleted['yomu-' + rec.id];
    } else data.deleted['yomu-' + rec.id] = now;
    await gh('PATCH', '/gists/' + id, { files: { [HIBI_FILE]: { content: JSON.stringify({ ...data, app: 'hibi', version: 1 }) } } });
    delete rec.hibiPending;
    await db.put('books', rec);
  } catch (e) { if (e.status === 404) { settings.hibiGistId = ''; saveSettings(); } }
}
// Anything that couldn't reach Hibi (offline) goes when the app next opens.
async function sendPendingToHibi() {
  for (const b of await db.all('books')) if (b.hibiPending) await sendToHibi(b);
}

async function renderShelf() {
  coverUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const all = await db.all('books');
  const reading = all.filter((b) => !b.finished).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
  const done = all.filter((b) => b.finished).sort((a, b) => b.finished - a.finished);
  const books = [...reading, ...done];
  $('emptyShelf').hidden = books.length > 0;
  $('libSub').textContent = books.length ? `${books.length} ${books.length === 1 ? 'book' : 'books'}` : '';
  $('libSub').parentElement.hidden = !books.length;
  $('editBtn').hidden = books.length === 0 || !$('discoverView').hidden;
  if (!books.length) editing = false;
  $('editBtn').textContent = editing ? 'Done' : 'Edit';
  $('shelf').innerHTML = '';
  for (const b of books) {
    if (b === done[0]) $('shelf').insertAdjacentHTML('beforeend', `<p class="shelf-head">Finished · ${done.length}</p>`);
    const el = document.createElement('div');
    el.className = 'book-item';
    let cover;
    if (b.cover) {
      const u = URL.createObjectURL(b.cover instanceof Blob ? b.cover : new Blob([b.cover.data], { type: b.cover.type }));
      coverUrls.push(u);
      cover = `<div class="book-cover"><img src="${u}" alt=""></div>`;
    } else cover = typesetCover(b.web || b.kakuyomu ? shortTitle(b.title) : b.title, b.author, sourceOf(b), b.color);
    const shown = b.web || b.kakuyomu ? shortTitle(b.title) : b.title;
    const pct = b.lastOpened ? Math.max(1, b.percent ?? Math.round(((b.chapter || 0) + 1) / (b.chapters || 1) * 100)) : 0;
    const prog = b.finished ? niceDate(b.finished) : !b.lastOpened ? 'Not started' : `${pct}% read`;
    el.innerHTML = `<button class="book" data-open="${b.id}" aria-label="Open ${esc(b.title)}">${cover}
      <div class="book-meta"><div class="t">${esc(shown)}</div><div class="p">${b.lastOpened || b.finished ? prog : esc(b.author || 'Not started')}</div>${pct && !b.finished ? `<div class="book-bar"><span style="width:${pct}%"></span></div>` : ''}</div></button>
      ${editing ? `<button class="book-remove" data-remove="${b.id}" aria-label="Remove ${esc(b.title)}">✕</button>` : ''}`;
    $('shelf').appendChild(el);
  }
  fillCovers(books);
}

// Store an EPUB in the library and return its id.
async function addBookBuffer(buf, extra = {}) {
  const epub = await openEpub(buf);
  if (!epub.spine.length) throw new Error('empty');
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await db.put('files', buf, id);
  await db.put('books', { id, title: epub.title, author: epub.author, cover: await coverBlob(epub), chapters: epub.spine.length, lengths: await chapterLengths(epub), chapter: 0, percent: 0, added: Date.now(), ...extra });
  renderShelf();
  return id;
}
async function findWebBook(site, work) {
  const books = await db.all('books');
  return books.find((b) => (b.web ? b.web.site === site && b.web.work === work : site === 'kakuyomu' && b.kakuyomu?.work === work))?.id || null;
}

// Download the next episodes of the Kakuyomu story that's open, then carry on reading.
async function moreEpisodes() {
  const btn = $('moreEpisodes'), say = (t) => { const m = $('moreMsg'); if (m) m.textContent = t; };
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const rec = reader.book, at = reader.chapter;
  try {
    const kk = await import(`./webnovel.js${V}`);
    const res = await kk.getMore(rec, await db.get('files', rec.id), say);
    if (!res.added) {
      await db.put('books', res.rec);
      reader.book = res.rec;
      say(res.rec.web.finished ? 'This is the end of the story.' : 'No new episodes yet.');
      btn.disabled = false;
      return;
    }
    const epub = await openEpub(res.buf);
    await db.put('files', res.buf, rec.id);
    const updated = { ...res.rec, chapters: epub.spine.length, lengths: await chapterLengths(epub) };
    await db.put('books', updated);
    if (reader.book?.id !== rec.id) return;   // the reader was closed meanwhile
    reader.book = updated;
    reader.epub = epub;
    await loadChapter(at + 1);
  } catch (e) {
    say(e.message || 'The episodes couldn’t be downloaded.');
    btn.disabled = false;
  }
}

async function findAozoraBook(aozoraId) {
  const books = await db.all('books');
  return books.find((b) => b.aozora === aozoraId)?.id || null;
}

async function addBookFile(file) {
  if (!file) return;
  toast('Adding book…');
  try {
    const buf = await file.arrayBuffer();
    await addBookBuffer(buf);
    toast('Book added.');
  } catch (e) {
    toast(e instanceof CopyProtectedError
      ? 'This book has copy protection, so its text can\'t be read here.'
      : 'This file couldn\'t be opened. Make sure it\'s an EPUB.');
  }
}

/* =========================================================
   Settings sheet
   ========================================================= */
async function checkKey() {
  settings.key = $('keyInput').value.trim();
  saveSettings();
  if (!settings.key) return ($('keyMsg').textContent = 'Paste your key first.');
  $('keyMsg').textContent = 'Checking…';
  try {
    const data = await jpdb('list-user-decks', { fields: ['id', 'name', 'vocabulary_count'] });
    fillDecks(data.decks.map(([id, name, count]) => ({ id, name, count })));
    $('keyMsg').textContent = 'Key works.';
    if (reader.book) loadChapter(reader.chapter, { block: currentBlock() });
  } catch (e) {
    $('keyMsg').textContent = e.code === 'bad_key' ? 'jpdb did not accept this key.' : e.message;
  }
}
function fillDecks(decks) {
  const sel = $('deckSelect');
  sel.innerHTML = decks.length ? decks.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('') : '<option value="">Create a deck on jpdb.io first</option>';
  sel.disabled = !decks.length;
  if (decks.length) {
    if (!decks.some((d) => String(d.id) === String(settings.deck))) settings.deck = String(decks[0].id);
    sel.value = settings.deck;
    saveSettings();
  }
  try { localStorage.setItem('yomu.decks', JSON.stringify(decks)); } catch {}
}

/* =========================================================
   Wiring
   ========================================================= */
function init() {
  applySettings();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applySettings);
  $('keyInput').value = settings.key;
  try { const d = JSON.parse(localStorage.getItem('yomu.decks') || '[]'); if (d.length) fillDecks(d); } catch {}

  $('fileInput').addEventListener('change', (e) => { closeSheet(); addBookFile(e.target.files[0]); e.target.value = ''; });
  $('addBookBtn').addEventListener('click', async () => {
    if (!webMod) { webMod = await import(`./webnovel.js${V}`); webMod.init(); }
    webMod.resetSheet();
    openSheet('addSheet');
  });
  $('editBtn').addEventListener('click', () => { editing = !editing; renderShelf(); });
  $('tabLibrary').addEventListener('click', () => showTab('library'));
  $('tabDiscover').addEventListener('click', () => showTab('discover'));
  try { if (localStorage.getItem('yomu.tab') === 'discover') showTab('discover'); } catch {}
  $('shelf').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const id = rm.dataset.remove;
      const b = await db.get('books', id);
      if (confirm(`Remove "${b?.title}" from this phone?`)) {
        await db.del('books', id); await db.del('files', id); await db.del('progress', id); await db.delPrefix('parsed', id + '/');
        renderShelf();
      }
      return;
    }
    const op = e.target.closest('[data-open]');
    if (op && !editing) openBook(op.dataset.open);
  });

  $('backBtn').addEventListener('click', closeBook);
  $('tocBtn').addEventListener('click', () => {
    const { toc, spine } = reader.epub;
    const items = toc.length ? toc : spine.map((h, i) => ({ label: `Part ${i + 1}`, href: h, frag: '' }));
    $('tocList').innerHTML = items.map((t, i) =>
      `<li><button data-i="${i}" class="${spine.indexOf(t.href) === reader.chapter ? 'current' : ''}">${esc(t.label)}</button></li>`).join('');
    $('tocList').onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const t = items[+b.dataset.i];
      closeSheet();
      loadChapter(spine.indexOf(t.href), { frag: t.frag });
    };
    showOfflineState();
    openSheet('tocSheet');
  });
  $('readerSettingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
  $('offlineBtn').addEventListener('click', () => saveWholeBook());
  window.addEventListener('online', flushPending);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { flushPending(); checkRemoteWhileReading(); }
    else pushPosition(true);   // leaving the app: save your place right away
  });
  $('ghConnectBtn').addEventListener('click', connectSync);
  $('dictBtn').addEventListener('click', toggleDict);
  refreshDictState();
  window.addEventListener('online', () => { reader.offline = false; });
  $('ghInput').value = settings.ghToken;
  showSyncState();
  setTimeout(flushPending, 1500);
  $('libSettingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
  $('scrim').addEventListener('click', closeSheet);
  $('learnBtn').addEventListener('click', startLearning);
  document.addEventListener('selectionchange', onSelection);
  $('explainPill').addEventListener('click', () => {
    const s = selectedInBook();
    $('explainPill').hidden = true;
    if (!s) return;
    window.getSelection().removeAllRanges();
    explain(s.text, s.context);
  });
  refreshLearn();
  document.querySelectorAll('.sheet').forEach(enableSheetSwipe);
  document.querySelectorAll('.close-sheet').forEach((b) => b.addEventListener('click', closeSheet));

  $('finishBtn').addEventListener('click', () => setFinished(!reader.book?.finished));
  $('text').addEventListener('click', (e) => {
    if (e.target.closest('#nextChapter')) return loadChapter(reader.chapter + 1);
    if (e.target.closest('#chapterLearn')) return startLearning();
    if (e.target.closest('#moreEpisodes')) return moreEpisodes();
    const link = e.target.closest('[data-target]');
    if (link) {
      const t = link.dataset.target;
      if (/^https?:/i.test(t)) return window.open(t, '_blank', 'noopener');
      const [path, frag] = t.split('#');
      const i = reader.epub.spine.indexOf(path);
      if (i >= 0) return loadChapter(i, { frag: frag || '' });
    }
    const w = e.target.closest('.w');
    if (w) return openWord(w);
    if (window.getSelection()?.toString()) return;
    tapZone(e.clientX);
  });
  // Taps in the margins around the text also turn pages.
  $('page').addEventListener('click', (e) => { if (e.target === $('page')) tapZone(e.clientX); });
  // Swipes: the page follows your finger.
  let suppressClick = false;
  $('page').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { slide.drag = null; return; }
    dragStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  $('page').addEventListener('touchmove', (e) => {
    if (slide.drag) dragMove(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });
  const endTouch = () => { if (dragEnd()) { suppressClick = true; setTimeout(() => (suppressClick = false), 400); } };
  $('page').addEventListener('touchend', endTouch);
  $('page').addEventListener('touchcancel', endTouch);
  $('page').addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  window.addEventListener('resize', () => { if (reader.book) relayoutKeeping(currentBlock()); });

  $('addBtn').addEventListener('click', () => {
    const name = $('deckSelect').selectedOptions[0]?.textContent || 'your deck';
    addCurrent(settings.deck ? Number(settings.deck) : null, ['new'], `Added to ${name}.`);
  });
  $('knownBtn').addEventListener('click', () => addCurrent('never-forget', ['never-forget'], 'Marked as known.'));

  $('checkKeyBtn').addEventListener('click', checkKey);
  $('deckSelect').addEventListener('change', (e) => { settings.deck = e.target.value; saveSettings(); });
  document.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const block = reader.book ? currentBlock() : 0;
    settings[seg.dataset.setting] = b.dataset.value;
    saveSettings();
    if (['direction', 'font'].includes(seg.dataset.setting)) relayoutKeeping(block);
  }));
  const resize = (d) => {
    const block = reader.book ? currentBlock() : 0;
    settings.size = Math.max(14, Math.min(34, settings.size + d));
    saveSettings();
    relayoutKeeping(block);
  };
  $('sizeDown').addEventListener('click', () => resize(-2));
  $('sizeUp').addEventListener('click', () => resize(2));
  $('sentenceToggle').addEventListener('change', (e) => { settings.sentence = e.target.checked; saveSettings(); });
  $('marksToggle').addEventListener('change', (e) => { settings.underline = e.target.checked; saveSettings(); });
  $('animateToggle').addEventListener('change', (e) => { settings.animate = e.target.checked; saveSettings(); });
  $('awakeToggle').addEventListener('change', (e) => { settings.awake = e.target.checked; saveSettings(); keepAwake(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeSheet();
    if (!reader.book || openSheetId) return;
    const forward = pager.vertical ? 'ArrowLeft' : 'ArrowRight';
    const back = pager.vertical ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); nextPage(); }
    else if (e.key === back || e.key === 'PageUp') { e.preventDefault(); prevPage(); }
  });

  // Ask the browser to keep stored books even when space runs low.
  navigator.storage?.persist?.().catch(() => {});
  sendPendingToHibi();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  renderShelf();
}

// Shared with the Discover screen (discover.js).
window.yomu = {
  get settings() { return settings; }, speed, vocab, parseTexts, toast, openSheet, closeSheet,
  addBookBuffer, findAozoraBook, findWebBook, openBook,
  jpdb, learnList, learned, refreshLearn,
};

init();

