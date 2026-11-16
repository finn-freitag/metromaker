// A metroserver client that owns one Listen Together room as its host.
// Wire format: binary WebSocket frames holding a protobuf Envelope whose
// payload is another protobuf message, optionally gzip-compressed.
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import protobuf from 'protobufjs'
import WebSocket from 'ws'

const root = new protobuf.Root()
root.loadSync(fileURLToPath(new URL('./proto/listentogether.proto', import.meta.url)), { keepCase: true })
const type = name => root.lookupType(`listentogether.${name}`)
const Envelope = type('Envelope')

const OUTGOING = {
  client_capabilities: type('ClientCapabilities'),
  create_room: type('CreateRoomPayload'),
  reconnect: type('ReconnectPayload'),
  leave_room: type('LeaveRoomPayload'),
  approve_join: type('ApproveJoinPayload'),
  playback_action: type('PlaybackActionPayload'),
  approve_suggestion: type('ApproveSuggestionPayload'),
  reject_suggestion: type('RejectSuggestionPayload'),
}

const INCOMING = {
  server_capabilities: type('ServerCapabilities'),
  room_created: type('RoomCreatedPayload'),
  reconnected: type('ReconnectedPayload'),
  join_request: type('JoinRequestPayload'),
  user_joined: type('UserJoinedPayload'),
  user_left: type('UserLeftPayload'),
  user_reconnected: type('UserReconnectedPayload'),
  user_disconnected: type('UserDisconnectedPayload'),
  suggestion_received: type('SuggestionReceivedPayload'),
  host_changed: type('HostChangedPayload'),
  kicked: type('KickedPayload'),
  server_restarting: type('ServerRestartingPayload'),
  error: type('ErrorPayload'),
}

const COMPRESS_ABOVE = 100
const MAX_BACKOFF_MS = 15_000 // stay well under metroserver's 30 s host failover

function encode(messageType, payload) {
  let bytes = Buffer.from(OUTGOING[messageType].encode(OUTGOING[messageType].fromObject(payload ?? {})).finish())
  let compressed = false
  if (bytes.length > COMPRESS_ABOVE) {
    const zipped = zlib.gzipSync(bytes)
    if (zipped.length < bytes.length) {
      bytes = zipped
      compressed = true
    }
  }
  return Envelope.encode({ type: messageType, payload: bytes, compressed }).finish()
}

function decode(data) {
  const envelope = Envelope.decode(data)
  const schema = INCOMING[envelope.type]
  if (!schema) return { type: envelope.type, payload: null }
  const bytes = envelope.compressed ? zlib.gunzipSync(envelope.payload) : envelope.payload
  return { type: envelope.type, payload: schema.toObject(schema.decode(bytes), { longs: Number, defaults: true, arrays: true }) }
}

/**
 * Events:
 *  - `ready` ({ fresh, state }): the room exists and we are its host. `fresh`
 *    means it was just created (empty); otherwise `state` is the server's copy.
 *  - `code` (roomCode): the room code changed (first creation or re-creation).
 *  - `users`: the listener list changed.
 *  - `suggestion` ({ id, track, username, userId }): a Metrolist guest suggested a track.
 *  - `down`: the connection dropped; a reconnect is already scheduled.
 *  - `fatal` (message): the server refuses to let us host.
 */
export class MetroHost extends EventEmitter {
  constructor({ url, username, session = null }) {
    super()
    this.url = url
    this.username = username
    this.sessionToken = session?.token ?? ''
    this.roomCode = session?.code ?? ''
    this.userId = ''
    this.ready = false
    this.stopped = false
    this.users = new Map()
    this.ws = null
    this.attempts = 0
    this.retryTimer = null
    this.restartDelay = 0
  }

  start() {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    const ws = new WebSocket(this.url, { headers: { 'User-Agent': 'Metromaker/1.0' }, handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 })
    this.ws = ws
    ws.on('open', () => {
      this.attempts = 0
      this.#send('client_capabilities', {
        supports_protobuf: true,
        supports_compression: true,
        client_version: 'metromaker-1',
        features: ['replace_queue', 'server_restarting', 'suggestion_ack'],
      })
    })
    ws.on('message', data => {
      if (ws !== this.ws) return
      try {
        const message = decode(data)
        this.#handle(message.type, message.payload)
      } catch (error) {
        console.warn(`[metro ${this.roomCode || 'new'}] undecodable message: ${error.message}`)
      }
    })
    ws.on('error', error => {
      if (ws === this.ws && this.attempts === 0) console.warn(`[metro ${this.roomCode || 'new'}] ${error.message}`)
    })
    ws.on('close', () => {
      if (ws !== this.ws) return
      this.ws = null
      const wasReady = this.ready
      this.ready = false
      if (this.stopped) return
      if (wasReady) this.emit('down')
      const delay = this.restartDelay || Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS)
      this.restartDelay = 0
      this.attempts++
      this.retryTimer = setTimeout(() => this.start(), delay)
    })
  }

  /** Leaves the room for good, which closes it for everyone once it is empty. */
  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    if (this.ready) this.#send('leave_room', {})
    this.ready = false
    const ws = this.ws
    this.ws = null
    // Give the leave message a moment to flush before closing.
    if (ws) setTimeout(() => ws.close(), 200)
  }

  /** Disconnects but keeps the room on the server so a restart can reclaim it. */
  detach() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.ready = false
    this.ws?.close()
    this.ws = null
  }

  /** Connected Metrolist listeners, not counting ourselves. */
  get audience() {
    let count = 0
    for (const [id, user] of this.users) if (id !== this.userId && user.connected) count++
    return count
  }

  /** Sends a host playback action; dropped while disconnected (state is re-pushed on `ready`). */
  action(payload) {
    if (this.ready) this.#send('playback_action', payload)
  }

  approveSuggestion(id) {
    if (this.ready) this.#send('approve_suggestion', { suggestion_id: id })
  }

  rejectSuggestion(id, reason) {
    if (this.ready) this.#send('reject_suggestion', { suggestion_id: id, reason })
  }

  #send(messageType, payload) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(messageType, payload))
  }

  #enter() {
    if (this.sessionToken) this.#send('reconnect', { session_token: this.sessionToken })
    else this.#send('create_room', { username: this.username })
  }

  #setUsers(users) {
    this.users = new Map(users.map(user => [user.user_id, { username: user.username, connected: user.is_connected }]))
    this.emit('users')
  }

  #handle(messageType, payload) {
    switch (messageType) {
      case 'server_capabilities':
        if (!payload.can_host) {
          this.#fatal('This metroserver does not allow Metromaker to host rooms (User-Agent policy).')
          return
        }
        this.#enter()
        break

      case 'room_created':
        this.userId = payload.user_id
        this.sessionToken = payload.session_token
        this.users = new Map([[payload.user_id, { username: this.username, connected: true }]])
        this.ready = true
        if (payload.room_code !== this.roomCode) {
          this.roomCode = payload.room_code
          this.emit('code', payload.room_code)
        }
        this.emit('users')
        this.emit('ready', { fresh: true, state: null })
        break

      case 'reconnected':
        this.userId = payload.user_id
        this.roomCode = payload.room_code
        this.#setUsers(payload.state?.users ?? [])
        // After a failover the server hands the room back to its original host.
        this.ready = payload.is_host
        if (payload.is_host) this.emit('ready', { fresh: false, state: payload.state })
        else console.warn(`[metro ${this.roomCode}] reconnected without host role`)
        break

      case 'host_changed':
        if (payload.new_host_id === this.userId && !this.ready) {
          this.ready = true
          this.emit('ready', { fresh: false, state: null })
        }
        break

      case 'join_request':
        // Everyone with the code may listen; nobody but us can become host.
        this.#send('approve_join', { user_id: payload.user_id })
        break

      case 'user_joined':
      case 'user_reconnected':
        this.users.set(payload.user_id, { username: payload.username, connected: true })
        this.emit('users')
        break

      case 'user_disconnected':
        if (this.users.has(payload.user_id)) this.users.get(payload.user_id).connected = false
        this.emit('users')
        break

      case 'user_left':
        this.users.delete(payload.user_id)
        this.emit('users')
        break

      case 'suggestion_received':
        if (payload.track_info?.id) {
          this.emit('suggestion', { id: payload.suggestion_id, track: payload.track_info, username: payload.from_username, userId: payload.from_user_id })
        }
        break

      case 'server_restarting':
        this.restartDelay = Math.min(Math.max(payload.eta_ms, 1000), MAX_BACKOFF_MS) + 500
        break

      case 'kicked':
        // The server closed the room. Start over with a new one.
        this.#forgetRoom()
        this.ws?.close()
        break

      case 'error':
        this.#handleError(payload)
        break
    }
  }

  /** Reports a refusal and keeps retrying slowly in case the server's policy changes. */
  #fatal(message) {
    this.emit('fatal', message)
    this.restartDelay = MAX_BACKOFF_MS
    this.ws?.close()
  }

  #forgetRoom() {
    this.sessionToken = ''
    this.ready = false
    this.users = new Map()
  }

  #handleError({ code, message }) {
    switch (code) {
      case 'session_not_found':
      case 'session_expired':
      case 'room_not_found':
        // The server no longer knows our room (restart without its database,
        // or we were away longer than the grace period). Create a new one.
        this.#forgetRoom()
        this.#send('create_room', { username: this.username })
        break
      case 'host_not_allowed':
        this.#fatal('This metroserver does not allow Metromaker to host rooms (User-Agent policy).')
        break
      case 'room_limit_reached':
        this.#fatal('The metroserver is at room capacity.')
        break
      case 'rate_limited':
        if (!this.ready) {
          this.restartDelay = MAX_BACKOFF_MS
          this.ws?.close()
        }
        break
      case 'not_host':
      case 'not_in_room':
        // Our view of the room is stale; a clean reconnect resynchronises it.
        this.ws?.close()
        break
      case 'duplicate_track':
      case 'stale_track':
      case 'suggestion_not_found':
        break // harmless races between our queue and the server's copy
      default:
        console.warn(`[metro ${this.roomCode || 'new'}] ${code}: ${message}`)
    }
  }
}
