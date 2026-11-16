import path from 'node:path'

function int(name, fallback, min = 1) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value >= min ? value : fallback
}

/** Accepts ws(s):// or http(s):// and adds the /ws path metroserver listens on. */
export function normalizeMetroserverUrl(raw) {
  const value = (raw ?? '').trim()
  if (!value) return ''
  let url
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `ws://${value}`)
  } catch {
    throw new Error(`Invalid metroserver URL: ${value}`)
  }
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`Invalid metroserver URL: ${value}`)
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws'
  return url.toString()
}

const metroserverUrl = normalizeMetroserverUrl(process.env.METROSERVER_URL || 'ws://localhost:8080/ws')

export const config = {
  port: int('PORT', 3000),
  /** Where this backend connects to as the room host. */
  metroserverUrl,
  /** What guests have to enter in Metrolist. Defaults to the URL above. */
  metroserverPublicUrl: normalizeMetroserverUrl(process.env.METROSERVER_PUBLIC_URL) || metroserverUrl,
  hostName: (process.env.HOST_NAME || 'Metromaker').slice(0, 50),
  maxRooms: int('MAX_ROOMS', 20),
  roomIdleMs: int('ROOM_IDLE_MINUTES', 180) * 60_000,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
  language: process.env.YTM_LANGUAGE || 'en',
  region: process.env.YTM_REGION || 'US',
}
