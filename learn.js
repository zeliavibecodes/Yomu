// Review words: a short session (at most 20 cards) for the words you met while reading.
// Three kinds of card, each clearly tagged:
//   New on jpdb    — words you added to a deck; your grade starts them on jpdb.
//   Review on jpdb — words you'd studied but looked up; your grade counts as a jpdb review.
//   Practice only  — words outside your decks; nothing goes to jpdb.
// Words you forget on jpdb come back once at the end, in their own short round.

const Y = () => window.yomu;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Grades as jpdb names them, with the labels shown here.
const GRADES = [['nothing', 'Forgot'], ['hard', 'Hard'], ['okay', 'Okay'], ['easy', 'Easy']];
const SECTIONS = {
  new: { tag: 'New on jpdb', hint: 'Your grade starts this word on jpdb.' },
  review: { tag: 'Review on jpdb', hint: 'Your grade counts as a jpdb review.' },
  practice: { tag: 'Practice only', hint: 'Not in your decks. Nothing is sent to jpdb.' },
  again: { tag: 'One more time', hint: 'You forgot this one. This round stays in Yomu.' },
};

const session = { queue: [], again: [], pos: 0, total: 0, round: 'main', shown: false, busy: false, locked: [], counts: {}, notTaken: 0, left: 0 };

// jpdb's page for a word, where a locked word can be unlocked.
const jpdbPage = (it) => `https://jpdb.io/vocabulary/${it.vid}/${encodeURIComponent(it.spelling)}`;
const isLocked = (st) => Array.isArray(st) && st[0] === 'locked';
const isNew = (st) => !st || (Array.isArray(st) && (st[0] === 'new' || (st[0] === 'locked' && st[1] === 'new')));
const key = (it) => it.vid + '/' + it.sid;

// Ask jpdb where each word stands, and how common it is. Returns a map of "vid/sid" to
// { state, freq }, or null offline.
async function lookup(list) {
  if (!list.length) return new Map();
  try {
    const res = await Y().jpdb('lookup-vocabulary', { list: list.map((it) => [it.vid, it.sid]), fields: ['card_state', 'frequency_rank'] });
    return new Map(list.map((it, i) => [key(it), { state: res.vocabulary_info?.[i]?.[0] ?? null, freq: res.vocabulary_info?.[i]?.[1] ?? null }]));
  } catch { return null; }
}

// The words you tapped most come first, then the most common ones.
const byPriority = (a, b) => (b.n || 1) - (a.n || 1) || (a.freq || Infinity) - (b.freq || Infinity);

export async function start() {
  let list = Y().learnList();
  let looked = Y().lookedUpList();
  if (!list.length && !looked.length) return Y().toast('No words to review.');
  Y().openSheet('learnSheet');
  $('learnBody').innerHTML = '<p class="hint d-loading">Checking your words on jpdb…</p>';

  // A word in both lists (looked up, then added to a deck) is a new word: keep that one.
  const inLearn = new Set(list.map(key));
  for (const it of looked) if (inLearn.has(key(it))) Y().reviewedLookedUp(it);
  looked = Y().lookedUpList();

  const info = await lookup([...list, ...looked]);
  if (info) {
    // Words already started on jpdb don't need a "new" card.
    for (const it of list) if (!isNew(info.get(key(it))?.state)) Y().learned(it);
    list = Y().learnList();
    // A studied word you since removed from your decks, or reset to new, has nothing to review on jpdb.
    for (const it of looked) { const s = info.get(key(it))?.state; if (!it.local && (!s || isNew(s))) Y().reviewedLookedUp(it); }
    looked = Y().lookedUpList();
    const freqs = new Map();
    for (const it of [...list, ...looked]) {
      const i = info.get(key(it));
      if (i?.freq) { it.freq = i.freq; freqs.set(key(it), i.freq); }
      it.lockedOnJpdb = isLocked(i?.state);
    }
    Y().rememberFreq(freqs);
  }

  const cards = [
    ...list.map((it) => ({ ...it, sec: 'new' })),
    ...looked.filter((it) => !it.local).map((it) => ({ ...it, sec: 'review' })),
    ...looked.filter((it) => it.local && Y().practiceReady(it)).map((it) => ({ ...it, sec: 'practice' })),
  ].sort(byPriority);
  const picked = cards.slice(0, Y().SESSION_SIZE);
  const order = ['new', 'review', 'practice'];
  const queue = order.flatMap((sec) => picked.filter((c) => c.sec === sec));
  Object.assign(session, { queue, again: [], pos: 0, total: queue.length, round: 'main', shown: false, busy: false, locked: [], counts: { new: 0, review: 0, practice: 0, added: 0 }, notTaken: 0, left: cards.length - picked.length });
  render();
}

function lockedHtml() {
  if (!session.locked.length) return '';
  const n = session.locked.length;
  return `<div class="ln-locked">
    <p><b>${n} ${n === 1 ? 'word is' : 'words are'} locked on jpdb</b> until you learn ${n === 1 ? 'its' : 'their'} kanji. Unlock ${n === 1 ? 'it' : 'them'} on jpdb.io, and ${n === 1 ? 'it' : 'they'}’ll come back here.</p>
    <p class="ln-locked-list">${session.locked.map((it) => `<a href="${jpdbPage(it)}" target="_blank" rel="noopener">${esc(it.spelling)}</a>`).join('')}</p></div>`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function summaryHtml() {
  const c = session.counts, lines = [];
  if (c.new) lines.push(`${plural(c.new, 'new word', 'new words')} started on jpdb.`);
  if (session.notTaken) lines.push(`jpdb didn’t start ${plural(session.notTaken, 'word', 'words')}, so ${session.notTaken === 1 ? 'it’s' : 'they’re'} kept for next time.`);
  if (c.review) lines.push(`${plural(c.review, 'jpdb review', 'jpdb reviews')} done.`);
  if (c.practice) lines.push(`${plural(c.practice, 'word', 'words')} practised here only.`);
  if (c.added) lines.push(`${plural(c.added, 'word', 'words')} added to your deck.`);
  return lines.map((l) => `<p class="hint ln-sum">${l}</p>`).join('');
}

function render() {
  const box = $('learnBody');
  let it = session.round === 'main' ? session.queue[session.pos] : session.again[session.pos];

  // Main round done: forgotten jpdb words get one more look, introduced first.
  if (!it && session.round === 'main' && session.again.length) {
    box.innerHTML = `<div class="ln-end">
      <p class="ln-end-big">One more time</p>
      <p class="hint">${plural(session.again.length, 'word', 'words')} you forgot, shown once more without the reading. Your grades are already on jpdb; this round stays in Yomu.</p>
      <button class="btn primary" id="lnAgain">Continue</button>
      <button class="text-btn ln-skip" id="lnEndNow">Finish now</button></div>`;
    $('lnAgain').onclick = () => { session.round = 'again'; session.pos = 0; session.shown = false; render(); };
    $('lnEndNow').onclick = () => { session.again = []; render(); };
    return;
  }
  if (!it) {
    const left = session.left;
    box.innerHTML = `${lockedHtml()}<div class="ln-end">
      ${session.total ? '<p class="ln-end-big">All done</p>' : '<p class="hint">Nothing to review for now.</p>'}
      ${summaryHtml()}
      ${left ? `<p class="hint ln-sum">${plural(left, 'more word is', 'more words are')} waiting for your next session.</p>` : ''}
      <button class="btn primary" id="lnClose">Back to reading</button>
      ${left ? `<button class="text-btn ln-skip" id="lnMore">Review the next ${Math.min(left, Y().SESSION_SIZE)}</button>` : ''}</div>`;
    $('lnClose').onclick = () => Y().closeSheet();
    if ($('lnMore')) $('lnMore').onclick = () => start();
    Y().refreshLearn();
    return;
  }

  const sec = session.round === 'again' ? 'again' : it.sec;
  const s = it.sentence || {};
  const sentence = s.word ? `${esc(s.before)}<b>${esc(s.word)}</b>${esc(s.after)}` : '';
  // The reading shows on new words from the start; reviews and the second round start without it.
  const reading = it.reading && it.reading !== it.spelling ? it.reading : '';
  const showReading = session.shown || sec === 'new';
  const count = session.round === 'main' ? `${session.pos + 1} of ${session.total}` : `${session.pos + 1} of ${session.again.length}`;
  box.innerHTML = `${session.pos === 0 && session.round === 'main' && !session.shown ? lockedHtml() : ''}
    <div class="ln-top"><span class="ln-progress">${count}</span><span class="ln-tag ln-tag-${sec}">${SECTIONS[sec].tag}</span></div>
    <div class="ln-card">
      <ruby class="ln-word">${esc(it.spelling)}<rt>${showReading ? esc(reading) : ''}</rt></ruby>
      ${sentence ? `<p class="ln-sentence">${sentence}</p>` : ''}
      ${it.book ? `<p class="ln-book">${esc(it.book)}${(it.n || 1) > 1 ? ` · looked up ${it.n} times` : ''}</p>` : ''}
      ${it.lockedOnJpdb ? '<p class="ln-book">jpdb lists this word as locked</p>' : ''}
    </div>
    ${session.shown ? `
      <ol class="meanings ln-meanings">${(it.meanings || []).slice(0, 3).map((m) => `<li>${esc(m.g.join('; '))}</li>`).join('')}</ol>
      <div class="ln-grades">${GRADES.map(([g, l]) => `<button class="btn${g === 'okay' ? ' primary' : ''}" data-grade="${g}">${l}</button>`).join('')}</div>`
    : '<button class="btn primary ln-show" id="lnShow">Show answer</button>'}
    <p class="ln-hint">${SECTIONS[sec].hint}</p>
    <p class="sheet-msg" id="lnMsg"></p>
    <div class="ln-foot">
      <button class="text-btn ln-skip" id="lnSkip">Skip this word</button>
      ${sec === 'practice' ? '<button class="text-btn ln-skip" id="lnAdd">Add to my deck</button>' : ''}
    </div>`;
  if ($('lnShow')) $('lnShow').onclick = () => { session.shown = true; render(); };
  $('lnSkip').onclick = next;
  if ($('lnAdd')) $('lnAdd').onclick = () => addToDeck(it);
  box.querySelectorAll('[data-grade]').forEach((b) => (b.onclick = () => grade(it, sec, b.dataset.grade)));
}

function next() { session.pos++; session.shown = false; render(); }

// A practice word you want to keep: add it to your deck, and grade it now as a new word.
async function addToDeck(it) {
  $('lnMsg').textContent = 'Adding…';
  try {
    await Y().addToDeckFromReview(it);
    it.sec = 'new'; it.local = false; it.review = false;
    session.counts.added++;
    session.shown = false;
    render();
    $('lnMsg').textContent = 'Added to your deck. Grade it to start it on jpdb.';
  } catch (e) {
    $('lnMsg').textContent = e.code === 'offline' ? 'You’re offline. Try again when you’re back online.' : e.message;
  }
}

async function grade(it, sec, g) {
  if (session.busy) return;
  // The second round is only for you: nothing goes to jpdb.
  if (sec === 'again') return next();
  // Words outside your decks are practised here only: nothing goes to jpdb.
  if (sec === 'practice') {
    Y().reviewedLookedUp(it);
    session.counts.practice++;
    return next();
  }
  session.busy = true;
  document.querySelectorAll('[data-grade]').forEach((b) => (b.disabled = true));
  $('lnMsg').textContent = 'Saving…';
  try {
    await Y().jpdb('review', { vid: it.vid, sid: it.sid, grade: g });
    if (sec === 'review') {
      // Keep the sentence where you looked it up on the jpdb card, so reviews there show it too.
      const s = it.sentence || {};
      const full = (s.before || '') + (s.word || '') + (s.after || '');
      if (Y().settings.sentence && s.word && full.length <= 300) {
        try { await Y().jpdb('set-card-sentence', { vid: it.vid, sid: it.sid, sentence: full }); } catch {}
      }
      Y().reviewedLookedUp(it);
      session.counts.review++;
    } else {
      // Check that jpdb really started the word; if it's still new, keep it for next time.
      const after = (await lookup([it]))?.get(key(it))?.state;
      if (after !== undefined && isNew(after)) {
        session.notTaken++;
        if (isLocked(after) || it.lockedOnJpdb) session.locked.push(it);
      } else { Y().learned(it); session.counts.new++; }
    }
    if (g === 'nothing') session.again.push(it);
  } catch (e) {
    $('lnMsg').textContent = e.code === 'offline' ? 'You’re offline. Try again when you’re back online.' : `jpdb didn’t accept this: ${e.message}`;
    document.querySelectorAll('[data-grade]').forEach((b) => (b.disabled = false));
    session.busy = false;
    return;
  }
  session.busy = false;
  next();
}
