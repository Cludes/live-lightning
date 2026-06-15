# Live Lightning

Real-time lightning strikes flashing on a dark world map, the moment they're detected - with a
day/night terminator for context and live counters (strikes/min, flashing now, session total).

## Data - Blitzortung (keyless, live websocket)
Strikes stream straight to the browser over Blitzortung.org's community websocket (`wss://ws1/ws7/ws8
.blitzortung.org`, subscribe with `{"a":111}`). Each frame is LZW-compressed JSON; `decode()` unpacks
it to a strike with lat/lon/time. No API key, no proxy - the browser connects directly (websockets
aren't CORS-gated), with automatic failover across the three servers and reconnect.

## Rendering
All strikes draw on a single `<canvas>` for performance: each is a hot core + expanding ring that fades
over ~2.2s. Easily handles the global rate (often 10-50+ strikes/second during active storms).

Strike data is provided by the Blitzortung.org community network and its contributors.

## Deploy
Static site -> Cloudflare Pages project `live-lightning` via GitHub Action on push to `master`
(secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://live-lightning.pages.dev
