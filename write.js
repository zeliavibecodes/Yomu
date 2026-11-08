// Write about this chapter: a question about what you just read, a line or two of Japanese,
// and a corrected version back from Gemini (through the Vercel relay). Every entry is kept,
// so each book leaves a short journal of what you wrote while reading it.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const URL_ = 'https://yomu-vercel.vercel.app/api/summary';

const JOURNAL_KEY = 'yomu.journal';
const DRAFT_KEY = 'yomu.writeDrafts';
export function journal() { try { return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'); } catch { return []; } }
function setJournal(l) { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(l)); } catch {} }
function drafts() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; } }
function setDraft(k, d) {
  const all = drafts();
  if (d) all[k] = { ...d, at: Date.now() }; else delete all[k];
  for (const old of Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(20)) delete all[old];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {}
}

const niceDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

async function ask(body) {
  if (!navigator.onLine) { const e = new Error('offline'); e.code = 'offline'; throw e; }
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 503) throw new Error('This needs a Gemini key on the Vercel relay.');
  if (!res.ok) throw new Error('Gemini couldn’t answer right now. Try again in a moment.');
  return res.json();
}

let ctx = null;   // the chapter being written about
let state = null; // { q, hint, words, asked: [], text }

// The corrected text, with the parts that changed marked.
function correctedHtml(segs) {
  return segs.map((s) => s.changed ? `<mark${s.was ? ` title="You wrote: ${esc(s.was)}"` : ''}>${esc(s.text)}</mark>` : esc(s.text)).join('');
}
const correctedText = (segs) => segs.map((s) => s.text).join('');

function entryHtml(e) {
  const changed = e.segs.some((s) => s.changed);
  return `<div class="wr-entry">
    ${e.q ? `<p class="wr-q-small">${esc(e.q)}</p>` : ''}
    <p class="lbl">You wrote</p>
    <p class="wr-mine">${esc(e.text)}</p>
    ${changed ? `<p class="lbl">More natural</p><p class="wr-fixed">${correctedHtml(e.segs)}</p>` : ''}
    ${e.note ? `<p class="wr-note">${esc(e.note)}</p>` : ''}
    ${e.tr ? `<p class="wr-tr">${esc(e.tr)}</p>` : ''}
    ${e.used?.length ? `<p class="wr-used">Words you used: ${e.used.map((w) => `<b>${esc(w)}</b>`).join('、')}</p>` : ''}
  </div>`;
}

export async function start() {
  ctx = Y().writingContext();
  if (!ctx) return;
  Y().openSheet('writeSheet');
  $('writeTitle').textContent = 'Write';
  const done = journal().filter((e) => e.book === ctx.bookId && e.chapter === ctx.chapter);
  if (done.length) return showDone(done);
  compose();
}

function showDone(list) {
  const box = $('writeBody');
  box.innerHTML = `${list.slice().reverse().map(entryHtml).join('')}
    <div class="wr-actions"><button class="btn primary" id="wrClose">Back to reading</button></div>
    <button class="text-btn wr-link" id="wrAgain">Write another</button>`;
  $('wrClose').onclick = () => Y().closeSheet();
  $('wrAgain').onclick = () => compose(true);
}

async function compose(fresh = false) {
  const k = ctx.bookId + '/' + ctx.chapter;
  const saved = !fresh && drafts()[k];
  state = saved ? { q: saved.q, hint: saved.hint, words: saved.words || [], asked: saved.asked || [], text: saved.text || '' } : { q: '', hint: '', words: [], asked: [], text: '' };
  renderCompose();
  if (!state.q) newQuestion();
}

function renderCompose(msg = '') {
  const box = $('writeBody');
  box.innerHTML = `<div class="wr-prompt" id="wrPrompt">${promptHtml()}</div>
    <textarea id="wrText" class="wr-text" lang="ja" rows="4" placeholder="ここに書いてください" autocapitalize="off" autocomplete="off" spellcheck="false">${esc(state.text)}</textarea>
    <div class="wr-actions"><button class="btn primary" id="wrCheck">Check</button></div>
    <p class="sheet-msg" id="wrMsg">${esc(msg)}</p>
    <div class="wr-skips">
      <button class="text-btn wr-link" id="wrSkip">Skip this chapter</button>
      <button class="text-btn wr-link" id="wrOff">Just reading this book</button>
    </div>`;
  const ta = $('wrText');
  ta.oninput = () => { state.text = ta.value; save(); };
  $('wrCheck').onclick = check;
  $('wrSkip').onclick = () => Y().closeSheet();
  $('wrOff').onclick = async () => { await Y().setBookWriting(false); Y().closeSheet(); Y().toast('No writing for this book. Turn it back on from Contents.'); };
  wirePrompt();
}

function promptHtml() {
  if (!state.q) return '<p class="hint wr-wait">Thinking of a question…</p>';
  return `<p class="wr-q" lang="ja">${esc(state.q)}</p>
    ${state.hint ? `<p class="wr-hint">${esc(state.hint)}</p>` : ''}
    ${state.words.length ? `<p class="wr-words">Try using ${state.words.map((w) => `<button class="wr-word" data-w="${esc(w)}">${esc(w)}</button>`).join('')}</p>` : ''}
    <button class="text-btn wr-link" id="wrNew">Different question</button>`;
}
function wirePrompt() {
  if ($('wrNew')) $('wrNew').onclick = () => newQuestion();
  // Tapping a suggested word puts it where you're typing.
  document.querySelectorAll('.wr-word').forEach((b) => (b.onclick = () => {
    const ta = $('wrText'), w = b.dataset.w;
    const at = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, at) + w + ta.value.slice(ta.selectionEnd ?? at);
    state.text = ta.value; save();
    ta.focus(); ta.selectionStart = ta.selectionEnd = at + w.length;
  }));
}
function save() { setDraft(ctx.bookId + '/' + ctx.chapter, { q: state.q, hint: state.hint, words: state.words, asked: state.asked, text: state.text }); }

async function newQuestion() {
  const forCtx = ctx;
  if (state.q) state.asked.push(state.q);
  state.q = ''; state.hint = ''; state.words = [];
  $('wrPrompt').innerHTML = promptHtml();
  try {
    const out = await ask({ mode: 'prompt', book: forCtx.bookTitle, chapter: forCtx.text, words: forCtx.tapped, avoid: state.asked });
    if (ctx !== forCtx || !$('wrPrompt')) return;
    Object.assign(state, { q: out.question, hint: out.hint, words: out.words || [] });
  } catch (e) {
    if (ctx !== forCtx || !$('wrPrompt')) return;
    // Without a question you can still write; the check needs the internet either way.
    Object.assign(state, { q: 'この章について、自由に書いてください。', hint: e.code === 'offline' ? 'Write anything about this chapter. (You’re offline: your text is kept, and you can check it once you’re back online.)' : 'Write anything about this chapter.', words: forCtx.tapped.slice(0, 3) });
  }
  save();
  $('wrPrompt').innerHTML = promptHtml();
  wirePrompt();
}

async function check() {
  const text = $('wrText').value.trim();
  if (!text) return ($('wrMsg').textContent = 'Write something first.');
  if (!/[぀-ヿ㐀-鿿]/.test(text)) return ($('wrMsg').textContent = 'Try writing it in Japanese.');
  const forCtx = ctx;
  $('wrCheck').disabled = true;
  $('wrMsg').textContent = 'Checking…';
  let out;
  try {
    out = await ask({ mode: 'correct', text, question: state.q, chapter: forCtx.text.slice(-1500) });
  } catch (e) {
    if (!$('wrMsg')) return;
    $('wrMsg').textContent = e.code === 'offline' ? 'You’re offline. Your text is kept here; check it when you’re back online.' : e.message;
    $('wrCheck').disabled = false;
    return;
  }
  const fixed = correctedText(out.segments);
  const entry = {
    id: Date.now().toString(36), at: Date.now(), book: forCtx.bookId, title: forCtx.bookTitle, chapter: forCtx.chapter,
    q: state.q, text, segs: out.segments, note: out.note, tr: out.translation,
    used: forCtx.tapped.filter((w) => fixed.includes(w)),
  };
  setJournal([...journal(), entry]);
  setDraft(forCtx.bookId + '/' + forCtx.chapter, null);
  Y().refreshWrite();
  if (ctx !== forCtx || !$('writeBody')) return;
  $('writeBody').innerHTML = `${entryHtml(entry)}
    <div class="wr-actions"><button class="btn primary" id="wrClose">Back to reading</button></div>
    <button class="text-btn wr-link" id="wrAgain">Write another</button>`;
  $('wrClose').onclick = () => Y().closeSheet();
  $('wrAgain').onclick = () => compose(true);
}

// Everything you wrote about one book, newest first.
export function openJournal(bookId, title) {
  ctx = null;
  Y().openSheet('writeSheet');
  $('writeTitle').textContent = 'Your writing';
  const list = journal().filter((e) => e.book === bookId).reverse();
  $('writeBody').innerHTML = list.length
    ? `<p class="hint wr-book">${esc(title)} · ${list.length} ${list.length === 1 ? 'entry' : 'entries'}</p>${list.map((e) => `<p class="wr-date">${niceDate(e.at)}</p>${entryHtml(e)}`).join('')}`
    : '<p class="hint">Nothing written for this book yet.</p>';
}
