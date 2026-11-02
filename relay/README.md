# Web novel relay

Kakuyomu and Narou don't let other websites read their pages, so Yomu fetches them through this small relay. It only passes on these two sites' story, episode and search pages, and only to Yomu.

- **On the Mac:** nothing to set up. `python3 serve.py` includes the relay.
- **Online:** the relay runs on Vercel, in Tokyo (`vercel/api/relay.js`), at https://yomu-vercel.vercel.app/api/relay. Kakuyomu works fully. Narou's search works, but its episode pages refuse Vercel's servers, so Narou is left out of the online version for now. (Cloudflare had the opposite problem: Kakuyomu and Narou's search refused it.)

## Set up the online relay (once, about 5 minutes)

1. Go to vercel.com and choose **Sign Up → Continue with GitHub**. Pick the free **Hobby** plan.
2. Choose **Add New → Project**, and **Import** the `Yomu` repository.
3. Next to **Root Directory**, choose **Edit** and pick `relay/vercel`.
4. Choose **Deploy**.
5. Copy the project's address (for example `https://yomu-relay.vercel.app`) and give it to Claude, who puts it in `webnovel.js` (`ONLINE_RELAY`).

A 10-episode download uses 11 requests; checking the difficulty of a list of 40 stories uses about 45. The free plan covers this many times over.
