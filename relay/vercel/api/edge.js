// Same relay, run on Vercel's edge network instead of its regular servers (a test for Narou episode pages).
export const config = { runtime: 'edge' };
import { GET as get, OPTIONS as options } from './relay.js';
export default function handler(request) {
  return request.method === 'OPTIONS' ? options(request) : get(request);
}
