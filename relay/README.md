# Web novel relay

Kakuyomu and Narou don't let other websites read their pages, so Yomu fetches them through this small relay. It only passes on these two sites' story, episode and search pages, and only to Yomu.

- **On the Mac:** nothing to set up. `python3 serve.py` includes the relay.
- **Online:** the relay runs as a free Cloudflare Worker.

## Set up the online relay (once, about 10 minutes)

1. Create a free account at dash.cloudflare.com.
2. Choose **Workers & Pages → Create → Create Worker**. Name it `yomu-relay` and choose **Deploy**.
3. Choose **Edit code**, replace everything with the contents of `worker.js`, and choose **Deploy** again.
4. Copy the Worker's address (for example `https://yomu-relay.your-name.workers.dev`).
5. Give the address to Claude, who puts it in `webnovel.js` (`ONLINE_RELAY`).

The free plan allows 100,000 requests a day. A 10-episode download uses 11; checking the difficulty of a list of 40 stories uses about 45.
