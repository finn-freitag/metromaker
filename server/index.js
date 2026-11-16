import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { config } from './config.js'
import { RoomError, RoomManager } from './rooms.js'
import { loadPlaylist, searchSongs } from './ytmusic.js'

const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const rooms = new RoomManager()

// Songs may only be added by ID from a recent search, so titles, durations and
// thumbnails always come from YouTube Music and never from the browser.
const knownTracks = new Map()
const MAX_KNOWN_TRACKS = 5000
function remember(tracks) {
  for (const track of tracks) {
    knownTracks.delete(track.id)
    knownTracks.set(track.id, track)
  }
  while (knownTracks.size > MAX_KNOWN_TRACKS) knownTracks.delete(knownTracks.keys().next().value)
}

const searchCache = new Map()
const SEARCH_TTL_MS = 5 * 60_000
async function cachedSearch(query) {
  const key = query.toLowerCase()
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.tracks
  const tracks = await searchSongs(query)
  searchCache.set(key, { at: Date.now(), tracks })
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value)
  return tracks
}

// Fixed-window rate limits per client address.
const windows = new Map()
function allow(request, bucket, limit, windowMs) {
  const key = `${bucket}:${clientAddress(request)}`
  const now = Date.now()
  let entry = windows.get(key)
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0, windowMs }
    windows.set(key, entry)
  }
  return ++entry.count <= limit
}
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of windows) if (now - entry.start >= entry.windowMs) windows.delete(key)
}, 60_000).unref()

function clientAddress(request) {
  if (config.trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return request.socket.remoteAddress ?? ''
}

function validVoter(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : ''
}

function json(response, status, body) {
  const data = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) })
  response.end(data)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > 16 * 1024) {
        reject(new RoomError('too_large', 'Request is too large.', 413))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        resolve(body && typeof body === 'object' ? body : {})
      } catch {
        reject(new RoomError('bad_json', 'Request is not valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

function requireRoom(id) {
  const room = rooms.get(id)
  if (!room) throw new RoomError('room_not_found', 'This room does not exist or has ended.', 404)
  return room
}

async function api(request, response, url) {
  const segments = url.pathname.split('/').filter(Boolean).slice(1) // drop "api"
  const method = request.method

  if (method === 'GET' && segments[0] === 'health') return json(response, 200, { status: 'ok', rooms: rooms.rooms.size })

  if (method === 'GET' && segments[0] === 'config') {
    return json(response, 200, { metroserverUrl: config.metroserverPublicUrl })
  }

  if (method === 'GET' && segments[0] === 'search') {
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
    if (query.length < 2) return json(response, 200, { tracks: [] })
    if (!allow(request, 'search', 40, 60_000)) throw new RoomError('rate_limited', 'Too many searches. Wait a moment.', 429)
    let tracks
    try {
      tracks = await cachedSearch(query)
    } catch (error) {
      console.warn(`Search failed: ${error.message}`)
      throw new RoomError('search_failed', 'YouTube Music could not be reached. Try again.', 502)
    }
    remember(tracks)
    return json(response, 200, { tracks })
  }

  if (segments[0] !== 'rooms') throw new RoomError('not_found', 'Not found.', 404)

  if (method === 'POST' && segments.length === 1) {
    if (!allow(request, 'create', 6, 10 * 60_000)) throw new RoomError('rate_limited', 'Too many rooms created. Try again later.', 429)
    const body = await readBody(request)
    const mode = body.mode === 'queue' ? 'queue' : 'vote'
    let playlist = null
    if (typeof body.playlist === 'string' && body.playlist.trim()) {
      try {
        playlist = await loadPlaylist(body.playlist)
      } catch (error) {
        throw new RoomError('playlist_failed', error.message.startsWith('YouTube') ? 'YouTube Music could not be reached. Try again.' : error.message)
      }
    }
    const room = await rooms.create({ mode, allowRepeats: body.allowRepeats === true, playlist })
    console.log(`Room ${room.id} created (${mode}, repeats ${room.allowRepeats ? 'on' : 'off'}, playlist ${playlist ? `"${playlist.title}" with ${playlist.tracks.length} songs` : 'none'})`)
    return json(response, 201, { id: room.id, adminToken: room.adminToken })
  }

  const room = requireRoom(segments[1])
  const action = segments[2]

  if (method === 'GET' && !action) return json(response, 200, { id: room.id, code: room.code })

  if (method !== 'POST') throw new RoomError('not_found', 'Not found.', 404)
  const body = await readBody(request)
  const voter = validVoter(body.voter)

  if (action === 'songs') {
    if (!voter) throw new RoomError('bad_voter', 'Reload the page and try again.')
    if (!allow(request, 'add', 30, 60_000)) throw new RoomError('rate_limited', 'Slow down a little.', 429)
    const track = knownTracks.get(body.id)
    if (!track) throw new RoomError('unknown_track', 'Search for the song again and pick it from the results.')
    return json(response, 200, room.addSong(track, voter))
  }

  if (action === 'votes') {
    if (!voter) throw new RoomError('bad_voter', 'Reload the page and try again.')
    if (!allow(request, 'vote', 120, 60_000)) throw new RoomError('rate_limited', 'Slow down a little.', 429)
    const value = body.value === 1 ? 1 : body.value === -1 ? -1 : 0
    room.vote(Number(body.key), voter, value)
    return json(response, 200, { ok: true })
  }

  if (action === 'admin') {
    if (typeof body.token !== 'string' || body.token !== room.adminToken) throw new RoomError('forbidden', 'Only the room creator can do this.', 403)
    room.touch()
    switch (body.action) {
      case 'skip':
        room.playNext()
        break
      case 'pause':
        room.pause()
        break
      case 'resume':
        room.resume()
        break
      case 'remove':
        room.remove(Number(body.key))
        break
      case 'close':
        rooms.delete(room)
        break
      default:
        throw new RoomError('bad_action', 'Unknown action.')
    }
    return json(response, 200, { ok: true })
  }

  throw new RoomError('not_found', 'Not found.', 404)
}

function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return
  }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)))
  if (!file.startsWith(DIST)) file = path.join(DIST, 'index.html')
  let stat = fs.statSync(file, { throwIfNoEntry: false })
  // Every other path is a client-side route (/, /ROOMCODE).
  const isAsset = stat?.isFile() === true
  if (!isAsset) {
    file = path.join(DIST, 'index.html')
    stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat) {
      response.writeHead(503, { 'content-type': 'text/plain' }).end('The web app has not been built yet. Run "npm run build".')
      return
    }
  }
  const immutable = isAsset && url.pathname.startsWith('/assets/')
  response.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : isAsset ? 'public, max-age=3600' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  })
  if (request.method === 'HEAD') response.end()
  else fs.createReadStream(file).pipe(response)
}

const server = http.createServer((request, response) => {
  let url
  try {
    url = new URL(request.url ?? '/', 'http://localhost')
    decodeURIComponent(url.pathname)
  } catch {
    response.writeHead(400).end()
    return
  }
  if (url.pathname.startsWith('/api/')) {
    api(request, response, url).catch(error => {
      if (!(error instanceof RoomError)) console.error(error)
      if (response.headersSent) return response.end()
      if (error instanceof RoomError) json(response, error.status, { error: error.code, message: error.message })
      else json(response, 500, { error: 'server_error', message: 'Something went wrong.' })
    })
  } else {
    serveStatic(request, response, url)
  }
})

// Listen Together passthrough: Metrolist can use wss://<this site>/ws, so one
// domain is enough and the metroserver needs no public address of its own.
function forwardToMetroserver(request, socket, head) {
  const target = new URL(config.metroserverUrl)
  const secure = target.protocol === 'wss:'
  const upstream = (secure ? https : http).request({
    host: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    // metroserver limits connections per address and reads the listener's
    // address from this header; without it everyone would count as us.
    headers: { ...request.headers, host: target.host, 'cf-connecting-ip': clientAddress(request) },
  })
  const refuse = status => {
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstreamSocket.write(head)
    for (const side of [socket, upstreamSocket]) {
      side.setTimeout(0)
      side.setNoDelay(true)
    }
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    upstreamSocket.on('error', () => socket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
  })
  // The metroserver answered without upgrading (at capacity, restarting, ...).
  upstream.on('response', response => {
    response.resume()
    refuse(`${response.statusCode} ${response.statusMessage}`)
  })
  upstream.on('error', () => refuse('502 Bad Gateway'))
  socket.on('error', () => upstream.destroy())
  upstream.end()
}

// Live room state for browsers: /api/rooms/<id>/ws?voter=<id>
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 })
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname === '/ws') return forwardToMetroserver(request, socket, head)
  const match = /^\/api\/rooms\/([A-Za-z0-9]{1,16})\/ws$/.exec(url.pathname)
  const room = match && rooms.get(match[1])
  if (!room || room.sockets.size >= 500) {
    socket.end(`HTTP/1.1 ${room ? 503 : 404} ${room ? 'Busy' : 'Not Found'}\r\nConnection: close\r\n\r\n`)
    return
  }
  sockets.handleUpgrade(request, socket, head, ws => {
    ws.voter = validVoter(url.searchParams.get('voter'))
    ws.alive = true
    ws.on('pong', () => (ws.alive = true))
    ws.on('error', () => {})
    room.attach(ws)
  })
})
setInterval(() => {
  for (const ws of sockets.clients) {
    if (!ws.alive) ws.terminate()
    else {
      ws.alive = false
      ws.ping()
    }
  }
}, 30_000).unref()

rooms.load()
server.listen(config.port, () => {
  console.log(`Metromaker listening on :${config.port}`)
  console.log(`Hosting rooms on ${config.metroserverUrl} (guests use ${config.metroserverPublicUrl || 'this website\'s address + /ws'})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    rooms.shutdown()
    server.close()
    setTimeout(() => process.exit(0), 300)
  })
}
