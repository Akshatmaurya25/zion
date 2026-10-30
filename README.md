# Office Drop

Peer-to-peer file sharing + chat for two coworkers on the same network.
No accounts, no database — just a 6-digit room code and a direct WebRTC
connection between your two browsers.

## How it works

1. `server/` is a tiny Node.js WebSocket **signaling** server. It only helps
   two browsers find each other and exchange connection info. It never
   touches your files or chat messages, and keeps nothing in a database —
   everything lives in memory and disappears on restart.
2. `extension/` is the Chrome extension. It opens as a **side panel**
   (not a popup) so it stays open while a transfer is running.
3. Once two browsers are matched in a room, a direct WebRTC data channel
   opens between them. Files are chunked and sent straight from one
   browser to the other; the signaling server is no longer involved.

## Run it locally (same office Wi-Fi)

```bash
cd server
npm install
npm start
# -> Office Drop signaling server listening on ws://localhost:8080
```

Then load the extension:

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" → select the `extension/` folder
4. Click the extension icon to open the side panel

By default `extension/sidepanel.js` points at `ws://localhost:8080`. If
you run the server on one machine and both of you connect to that
machine's local IP (e.g. `ws://192.168.1.23:8080`), update
`SIGNALING_URL` at the top of `sidepanel.js` accordingly — both of you
need to point at the same server.

## Hosting the signaling server so it's always reachable

Running it on `localhost` only works if both of you are pointing at
whichever machine happens to be running it. For something that's just
always on, deploy it rather than keep a laptop running:

- **Recommended: Cloudflare Workers + Durable Objects.** Free tier with
  no sleep/cold-start, built for exactly this (short-lived WebSocket
  signaling, small in-memory state). This would mean rewriting
  `server.js` as a Durable Object instead of a plain `ws` server — ask
  me and I'll port it if you want to go this route.
- **Fly.io** — if you want to keep this exact Node.js file as-is, Fly's
  free allowance runs a small VM that doesn't sleep, which plain
  Railway/Render free tiers do.
- **Render free tier** — works fine, just has a cold-start delay
  (~10-30s) after 15 minutes of inactivity. Fine for occasional use,
  mildly annoying the first time each day.

Wherever you host it, update `SIGNALING_URL` in `sidepanel.js` to that
server's `wss://` address (use `wss://`, not `ws://`, once it's behind
HTTPS/TLS, which Fly/Render/Cloudflare give you automatically).

## Notes

- Works best on the same LAN — WebRTC will usually find a direct local
  path between you and your teammate, so transfers stay fast even
  though the signaling server might be hosted elsewhere.
- No file size cap beyond available memory/browser limits — large files
  just take longer, chunked in 16KB pieces over the data channel.
- Avatars are just the first letter of the name you enter, colored
  deterministically — no images, no uploads.
