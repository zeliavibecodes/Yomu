// Yomu's relay for Kakuyomu, run as a free Cloudflare Worker (see README.md in this folder).
// Kakuyomu doesn't let other websites read its pages, so Yomu asks this relay instead.
// It only passes on Kakuyomu story and episode pages, and only to Yomu itself,
// so it can't be used as a general-purpose proxy.

const ALLOWED_PATH = /^\/works\/\d+(\/episodes\/\d+)?$/;
const ALLOWED_ORIGINS = ['https://zeliavibecodes.github.io'];
const AGENT = 'Yomu personal reader (one reader, one episode at a time)';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET' || !ALLOWED_ORIGINS.includes(origin)) return new Response('Not allowed', { status: 403, headers: cors });

    const path = new URL(request.url).searchParams.get('path') || '';
    if (!ALLOWED_PATH.test(path)) return new Response('Only Kakuyomu story pages can be fetched.', { status: 400, headers: cors });

    // Episodes rarely change, so keep them for a day; a story's contents for 10 minutes.
    const ttl = path.includes('/episodes/') ? 86400 : 600;
    const res = await fetch('https://kakuyomu.jp' + path, {
      headers: { 'User-Agent': AGENT },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `private, max-age=${ttl}` },
    });
  },
};
