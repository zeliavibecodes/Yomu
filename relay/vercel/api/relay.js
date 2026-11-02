// Yomu's relay for web novels, run on Vercel (see relay/README.md).
// Kakuyomu and Narou don't let other websites read their pages, so Yomu asks this relay instead.
// It only passes on these sites' story, episode and search pages, and only to Yomu itself,
// so it can't be used as a general-purpose proxy.

const ALLOWED = [
  /^https:\/\/kakuyomu\.jp\/works\/\d+(\/episodes\/\d+)?$/,
  /^https:\/\/kakuyomu\.jp\/search\?[^#]*$/,
  /^https:\/\/ncode\.syosetu\.com\/n[0-9a-z]+\/(\d+\/)?$/,
  /^https:\/\/api\.syosetu\.com\/novelapi\/api\/\?[^#]*$/,
  /^https:\/\/cdn\.kdkw\.jp\/cover_\d+\/[\w\/.-]+\.(webp|jpe?g|png)$/,   // official book covers
];
const IMAGE = /^https:\/\/cdn\.kdkw\.jp\//;
const ALLOWED_ORIGINS = ['https://zeliavibecodes.github.io'];
const AGENT = 'Yomu personal reader (one reader, one episode at a time)';

const corsFor = (request) => {
  const origin = request.headers.get('origin') || '';
  return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], 'Vary': 'Origin' };
};

export function OPTIONS(request) {
  return new Response(null, { headers: { ...corsFor(request), 'Access-Control-Allow-Methods': 'GET' } });
}

export async function GET(request) {
  const cors = corsFor(request);
  if (!ALLOWED_ORIGINS.includes(request.headers.get('origin') || '')) return new Response('Not allowed', { status: 403, headers: cors });
  const target = new URL(request.url).searchParams.get('url') || '';
  if (!ALLOWED.some((r) => r.test(target))) return new Response('Only Kakuyomu and Narou story pages can be fetched.', { status: 400, headers: cors });
  let res;
  try {
    res = await fetch(target, { headers: { 'User-Agent': AGENT } });
  } catch {
    return new Response('The site couldn’t be reached.', { status: 502, headers: cors });
  }
  // Episodes rarely change, so let the phone keep them for a day; searches and story pages for an hour.
  const ttl = /\/episodes\/\d+$|syosetu\.com\/n[0-9a-z]+\/\d+\/$/.test(target) || IMAGE.test(target) ? 86400 : 3600;
  if (IMAGE.test(target)) {
    return new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: { ...cors, 'Content-Type': res.headers.get('content-type') || 'image/webp', 'Cache-Control': `private, max-age=${ttl}` },
    });
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `private, max-age=${ttl}` },
  });
}
