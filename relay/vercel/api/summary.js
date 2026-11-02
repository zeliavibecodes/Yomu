// English titles and summaries for web novels, written by Gemini.
// The Gemini key lives in this Vercel project's settings (GEMINI_API_KEY), never on the phone.
//
// POST { mode: 'list', stories: [{ id, title, pitch, tags }] }  → { stories: [{ id, title, line }] }
// POST { mode: 'story', story: { title, pitch, intro, tags } }   → { title, summary }

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

async function gemini(prompt, schema) {
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
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3 },
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

const STYLE = 'Write for an English speaker who is learning Japanese and deciding whether to read this web novel. Use plain, everyday English. No hype, no exclamation marks, no Japanese words, no spoilers beyond the setup.';

export async function POST(request) {
  const cors = corsFor(request);
  if (!ORIGINS.some((r) => r.test(request.headers.get('origin') || ''))) return json({ error: 'Not allowed' }, 403, cors);
  if (!process.env.GEMINI_API_KEY) return json({ error: 'No Gemini key set up yet' }, 503, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400, cors); }

  try {
    if (body.mode === 'list') {
      const stories = (body.stories || []).slice(0, 12).map((s) => ({ id: clip(s.id, 40), title: clip(s.title, 200), pitch: clip(s.pitch, 200), tags: (s.tags || []).slice(0, 12).map((t) => clip(t, 30)) }));
      if (!stories.length) return json({ stories: [] }, 200, cors);
      const out = await gemini(
        `${STYLE}\nFor each story below, give a short natural English title (under 8 words) and one line saying what it's about (under 16 words).\n\n${JSON.stringify(stories)}`,
        { type: 'OBJECT', properties: { stories: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, title: { type: 'STRING' }, line: { type: 'STRING' } }, required: ['id', 'title', 'line'] } } }, required: ['stories'] },
      );
      return json({ stories: out.stories || [] }, 200, cors);
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
