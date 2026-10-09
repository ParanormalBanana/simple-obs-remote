# simple-obs-remote

A one-bar remote for OBS Studio. Stream, record, pause, and scene buttons sit in a single row of small squares, in the same spirit as the wide-screen top bar on [OBS-web](https://obs-web.niek.tv/). When Aitum Multistream or Stream Suite is connected, the stream button becomes Start all.

It is a static site, so GitHub Pages can host it with no build step.

## Connect

OBS 28 and newer already include the WebSocket server.

1. In OBS, open **Tools → WebSocket Server Settings**.
2. Enable **Enable WebSocket Server**. Leave the port at `4455` unless you changed it.
3. Open this page, enter `ws://localhost:4455` and the server password, then **Connect**.

**Save** keeps the address and password in this browser. A bookmark works too: `#ws://localhost:4455` or `#ws://localhost:4455#your-password`. After a successful connect the password is removed from the address bar.

Scenes named with `(hidden)` are left off the bar.

Stopping a stream or a recording asks for confirmation. Everything else happens on the first click. The live scene is the red square. Stream time, recording time, and the current scene are on the disconnect button’s tooltip. The blue chip shows fps, CPU, and skipped frames.

## GitHub Pages

Push this folder to a repository, then in the repo open **Settings → Pages** and deploy the `main` branch from `/` (root).

The page will be at `https://<user>.github.io/<repo>/`.

GitHub Pages is HTTPS. Browsers allow `ws://localhost` from that page, and they block `ws://` to any other host (such as a LAN IP). From another device, put a `wss://` tunnel in front of OBS, or serve this folder over plain `http` on the local network.

## Library

`vendor/obs-websocket.js` is [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) 5.0.8, MIT. See `vendor/LICENSE-obs-websocket-js.txt`.
