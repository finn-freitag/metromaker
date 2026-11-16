export interface Track {
  id: string
  title: string
  artist: string
  album: string
  /** milliseconds; 0 when unknown */
  duration: number
  thumbnail: string
}

export interface QueueEntry {
  key: number
  track: Track
  /** Metrolist username when the song was suggested from the app */
  name: string
  score: number
  myVote: -1 | 0 | 1
  mine: boolean
}

export interface RoomState {
  type: 'state'
  id: string
  /** Listen Together code to enter in Metrolist */
  code: string
  mode: 'vote' | 'queue'
  allowRepeats: boolean
  playlist: { id: string; title: string; count: number } | null
  now: { track: Track; source: 'user' | 'playlist'; name: string; position: number; playing: boolean } | null
  queue: QueueEntry[]
  /** Next songs from the fallback playlist, only while the queue is empty */
  upNext: Track[]
  playedIds: string[]
  listeners: number
  viewers: number
  metroConnected: boolean
  metroError: string
}

export class ApiError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('offline', 'Could not reach the server. Check your connection.', 0)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(data.error ?? 'error', data.message ?? 'Something went wrong.', response.status)
  return data as T
}

function storage(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(key, value)
    return localStorage.getItem(key) ?? ''
  } catch {
    return value ?? ''
  }
}

let voter = ''
/** A random ID per browser so everyone gets one vote per song. */
export function voterId(): string {
  if (!voter) voter = storage('metromaker.voter')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(voter)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    voter = storage('metromaker.voter', Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''))
  }
  return voter
}

/** The creator's browser keeps a token that unlocks skip, pause and remove. */
export function adminToken(room: string, token?: string): string {
  return storage(`metromaker.admin.${room}`, token)
}

export const api = {
  config: () => request<{ metroserverUrl: string }>('/config'),
  createRoom: (options: { mode: 'vote' | 'queue'; allowRepeats: boolean; playlist: string }) =>
    request<{ id: string; adminToken: string }>('/rooms', options),
  room: (id: string) => request<{ id: string; code: string }>(`/rooms/${encodeURIComponent(id)}`),
  search: (query: string, signal: AbortSignal) => request<{ tracks: Track[] }>(`/search?q=${encodeURIComponent(query)}`, undefined, signal),
  addSong: (room: string, id: string) => request<{ status: 'added' | 'upvoted' }>(`/rooms/${room}/songs`, { id, voter: voterId() }),
  vote: (room: string, key: number, value: -1 | 0 | 1) => request<{ ok: true }>(`/rooms/${room}/votes`, { key, value, voter: voterId() }),
  admin: (room: string, action: 'skip' | 'pause' | 'resume' | 'remove' | 'close', key?: number) =>
    request<{ ok: true }>(`/rooms/${room}/admin`, { action, key, token: adminToken(room) }),
}

export function formatDuration(milliseconds: number): string {
  if (!milliseconds || milliseconds < 0) return ''
  const total = Math.floor(milliseconds / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs HTTPS; fall back to a selected copy on plain-HTTP LAN setups.
  }
  const input = document.createElement('input')
  try {
    input.value = text
    input.readOnly = true
    input.style.cssText = 'position: fixed; left: -9999px; top: 0;'
    document.body.appendChild(input)
    input.select()
    return document.execCommand('copy') === true
  } catch {
    return false
  } finally {
    input.remove()
  }
}
