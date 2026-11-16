# Metromaker

A party queue website for [Metrolist](https://metrolist.cc)'s **Listen Together**.

Create a room, share the link or QR code, and let your guests search YouTube Music, add songs and vote for them from their browser. They do not need Metrolist. Every device that joins the room in Metrolist plays the queue in sync.

Metromaker connects to a normal [metroserver](https://github.com/MetrolistGroup/metroserver) as the **host** of a Listen Together room. Metrolist users can only join as listeners, so the queue is always managed by the website.

## Features

- **Two room modes**: *Voting* (songs with the most likes play first) or *Queue only* (new songs go to the end).
- **One vote per browser and song**, up or down. Picking a song that is already queued counts as an upvote.
- **No duplicates**: a song can only be in the queue once. Per room you decide whether a song may be added again after it has played.
- **Fallback playlist**: a YouTube / YouTube Music playlist that plays whenever the queue is empty.
- **Share link and QR code** on the room page, plus the room code and an "Open in Metrolist" link for listeners.
- **Host controls** for the browser that created the room: pause, skip, remove songs, end the room.
- Song suggestions sent from Metrolist land in the same queue.
- Rooms survive restarts of Metromaker and of metroserver.

## Self-hosting

You need Docker with the Compose plugin. Pick one of the two compose files:

| File | Use it when |
| --- | --- |
| `docker-compose.yml` | You already have a metroserver (your own or a public one) and only want the website. |
| `docker-compose.with-metroserver.yml` | You want the website and your own metroserver together. |

### Website only

```bash
curl -O https://raw.githubusercontent.com/finn-freitag/metromaker/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/finn-freitag/metromaker/main/.env.example
# edit .env: set METROSERVER_URL to the existing metroserver
docker compose up -d
```

### Website + metroserver

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/finn-freitag/metromaker/main/docker-compose.with-metroserver.yml
curl -o .env https://raw.githubusercontent.com/finn-freitag/metromaker/main/.env.example
# edit .env if you want to change ports or other settings
docker compose up -d
```

The website is then available on port `3000` (change it with `METROMAKER_PORT`).

In the bundled setup Metromaker forwards `/ws` to its metroserver, so listeners use the website's own address in Metrolist, for example `wss://music.example.com/ws`. The room page shows the exact address. Your reverse proxy only has to send the domain to port 3000 with WebSocket support.

### Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `METROMAKER_PORT` | `3000` | Port of the website on the Docker host. |
| `METROSERVER_URL` | | The metroserver Metromaker hosts its rooms on (`ws://` or `wss://`; `/ws` is added if missing). Ignored by the bundled setup. |
| `METROSERVER_PUBLIC_URL` | see text | The Listen Together address shown to guests. Defaults to `METROSERVER_URL` (website only) or to the website's own address + `/ws` (bundled). |
| `HOST_NAME` | `Metromaker` | Name of the room host shown in Metrolist. |
| `MAX_ROOMS` | `20` | Maximum number of simultaneous rooms. |
| `ROOM_IDLE_MINUTES` | `180` | Rooms without page visitors and listeners are closed after this time. |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so each visitor's `X-Forwarded-For` address is used. Needed there for more than 32 listeners. |
| `YTM_LANGUAGE` / `YTM_REGION` | `en` / `US` | Language and country for YouTube Music results. |

### Good to know

- **Listeners must use the same metroserver.** A room only exists on the server Metromaker is connected to, so Metrolist has to be pointed at that server (shown on the room page) before entering the room code.
- **Use HTTPS in public.** Put Metromaker behind a reverse proxy with TLS that forwards WebSockets, and set `TRUST_PROXY=true`.
- **Limits of foreign servers.** metroserver accepts at most 32 connections and 10 new rooms per minute from one address, and Metromaker uses one connection per room.
- A metroserver with a User-Agent policy must let the User-Agent `Metromaker/1.0` host rooms.
- When the fallback playlist runs out of unplayed songs in a room without replays, it starts over rather than going silent.
- Votes are tied to a random ID stored in the browser. That keeps honest guests to one vote per song; it is not tamper-proof.

## Development

```bash
npm install
npm run dev          # backend on :3000, Vite dev server on :5173
```

Set `METROSERVER_URL` to a metroserver you can reach (default `ws://localhost:8080/ws`).

```bash
npm run build        # type-check and build the web app into dist/
npm start            # serve the API and the built web app
docker build -t metromaker .
```

- `server/`: Node.js backend. `metro.js` speaks metroserver's protobuf protocol as the room host, `rooms.js` holds the queue, votes and playback timeline, `ytmusic.js` searches YouTube Music and loads playlists.
- `src/`: Vue 3 web app.
- `.github/workflows/docker.yml`: builds the image and pushes it to `ghcr.io/<owner>/metromaker` on every push to `main` and on `v*` tags.

## Credits and licence

The look follows the [Metrolist website](https://github.com/MetrolistGroup/metrosite): its design tokens, base styles, the Google Sans Flex font subset and the logo are taken from there. `server/proto/listentogether.proto` comes from [metroproto](https://github.com/metrolistgroup/metroproto). Icons are [Material Symbols](https://fonts.google.com/icons) (Apache 2.0).

Metromaker is licensed under the GPL-3.0, like metrosite. It is a community project and not affiliated with the Metrolist team.
