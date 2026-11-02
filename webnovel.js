// Web novels from Kakuyomu (kakuyomu.jp) and Narou (小説家になろう, syosetu.com):
// search them, read their first episode, and add them to the library.
// Neither site lets other websites read its pages, so pages come through a small
// relay (serve.py on the Mac, relay/worker.js online) that only passes on these
// sites' story, episode and search pages. Episodes are fetched a few at a time,
// slowly, and kept only on this device, never in the GitHub repository.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The online relays (see relay/README.md). Narou's episode pages refuse Vercel's servers,
// so they need a second relay; until it exists, Narou is left out of the online version.
const ONLINE = /github\.io$/.test(location.hostname);
const ONLINE_RELAY = 'https://yomu-vercel.vercel.app/api/relay';
const NAROU_EPISODE_RELAY = '';
const RELAY = ONLINE ? ONLINE_RELAY : 'web-relay';   // on the Mac, served by serve.py
const relayFor = (url) => (ONLINE && /^https:\/\/ncode\.syosetu\.com\//.test(url) ? NAROU_EPISODE_RELAY : RELAY);
export const narouReady = !ONLINE || !!NAROU_EPISODE_RELAY;
const BATCH = 10;        // episodes per download
const GAP = 1200;        // wait between episode pages, to keep the load on the sites light

export const SITES = { kakuyomu: 'Kakuyomu', narou: 'Narou' };
export const relayReady = !!RELAY;

/* ---------- Fetching through the relay ---------- */

async function fetchVia(url) {
  const relay = relayFor(url);
  if (!relay) throw new Error('Narou stories can’t be read in the online version of Yomu yet.');
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {   // a page sometimes fails once; try again after a pause
    if (attempt) await sleep(3000);
    try { res = await fetch(`${relay}?url=${encodeURIComponent(url)}`); } catch { res = null; continue; }
    if (res.ok || res.status < 500) break;
  }
  if (!res) throw new Error('The site couldn’t be reached. Check your connection.');
  if (res.status === 404 && !ONLINE && relay === RELAY && res.headers.get('X-Yomu-Relay') !== '1') throw new Error('Web novels need Yomu started with serve.py. In Terminal, in the yomu folder, run: python3 serve.py');
  if (res.status === 404) throw new Error('This story wasn’t found. It may have been removed or made private.');
  if (res.status === 400 && !ONLINE) throw new Error('The Mac’s relay is out of date. Stop serve.py in Terminal (Ctrl+C) and start it again.');
  if (!res.ok) throw new Error('The site couldn’t be reached right now. Try again in a minute.');
  return res.text();
}
const fetchDoc = async (url) => new DOMParser().parseFromString(await fetchVia(url), 'text/html');

// An official book cover, through the relay (the image site doesn't let other websites read it).
async function fetchImage(url) {
  const relay = relayFor(url);
  if (!relay || !url) return null;
  try {
    const res = await fetch(`${relay}?url=${encodeURIComponent(url)}`);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\//.test(type)) return null;
    // Kept as plain bytes: some browsers can't store image files in the app's database.
    return { type, data: await res.arrayBuffer() };
  } catch { return null; }
}
// Cover and colour for a Kakuyomu story already in the library (books added before covers existed).
export async function coverFor(site, id) {
  if (site !== 'kakuyomu') return { color: '', cover: null };
  const w = await kkWork(id);
  return { color: w.color, cover: w.cover ? await fetchImage(w.cover) : null };
}

/* ---------- Links ---------- */

export function parseLink(text) {
  const s = String(text);
  let m = s.match(/kakuyomu\.jp\/works\/(\d+)/);
  if (m) return { site: 'kakuyomu', work: m[1] };
  m = s.match(/(?:ncode|novel18)\.syosetu\.com\/(n[0-9a-z]+)/i);
  if (m) return { site: 'narou', work: m[1].toLowerCase() };
  return null;
}

/* ---------- Kakuyomu ---------- */

const KK_GENRES = { FANTASY: 'Other-world fantasy', ACTION: 'Modern fantasy', SF: 'Sci-fi', LOVE_STORY: 'Romance', ROMANCE: 'Romantic comedy', DRAMA: 'Drama', HORROR: 'Horror', MYSTERY: 'Mystery', NONFICTION: 'Essay', HISTORY: 'History', CRITICISM: 'Writing advice', OTHERS: 'Other' };

function apollo(doc) {
  const raw = doc.getElementById('__NEXT_DATA__')?.textContent;
  if (!raw) throw new Error(`Kakuyomu sent back a page Yomu didn’t expect (“${(doc.title || 'no title').slice(0, 60)}”).`);
  try { return JSON.parse(raw)?.props?.pageProps?.__APOLLO_STATE__ || null; }
  catch { throw new Error('Kakuyomu sent back a page Yomu couldn’t read.'); }
}
function kkStory(st, w) {
  const ref = (r) => (r && r.__ref ? st[r.__ref] : null);
  return {
    site: 'kakuyomu', id: w.id, title: w.title, author: ref(w.author)?.activityName || w.alternateAuthorName || '',
    pitch: w.catchphrase || '', intro: w.introduction || '', tags: w.tagLabels || [],
    genre: KK_GENRES[w.genre] || '', chars: +w.totalCharacterCount || 0, count: +w.publicEpisodeCount || 0,
    finished: w.serialStatus === 'COMPLETED', short: false, first: ref(w.firstPublicEpisodeUnion)?.id || null,
    url: `https://kakuyomu.jp/works/${w.id}`,
    // What readers think: total stars (each reader gives up to 3), whether it became a book,
    // and the headlines of a couple of reader reviews.
    stars: +w.totalReviewPoint || 0, book: !!w.hasPublication,
    // The colour the author picked for the story's page, and the official cover if it became a book.
    color: /^#[0-9a-f]{6}$/i.test(w.baseColor || '') ? w.baseColor : '', cover: w.adminCoverImageUrl || '',
    headlines: (w.textualWorkReviewsForCatchphraseInRandom || []).map((r) => ref(r)?.title).filter(Boolean),
  };
}

// Followers, reads, average stars and recent reader reviews, from a story's own page.
export async function readerDetails(story) {
  if (story.site === 'narou') {
    return { bookmarks: story.bookmarks, ratings: story.ratings, average: story.ratings ? story.points / story.ratings : 0, outOf: 10, reviewCount: story.reviewCount, reviews: [] };
  }
  const st = apollo(await fetchDoc(`https://kakuyomu.jp/works/${story.id}`));
  const w = st?.[`Work:${story.id}`];
  if (!w) return null;
  const ref = (r) => (r && r.__ref ? st[r.__ref] : null);
  const reviews = (ref(w.workTopWorkReviews)?.newTextualWorkReviews || []).map(ref)
    .filter((r) => r && r.isSpoiler !== true && r.body).slice(0, 3)
    .map((r) => ({ title: r.title || '', body: r.body.slice(0, 400), stars: +r.point || 0 }));
  const ratings = +w.reviewCount || 0;
  return { followers: +w.totalFollowers || 0, reads: +w.totalReadCount || 0, ratings, average: ratings ? (+w.totalReviewPoint || 0) / ratings : 0, outOf: 3, reviews };
}

// One page of Kakuyomu search results (20 stories).
async function kkSearch({ query = '', genres = [], order = 'popular' }) {
  const p = new URLSearchParams({ order });
  if (query) p.set('q', query);
  genres.forEach((g) => p.append('genre_name', g));
  const st = apollo(await fetchDoc(`https://kakuyomu.jp/search?${p}`));
  if (!st) return [];
  const key = Object.keys(st.ROOT_QUERY || {}).find((k) => k.startsWith('searchWorks'));
  return (st.ROOT_QUERY[key]?.nodes || []).map((n) => st[n.__ref]).filter(Boolean).map((w) => kkStory(st, w));
}

// A story's details and its list of episodes.
async function kkWork(id) {
  const st = apollo(await fetchDoc(`https://kakuyomu.jp/works/${id}`));
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
  return { ...kkStory(st, w), episodes };
}

/* ---------- Narou ---------- */

const NR_GENRES = { 101: 'Other-world romance', 102: 'Romance', 201: 'High fantasy', 202: 'Modern fantasy', 301: 'Literary', 302: 'Drama', 303: 'History', 304: 'Mystery', 305: 'Horror', 306: 'Action', 307: 'Comedy', 401: 'VR game', 402: 'Space', 403: 'Sci-fi', 404: 'Disaster', 9901: 'Fairy tale', 9902: 'Poetry', 9903: 'Essay', 9904: 'Replay', 9999: 'Other' };
const NR_FIELDS = 't-n-w-s-g-k-l-e-nt-ga-f-r-a-ah';

function nrStory(x) {
  const id = String(x.ncode).toLowerCase();
  return {
    site: 'narou', id, title: x.title, author: x.writer, pitch: '', intro: x.story || '',
    tags: String(x.keyword || '').split(/\s+/).filter(Boolean), genre: NR_GENRES[x.genre] || '',
    chars: +x.length || 0, count: +x.general_all_no || 1, finished: +x.end === 0, short: +x.noveltype === 2,
    first: +x.noveltype === 2 ? '' : '1', url: `https://ncode.syosetu.com/${id}/`,
    // What readers think: bookmarks, and ratings out of 10 (5 for the story, 5 for the writing).
    bookmarks: +x.fav_novel_cnt || 0, points: +x.all_point || 0, ratings: +x.all_hyoka_cnt || 0, reviewCount: +x.review_cnt || 0,
    book: /書籍化|コミカライズ/.test(x.title + ' ' + (x.story || '').slice(0, 200)), headlines: [],
  };
}
async function nrApi(params) {
  const p = new URLSearchParams({ out: 'json', of: NR_FIELDS, ...params });
  const text = await fetchVia(`https://api.syosetu.com/novelapi/api/?${p}`);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Narou sent back a page Yomu didn’t expect (“${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}”).`); }
  return data.slice(1).map(nrStory);
}
// One page of Narou search results. Keyword search looks only at the authors' tags.
const nrSearch = ({ word = '', genres = [], order = 'hyoka', lim = 20 }) =>
  nrApi({ order, lim, ...(word ? { word, keyword: 1 } : {}), ...(genres.length ? { genre: genres.join('-') } : {}) });

async function nrWork(id) {
  const [s] = await nrApi({ ncode: id });
  if (!s) throw new Error('This story wasn’t found on Narou.');
  const episodes = s.short ? [{ id: '', title: s.title, heading: '' }]
    : Array.from({ length: s.count }, (_, i) => ({ id: String(i + 1), title: '', heading: '' }));
  return { ...s, episodes };
}

/* ---------- Episodes ---------- */

// Turn an episode's paragraphs into simple, safe markup, keeping readings and emphasis dots.
function inline(node) {
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
    else if (n.localName === 'rp' || n.localName === 'br' || n.localName === 'img') continue;
    else s += inline(n);
  }
  return s;
}
const paras = (ps) => Array.from(ps).map((p) => (p.classList.contains('blank') || !p.textContent.trim() ? '' : inline(p)));

// Returns { title, paras } for one episode.
async function getEpisode(story, ep) {
  if (story.site === 'kakuyomu') {
    const doc = await fetchDoc(`https://kakuyomu.jp/works/${story.id}/episodes/${ep.id}`);
    const body = doc.querySelector('.widget-episodeBody');
    if (!body) throw new Error('An episode couldn’t be read.');
    return { title: ep.title || doc.querySelector('.widget-episodeTitle')?.textContent.trim() || '', paras: paras(body.querySelectorAll('p')) };
  }
  const doc = await fetchDoc(`https://ncode.syosetu.com/${story.id}/${ep.id ? ep.id + '/' : ''}`);
  const body = doc.querySelector('.p-novel__body');
  if (!body) throw new Error('An episode couldn’t be read.');
  // The main text only: leave out the author's notes before and after.
  const main = Array.from(body.querySelectorAll('.p-novel__text')).filter((d) => !/preface|afterword/.test(d.className));
  return { title: ep.title || doc.querySelector('.p-novel__title')?.textContent.trim() || '', paras: paras(main.flatMap((d) => Array.from(d.querySelectorAll('p')))) };
}

// The first episode's plain text, for the opening lines and the difficulty score.
const firsts = new Map();
export function firstEpisode(story) {
  const key = story.site + story.id;
  if (!firsts.has(key)) {
    const job = getEpisode(story, { id: story.first ?? '', title: '' }).then((e) => e.paras.map((p) => p.replace(/<rt>[^<]*<\/rt>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).filter(Boolean).join('\n'));
    job.catch(() => firsts.delete(key));
    firsts.set(key, job);
  }
  return firsts.get(key);
}

/* ---------- Search ---------- */

// Gather stories for a mood and genre from both sites. Each tag is one search,
// since neither site can search for "this tag or that tag" at once.
export async function search({ tags = [], kk = [], nr = [], order = 'popular' }) {
  const jobs = [];
  let firstError = null;
  const keep = (e) => { firstError = firstError || e; return []; };
  const words = tags.length ? tags : [''];
  for (const w of words) {
    jobs.push(kkSearch({ query: w, genres: kk, order }).catch(keep));
    if (narouReady) jobs.push(nrSearch({ word: w, genres: nr, order: order === 'popular' ? 'hyoka' : 'weekly' }).catch(keep));
  }
  const lists = await Promise.all(jobs);
  if (firstError && lists.every((l) => !l.length)) throw firstError;
  // Take turns between the result lists so both sites and every tag are represented.
  const seen = new Set(), out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const s = l[i];
      if (s && !seen.has(s.site + s.id)) { seen.add(s.site + s.id); out.push(s); }
    }
  }
  return out;
}

/* ---------- Building the book ---------- */

const XHTML = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja"><head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
const fileName = (i) => `ep${String(i + 1).padStart(4, '0')}.xhtml`;

async function addEpisodes(zip, work, from, count, onStep) {
  if (!zip) {
    zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/style.css', '.sesame_dot{text-emphasis-style:sesame;-webkit-text-emphasis-style:sesame;font-style:normal}');
  }
  // Titles of episodes already in the book, kept in the book itself.
  const titles = JSON.parse((await zip.file('OEBPS/titles.json')?.async('string')) || '[]');
  const eps = work.episodes.slice(from, from + count);
  for (let i = 0; i < eps.length; i++) {
    const ep = eps[i], n = from + i;
    onStep?.(i, eps.length);
    if (i) await sleep(GAP);
    const e = await getEpisode(work, ep);
    const title = e.title || `${n + 1}`;
    titles[n] = title;
    const top = (n === 0 ? `<h1>${esc(work.title)}</h1><p>${esc(work.author)}</p><p><br/></p>` : '')
      + (ep.heading ? `<h2>${esc(ep.heading)}</h2>` : '') + (work.short ? '' : `<h3>${esc(title)}</h3>`);
    zip.file('OEBPS/' + fileName(n), XHTML(title, top + e.paras.map((p) => (p ? `<p>${p}</p>` : '<p><br/></p>')).join('')));
  }
  const have = from + eps.length;
  zip.file('OEBPS/titles.json', JSON.stringify(titles));
  const list = titles.slice(0, have);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head><body><nav epub:type="toc"><ol>${list.map((t, i) => `<li><a href="${fileName(i)}">${esc(t)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid" xml:lang="ja"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">${work.site}-${work.id}</dc:identifier><dc:title>${esc(work.title)}</dc:title><dc:creator>${esc(work.author)}</dc:creator><dc:language>ja</dc:language><dc:publisher>${work.site === 'kakuyomu' ? 'カクヨム' : '小説家になろう'}</dc:publisher><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${list.map((_, i) => `<item id="e${i}" href="${fileName(i)}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine page-progression-direction="rtl">${list.map((_, i) => `<itemref idref="e${i}"/>`).join('')}</spine></package>`);
  return { zip, have };
}

const getWork = (site, id) => (site === 'kakuyomu' ? kkWork(id) : nrWork(id));
const webInfo = (work, have) => ({ site: work.site, work: work.id, have, total: work.episodes.length, finished: work.finished });
// Books added before Narou support stored their details under "kakuyomu".
export const webOf = (rec) => rec.web || (rec.kakuyomu ? { site: 'kakuyomu', ...rec.kakuyomu } : null);

/* ---------- Adding and extending ---------- */

// Add a story by its link, or by a search result ({ site, id }).
export async function addStory(target, msg) {
  const link = typeof target === 'string' ? parseLink(target) : { site: target.site, work: target.id };
  if (!link) throw new Error('Paste a link to a story on kakuyomu.jp or syosetu.com.');
  const existing = await Y().findWebBook(link.site, link.work);
  if (existing) return { id: existing, existed: true };
  msg('Reading the story’s contents…');
  const work = await getWork(link.site, link.work);
  if (!work.episodes.length) throw new Error('This story has no episodes to read yet.');
  await sleep(GAP);
  const { zip, have } = await addEpisodes(null, work, 0, BATCH, (i, n) => msg(n > 1 ? `Downloading episode ${i + 1} of ${n}…` : 'Downloading…'));
  const buf = await (await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })).arrayBuffer();
  const cover = work.cover ? await fetchImage(work.cover) : null;
  const id = await Y().addBookBuffer(buf, { web: webInfo(work, have), color: work.color || '', coverChecked: true, ...(cover ? { cover } : {}) });
  return { id, existed: false };
}

// Fetch the next episodes of a book that's open, then rebuild it in place.
export async function getMore(rec, buf, msg) {
  const web = webOf(rec);
  const { kakuyomu, ...base } = rec;
  msg('Checking for new episodes…');
  const work = await getWork(web.site, web.work);
  const from = web.have;
  if (from >= work.episodes.length) return { added: 0, rec: { ...base, web: webInfo(work, from) } };
  await sleep(GAP);
  const zip = await JSZip.loadAsync(buf);
  if (!zip.file('OEBPS/titles.json')) {
    // Books made before titles were stored: read them back from the contents list.
    const nav = new DOMParser().parseFromString(await zip.file('OEBPS/nav.xhtml').async('string'), 'application/xhtml+xml');
    zip.file('OEBPS/titles.json', JSON.stringify(Array.from(nav.getElementsByTagName('a')).map((a) => a.textContent)));
  }
  const { zip: z, have } = await addEpisodes(zip, work, from, BATCH, (i, n) => msg(`Downloading episode ${from + i + 1} of ${from + n}…`));
  const out = await (await z.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })).arrayBuffer();
  return { added: have - from, buf: out, rec: { ...base, web: webInfo(work, have) } };
}

/* ---------- The add sheet ---------- */


// A story's details from its link, in the same form as search results, for a preview.
export async function storyFromLink(text) {
  const link = parseLink(text);
  if (!link) throw new Error('Paste a link to a story on kakuyomu.jp or syosetu.com.');
  if (link.site === 'narou' && !narouReady) throw new Error('Narou stories can’t be read in the online version of Yomu yet.');
  const { episodes, ...story } = await getWork(link.site, link.work);
  return story;
}

export function init() {
  // Pasting a link opens the story's details (difficulty, English summary, what readers say),
  // where you can add it to your library or save it for later.
  $('kkAdd').addEventListener('click', async () => {
    const btn = $('kkAdd'), say = (t) => ($('kkMsg').textContent = t);
    const input = $('kkLink').value.trim();
    if (!input) return say('Paste a link, or type a title.');
    btn.disabled = true;
    $('kkResults').innerHTML = '';
    try {
      const wd = await import(`./webdiscover.js${new URL(import.meta.url).search}`);
      if (parseLink(input)) {
        say('Looking up the story…');
        const story = await storyFromLink(input);
        resetSheet();
        return wd.previewStory(story);
      }
      // Not a story link: a Kakuyomu search link, or words typed in. Search Kakuyomu for them.
      let q = input;
      try { const u = new URL(input); if (/kakuyomu\.jp$/.test(u.hostname)) q = u.searchParams.get('q') || ''; else q = ''; } catch {}
      if (!q) return say('Paste a link to a story on kakuyomu.jp or syosetu.com, or type a title.');
      say(`Searching Kakuyomu for “${q}”…`);
      const found = (await kkSearch({ query: q })).slice(0, 8);
      if (!found.length) return say(`Nothing found on Kakuyomu for “${q}”.`);
      if (found.length === 1) { resetSheet(); return wd.previewStory(found[0]); }
      say('Pick a story:');
      $('kkResults').innerHTML = found.map((s, i) => `<li><button data-i="${i}"><span class="t">${esc(wd.shortTitle(s.title))}</span><span class="a">${esc(s.author)}${s.genre ? ' · ' + esc(s.genre) : ''}</span></button></li>`).join('');
      $('kkResults').onclick = (e) => {
        const b = e.target.closest('[data-i]');
        if (b) { const s = found[+b.dataset.i]; resetSheet(); wd.previewStory(s); }
      };
    } catch (e) {
      say(e.message || 'Something went wrong.');
    } finally {
      btn.disabled = false;
    }
  });
  $('kkLink').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('kkAdd').click(); } });
}

export function resetSheet(keepLink = false) {
  if (!keepLink) $('kkLink').value = '';
  $('kkMsg').textContent = '';
  $('kkResults').innerHTML = '';
}
