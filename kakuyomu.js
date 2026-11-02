// Kakuyomu: add a story from kakuyomu.jp by pasting its link.
// Kakuyomu doesn't let other websites read its pages directly, so pages come
// through a small relay (serve.py on the Mac, relay/worker.js online). The relay
// only passes on Kakuyomu story pages. Episodes are fetched a few at a time,
// slowly, and kept only on this device, never in the GitHub repository.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The online relay's address. Empty until the Cloudflare relay is set up (see relay/README.md).
const ONLINE_RELAY = '';
const RELAY = /github\.io$/.test(location.hostname) ? ONLINE_RELAY : 'relay';
const BATCH = 10;        // episodes per download
const GAP = 1200;        // wait between pages, to keep the load on Kakuyomu light

/* ---------- Reading Kakuyomu pages ---------- */

export function parseLink(text) {
  const m = String(text).match(/kakuyomu\.jp\/works\/(\d+)(?:\/episodes\/(\d+))?/);
  return m ? { work: m[1], episode: m[2] || null } : null;
}

async function page(path) {
  if (!RELAY) throw new Error('Kakuyomu isn’t connected on the online version of Yomu yet.');
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {   // a page sometimes fails once; try again after a pause
    if (attempt) await sleep(3000);
    try { res = await fetch(`${RELAY}?path=${encodeURIComponent(path)}`); } catch { res = null; continue; }
    if (res.ok || res.status < 500) break;
  }
  if (!res) throw new Error('Kakuyomu couldn’t be reached. Check your connection.');
  if (res.status === 404) throw new Error('This story wasn’t found on Kakuyomu. It may have been removed or made private.');
  if (!res.ok) throw new Error('Kakuyomu couldn’t be reached right now. Try again in a minute.');
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

// Title, author, introduction and the list of episodes, from the story's main page.
async function getWork(id) {
  const doc = await page(`/works/${id}`);
  const raw = doc.getElementById('__NEXT_DATA__')?.textContent;
  const st = raw && JSON.parse(raw)?.props?.pageProps?.__APOLLO_STATE__;
  const w = st?.[`Work:${id}`];
  if (!w) throw new Error('This page doesn’t look like a Kakuyomu story.');
  const ref = (r) => (r && r.__ref ? st[r.__ref] : null);
  const episodes = [];
  for (const t of w.tableOfContentsV2 || w.tableOfContents || []) {
    const part = ref(t);
    const heading = ref(part?.chapter)?.title || '';
    (part?.episodeUnions || []).forEach((e, i) => {
      const ep = ref(e);
      if (ep?.__typename === 'Episode') episodes.push({ id: ep.id, title: ep.title, heading: i === 0 ? heading : '' });
    });
  }
  return {
    id, title: w.title, author: ref(w.author)?.activityName || w.alternateAuthorName || '',
    intro: w.introduction || '', catchphrase: w.catchphrase || '',
    chars: w.totalCharacterCount || 0, finished: w.serialStatus === 'COMPLETED', episodes,
  };
}

// One episode's paragraphs, keeping the author's readings and emphasis dots.
async function getEpisode(workId, ep) {
  const doc = await page(`/works/${workId}/episodes/${ep.id}`);
  const body = doc.querySelector('.widget-episodeBody');
  if (!body) throw new Error('An episode couldn’t be read.');
  const inline = (node) => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) s += esc(n.data);
      else if (n.nodeType !== 1) continue;
      else if (n.localName === 'ruby') {
        const rt = Array.from(n.querySelectorAll('rt')).map((x) => x.textContent).join('');
        const base = n.querySelector('rb') ? Array.from(n.querySelectorAll('rb')).map((x) => x.textContent).join('')
          : Array.from(n.childNodes).filter((x) => x.nodeType === 3).map((x) => x.data).join('');
        s += rt ? `<ruby>${esc(base)}<rt>${esc(rt)}</rt></ruby>` : esc(base);
      } else if (n.localName === 'em') s += `<em class="sesame_dot">${esc(n.textContent)}</em>`;
      else if (n.localName === 'rp' || n.localName === 'br') continue;
      else s += inline(n);
    }
    return s;
  };
  return Array.from(body.querySelectorAll('p')).map((p) => (p.classList.contains('blank') || !p.textContent.trim() ? '' : inline(p)));
}

/* ---------- Building the book ---------- */

const XHTML = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja"><head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
const fileName = (i) => `ep${String(i + 1).padStart(4, '0')}.xhtml`;

// Add episodes to a book (a new one when zip is null) and rewrite its contents list.
async function addEpisodes(zip, work, from, count, onStep) {
  if (!zip) {
    zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/style.css', '.sesame_dot{text-emphasis-style:sesame;-webkit-text-emphasis-style:sesame;font-style:normal}');
  }
  const eps = work.episodes.slice(from, from + count);
  for (let i = 0; i < eps.length; i++) {
    const ep = eps[i], n = from + i;
    onStep?.(i, eps.length);
    if (i) await sleep(GAP);
    const paras = await getEpisode(work.id, ep);
    const top = (n === 0 ? `<h1>${esc(work.title)}</h1><p>${esc(work.author)}</p><p><br/></p>` : '')
      + (ep.heading ? `<h2>${esc(ep.heading)}</h2>` : '') + `<h3>${esc(ep.title)}</h3>`;
    zip.file('OEBPS/' + fileName(n), XHTML(ep.title, top + paras.map((p) => (p ? `<p>${p}</p>` : '<p><br/></p>')).join('')));
  }
  const have = from + eps.length;
  const list = work.episodes.slice(0, have);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head><body><nav epub:type="toc"><ol>${list.map((e, i) => `<li><a href="${fileName(i)}">${esc(e.title)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid" xml:lang="ja"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">kakuyomu-${work.id}</dc:identifier><dc:title>${esc(work.title)}</dc:title><dc:creator>${esc(work.author)}</dc:creator><dc:language>ja</dc:language><dc:publisher>カクヨム</dc:publisher><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${list.map((_, i) => `<item id="e${i}" href="${fileName(i)}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine page-progression-direction="rtl">${list.map((_, i) => `<itemref idref="e${i}"/>`).join('')}</spine></package>`);
  return { zip, have };
}

const kakuyomuInfo = (work, have) => ({ work: work.id, have, total: work.episodes.length, finished: work.finished });

/* ---------- Add from a link ---------- */

export async function addFromLink(text, msg) {
  const link = parseLink(text);
  if (!link) throw new Error('Paste a link to a story on kakuyomu.jp.');
  const existing = await Y().findKakuyomuBook(link.work);
  if (existing) return { id: existing, existed: true };
  msg('Reading the story’s contents…');
  const work = await getWork(link.work);
  if (!work.episodes.length) throw new Error('This story has no episodes to read yet.');
  await sleep(GAP);
  const { zip, have } = await addEpisodes(null, work, 0, BATCH, (i, n) => msg(`Downloading episode ${i + 1} of ${n}…`));
  const buf = await (await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })).arrayBuffer();
  const id = await Y().addBookBuffer(buf, { kakuyomu: kakuyomuInfo(work, have) });
  return { id, existed: false };
}

// Fetch the next episodes of a book that's open, then rebuild it in place.
export async function getMore(rec, buf, msg) {
  msg('Checking for new episodes…');
  const work = await getWork(rec.kakuyomu.work);
  const from = rec.kakuyomu.have;
  if (from >= work.episodes.length) return { added: 0, rec: { ...rec, kakuyomu: kakuyomuInfo(work, from) } };
  await sleep(GAP);
  const zip = await JSZip.loadAsync(buf);
  const { zip: z, have } = await addEpisodes(zip, work, from, BATCH, (i, n) => msg(`Downloading episode ${from + i + 1} of ${from + n}…`));
  const out = await (await z.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })).arrayBuffer();
  return { added: have - from, buf: out, rec: { ...rec, kakuyomu: kakuyomuInfo(work, have) } };
}

/* ---------- The add sheet ---------- */

let added = null;   // id of the book just added, so the button can open it

export function init() {
  $('kkAdd').addEventListener('click', async () => {
    const btn = $('kkAdd'), say = (t) => ($('kkMsg').textContent = t);
    if (added) { const id = added; resetSheet(); return Y().openBook(id); }
    btn.disabled = true;
    try {
      const { id, existed } = await addFromLink($('kkLink').value, say);
      $('kkLink').value = '';
      say(existed ? 'This story is already in your library.' : 'Added to your library.');
      added = id;
      btn.textContent = 'Open';
    } catch (e) {
      say(e.message || 'Something went wrong.');
    } finally {
      btn.disabled = false;
    }
  });
  $('kkLink').addEventListener('input', () => { if (added) resetSheet(true); });
}

export function resetSheet(keepLink = false) {
  if (!keepLink) $('kkLink').value = '';
  added = null;
  $('kkMsg').textContent = '';
  $('kkAdd').textContent = 'Add';
}
