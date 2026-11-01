// Yomu — a Japanese EPUB reader with jpdb readings and deck saving.
// Everything runs on the phone. The only network calls go to jpdb.io.

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================
   Settings (small values, kept in localStorage)
   ========================================================= */
const DEFAULTS = { key: '', deck: '', furigana: 'unknown', direction: 'vertical', size: 19, sentence: true, theme: 'auto', font: 'mincho', underline: false, animate: true };
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
function guessType(p) {
  const ext = p.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream';
}

/* =========================================================
   jpdb
   ========================================================= */
const TOKEN_FIELDS = ['vocabulary_index', 'position', 'length', 'furigana'];
const VOCAB_FIELDS = ['vid', 'sid', 'spelling', 'reading', 'meanings_chunks', 'meanings_part_of_speech', 'card_state'];

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
    const [vid, sid, spelling, reading, chunks, pos, card_state] = v;
    const key = vid + '/' + sid;
    vocab.set(key, { key, vid, sid, spelling, reading, meanings: chunks.map((g, i) => ({ g, pos: pos[i] || [] })), state: card_state });
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
function wrapTokens(data, tokens) {
  const { text, segs, rubies } = data;
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
      span.className = 'w ' + stateClass(v?.state);
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
  const rec = await db.get('books', id);
  const buf = await db.get('files', id);
  if (!rec || !buf) return toast('This book is missing. Try adding it again.');
  try {
    reader.epub = await openEpub(buf);
  } catch (e) {
    return toast('This book could not be opened.');
  }
  reader.book = rec;
  rec.lastOpened = Date.now();
  db.put('books', rec);
  $('readerTitle').textContent = rec.title;
  show('reader');
  const prog = (await db.get('progress', id)) || { chapter: 0, block: 0 };
  await loadChapter(Math.min(prog.chapter, reader.epub.spine.length - 1), { block: prog.block || 0, page: prog.page ?? null, sig: prog.sig || '' });
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
function rememberTokens(b, text, tokens) {
  if (!cache.data) return;
  cache.data.blocks[b] = { h: hashText(text), t: tokens.map((t) => [t.key, t.start, t.end, t.rubies.map((r) => [r.start, r.end, r.text])]) };
  for (const t of tokens) { const v = vocab.get(t.key); if (v) cache.data.vocab[t.key] = v; }
  saveCacheSoon();
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
  $('pageNum').textContent = `${pager.page + 1} / ${pager.count}`;
  if (save) saveProgress();
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

async function loadChapter(index, { block = 0, frag = '', page: pageArg = null, sig = '' } = {}) {
  reader.stopped = true;
  reader.observer?.disconnect();
  reader.queue = [];
  reader.chapter = index;
  const href = reader.epub.spine[index];
  const doc = parseXml(await reader.epub.file(href).async('string'));
  const body = doc.body || byLocal(doc, 'body')[0];
  const root = $('text');
  root.innerHTML = '';

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
  for (const img of frag2.querySelectorAll('img')) img.setAttribute('src', await imageUrl(resolvePath(href, img.getAttribute('src') || '')));
  for (const im of frag2.querySelectorAll('image')) {
    const h = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const u = await imageUrl(resolvePath(href, h));
    im.setAttribute('href', u);
    im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u);
  }
  for (const a of frag2.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    a.dataset.target = /^[a-z]+:/i.test(h) ? h : resolvePath(href, h) + (h.includes('#') ? '#' + h.split('#')[1] : '');
    a.removeAttribute('href');
  }
  root.appendChild(frag2);

  // Footer: next chapter
  const end = document.createElement('div');
  end.className = 'chapter-end';
  if (index < reader.epub.spine.length - 1) end.innerHTML = '<button class="btn" id="nextChapter">Next chapter</button>';
  else end.innerHTML = '<span class="hint">End of the book</span>';
  root.appendChild(end);

  // Find the paragraphs worth sending to jpdb.
  reader.blocks = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (!BLOCKS.has(el.localName) || el.closest('.chapter-end')) return false;
    for (const c of el.querySelectorAll('*')) if (BLOCKS.has(c.localName) || c.localName === 'img' || c.localName === 'svg') return false;
    return JP.test(el.textContent);
  });
  reader.blocks.forEach((el, i) => (el.dataset.b = i));
  reader.blocks.forEach(addTateChuYoko);

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
  if (settings.key) reader.blocks.forEach((b) => { if (!b.dataset.parsed) reader.observer.observe(b); });
  if (reader.blocks.every((b) => b.dataset.parsed)) pump();   // nothing to fetch on screen: go straight to saving the rest
  refreshWordStates(index);
  markGhostDirty();
  saveProgress();
}

async function pump() {
  if (reader.running || !settings.key) return;
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
      $('pageNum').textContent = `${pager.page + 1} / ${pager.count}`;
      markGhostDirty();
      errors = 0;
    } catch (e) {
      batch.forEach((b) => delete b.el.dataset.parsed);
      if (batch.every((b) => b.prefetch)) { if (e.code === 'offline' || e.code === 'bad_key') break; await sleep(2000); continue; }
      const onScreen = batch.filter((b) => !b.prefetch);
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
    db.put('progress', { chapter: reader.chapter, block: currentBlock(), page: pager.page, sig: pager.sig }, reader.book.id);
    reader.book.chapter = reader.chapter;
    db.put('books', reader.book);
  }, 400);
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

function openWord(el) {
  const v = vocab.get(el.dataset.k);
  if (!v) return;
  document.querySelectorAll('.w.sel').forEach((x) => x.classList.remove('sel'));
  el.classList.add('sel');
  current = { v, el, sentence: sentenceAround(el) };
  $('wSpelling').textContent = v.spelling;
  $('wReading').textContent = v.reading !== v.spelling ? v.reading : '';
  const st = $('wState');
  st.textContent = stateLabel(v.state);
  st.className = 'word-state' + (v.state ? '' : ' none');
  $('wMeanings').innerHTML = v.meanings.slice(0, 5).map((m) =>
    `<li>${esc(m.g.join('; '))}${m.pos.length ? `<span class="pos">${esc(m.pos.join(', '))}</span>` : ''}</li>`).join('');
  const s = current.sentence;
  $('wSentence').innerHTML = `${esc(s.before)}<b>${esc(s.word)}</b>${esc(s.after)}`;
  const deckName = $('deckSelect').selectedOptions[0]?.textContent;
  $('addBtn').textContent = settings.deck && deckName ? `Add to ${deckName}` : 'Add to deck';
  $('addBtn').disabled = false;
  $('knownBtn').disabled = false;
  $('wMsg').textContent = '';
  openSheet('wordSheet');
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

async function addCurrent(deckId, newState, doneMsg) {
  if (!current) return;
  if (!settings.key) return ($('wMsg').textContent = 'Add your jpdb key in Settings first.');
  if (deckId === null) return ($('wMsg').textContent = 'Choose a deck in Settings first.');
  const { v, sentence } = current;
  $('addBtn').disabled = $('knownBtn').disabled = true;
  $('wMsg').textContent = 'Saving…';
  try {
    await jpdb('deck/add-vocabulary', { id: deckId, vocabulary: [[v.vid, v.sid]] });
    if (settings.sentence && deckId !== 'never-forget' && sentence.full.length <= 300) {
      try { await jpdb('set-card-sentence', { vid: v.vid, sid: v.sid, sentence: sentence.full }); } catch {}
    }
    v.state = newState;
    updateWordEverywhere(v);
    $('wMsg').textContent = doneMsg;
  } catch (e) {
    $('wMsg').textContent = e.code === 'bad_deck' ? 'That deck no longer exists. Pick another in Settings.' : e.message;
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
function show(screen) {
  $('library').hidden = screen !== 'library';
  $('reader').hidden = screen !== 'reader';
  $('readerBar').classList.remove('hide');
}

/* =========================================================
   Library
   ========================================================= */
let editing = false;
const coverUrls = [];

async function renderShelf() {
  coverUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const books = (await db.all('books')).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
  $('emptyShelf').hidden = books.length > 0;
  $('libSub').innerHTML = books.length ? `${books.length} ${books.length === 1 ? 'book' : 'books'}<span class="jp">本棚</span>` : '<span class="jp">本棚</span>';
  $('editBtn').hidden = books.length === 0;
  if (!books.length) editing = false;
  $('editBtn').textContent = editing ? 'Done' : 'Edit';
  $('shelf').innerHTML = '';
  for (const b of books) {
    const el = document.createElement('div');
    el.className = 'book-item';
    let cover;
    if (b.cover) {
      const u = URL.createObjectURL(b.cover);
      coverUrls.push(u);
      cover = `<div class="book-cover"><img src="${u}" alt=""></div>`;
    } else cover = `<div class="book-cover"><div class="book-spine">${esc(b.title)}${b.author ? `<span class="sa">${esc(b.author)}</span>` : ''}</div></div>`;
    const prog = !b.lastOpened ? 'Not started' : b.chapters > 1 ? `Chapter ${(b.chapter || 0) + 1} of ${b.chapters}` : 'Started';
    const pct = b.lastOpened && b.chapters ? Math.round(((b.chapter || 0) + 1) / b.chapters * 100) : 0;
    el.innerHTML = `<button class="book" data-open="${b.id}" aria-label="Open ${esc(b.title)}">${cover}
      <div class="book-meta"><div class="t">${esc(b.title)}</div><div class="p">${b.lastOpened ? prog : esc(b.author || 'Not started')}</div>${pct ? `<div class="book-bar"><span style="width:${pct}%"></span></div>` : ''}</div></button>
      ${editing ? `<button class="book-remove" data-remove="${b.id}" aria-label="Remove ${esc(b.title)}">✕</button>` : ''}`;
    $('shelf').appendChild(el);
  }
}

async function addBookFile(file) {
  if (!file) return;
  toast('Adding book…');
  try {
    const buf = await file.arrayBuffer();
    const epub = await openEpub(buf);
    if (!epub.spine.length) throw new Error('empty');
    const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await db.put('files', buf, id);
    await db.put('books', { id, title: epub.title, author: epub.author, cover: await coverBlob(epub), chapters: epub.spine.length, chapter: 0, added: Date.now() });
    toast(`Added ${epub.title}`);
    renderShelf();
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

  $('fileInput').addEventListener('change', (e) => { addBookFile(e.target.files[0]); e.target.value = ''; });
  $('editBtn').addEventListener('click', () => { editing = !editing; renderShelf(); });
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
    openSheet('tocSheet');
  });
  $('readerSettingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
  $('libSettingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
  $('scrim').addEventListener('click', closeSheet);
  document.querySelectorAll('.close-sheet').forEach((b) => b.addEventListener('click', closeSheet));

  $('text').addEventListener('click', (e) => {
    if (e.target.closest('#nextChapter')) return loadChapter(reader.chapter + 1);
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
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  renderShelf();
}

init();

