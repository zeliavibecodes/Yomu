// Learn new words: a short session, right after reading, for the words you added from Yomu.
// Each card shows the word in the sentence where you found it. Your grade is sent to jpdb
// as a review, so the word starts its normal review schedule there.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Grades as jpdb names them, with the labels shown here.
const GRADES = [['nothing', 'Forgot'], ['hard', 'Hard'], ['okay', 'Okay'], ['easy', 'Easy']];

const session = { queue: [], done: 0, total: 0, again: new Set(), shown: false, busy: false, locked: [], notTaken: 0 };

// jpdb's page for a word, where a locked word can be unlocked.
const jpdbPage = (it) => `https://jpdb.io/vocabulary/${it.vid}/${encodeURIComponent(it.spelling)}`;
const isLocked = (st) => Array.isArray(st) && st[0] === 'locked';
const isNew = (st) => !st || (Array.isArray(st) && (st[0] === 'new' || (st[0] === 'locked' && st[1] === 'new')));

// Ask jpdb where each word stands. Returns a map of "vid/sid" to card state, or null offline.
async function states(list) {
  try {
    const res = await Y().jpdb('lookup-vocabulary', { list: list.map((it) => [it.vid, it.sid]), fields: ['card_state'] });
    return new Map(list.map((it, i) => [key(it), res.vocabulary_info?.[i]?.[0] ?? null]));
  } catch { return null; }
}

export async function start() {
  let list = Y().learnList();
  if (!list.length) return Y().toast('No new words to learn.');
  Y().openSheet('learnSheet');
  $('learnBody').innerHTML = '<p class="hint d-loading">Checking your words on jpdb…</p>';
  // Words jpdb has locked until their kanji are learned can't be studied yet, and words already
  // learned on jpdb don't need a card here.
  const st = await states(list);
  let locked = [];
  if (st) {
    for (const it of list) if (!isNew(st.get(key(it)))) Y().learned(it);
    list = Y().learnList();
    locked = list.filter((it) => isLocked(st.get(key(it))));
    list = list.filter((it) => !isLocked(st.get(key(it))));
  }
  Object.assign(session, { queue: [...list], done: 0, total: list.length, again: new Set(), shown: false, busy: false, locked, notTaken: 0 });
  render();
}

function learnedLine() {
  const ok = session.done - session.notTaken;
  const okText = `${ok} ${ok === 1 ? 'word is' : 'words are'} now learning on jpdb.`;
  return session.notTaken ? `${ok ? okText + ' ' : ''}jpdb didn’t start ${session.notTaken} ${session.notTaken === 1 ? 'word' : 'words'}, so ${session.notTaken === 1 ? 'it’s' : 'they’re'} kept here for next time.` : okText;
}

function lockedHtml() {
  if (!session.locked.length) return '';
  const n = session.locked.length;
  return `<div class="ln-locked">
    <p><b>${n} ${n === 1 ? 'word is' : 'words are'} locked on jpdb</b> until you learn ${n === 1 ? 'its' : 'their'} kanji. Unlock ${n === 1 ? 'it' : 'them'} on jpdb.io, and ${n === 1 ? 'it' : 'they'}’ll come back here.</p>
    <p class="ln-locked-list">${session.locked.map((it) => `<a href="${jpdbPage(it)}" target="_blank" rel="noopener">${esc(it.spelling)}</a>`).join('')}</p></div>`;
}

function render() {
  const box = $('learnBody');
  const it = session.queue[0];
  if (!it) {
    const nothing = !session.total;
    box.innerHTML = `${lockedHtml()}<div class="ln-end">
      ${nothing ? '<p class="hint">Nothing else to learn for now.</p>' : `<p class="ln-end-big">All done</p>
      <p class="hint">${learnedLine()}</p>`}
      <button class="btn primary" id="lnClose">Back to reading</button></div>`;
    $('lnClose').onclick = () => Y().closeSheet();
    Y().refreshLearn();
    return;
  }
  const s = it.sentence || {};
  const sentence = s.word ? `${esc(s.before)}<b>${esc(s.word)}</b>${esc(s.after)}` : '';
  const reading = it.reading && it.reading !== it.spelling ? it.reading : '';
  box.innerHTML = `${session.done === 0 && !session.shown ? lockedHtml() : ''}
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
    // Check that jpdb really started the word; if it's still new, keep it for next time.
    const after = (await states([it]))?.get(key(it));
    if (after !== undefined && isNew(after)) session.notTaken++;
    else Y().learned(it);
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
