# Kakuyomu relay

Kakuyomu doesn't let other websites read its pages, so Yomu fetches them through this small relay. It only passes on Kakuyomu story and episode pages, and only to Yomu.

- **On the Mac:** nothing to set up. `python3 serve.py` includes the relay.
- **Online:** the relay runs as a free Cloudflare Worker.

## Set up the online relay (once, about 10 minutes)

1. Create a free account at dash.cloudflare.com.
2. Choose **Workers & Pages → Create → Create Worker**. Name it `yomu-relay` and choose **Deploy**.
3. Choose **Edit code**, replace everything with the contents of `worker.js`, and choose **Deploy** again.
4. Copy the Worker's address (for example `https://yomu-relay.your-name.workers.dev`).
5. Give the address to Claude, who puts it in `kakuyomu.js` (`ONLINE_RELAY`).

The free plan allows 100,000 requests a day. A 10-episode download uses 11.
