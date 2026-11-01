// Offline dictionary: a Japanese word splitter (kuromoji) plus JMdict meanings.
// Used only when a page has no saved jpdb readings and jpdb can't be reached.
// The files (about 25 MB) are downloaded once from Settings and kept on the phone.

const DICT_CACHE = 'yomu-dict-v1';
const KUROMOJI_FILES = ['base', 'cc', 'check', 'tid', 'tid_map', 'tid_pos', 'unk', 'unk_char', 'unk_compat', 'unk_invoke', 'unk_map', 'unk_pos']
  .map((n) => `dict/kuromoji/${n}.dat.gz`);
export const DICT_FILES = [...KUROMOJI_FILES, 'dict/jmdict.tsv.gz', 'vendor/kuromoji.js'];

let tokenizer = null;
let entries = null;     // line per JMdict entry
let index = null;       // spelling -> [line numbers]
let loading = null;

// Fetch every file once and keep it in the browser's storage for offline use.
// Browsers only allow storage like this on secure (https) pages; on a plain
// local test address the files are simply fetched each time.
const hasCaches = () => typeof caches !== 'undefined' && window.isSecureContext;

export async function download(onProgress) {
  if (!hasCaches()) { onProgress?.(1); try { localStorage.setItem('yomu.dict', '1'); } catch {} return; }
  const cache = await caches.open(DICT_CACHE);
  let done = 0;
  for (const f of DICT_FILES) {
    if (!(await cache.match(f))) {
      const res = await fetch(f, { cache: 'no-store' });
      if (!res.ok) throw new Error('Download failed. Check your connection and try again.');
      await cache.put(f, res);
    }
    onProgress?.(++done / DICT_FILES.length);
  }
  try { localStorage.setItem('yomu.dict', '1'); } catch {}
}
export async function isDownloaded() {
  try {
    if (localStorage.getItem('yomu.dict') !== '1') return false;
    if (!hasCaches()) return true;
    const cache = await caches.open(DICT_CACHE);
    return !!(await cache.match('dict/jmdict.tsv.gz'));
  } catch { return false; }
}
export async function remove() {
  try { localStorage.removeItem('yomu.dict'); } catch {}
  tokenizer = entries = index = loading = null;
  if (hasCaches()) await caches.delete(DICT_CACHE);
}

async function cachedResponse(path) {
  if (!hasCaches()) return fetch(path);
  const cache = await caches.open(DICT_CACHE);
  return (await cache.match(path)) || fetch(path);
}
async function gunzipText(res) {
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);   // already unpacked by the server
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

// kuromoji reads its files with XMLHttpRequest; serve those requests from storage.
function serveKuromojiFromCache() {
  const Orig = window.XMLHttpRequest;
  if (Orig.__yomu) return;
  function Patched() {
    const xhr = new Orig();
    let url = '';
    const open = xhr.open;
    xhr.open = function (m, u, ...rest) { url = u; return open.call(xhr, m, u, ...rest); };
    const send = xhr.send;
    xhr.send = function (...a) {
      if (!/dict\/kuromoji\//.test(url)) return send.apply(xhr, a);
      const path = 'dict/kuromoji/' + url.split('dict/kuromoji/')[1];
      cachedResponse(path).then((r) => r.arrayBuffer()).then((ab) => {
        Object.defineProperty(xhr, 'status', { value: 200 });
        Object.defineProperty(xhr, 'response', { value: ab });
        Object.defineProperty(xhr, 'readyState', { value: 4 });
        xhr.onload?.({ target: xhr });
      }).catch((e) => xhr.onerror?.(e));
    };
    return xhr;
  }
  Patched.__yomu = true;
  window.XMLHttpRequest = Patched;
}

async function loadScript(path) {
  if (window.kuromoji) return;
  const res = await cachedResponse(path);
  const code = await res.text();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  await new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = url; s.onload = ok; s.onerror = fail;
    document.head.appendChild(s);
  });
}

export function ready() {
  if (!loading) loading = (async () => {
    await loadScript('vendor/kuromoji.js');
    serveKuromojiFromCache();
    tokenizer = await new Promise((ok, fail) =>
      window.kuromoji.builder({ dicPath: 'dict/kuromoji/' }).build((err, t) => (err ? fail(err) : ok(t))));
    const text = await gunzipText(await cachedResponse('dict/jmdict.tsv.gz'));
    entries = text.split('\n');
    index = new Map();
    entries.forEach((line, i) => {
      const [, kebs, rebs] = line.split('\t', 3);
      for (const sp of [...(kebs ? kebs.split(',') : []), ...rebs.split(',')]) {
        const l = index.get(sp);
        if (l) l.push(i); else index.set(sp, [i]);
      }
    });
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

const toHira = (s) => (s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hasKanji = (s) => /[㐀-鿿豈-﫿々〆]/.test(s);

// Look a word up in JMdict. Prefers the entry whose reading matches.
export function lookup(spelling, readingHint) {
  const ids = index?.get(spelling) || [];
  let best = null;
  for (const i of ids) {
    const [seq, kebs, rebs, senses] = entries[i].split('\t');
    const readings = rebs.split(',');
    const e = { seq: +seq, spelling: kebs ? (kebs.split(',').includes(spelling) ? spelling : kebs.split(',')[0]) : readings[0], reading: readings[0],
      meanings: senses.split('|').map((s) => { const [pos, g] = s.split('^'); return { g: g.split('; '), pos: pos ? pos.split(',') : [] }; }) };
    if (readingHint && readings.includes(readingHint)) { e.reading = readingHint; return e; }
    if (!best) best = e;
  }
  return best;
}

// Put a reading over only the kanji part of a word: 食べ + たべ -> 食(た)べ
function alignRuby(surface, reading, offset) {
  if (!hasKanji(surface) || !reading) return [];
  let a = 0, b = surface.length, ra = 0, rb = reading.length;
  while (a < b && ra < rb && !hasKanji(surface[a]) && toHira(surface[a]) === reading[ra]) { a++; ra++; }
  while (b > a && rb > ra && !hasKanji(surface[b - 1]) && toHira(surface[b - 1]) === reading[rb - 1]) { b--; rb--; }
  if (a >= b || ra >= rb) return [];
  return [{ start: offset + a, end: offset + b, text: reading.slice(ra, rb) }];
}

const CONTENT = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '感動詞', '接頭詞']);

// Split text into words, in the same shape the app uses for jpdb's results.
export function parse(text, knownState) {
  const raw = tokenizer.tokenize(text);
  const out = [];
  const words = {};
  let pos = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const start = pos;
    pos += t.surface_form.length;
    const p = t.pos, d1 = t.pos_detail_1;
    if (!CONTENT.has(p) || (p === '名詞' && /数|非自立|代名詞|接尾/.test(d1)) || /^[\s\p{P}]+$/u.test(t.surface_form)) continue;
    // Keep a verb or adjective together with its endings (見ていた), like jpdb does.
    let end = pos;
    const rubies = alignRuby(t.surface_form, toHira(t.reading), start);
    if (p === '動詞' || p === '形容詞') {
      while (i + 1 < raw.length) {
        const n = raw[i + 1];
        const joins = n.pos === '助動詞' || (n.pos === '動詞' && /非自立|接尾/.test(n.pos_detail_1)) ||
          (n.pos === '形容詞' && n.pos_detail_1 === '非自立') || (n.pos === '助詞' && n.pos_detail_1 === '接続助詞' && /^[てで]$/.test(n.surface_form));
        if (!joins) break;
        rubies.push(...alignRuby(n.surface_form, toHira(n.reading), end));
        end += n.surface_form.length; pos = end; i++;
      }
    }
    const base = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
    const hint = p === '名詞' ? toHira(t.reading) : null;
    const e = lookup(base, hint) || lookup(t.surface_form, toHira(t.reading));
    if (!e && !hasKanji(t.surface_form)) continue;   // unknown kana: nothing useful to show
    const key = 'L:' + (e ? e.seq : base);
    if (!words[key]) {
      words[key] = { key, vid: null, sid: null, local: true, spelling: e ? e.spelling : base, reading: e ? e.reading : toHira(t.reading),
        meanings: e ? e.meanings : [], state: knownState?.(e ? e.spelling : base) ?? null };
    }
    out.push({ key, start, end, rubies });
  }
  return { tokens: out, words };
}
