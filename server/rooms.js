// Rooms: the queue, voting and the playback timeline. Each room drives one
// metroserver room as its host, so Metrolist listeners follow whatever plays here.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { MetroHost } from './metro.js'

const START_DELAY_MS = 1500 // lets listeners buffer before the track starts
const UNKNOWN_DURATION_MS = 210_000
const MAX_QUEUE = 200
const PLAYLIST_PREVIEW = 10
const QUEUE_TITLE = 'Metromaker'

export class RoomError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function metroTrack(track, suggestedBy = '') {
  return { id: track.id, title: track.title, artist: track.artist, album: track.album ?? '', duration: track.duration, thumbnail: track.thumbnail ?? '', suggested_by: suggestedBy }
}

export class Room {
  constructor(manager, data) {
    this.manager = manager
    this.id = data.id
    this.adminToken = data.adminToken
    this.mode = data.mode // 'vote' | 'queue'
    this.allowRepeats = data.allowRepeats
    this.playlist = data.playlist ?? null // { id, title, tracks }
    this.playlistPos = data.playlistPos ?? 0
    this.createdAt = data.createdAt ?? Date.now()
    this.lastActive = Date.now()
    this.seq = data.seq ?? 0
    /** @type {{ key: number, track: object, addedBy: string, name: string, votes: Map<string, number> }[]} */
    this.queue = (data.queue ?? []).map(entry => ({ ...entry, votes: new Map(entry.votes) }))
    this.played = new Set(data.played ?? [])
    this.current = data.current ?? null // { track, source: 'user' | 'playlist', name }
    this.playing = data.playing ?? false
    this.positionBase = data.positionBase ?? 0
    this.startedAt = data.startedAt ?? 0
    this.endTimer = null
    this.startTimer = null
    this.syncTimer = null
    this.broadcastQueued = false
    this.sockets = new Set()
    this.metroError = ''
    this.closed = false

    this.metro = new MetroHost({ url: config.metroserverUrl, username: config.hostName, session: data.metro ?? null })
    this.metro.on('ready', event => this.#onMetroReady(event))
    this.metro.on('code', () => this.changed())
    this.metro.on('users', () => {
      this.touch()
      this.broadcast()
    })
    this.metro.on('down', () => this.broadcast())
    this.metro.on('fatal', message => {
      this.metroError = message
      this.broadcast()
    })
    this.metro.on('suggestion', suggestion => this.#onSuggestion(suggestion))
  }

  /** Resumes the timeline after a restart of this process. */
  restore() {
    if (this.current && this.playing) {
      if (this.position() >= this.#duration()) this.playNext()
      else this.#armEndTimer()
    } else if (!this.current) {
      this.playNext()
    }
    this.metro.start()
  }

  touch() {
    this.lastActive = Date.now()
  }

  get code() {
    return this.metro.roomCode || this.id
  }

  // ---- timeline -----------------------------------------------------------

  position() {
    if (!this.current) return 0
    const position = this.playing ? this.positionBase + (Date.now() - this.startedAt) : this.positionBase
    return Math.max(0, Math.min(position, this.#duration()))
  }

  #duration() {
    return this.current?.track.duration || UNKNOWN_DURATION_MS
  }

  #armEndTimer() {
    clearTimeout(this.endTimer)
    if (!this.current || !this.playing) return
    const remaining = this.#duration() - (this.positionBase + (Date.now() - this.startedAt))
    this.endTimer = setTimeout(() => this.playNext(), Math.max(remaining, 0) + 400)
  }

  sortedQueue() {
    const entries = [...this.queue]
    if (this.mode === 'vote') entries.sort((a, b) => score(b) - score(a) || a.key - b.key)
    else entries.sort((a, b) => a.key - b.key)
    return entries
  }

  /** Picks the next fallback track, preferring ones that have not been played. */
  #nextFromPlaylist(advance) {
    const tracks = this.playlist?.tracks ?? []
    if (tracks.length === 0) return null
    const queued = new Set(this.queue.map(entry => entry.track.id))
    for (let offset = 0; offset < tracks.length; offset++) {
      const index = (this.playlistPos + offset) % tracks.length
      const track = tracks[index]
      if (queued.has(track.id) || track.id === this.current?.track.id) continue
      if (!this.allowRepeats && this.played.has(track.id)) continue
      if (advance) this.playlistPos = (index + 1) % tracks.length
      return track
    }
    // Everything has been played: silence is worse than a repeat, so loop.
    const track = tracks[this.playlistPos % tracks.length]
    if (advance) this.playlistPos = (this.playlistPos + 1) % tracks.length
    return track
  }

  /** What Metrolist shows as "up next": the queue, then a taste of the playlist. */
  upcoming() {
    const queue = this.sortedQueue().map(entry => metroTrack(entry.track, entry.name))
    return [...queue, ...this.playlistPreview(PLAYLIST_PREVIEW).map(track => metroTrack(track))]
  }

  playlistPreview(limit) {
    const tracks = this.playlist?.tracks ?? []
    const skip = new Set(this.queue.map(entry => entry.track.id))
    if (this.current) skip.add(this.current.track.id)
    const preview = []
    for (let offset = 0; offset < tracks.length && preview.length < limit; offset++) {
      const track = tracks[(this.playlistPos + offset) % tracks.length]
      if (skip.has(track.id) || (!this.allowRepeats && this.played.has(track.id))) continue
      skip.add(track.id)
      preview.push(track)
    }
    return preview
  }

  playNext() {
    clearTimeout(this.endTimer)
    clearTimeout(this.startTimer)
    const previous = this.current
    this.current = null
    const entry = this.sortedQueue()[0]
    if (entry) {
      this.queue = this.queue.filter(other => other !== entry)
      this.current = { track: entry.track, source: 'user', name: entry.name }
    } else {
      const track = this.#nextFromPlaylist(true)
      if (track) this.current = { track, source: 'playlist', name: '' }
    }

    if (!this.current) {
      this.playing = false
      this.positionBase = 0
      if (previous) this.metro.action({ action: 'pause', track_id: previous.track.id, position: previous.track.duration || 0 })
      this.#syncQueueNow()
      this.changed()
      return
    }

    this.played.add(this.current.track.id)
    this.playing = true
    this.positionBase = 0
    this.startedAt = Date.now() + START_DELAY_MS
    this.#armEndTimer()
    this.#pushTrack()
    this.changed()
  }

  pause() {
    if (!this.current || !this.playing) return
    this.positionBase = this.position()
    this.playing = false
    clearTimeout(this.endTimer)
    clearTimeout(this.startTimer)
    this.metro.action({ action: 'pause', track_id: this.current.track.id, position: Math.round(this.positionBase) })
    this.changed()
  }

  resume() {
    if (!this.current || this.playing) return
    this.playing = true
    this.startedAt = Date.now()
    this.#armEndTimer()
    this.metro.action({ action: 'play', track_id: this.current.track.id, position: Math.round(this.positionBase) })
    this.changed()
  }

  // ---- metroserver --------------------------------------------------------

  /** Announces the current track, then starts (or parks) it once listeners had time to load it. */
  #pushTrack() {
    clearTimeout(this.startTimer)
    clearTimeout(this.syncTimer)
    if (!this.current) return
    const track = this.current.track
    this.metro.action({
      action: 'change_track',
      track_info: metroTrack(track, this.current.name),
      queue: this.upcoming(),
      replace_queue: true,
      queue_title: QUEUE_TITLE,
    })
    this.startTimer = setTimeout(() => {
      if (this.current?.track !== track) return
      const position = Math.round(this.position())
      this.metro.action({ action: this.playing ? 'play' : 'pause', track_id: track.id, position })
    }, START_DELAY_MS)
  }

  #syncQueueNow() {
    clearTimeout(this.syncTimer)
    this.metro.action({ action: 'sync_queue', queue: this.upcoming(), queue_title: QUEUE_TITLE })
  }

  #syncQueue() {
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => this.#syncQueueNow(), 300)
  }

  #onMetroReady({ fresh, state }) {
    this.metroError = ''
    const inSync = !fresh && state && (state.current_track?.id ?? '') === (this.current?.track.id ?? '') && state.is_playing === this.playing
    if (inSync || !this.current) this.#syncQueueNow()
    else this.#pushTrack()
    this.changed()
  }

  /** A Metrolist guest suggested a track: treat it like a song picked on the website. */
  #onSuggestion({ id, track, username, userId }) {
    const candidate = {
      id: track.id,
      title: track.title || track.id,
      artist: track.artist || '',
      album: track.album || '',
      duration: track.duration > 0 ? track.duration : 0,
      thumbnail: track.thumbnail || `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`,
    }
    try {
      this.checkAddable(candidate.id)
      // Approve first: the server needs the suggestion resolved before our own
      // queue update replaces its copy with the correctly ordered one.
      this.metro.approveSuggestion(id)
      this.addSong(candidate, `metro:${userId}`, username)
    } catch (error) {
      if (error instanceof RoomError && error.code === 'in_queue' && this.mode === 'vote') {
        this.vote(this.queue.find(entry => entry.track.id === candidate.id).key, `metro:${userId}`, 1)
        this.metro.rejectSuggestion(id, 'Already in the queue, so your suggestion counted as an upvote.')
      } else {
        this.metro.rejectSuggestion(id, error instanceof RoomError ? error.message : 'Could not add this song.')
      }
    }
  }

  // ---- queue --------------------------------------------------------------

  checkAddable(trackId) {
    if (this.current?.track.id === trackId) throw new RoomError('now_playing', 'This song is playing right now.')
    if (this.queue.some(entry => entry.track.id === trackId)) throw new RoomError('in_queue', 'This song is already in the queue.')
    if (!this.allowRepeats && this.played.has(trackId)) throw new RoomError('already_played', 'This song has already been played in this room.')
    if (this.queue.length >= MAX_QUEUE) throw new RoomError('queue_full', 'The queue is full.')
  }

  addSong(track, voter, name = '') {
    this.touch()
    const existing = this.queue.find(entry => entry.track.id === track.id)
    if (existing && this.mode === 'vote') {
      this.vote(existing.key, voter, 1)
      return { status: 'upvoted' }
    }
    this.checkAddable(track.id)
    this.queue.push({ key: ++this.seq, track, addedBy: voter, name: name.slice(0, 50), votes: new Map(this.mode === 'vote' ? [[voter, 1]] : []) })
    if (!this.current) this.playNext()
    else {
      this.#syncQueue()
      this.changed()
    }
    return { status: 'added' }
  }

  vote(key, voter, value) {
    if (this.mode !== 'vote') throw new RoomError('no_voting', 'Voting is turned off in this room.')
    const entry = this.queue.find(other => other.key === key)
    if (!entry) throw new RoomError('not_found', 'This song is no longer in the queue.', 404)
    this.touch()
    if (value === 0) entry.votes.delete(voter)
    else entry.votes.set(voter, value > 0 ? 1 : -1)
    this.#syncQueue()
    this.changed()
  }

  remove(key) {
    const before = this.queue.length
    this.queue = this.queue.filter(entry => entry.key !== key)
    if (this.queue.length === before) throw new RoomError('not_found', 'This song is no longer in the queue.', 404)
    this.#syncQueue()
    this.changed()
  }

  // ---- browsers -----------------------------------------------------------

  snapshot(voter) {
    return {
      type: 'state',
      id: this.id,
      code: this.code,
      mode: this.mode,
      allowRepeats: this.allowRepeats,
      playlist: this.playlist ? { id: this.playlist.id, title: this.playlist.title, count: this.playlist.tracks.length } : null,
      now: this.current ? { track: this.current.track, source: this.current.source, name: this.current.name, position: Math.round(this.position()), playing: this.playing } : null,
      queue: this.sortedQueue().map(entry => ({
        key: entry.key,
        track: entry.track,
        name: entry.name,
        score: score(entry),
        myVote: entry.votes.get(voter) ?? 0,
        mine: entry.addedBy === voter,
      })),
      upNext: this.queue.length === 0 ? this.playlistPreview(3) : [],
      playedIds: this.allowRepeats ? [] : [...this.played],
      listeners: this.metro.audience,
      viewers: this.sockets.size,
      metroConnected: this.metro.ready,
      metroError: this.metroError,
    }
  }

  /** State changed: tell the browsers and save. */
  changed() {
    this.broadcast()
    this.manager.save()
  }

  broadcast() {
    if (this.broadcastQueued) return
    this.broadcastQueued = true
    setImmediate(() => {
      this.broadcastQueued = false
      for (const socket of this.sockets) {
        if (socket.readyState === 1) socket.send(JSON.stringify(this.snapshot(socket.voter)))
      }
    })
  }

  attach(socket) {
    this.sockets.add(socket)
    this.touch()
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.touch()
      this.broadcast()
    })
    this.broadcast()
  }

  /** @param {boolean} keepMetroRoom keep the metroserver room for a later restore */
  dispose(keepMetroRoom) {
    this.closed = true
    clearTimeout(this.endTimer)
    clearTimeout(this.startTimer)
    clearTimeout(this.syncTimer)
    if (keepMetroRoom) this.metro.detach()
    else this.metro.stop()
    for (const socket of this.sockets) {
      if (!keepMetroRoom) socket.send(JSON.stringify({ type: 'closed' }))
      socket.close()
    }
    this.sockets.clear()
  }

  toJSON() {
    return {
      id: this.id,
      adminToken: this.adminToken,
      mode: this.mode,
      allowRepeats: this.allowRepeats,
      playlist: this.playlist,
      playlistPos: this.playlistPos,
      createdAt: this.createdAt,
      seq: this.seq,
      queue: this.queue.map(entry => ({ ...entry, votes: [...entry.votes] })),
      played: [...this.played],
      current: this.current,
      playing: this.playing,
      positionBase: this.positionBase,
      startedAt: this.startedAt,
      metro: this.metro.sessionToken ? { token: this.metro.sessionToken, code: this.metro.roomCode } : null,
    }
  }
}

function score(entry) {
  let total = 0
  for (const value of entry.votes.values()) total += value
  return total
}

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map()
    this.file = path.join(config.dataDir, 'rooms.json')
    this.saveTimer = null
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
    this.cleanupTimer.unref()
  }

  load() {
    let saved
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    for (const data of Array.isArray(saved) ? saved : []) {
      try {
        const room = new Room(this, data)
        this.rooms.set(room.id, room)
        room.restore()
      } catch (error) {
        console.warn(`Could not restore room ${data?.id}: ${error.message}`)
      }
    }
    if (this.rooms.size > 0) console.log(`Restored ${this.rooms.size} room(s)`)
  }

  save() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 1000)
  }

  saveNow() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      fs.mkdirSync(config.dataDir, { recursive: true })
      const temporary = `${this.file}.tmp`
      fs.writeFileSync(temporary, JSON.stringify([...this.rooms.values()]), { mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } catch (error) {
      console.warn(`Could not save rooms: ${error.message}`)
    }
  }

  get(id) {
    return this.rooms.get(String(id).toUpperCase())
  }

  /** Creates the metroserver room first; its code becomes the room's ID. */
  create({ mode, allowRepeats, playlist }) {
    if (this.rooms.size >= config.maxRooms) throw new RoomError('too_many_rooms', 'This server is hosting as many rooms as it can. Try again later.', 503)
    return new Promise((resolve, reject) => {
      const room = new Room(this, { id: '', adminToken: randomBytes(24).toString('base64url'), mode, allowRepeats, playlist })
      const fail = message => {
        clearTimeout(timeout)
        room.dispose(false)
        reject(new RoomError('metroserver_unavailable', message, 502))
      }
      const timeout = setTimeout(() => fail('Could not reach the Listen Together server. Try again in a moment.'), 10_000)
      room.metro.once('fatal', fail)
      room.metro.once('code', code => {
        clearTimeout(timeout)
        room.metro.off('fatal', fail)
        room.id = code
        this.rooms.set(room.id, room)
        this.save()
        resolve(room)
      })
      // Start with the fallback playlist so the party is never silent.
      room.metro.once('ready', () => room.playNext())
      room.metro.start()
    })
  }

  delete(room) {
    if (this.rooms.get(room.id) !== room) return
    this.rooms.delete(room.id)
    room.dispose(false)
    this.save()
  }

  cleanup() {
    const now = Date.now()
    for (const room of this.rooms.values()) {
      const idle = room.sockets.size === 0 && room.metro.audience === 0
      if (idle && now - room.lastActive > config.roomIdleMs) {
        console.log(`Closing idle room ${room.id}`)
        this.delete(room)
      }
    }
  }

  /** Graceful shutdown: keep metroserver rooms alive so a restart can reclaim them. */
  shutdown() {
    this.saveNow()
    for (const room of this.rooms.values()) room.dispose(true)
  }
}
