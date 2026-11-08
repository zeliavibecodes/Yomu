// English titles and summaries for web novels, written by Gemini.
// The Gemini key lives in this Vercel project's settings (GEMINI_API_KEY), never on the phone.
//
// POST { mode: 'list', stories: [{ id, title, pitch, tags }] }  → { stories: [{ id, title, line }] }
// POST { mode: 'story', story: { title, pitch, intro, tags } }   → { title, summary }
// POST { mode: 'reviews', reviews: [{ title, body }] }            → { reviews: [{ title, body }] }
// POST { mode: 'explain', text, context }                         → { translation, literal, points: [{ part, reading, explanation }] }
// POST { mode: 'prompt', book, chapter, words, avoid }             → { question, hint, words }
// POST { mode: 'correct', text, question, chapter }                → { segments: [{ text, changed, was }], note, translation }

const ORIGINS = [/^https:\/\/zeliavibecodes\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/];
const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-flash-latest'].filter(Boolean);
const clip = (s, n) => String(s || '').slice(0, n);

const corsFor = (request) => {
  const origin = request.headers.get('origin') || '';
  return { 'Access-Control-Allow-Origin': ORIGINS.some((r) => r.test(origin)) ? origin : 'https://zeliavibecodes.github.io', 'Vary': 'Origin' };
};
const json = (data, status, cors) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export function OPTIONS(request) {
  return new Response(null, { headers: { ...corsFor(request), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

async function gemini(prompt, schema, temperature = 0.3) {
  const key = process.env.GEMINI_API_KEY;
  let last = '';
  for (const model of MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      signal: AbortSignal.timeout(20000),   // give up on a model after 20 seconds and try the next
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature },
      }),
    });
    } catch (e) { last = `${model}: no answer (${e.name})`; continue; }
    if (res.ok) {
      const data = await res.json();
      return JSON.parse(data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '{}');
    }
    last = `${model}: ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status === 401 || res.status === 403) break;   // a key problem: another model won't help
  }
  throw new Error(last);
}

const WRITER = 'You help an English speaker who reads Japanese novels as a learner (past beginner, not yet intermediate) practise writing in Japanese. Explanations are in plain, everyday English: no jargon, no exclamation marks.';
const STYLE = 'Write for an English speaker who is learning Japanese and deciding whether to read this web novel. Use plain, everyday English. No hype, no exclamation marks, no Japanese words, no spoilers beyond the setup.';

export async function POST(request) {
  const cors = corsFor(request);
  if (!ORIGINS.some((r) => r.test(request.headers.get('origin') || ''))) return json({ error: 'Not allowed' }, 403, cors);
  if (!process.env.GEMINI_API_KEY) return json({ error: 'No Gemini key set up yet' }, 503, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400, cors); }

  try {
    if (body.mode === 'list') {
      const stories = (body.stories || []).slice(0, 12).map((s) => ({ id: clip(s.id, 40), title: clip(s.title, 200), pitch: clip(s.pitch, 200), tags: (s.tags || []).slice(0, 12).map((t) => clip(t, 30)), review: clip(s.review, 120) }));
      if (!stories.length) return json({ stories: [] }, 200, cors);
      const out = await gemini(
        `${STYLE}\nFor each story below, give a short natural English title (under 8 words) and one line saying what it's about (under 16 words). If it has a "review" (a reader's review headline) that says something about what the story is like (its feel, characters, humour, writing), translate it naturally as "quote". Leave "quote" empty when there's no review, or when the review only congratulates the author, mentions a book or anime, thanks them, or says nothing about the story itself.\n\n${JSON.stringify(stories)}`,
        { type: 'OBJECT', properties: { stories: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, title: { type: 'STRING' }, line: { type: 'STRING' }, quote: { type: 'STRING' } }, required: ['id', 'title', 'line'] } } }, required: ['stories'] },
      );
      return json({ stories: out.stories || [] }, 200, cors);
    }
    if (body.mode === 'explain') {
      const text = clip(body.text, 400), context = clip(body.context, 800);
      if (!text.trim()) return json({ error: 'Nothing to explain' }, 400, cors);
      const out = await gemini(
        `You are helping an English speaker who reads Japanese novels at an intermediate level. Explain the Japanese passage below.
Give: "translation", a natural English translation; "literal", a closer word-for-word version only if it helps show the structure (otherwise empty); and "points", 2 to 6 grammar points in the order they appear. For each point give "part" (the exact Japanese words it's about), "reading" (the hiragana reading of "part" whenever it contains kanji, otherwise an empty string), and "explanation" (one or two plain English sentences: what the grammar does here and why it's used). Focus on conjugations, set expressions, nuance and anything an intermediate reader might miss. Skip basics such as の, は, が, を, に used in their ordinary way. No jargon without a short explanation. Never use romaji: when an explanation mentions a Japanese word, write it in Japanese (for example 終わる, not owaru).
${context && context !== text ? `The passage comes from this part of the book, for context only: ${JSON.stringify(context)}\n` : ''}Passage: ${JSON.stringify(text)}`,
        { type: 'OBJECT', properties: { translation: { type: 'STRING' }, literal: { type: 'STRING' }, points: { type: 'ARRAY', items: { type: 'OBJECT', properties: { part: { type: 'STRING' }, reading: { type: 'STRING' }, explanation: { type: 'STRING' } }, required: ['part', 'reading', 'explanation'] } } }, required: ['translation', 'points'] },
      );
      return json({ translation: out.translation || '', literal: out.literal || '', points: out.points || [] }, 200, cors);
    }
    if (body.mode === 'prompt') {
      const chapter = clip(body.chapter, 3200), book = clip(body.book, 200);
      const words = (body.words || []).slice(0, 12).map((w) => clip(w, 30)).filter(Boolean);
      const avoid = (body.avoid || []).slice(0, 8).map((q) => clip(q, 200));
      const out = await gemini(
        `${WRITER}
She has just finished a chapter${book ? ` of ${JSON.stringify(book)}` : ''}. Ask her ONE question about it that she can answer in one or two short Japanese sentences.
- Write "question" in simple, natural Japanese, friendly and short (under 30 characters). Use kanji only for common words.
- Make it about this chapter: name a character, place or event from it. Ask what she thought or felt, how a character felt, what she would do in their place, what might happen next, or her favourite moment. Never a quiz with one right answer.
- "hint": a natural English translation of the question.
- "words": from the words she looked up while reading, pick up to 4 that would fit naturally in an answer, copied exactly as listed. Leave it empty if none fit.
${avoid.length ? `Ask something different from these earlier questions: ${JSON.stringify(avoid)}
` : ''}Words she looked up: ${JSON.stringify(words)}
The chapter (it may be cut in the middle): ${JSON.stringify(chapter)}`,
        { type: 'OBJECT', properties: { question: { type: 'STRING' }, hint: { type: 'STRING' }, words: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['question', 'hint', 'words'] },
        0.9,
      );
      return json({ question: out.question || '', hint: out.hint || '', words: (out.words || []).filter((w) => words.includes(w)).slice(0, 4) }, 200, cors);
    }
    if (body.mode === 'correct') {
      const text = clip(body.text, 600), question = clip(body.question, 200), chapter = clip(body.chapter, 1500);
      if (!text.trim()) return json({ error: 'Nothing to check' }, 400, cors);
      const out = await gemini(
        `${WRITER}
She wrote the Japanese below${question ? ` in answer to the question ${JSON.stringify(question)}` : ' about the chapter she just read'}. Correct it so it is natural and grammatically correct.
- Keep her meaning, her ideas and her level. Change as little as possible and don't make it fancier than it needs to be.
- "segments": the corrected text split into pieces, in order. Joined together, the pieces must equal the corrected text exactly. Mark each piece "changed": true if it differs from what she wrote, with "was" set to what she wrote in its place (an empty string if the piece is new). Unchanged pieces have "changed": false and "was" empty. Keep changed pieces as small as possible.
- "note": one or two plain English sentences about the most useful fix and why. Write every Japanese word, particle or ending in Japanese script, never in romaji (write な, not na). If her text was already natural, return it as one unchanged piece and say in one short sentence what works well.
- "translation": a natural English translation of the corrected text.
${chapter ? `For context only, the end of the chapter: ${JSON.stringify(chapter)}
` : ''}What she wrote: ${JSON.stringify(text)}`,
        { type: 'OBJECT', properties: { segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, changed: { type: 'BOOLEAN' }, was: { type: 'STRING' } }, required: ['text', 'changed', 'was'] } }, note: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['segments', 'note', 'translation'] },
      );
      const segments = (out.segments || []).filter((x) => x && typeof x.text === 'string').map((x) => ({ text: x.text, changed: !!x.changed, was: x.was || '' }));
      return json({ segments: segments.length ? segments : [{ text, changed: false, was: '' }], note: out.note || '', translation: out.translation || '' }, 200, cors);
    }
    if (body.mode === 'reviews') {
      const reviews = (body.reviews || []).slice(0, 3).map((r) => ({ title: clip(r.title, 100), body: clip(r.body, 400) }));
      if (!reviews.length) return json({ reviews: [] }, 200, cors);
      const out = await gemini(
        `Translate these reader reviews of a Japanese web novel into plain, natural English, keeping each reader's tone. Shorten each body to at most 2 sentences. Keep them in the same order.\n\n${JSON.stringify(reviews)}`,
        { type: 'OBJECT', properties: { reviews: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, body: { type: 'STRING' } }, required: ['title', 'body'] } } }, required: ['reviews'] },
      );
      return json({ reviews: out.reviews || [] }, 200, cors);
    }
    const s = body.story || {};
    const story = { title: clip(s.title, 200), pitch: clip(s.pitch, 200), intro: clip(s.intro, 2500), tags: (s.tags || []).slice(0, 15).map((t) => clip(t, 30)) };
    const out = await gemini(
      `${STYLE}\nGive a short natural English title (under 8 words) and a summary of the story's setup in 2 or 3 sentences. Skip notices about books, manga or anime adaptations.\n\n${JSON.stringify(story)}`,
      { type: 'OBJECT', properties: { title: { type: 'STRING' }, summary: { type: 'STRING' } }, required: ['title', 'summary'] },
    );
    return json({ title: out.title || '', summary: out.summary || '' }, 200, cors);
  } catch (e) {
    return json({ error: 'Gemini couldn’t answer', detail: String(e.message || e) }, 502, cors);
  }
}
