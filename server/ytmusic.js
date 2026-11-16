// Minimal YouTube Music client: song search and playlist loading through the
// same InnerTube endpoints music.youtube.com uses. No API key or login needed.
import { config } from './config.js'

const ENDPOINT = 'https://music.youtube.com/youtubei/v1'
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF'
const MAX_PLAYLIST_TRACKS = 1000
const MAX_PLAYLIST_PAGES = 12

/**
 * @typedef {{ id: string, title: string, artist: string, album: string, duration: number, thumbnail: string }} Track
 * `duration` is in milliseconds, matching metroserver's TrackInfo.
 */

async function innertube(endpoint, body) {
  const response = await fetch(`${ENDPOINT}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      origin: 'https://music.youtube.com',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20251110.01.00', hl: config.language, gl: config.region } },
      ...body,
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`YouTube Music answered ${response.status}`)
  return response.json()
}

/** Collects every value stored under `key`, however deep the response nests it. */
function findAll(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, key, out)
  } else if (node && typeof node === 'object') {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) out.push(value)
      findAll(value, key, out)
    }
  }
  return out
}

function parseDuration(text) {
  if (!/^\d+(:\d{2}){1,2}$/.test(text ?? '')) return 0
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000
}

function pageType(run) {
  return run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
}

function bestThumbnail(renderer, id) {
  const thumbnails = findAll(renderer.thumbnail, 'thumbnails')[0]
  const url = thumbnails?.at(-1)?.url
  if (!url) return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
  // Album art is served at any requested size.
  return url.replace(/=w\d+-h\d+/, '=w226-h226')
}

/** @returns {Track | null} */
function parseItem(renderer) {
  const id = renderer.playlistItemData?.videoId
  if (!id) return null
  if (renderer.musicItemRendererDisplayPolicy === 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT') return null
  const columns = (renderer.flexColumns ?? []).map(column => column.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
  const title = (columns[0] ?? []).map(run => run.text).join('').trim()
  if (!title) return null
  const meta = columns.slice(1).flat()
  let artist = meta
    .filter(run => ['MUSIC_PAGE_TYPE_ARTIST', 'MUSIC_PAGE_TYPE_USER_CHANNEL'].includes(pageType(run)))
    .map(run => run.text)
    .join(', ')
  if (!artist) {
    // Artists without a channel page are plain text before the first bullet.
    artist = (columns[1] ?? []).map(run => run.text).join('').split(' • ')[0].trim()
  }
  const fixed = renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text
  const duration = parseDuration(fixed) || meta.map(run => parseDuration(run.text)).find(Boolean) || 0
  return {
    id,
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    album: (meta.find(run => pageType(run) === 'MUSIC_PAGE_TYPE_ALBUM')?.text ?? '').slice(0, 200),
    duration,
    thumbnail: bestThumbnail(renderer, id),
  }
}

function parseItems(response) {
  const seen = new Set()
  const tracks = []
  for (const renderer of findAll(response, 'musicResponsiveListItemRenderer')) {
    const track = parseItem(renderer)
    if (track && !seen.has(track.id)) {
      seen.add(track.id)
      tracks.push(track)
    }
  }
  return tracks
}

/** @returns {Promise<Track[]>} */
export async function searchSongs(query) {
  return parseItems(await innertube('search', { query, params: SONGS_FILTER }))
}

/** Extracts a playlist ID from a YouTube / YouTube Music link or a bare ID. */
export function parsePlaylistId(input) {
  const value = (input ?? '').trim()
  if (!value) return ''
  try {
    const list = new URL(value).searchParams.get('list')
    if (list && /^[A-Za-z0-9_-]{10,100}$/.test(list)) return list
  } catch {
    // Not a URL; fall through to the bare-ID check.
  }
  return /^[A-Za-z0-9_-]{10,100}$/.test(value) ? value.replace(/^VL/, '') : ''
}

/** @returns {Promise<{ id: string, title: string, tracks: Track[] }>} */
export async function loadPlaylist(input) {
  const id = parsePlaylistId(input)
  if (!id) throw new Error('That does not look like a YouTube playlist link.')
  let page = await innertube('browse', { browseId: `VL${id}` })
  const header = findAll(page, 'musicResponsiveHeaderRenderer')[0] ?? findAll(page, 'musicDetailHeaderRenderer')[0]
  const title = header?.title?.runs?.map(run => run.text).join('').trim() || 'Playlist'

  const tracks = []
  const seen = new Set()
  for (let pageNumber = 0; pageNumber < MAX_PLAYLIST_PAGES; pageNumber++) {
    for (const track of parseItems(pageNumber === 0 ? findAll(page, 'musicPlaylistShelfRenderer') : page)) {
      if (!seen.has(track.id) && tracks.length < MAX_PLAYLIST_TRACKS) {
        seen.add(track.id)
        tracks.push(track)
      }
    }
    const shelf = pageNumber === 0 ? findAll(page, 'musicPlaylistShelfRenderer') : page
    const token = findAll(shelf, 'continuationItemRenderer')[0]?.continuationEndpoint?.continuationCommand?.token
    if (!token || tracks.length >= MAX_PLAYLIST_TRACKS) break
    page = await innertube('browse', { continuation: token })
  }
  if (tracks.length === 0) throw new Error('No playable songs found. The playlist must be public or unlisted.')
  return { id, title: title.slice(0, 120), tracks }
}
