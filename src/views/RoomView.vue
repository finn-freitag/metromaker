<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import TrackRow from '../components/TrackRow.vue'
import { adminToken, api, ApiError, copyText, formatDuration, voterId, type QueueEntry, type RoomState, type Track } from '../api'

const props = defineProps<{ room: string }>()
const roomId = computed(() => props.room.toUpperCase())

// ---- live room state ------------------------------------------------------

const status = ref<'loading' | 'ready' | 'missing' | 'closed'>('loading')
const state = ref<RoomState | null>(null)
const online = ref(false)
const isAdmin = ref(false)
const clock = ref(performance.now())
let receivedAt = 0
let socket: WebSocket | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let attempts = 0
let unmounted = false

function connect() {
  if (unmounted) return
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${location.host}/api/rooms/${roomId.value}/ws?voter=${voterId()}`)
  socket = ws
  ws.onopen = () => {
    attempts = 0
    online.value = true
  }
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.type === 'closed') {
      status.value = 'closed'
    } else if (message.type === 'state') {
      receivedAt = performance.now()
      clock.value = receivedAt
      state.value = message
      status.value = 'ready'
    }
  }
  ws.onclose = async () => {
    if (ws !== socket || unmounted) return
    online.value = false
    if (status.value === 'closed') return
    // Tell a room that ended apart from a network hiccup.
    try {
      await api.room(roomId.value)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        status.value = state.value ? 'closed' : 'missing'
        return
      }
    }
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10_000))
  }
}

onMounted(() => {
  isAdmin.value = adminToken(roomId.value) !== ''
  connect()
  clockTimer = setInterval(() => (clock.value = performance.now()), 500)
  api.config().then(config => (serverUrl.value = config.metroserverUrl)).catch(() => {})
})

onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(retryTimer)
  clearTimeout(toastTimer)
  clearTimeout(searchTimer)
  clearInterval(clockTimer)
  socket?.close()
})

const position = computed(() => {
  const now = state.value?.now
  if (!now) return 0
  const elapsed = now.playing ? clock.value - receivedAt : 0
  return Math.min(now.position + elapsed, now.track.duration || Infinity)
})
const progress = computed(() => {
  const duration = state.value?.now?.track.duration
  return duration ? Math.min(position.value / duration, 1) : 0
})

// ---- feedback -------------------------------------------------------------

const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function notify(message: string) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 3200)
}
function fail(error: unknown) {
  notify(error instanceof Error ? error.message : 'Something went wrong.')
}

// ---- search ---------------------------------------------------------------

const query = ref('')
const results = ref<Track[]>([])
const searching = ref(false)
const searchError = ref('')
const adding = ref(new Set<string>())
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchAbort: AbortController | undefined

watch(query, value => {
  clearTimeout(searchTimer)
  searchAbort?.abort()
  searchError.value = ''
  const text = value.trim()
  if (text.length < 2) {
    results.value = []
    searching.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(async () => {
    const abort = new AbortController()
    searchAbort = abort
    try {
      results.value = (await api.search(text, abort.signal)).tracks.slice(0, 10)
      searching.value = false
    } catch (error) {
      if (abort.signal.aborted) return
      results.value = []
      searching.value = false
      searchError.value = error instanceof Error ? error.message : 'Search failed.'
    }
  }, 350)
})

const queuedById = computed(() => new Map((state.value?.queue ?? []).map(entry => [entry.track.id, entry])))
const playedIds = computed(() => new Set(state.value?.playedIds ?? []))

/** Why a search result cannot simply be added, if so. */
function resultStatus(track: Track): 'playing' | 'queued' | 'voted' | 'played' | 'free' {
  if (state.value?.now?.track.id === track.id) return 'playing'
  const entry = queuedById.value.get(track.id)
  if (entry) return state.value?.mode === 'vote' && entry.myVote !== 1 ? 'queued' : 'voted'
  if (playedIds.value.has(track.id)) return 'played'
  return 'free'
}

async function addSong(track: Track) {
  if (adding.value.has(track.id)) return
  adding.value = new Set(adding.value).add(track.id)
  try {
    const result = await api.addSong(roomId.value, track.id)
    notify(result.status === 'upvoted' ? `Upvoted “${track.title}”` : `Added “${track.title}”`)
  } catch (error) {
    fail(error)
  } finally {
    const next = new Set(adding.value)
    next.delete(track.id)
    adding.value = next
  }
}

// ---- queue ----------------------------------------------------------------

async function vote(entry: QueueEntry, value: 1 | -1) {
  try {
    await api.vote(roomId.value, entry.key, entry.myVote === value ? 0 : value)
  } catch (error) {
    fail(error)
  }
}

async function admin(action: 'skip' | 'pause' | 'resume' | 'remove', key?: number) {
  try {
    await api.admin(roomId.value, action, key)
  } catch (error) {
    fail(error)
  }
}

const closeDialog = ref<HTMLDialogElement>()
async function closeRoom() {
  try {
    await api.admin(roomId.value, 'close')
    closeDialog.value?.close()
    status.value = 'closed'
  } catch (error) {
    fail(error)
  }
}

// ---- sharing --------------------------------------------------------------

const serverUrl = ref('')
const shareUrl = computed(() => `${location.origin}/${roomId.value}`)
const appUrl = computed(() => `metrolist://party?r=${state.value?.code ?? roomId.value}`)
const qr = ref('')
const qrDialog = ref<HTMLDialogElement>()
const copied = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

watch(
  shareUrl,
  async url => {
    qr.value = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#121113', light: '#ffffff' } })
  },
  { immediate: true },
)

async function copy(what: 'link' | 'code' | 'server', text: string) {
  if (!(await copyText(text))) return notify('Could not copy. Select the text and copy it manually.')
  copied.value = what
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 2000)
}

const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
function share() {
  navigator.share({ title: 'Metromaker party queue', text: 'Add and vote for songs:', url: shareUrl.value }).catch(() => {})
}
</script>

<template>
  <main class="room">
    <div class="container">
      <nav class="topbar" aria-label="Room">
        <RouterLink to="/" class="brand">
          <span><img src="/logo.svg" alt="" width="28" height="28" /></span>
          Metromaker
        </RouterLink>
        <div v-if="state && status === 'ready'" class="room__status">
          <span v-if="!online" class="chip chip--warn"><AppIcon name="wifi_off" />Reconnecting…</span>
          <span class="chip" :title="`${state.listeners} listening in Metrolist`"><AppIcon name="headphones" />{{ state.listeners }}</span>
          <span class="chip" :title="`${state.viewers} on this page`"><AppIcon name="groups" />{{ state.viewers }}</span>
          <button type="button" class="icon-button room__share-button" aria-label="Show QR code" @click="qrDialog?.showModal()">
            <AppIcon name="qr_code_2" />
          </button>
        </div>
      </nav>

      <section v-if="status === 'loading'" class="room__notice" aria-busy="true">
        <span class="spinner" aria-hidden="true" />
        <div><h1>Joining room…</h1></div>
      </section>

      <section v-else-if="status === 'missing' || status === 'closed'" class="room__notice">
        <AppIcon name="logout" />
        <div>
          <h1>{{ status === 'closed' ? 'This room has ended' : 'Room not found' }}</h1>
          <p>{{ status === 'closed' ? 'The host closed the room. Thanks for listening!' : `There is no room with the code ${roomId}. Check the link or start a new one.` }}</p>
          <RouterLink to="/" class="btn btn-filled"><AppIcon name="add" />Create a room</RouterLink>
        </div>
      </section>

      <div v-else-if="state" class="room__grid">
        <div class="room__main">
          <p v-if="state.metroError || !state.metroConnected" class="room__warning" role="status">
            <AppIcon name="wifi_off" />
            {{ state.metroError || 'Reconnecting to the Listen Together server. Voting still works; playback resumes once it is back.' }}
          </p>

          <!-- Now playing -->
          <section class="now" :class="{ 'now--idle': !state.now }" aria-labelledby="now-title">
            <template v-if="state.now">
              <img class="now__art" :src="state.now.track.thumbnail" alt="" width="132" height="132" referrerpolicy="no-referrer" />
              <div class="now__body">
                <p id="now-title" class="now__label">
                  <AppIcon :name="state.now.playing ? 'graphic_eq' : 'pause'" />
                  {{ state.now.playing ? 'Now playing' : 'Paused' }}
                  <template v-if="state.now.source === 'playlist'"> · from the playlist</template>
                  <template v-else-if="state.now.name"> · picked by {{ state.now.name }}</template>
                </p>
                <h1>{{ state.now.track.title }}</h1>
                <p class="now__artist">{{ state.now.track.artist }}</p>
                <div class="now__progress">
                  <span>{{ formatDuration(position) || '0:00' }}</span>
                  <div role="progressbar" aria-label="Playback position" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
                    <i :style="{ width: `${progress * 100}%` }" />
                  </div>
                  <span>{{ formatDuration(state.now.track.duration) }}</span>
                </div>
              </div>
              <div v-if="isAdmin" class="now__controls">
                <button type="button" class="icon-button" :aria-label="state.now.playing ? 'Pause' : 'Resume'" @click="admin(state.now.playing ? 'pause' : 'resume')">
                  <AppIcon :name="state.now.playing ? 'pause' : 'play_arrow'" />
                </button>
                <button type="button" class="icon-button" aria-label="Skip to next song" @click="admin('skip')"><AppIcon name="skip_next" /></button>
              </div>
            </template>
            <template v-else>
              <span class="now__empty-icon"><AppIcon name="music_note" /></span>
              <div class="now__body">
                <p id="now-title" class="now__label">Nothing playing</p>
                <h1>Pick the first song</h1>
                <p class="now__artist">Search below. It starts playing for everyone right away.</p>
              </div>
            </template>
          </section>

          <!-- Search -->
          <section class="search" aria-label="Add a song">
            <label class="search__field">
              <AppIcon name="search" />
              <input v-model="query" type="search" placeholder="Search YouTube Music for a song" aria-label="Search YouTube Music for a song" autocomplete="off" enterkeyhint="search" />
              <span v-if="searching" class="spinner" aria-hidden="true" />
              <button v-else-if="query" type="button" class="icon-button" aria-label="Clear search" @click="query = ''"><AppIcon name="close" /></button>
            </label>

            <div v-if="query.trim().length >= 2" class="search__results" aria-live="polite">
              <p v-if="searchError" class="search__hint">{{ searchError }}</p>
              <p v-else-if="!searching && results.length === 0" class="search__hint">No songs found for “{{ query.trim() }}”.</p>
              <TrackRow v-for="track in results" :key="track.id" :track="track">
                <template v-for="reason in [resultStatus(track)]" :key="reason">
                  <span v-if="reason === 'playing'" class="chip"><AppIcon name="graphic_eq" />Playing</span>
                  <span v-else-if="reason === 'played'" class="chip" title="Songs can only be played once in this room"><AppIcon name="history" />Played</span>
                  <span v-else-if="reason === 'voted'" class="chip chip--on"><AppIcon name="check" />In queue</span>
                  <button v-else-if="reason === 'queued'" type="button" class="btn btn-tonal btn-sm" :disabled="adding.has(track.id)" @click="addSong(track)">
                    <AppIcon name="thumb_up" />Upvote
                  </button>
                  <button v-else type="button" class="btn btn-filled btn-sm" :disabled="adding.has(track.id)" @click="addSong(track)"><AppIcon name="add" />Add</button>
                </template>
              </TrackRow>
            </div>
          </section>

          <!-- Queue -->
          <section class="queue" aria-labelledby="queue-title">
            <header>
              <h2 id="queue-title">Up next</h2>
              <span class="chip">{{ state.queue.length }} {{ state.queue.length === 1 ? 'song' : 'songs' }}</span>
            </header>

            <TransitionGroup v-if="state.queue.length" name="queue" tag="ol" class="queue__list">
              <li v-for="(entry, index) in state.queue" :key="entry.key">
                <TrackRow :track="entry.track" :note="entry.name ? `by ${entry.name}` : entry.mine ? 'your pick' : ''">
                  <template #lead><span class="queue__rank">{{ index + 1 }}</span></template>
                  <div v-if="state.mode === 'vote'" class="votes" role="group" :aria-label="`Vote for ${entry.track.title}`">
                    <button type="button" :class="{ on: entry.myVote === 1 }" :aria-pressed="entry.myVote === 1" aria-label="Upvote" @click="vote(entry, 1)">
                      <AppIcon name="thumb_up" :outlined="entry.myVote !== 1" />
                    </button>
                    <output :aria-label="`${entry.score} votes`">{{ entry.score }}</output>
                    <button type="button" :class="{ on: entry.myVote === -1 }" :aria-pressed="entry.myVote === -1" aria-label="Downvote" @click="vote(entry, -1)">
                      <AppIcon name="thumb_down" :outlined="entry.myVote !== -1" />
                    </button>
                  </div>
                  <button v-if="isAdmin" type="button" class="icon-button queue__remove" aria-label="Remove from queue" @click="admin('remove', entry.key)">
                    <AppIcon name="delete" />
                  </button>
                </TrackRow>
              </li>
            </TransitionGroup>

            <div v-else class="queue__empty">
              <AppIcon name="queue_music" />
              <p>
                <strong>The queue is empty</strong>
                {{ state.playlist ? `Until someone adds a song, “${state.playlist.title}” keeps the music going.` : 'Search for a song to get the party started.' }}
              </p>
            </div>

            <template v-if="state.upNext.length">
              <h3>Coming up from the playlist</h3>
              <ul class="queue__list">
                <li v-for="track in state.upNext" :key="track.id"><TrackRow :track="track" dimmed /></li>
              </ul>
            </template>
          </section>
        </div>

        <!-- Sidebar -->
        <aside class="side">
          <section class="share" aria-labelledby="share-title">
            <h2 id="share-title">Invite guests</h2>
            <p>Scan to add{{ state.mode === 'vote' ? ' and vote for' : '' }} songs. No app needed.</p>
            <button type="button" class="share__qr" aria-label="Show large QR code" @click="qrDialog?.showModal()" v-html="qr" />
            <div class="share__actions">
              <button type="button" class="btn btn-filled" @click="copy('link', shareUrl)">
                <AppIcon :name="copied === 'link' ? 'check' : 'link'" />{{ copied === 'link' ? 'Copied' : 'Copy link' }}
              </button>
              <button v-if="canShare" type="button" class="icon-button" aria-label="Share" @click="share"><AppIcon name="share" /></button>
            </div>
          </section>

          <section class="listen" aria-labelledby="listen-title">
            <h2 id="listen-title">Listen in Metrolist</h2>
            <p>Join this Listen Together room to hear the music in sync.</p>
            <button type="button" class="listen__code" :aria-label="`Copy room code ${state.code}`" @click="copy('code', state.code)">
              <small>Room code</small>
              <strong>{{ state.code }}</strong>
              <AppIcon :name="copied === 'code' ? 'check' : 'content_copy'" />
            </button>
            <a :href="appUrl" class="btn btn-tonal"><AppIcon name="open_in_new" />Open in Metrolist</a>
            <button v-if="serverUrl" type="button" class="listen__server" @click="copy('server', serverUrl)">
              <AppIcon :name="copied === 'server' ? 'check' : 'dns'" />
              <span><small>Listen Together server (set it in Metrolist's settings)</small><code>{{ serverUrl }}</code></span>
            </button>
          </section>

          <section class="rules" aria-labelledby="rules-title">
            <h2 id="rules-title">Room rules</h2>
            <ul>
              <li><AppIcon :name="state.mode === 'vote' ? 'how_to_vote' : 'queue_music'" />{{ state.mode === 'vote' ? 'Most liked songs play first' : 'Songs play in the order they were added' }}</li>
              <li><AppIcon :name="state.allowRepeats ? 'repeat' : 'block'" />{{ state.allowRepeats ? 'Songs can be added again after they played' : 'Every song plays only once' }}</li>
              <li v-if="state.playlist"><AppIcon name="playlist_play" />Empty queue plays “{{ state.playlist.title }}” ({{ state.playlist.count }} songs)</li>
            </ul>
            <button v-if="isAdmin" type="button" class="btn btn-error" @click="closeDialog?.showModal()"><AppIcon name="logout" />End room</button>
          </section>
        </aside>
      </div>
    </div>

    <dialog ref="qrDialog" class="site-dialog qr-dialog" aria-label="Room QR code" @click="qrDialog?.close()">
      <div class="qr-dialog__code" v-html="qr" />
      <p>{{ shareUrl.replace(/^https?:\/\//, '') }}</p>
      <button type="button" class="btn btn-outlined"><AppIcon name="close" />Close</button>
    </dialog>

    <dialog ref="closeDialog" class="site-dialog confirm-dialog" aria-labelledby="close-title">
      <h2 id="close-title">End this room?</h2>
      <p>The queue is deleted and everyone listening in Metrolist is disconnected. This cannot be undone.</p>
      <div>
        <button type="button" class="btn btn-outlined" @click="closeDialog?.close()">Keep room</button>
        <button type="button" class="btn btn-error" @click="closeRoom">End room</button>
      </div>
    </dialog>

    <Transition name="toast">
      <p v-if="toast" class="toast" role="status">{{ toast }}</p>
    </Transition>
  </main>
</template>

<style scoped>
.room {
  min-height: 100vh;
  padding-bottom: 80px;
}

.room h2 {
  font: var(--md-sys-typescale-title-large);
  letter-spacing: var(--md-sys-typescale-title-large-tracking);
}

.room__status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.room__share-button {
  display: none;
}

.chip--warn {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}

.chip--on {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.room__notice {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  padding: clamp(28px, 6vw, 64px);
  border-radius: 44px 44px 18px 44px;
  background: var(--md-sys-color-surface-container-low);
}

.room__notice > .icon {
  width: 64px;
  height: 64px;
  border-radius: 22px;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-primary);
  font-size: 32px;
}

.room__notice h1 {
  font: var(--md-sys-typescale-headline-large);
}

.room__notice p {
  max-width: 520px;
  margin: 10px 0 24px;
  color: var(--md-sys-color-on-surface-variant);
}

.room__warning {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-radius: 20px;
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font: var(--md-sys-typescale-body-medium);
}

.room__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  align-items: start;
}

.room__main {
  display: grid;
  gap: 16px;
  min-width: 0;
}

/* Now playing */
.now {
  display: flex;
  align-items: center;
  gap: clamp(16px, 3vw, 28px);
  padding: clamp(20px, 3.4vw, 36px);
  border-radius: 44px 44px 18px 44px;
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.now--idle {
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface);
}

.now__art,
.now__empty-icon {
  flex: 0 0 auto;
  width: clamp(84px, 14vw, 132px);
  height: clamp(84px, 14vw, 132px);
  border-radius: 32px 32px 12px 32px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  object-fit: cover;
}

.now__empty-icon {
  display: grid;
  place-items: center;
  color: var(--md-sys-color-primary);
}

.now__empty-icon .icon {
  font-size: 48px;
}

.now__body {
  flex: 1 1 auto;
  min-width: 0;
}

.now__label {
  display: flex;
  align-items: center;
  gap: 8px;
  font: var(--md-sys-typescale-label-large);
  font-variation-settings: 'ROND' 100;
  opacity: 0.86;
}

.now__label .icon {
  font-size: 18px;
}

.now h1 {
  margin: 8px 0 2px;
  overflow: hidden;
  font: var(--md-sys-typescale-headline-large);
  font-variation-settings: 'ROND' 100;
  letter-spacing: var(--md-sys-typescale-headline-large-tracking);
  text-overflow: ellipsis;
  text-wrap: nowrap;
}

.now__artist {
  overflow: hidden;
  font: var(--md-sys-typescale-body-large);
  opacity: 0.8;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now--idle .now__artist {
  white-space: normal;
}

.now__progress {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  font: var(--md-sys-typescale-label-medium);
  font-variant-numeric: tabular-nums;
}

.now__progress > div {
  flex: 1 1 auto;
  height: 8px;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.now__progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--md-sys-color-primary);
  transition: width 500ms linear;
}

.now__controls {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
}

.now__controls .icon-button {
  width: 56px;
  height: 56px;
  border-radius: 20px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

.now__controls .icon-button + .icon-button {
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
}

/* Search */
.search {
  display: grid;
  gap: 8px;
}

.search__field {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 0 12px 0 22px;
  border-radius: var(--md-sys-shape-corner-full);
  outline: 2px solid transparent;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
  cursor: text;
  transition: outline-color var(--md-motion-effects-default);
}

.search__field:focus-within {
  outline-color: var(--md-sys-color-primary);
}

.search__field input {
  flex: 1 1 auto;
  min-width: 0;
  height: 64px;
  border: 0;
  outline: 0;
  background: none;
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-body-large);
}

.search__field input::placeholder {
  color: var(--md-sys-color-on-surface-variant);
}

.search__field input::-webkit-search-cancel-button {
  display: none;
}

.search__field .icon-button {
  width: 44px;
  height: 44px;
  background: transparent;
}

.search__field .spinner {
  margin-right: 12px;
  color: var(--md-sys-color-primary);
}

.search__results {
  display: grid;
  gap: 4px;
  padding: 8px;
  border-radius: 28px;
  background: var(--md-sys-color-surface-container-low);
}

.search__hint {
  padding: 18px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

/* Queue */
.queue {
  padding: clamp(16px, 2.4vw, 24px);
  border-radius: 18px 44px 44px 44px;
  background: var(--md-sys-color-surface-container-low);
}

.queue header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 6px 16px;
}

.queue h3 {
  margin: 20px 6px 8px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large);
  font-variation-settings: 'ROND' 100;
}

.queue__list {
  position: relative;
  display: grid;
  gap: 4px;
  list-style: none;
}

.queue__rank {
  flex: 0 0 auto;
  width: 22px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.queue__remove {
  width: 40px;
  height: 40px;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
}

.queue__remove .icon {
  font-size: 20px;
}

.queue__empty {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border-radius: 24px;
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium);
}

.queue__empty .icon {
  width: 52px;
  height: 52px;
  border-radius: 18px;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-primary);
}

.queue__empty strong {
  display: block;
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-title-small);
}

.queue-move {
  transition: transform var(--md-motion-spatial-default);
}

.queue-enter-active {
  transition: opacity var(--md-motion-effects-slow), transform var(--md-motion-spatial-default);
}

.queue-leave-active {
  position: absolute;
  inset-inline: 0;
  transition: opacity var(--md-motion-exit);
}

.queue-enter-from {
  opacity: 0;
  transform: translateY(12px);
}

.queue-leave-to {
  opacity: 0;
}

.votes {
  display: flex;
  align-items: center;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
}

.votes button {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  transition: background-color var(--md-motion-effects-default), scale var(--md-motion-spatial-fast);
  -webkit-tap-highlight-color: transparent;
}

.votes button:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.votes button:active {
  scale: 0.86;
}

.votes button.on {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

.votes button.on:last-child {
  background: var(--md-sys-color-tertiary);
  color: var(--md-sys-color-on-tertiary);
}

.votes .icon {
  font-size: 20px;
}

.votes output {
  min-width: 24px;
  font: var(--md-sys-typescale-label-large);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

/* Sidebar */
.side {
  position: sticky;
  top: 16px;
  display: grid;
  gap: 16px;
}

.side section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  padding: 24px;
}

.side section > p {
  margin-top: -8px;
  color: color-mix(in srgb, currentColor 78%, transparent);
  font: var(--md-sys-typescale-body-medium);
}

.share {
  border-radius: 44px 18px 44px 44px;
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}

.share__qr {
  width: 100%;
  max-width: 240px;
  align-self: center;
  padding: 16px;
  border: 0;
  border-radius: 28px;
  background: #fff;
  cursor: zoom-in;
  line-height: 0;
}

.share__qr :deep(svg),
.qr-dialog__code :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}

.share__actions {
  display: flex;
  width: 100%;
  gap: 8px;
}

.share__actions .btn {
  flex: 1 1 auto;
  background: var(--md-sys-color-tertiary);
  color: var(--md-sys-color-on-tertiary);
}

.share__actions .icon-button {
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
}

.listen {
  border-radius: 28px;
  background: var(--md-sys-color-surface-container-low);
}

.listen__code {
  position: relative;
  display: grid;
  width: 100%;
  gap: 6px;
  padding: 16px 52px 16px 20px;
  border: 0;
  border-radius: 12px 28px 28px 28px;
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  cursor: pointer;
  text-align: left;
}

.listen__code small,
.listen__server small {
  font: var(--md-sys-typescale-label-small);
  font-variation-settings: 'ROND' 100;
  letter-spacing: var(--md-sys-typescale-label-small-tracking);
}

.listen__code strong {
  font-family: ui-monospace, monospace;
  font-size: 1.75rem;
  letter-spacing: 0.12em;
  line-height: 1;
}

.listen__code .icon {
  position: absolute;
  top: 50%;
  right: 18px;
  font-size: 20px;
  translate: 0 -50%;
}

.listen .btn {
  width: 100%;
}

.listen__server {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 12px;
  padding: 12px 14px;
  border: 0;
  border-radius: 18px;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  text-align: left;
}

.listen__server .icon {
  font-size: 20px;
}

.listen__server span {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.listen__server small {
  letter-spacing: 0.02em;
}

.listen__server code {
  overflow-wrap: anywhere;
  color: var(--md-sys-color-on-surface);
  font: 0.8125rem / 1.3 ui-monospace, monospace;
}

.rules {
  border-radius: 28px 28px 44px 28px;
  background: var(--md-sys-color-surface-container-low);
}

.rules ul {
  display: grid;
  gap: 12px;
  list-style: none;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium);
}

.rules li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.rules li .icon {
  margin-top: 1px;
  color: var(--md-sys-color-primary);
  font-size: 20px;
}

.rules .btn {
  margin-top: 6px;
}

/* Dialogs and toast */
.qr-dialog,
.confirm-dialog {
  width: min(100% - 32px, 460px);
  margin: auto;
  padding: 28px;
  border-radius: 44px 44px 18px 44px;
  background: var(--md-sys-color-surface-container-high);
}

.qr-dialog[open] {
  display: grid;
  justify-items: center;
  gap: 18px;
}

.qr-dialog__code {
  width: 100%;
  padding: 22px;
  border-radius: 32px;
  background: #fff;
}

.qr-dialog p {
  overflow-wrap: anywhere;
  font: 1rem / 1.3 ui-monospace, monospace;
  text-align: center;
}

.confirm-dialog p {
  margin: 12px 0 24px;
  color: var(--md-sys-color-on-surface-variant);
}

.confirm-dialog div {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.confirm-dialog .btn-outlined {
  background: var(--md-sys-color-surface-container-highest);
}

.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  z-index: 50;
  max-width: min(100% - 32px, 480px);
  padding: 14px 22px;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-on-surface);
  color: var(--md-sys-color-surface);
  font: var(--md-sys-typescale-label-large);
  text-overflow: ellipsis;
  translate: -50% 0;
  white-space: nowrap;
}

.toast-enter-active {
  transition: opacity var(--md-motion-effects-default), transform var(--md-motion-spatial-default);
}

.toast-leave-active {
  transition: opacity var(--md-motion-exit);
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(16px);
}

.toast-leave-to {
  opacity: 0;
}

@media (max-width: 960px) {
  .room__grid {
    grid-template-columns: 1fr;
  }

  .side {
    position: static;
  }

  .room__share-button {
    display: inline-flex;
  }
}

@media (max-width: 600px) {
  .now {
    flex-wrap: wrap;
    border-radius: 32px 32px 14px 32px;
  }

  .now__body {
    flex-basis: calc(100% - 110px);
  }

  .now h1 {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    text-wrap: wrap;
  }

  .now__controls {
    width: 100%;
    flex-direction: row;
  }

  .now__controls .icon-button {
    flex: 1 1 0;
  }

  .queue {
    padding: 12px 8px;
    border-radius: 14px 32px 32px 32px;
  }

  .queue header {
    margin-inline: 10px;
  }

  .queue__rank {
    display: none;
  }

  .votes button {
    width: 36px;
    height: 36px;
  }

  .search__field {
    min-height: 56px;
  }

  .search__field input {
    height: 56px;
    font-size: 1rem;
  }

  .room__notice {
    flex-direction: column;
  }
}
</style>
