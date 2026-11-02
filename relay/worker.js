// Yomu's relay for web novels, run as a free Cloudflare Worker (see README.md in this folder).
// Kakuyomu and Narou don't let other websites read their pages, so Yomu asks this relay instead.
// It only passes on these sites' story, episode and search pages, and only to Yomu itself,
// so it can't be used as a general-purpose proxy.

const ALLOWED = [
  /^https:\/\/kakuyomu\.jp\/works\/\d+(\/episodes\/\d+)?$/,
  /^https:\/\/kakuyomu\.jp\/search\?[^#]*$/,
  /^https:\/\/ncode\.syosetu\.com\/n[0-9a-z]+\/(\d+\/)?$/,
  /^https:\/\/api\.syosetu\.com\/novelapi\/api\/\?[^#]*$/,
];
const ALLOWED_ORIGINS = ['https://zeliavibecodes.github.io'];
const AGENT = 'Yomu personal reader (one reader, one episode at a time)';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET' || !ALLOWED_ORIGINS.includes(origin)) return new Response('Not allowed', { status: 403, headers: cors });

    const target = new URL(request.url).searchParams.get('url') || '';
    if (!ALLOWED.some((r) => r.test(target))) return new Response('Only Kakuyomu and Narou story pages can be fetched.', { status: 400, headers: cors });

    // Episodes rarely change, so keep them for a day; searches and story pages for an hour.
    const episode = /\/episodes\/\d+$|syosetu\.com\/n[0-9a-z]+\/\d+\/$/.test(target);
    const ttl = episode ? 86400 : 3600;
    const res = await fetch(target, { headers: { 'User-Agent': AGENT }, cf: { cacheTtl: ttl, cacheEverything: true } });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `private, max-age=${ttl}` },
    });
  },
};
