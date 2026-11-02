// Learn new words: a short session, right after reading, for the words you added from Yomu.
// Each card shows the word in the sentence where you found it. Your grade is sent to jpdb
// as a review, so the word starts its normal review schedule there.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Grades as jpdb names them, with the labels shown here.
const GRADES = [['nothing', 'Forgot'], ['hard', 'Hard'], ['okay', 'Okay'], ['easy', 'Easy']];

const session = { queue: [], done: 0, total: 0, again: new Set(), shown: false, busy: false };

export function start() {
  const list = Y().learnList();
  if (!list.length) return Y().toast('No new words to learn.');
  Object.assign(session, { queue: [...list], done: 0, total: list.length, again: new Set(), shown: false, busy: false });
  Y().openSheet('learnSheet');
  render();
}

function render() {
  const box = $('learnBody');
  const it = session.queue[0];
  if (!it) {
    box.innerHTML = `<div class="ln-end">
      <p class="ln-end-big">All done</p>
      <p class="hint">${session.done} ${session.done === 1 ? 'word is' : 'words are'} now in your jpdb reviews.</p>
      <button class="btn primary" id="lnClose">Back to reading</button></div>`;
    $('lnClose').onclick = () => Y().closeSheet();
    Y().refreshLearn();
    return;
  }
  const s = it.sentence || {};
  const sentence = s.word ? `${esc(s.before)}<b>${esc(s.word)}</b>${esc(s.after)}` : '';
  const reading = it.reading && it.reading !== it.spelling ? it.reading : '';
  box.innerHTML = `
    <p class="ln-progress">${Math.min(session.done + 1, session.total)} of ${session.total}${session.again.has(key(it)) ? ' · once more' : ''}</p>
    <div class="ln-card">
      <ruby class="ln-word">${esc(it.spelling)}<rt>${session.shown ? esc(reading) : ''}</rt></ruby>
      ${sentence ? `<p class="ln-sentence">${sentence}</p>` : ''}
      ${it.book ? `<p class="ln-book">From ${esc(it.book)}</p>` : ''}
    </div>
    ${session.shown ? `
      <ol class="meanings ln-meanings">${(it.meanings || []).slice(0, 3).map((m) => `<li>${esc(m.g.join('; '))}</li>`).join('')}</ol>
      <div class="ln-grades">${GRADES.map(([g, l]) => `<button class="btn${g === 'okay' ? ' primary' : ''}" data-grade="${g}">${l}</button>`).join('')}</div>`
    : '<button class="btn primary ln-show" id="lnShow">Show answer</button>'}
    <p class="sheet-msg" id="lnMsg"></p>
    <button class="text-btn ln-skip" id="lnSkip">Skip this word</button>`;
  if ($('lnShow')) $('lnShow').onclick = () => { session.shown = true; render(); };
  $('lnSkip').onclick = () => { session.queue.shift(); session.shown = false; render(); };
  box.querySelectorAll('[data-grade]').forEach((b) => (b.onclick = () => grade(it, b.dataset.grade)));
}

const key = (it) => it.vid + '/' + it.sid;

async function grade(it, g) {
  if (session.busy) return;
  // A word you forgot comes back once at the end of the session; that second look stays in Yomu.
  if (session.again.has(key(it))) {
    session.again.delete(key(it));
    session.queue.shift();
    session.shown = false;
    return render();
  }
  session.busy = true;
  document.querySelectorAll('[data-grade]').forEach((b) => (b.disabled = true));
  $('lnMsg').textContent = 'Saving…';
  try {
    await Y().jpdb('review', { vid: it.vid, sid: it.sid, grade: g });
    Y().learned(it);
    session.done++;
    session.queue.shift();
    if (g === 'nothing') { session.again.add(key(it)); session.queue.push(it); }
    session.shown = false;
  } catch (e) {
    $('lnMsg').textContent = e.code === 'offline' ? 'You’re offline. Try again when you’re back online.' : `jpdb didn’t accept this: ${e.message}`;
    document.querySelectorAll('[data-grade]').forEach((b) => (b.disabled = false));
    session.busy = false;
    return;
  }
  session.busy = false;
  render();
}
