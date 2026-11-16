<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'
import { adminToken, api } from '../api'

const router = useRouter()
const mode = ref<'vote' | 'queue'>('vote')
const allowRepeats = ref(false)
const playlist = ref('')
const creating = ref(false)
const error = ref('')
const joinCode = ref('')

async function createRoom() {
  if (creating.value) return
  creating.value = true
  error.value = ''
  try {
    const room = await api.createRoom({ mode: mode.value, allowRepeats: allowRepeats.value, playlist: playlist.value.trim() })
    adminToken(room.id, room.adminToken)
    await router.push(`/${room.id}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Something went wrong.'
  } finally {
    creating.value = false
  }
}

function joinRoom() {
  const code = joinCode.value.trim().toUpperCase()
  if (/^[A-Z0-9]{4,16}$/.test(code)) router.push(`/${code}`)
}
</script>

<template>
  <main class="home">
    <div class="container home__inner">
      <nav class="topbar" aria-label="Site">
        <RouterLink to="/" class="brand">
          <span><img src="/logo.svg" alt="" width="28" height="28" /></span>
          Metromaker
        </RouterLink>
        <a href="https://metrolist.cc" class="btn btn-outlined" target="_blank" rel="noopener">
          <AppIcon name="open_in_new" />
          Get Metrolist
        </a>
      </nav>

      <div class="home__hero">
        <header class="home__copy">
          <p class="section-label"><AppIcon name="groups" />Listen Together</p>
          <h1>One queue, <span>everyone's music</span></h1>
          <p class="home__lede">
            Start a room, share the link, and let your guests pick and vote for songs from their browser. Every device running Metrolist plays along in sync.
          </p>
          <ol class="home__steps">
            <li><span><AppIcon name="add" /></span>Create a room</li>
            <li><span><AppIcon name="qr_code_2" /></span>Share the link or QR code</li>
            <li><span><AppIcon name="headphones" /></span>Join in Metrolist with the room code</li>
          </ol>
        </header>

        <form class="create" aria-labelledby="create-title" @submit.prevent="createRoom">
          <h2 id="create-title">New room</h2>

          <fieldset class="create__modes">
            <legend>How guests shape the queue</legend>
            <label class="mode" :class="{ 'mode--on': mode === 'vote' }">
              <input v-model="mode" type="radio" name="mode" value="vote" />
              <AppIcon name="how_to_vote" />
              <span><strong>Voting</strong><small>Guests add songs and vote. The most liked plays next.</small></span>
            </label>
            <label class="mode" :class="{ 'mode--on': mode === 'queue' }">
              <input v-model="mode" type="radio" name="mode" value="queue" />
              <AppIcon name="queue_music" />
              <span><strong>Queue only</strong><small>New songs go to the end. First come, first played.</small></span>
            </label>
          </fieldset>

          <label class="switch">
            <span><strong>Allow replays</strong><small>A song can be added again after it has finished.</small></span>
            <input v-model="allowRepeats" type="checkbox" role="switch" />
            <i aria-hidden="true" />
          </label>

          <label class="field">
            <span>Fallback playlist <small>optional</small></span>
            <input v-model="playlist" type="url" inputmode="url" placeholder="https://music.youtube.com/playlist?list=…" autocomplete="off" spellcheck="false" />
            <small>Plays whenever the queue is empty. Use a public or unlisted YouTube playlist link.</small>
          </label>

          <p v-if="error" class="create__error" role="alert"><AppIcon name="block" />{{ error }}</p>

          <button type="submit" class="btn btn-filled btn-lg" :disabled="creating">
            <span v-if="creating" class="spinner" aria-hidden="true" />
            <AppIcon v-else name="celebration" />
            {{ creating ? 'Creating room…' : 'Create room' }}
          </button>
        </form>
      </div>

      <form class="join" @submit.prevent="joinRoom">
        <div>
          <h2>Have a room code?</h2>
          <p>Open a room that someone else started.</p>
        </div>
        <div class="join__field">
          <input v-model="joinCode" type="text" aria-label="Room code" placeholder="ROOM CODE" maxlength="16" autocomplete="off" autocapitalize="characters" spellcheck="false" />
          <button type="submit" class="icon-button" aria-label="Open room"><AppIcon name="arrow_forward" /></button>
        </div>
      </form>
    </div>
  </main>
</template>

<style scoped>
.home {
  min-height: 100vh;
  padding-bottom: 64px;
}

.home__hero {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(340px, 0.9fr);
  gap: 16px;
  align-items: stretch;
}

.home__copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: clamp(28px, 5vw, 64px);
  border-radius: 44px 44px 18px 44px;
  background: var(--md-sys-color-surface-container-low);
}

.home h1 {
  margin: 24px 0;
  font: var(--md-sys-typescale-display-medium);
  letter-spacing: var(--md-sys-typescale-display-medium-tracking);
}

.home h1 span {
  color: var(--md-sys-color-primary);
}

.home__lede {
  max-width: 560px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-large);
}

.home__steps {
  display: grid;
  gap: 10px;
  margin-top: auto;
  padding-top: 40px;
  list-style: none;
  font: var(--md-sys-typescale-title-small);
  font-variation-settings: 'ROND' 100;
}

.home__steps li {
  display: flex;
  align-items: center;
  gap: 14px;
}

.home__steps li > span {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 16px;
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.home__steps li:nth-child(2) > span {
  border-radius: 50%;
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}

.home__steps li:nth-child(3) > span {
  border-radius: 16px 16px 6px 16px;
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.home__steps .icon {
  font-size: 22px;
}

.create {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: clamp(24px, 3.4vw, 36px);
  border-radius: 18px 44px 44px 44px;
  background: var(--md-sys-color-surface-container-high);
}

.create h2 {
  font: var(--md-sys-typescale-headline-small);
  letter-spacing: var(--md-sys-typescale-headline-small-tracking);
}

.create__modes {
  display: grid;
  gap: 8px;
  border: 0;
}

.create legend,
.field > span {
  margin-bottom: 10px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large);
  font-variation-settings: 'ROND' 100;
}

.field > span small {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
  font: var(--md-sys-typescale-label-small);
  letter-spacing: var(--md-sys-typescale-label-small-tracking);
  text-transform: uppercase;
}

.mode {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 20px;
  background: var(--md-sys-color-surface-container);
  cursor: pointer;
  transition: border-radius var(--md-motion-spatial-fast), background-color var(--md-motion-effects-default);
}

.mode input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.mode:has(input:focus-visible) {
  outline: 3px solid var(--md-sys-color-secondary);
  outline-offset: 3px;
}

.mode > .icon {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}

.mode--on {
  border-radius: 28px;
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.mode--on > .icon {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

.mode strong,
.switch strong {
  display: block;
  font: var(--md-sys-typescale-title-small);
  font-variation-settings: 'ROND' 100;
}

.mode small,
.switch small,
.field > small {
  display: block;
  color: color-mix(in srgb, currentColor 72%, transparent);
  font: var(--md-sys-typescale-body-small);
}

.switch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  cursor: pointer;
}

.switch input {
  position: absolute;
  opacity: 0;
}

.switch i {
  position: relative;
  flex: 0 0 auto;
  width: 52px;
  height: 32px;
  border: 2px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
  transition: background-color var(--md-motion-effects-default), border-color var(--md-motion-effects-default);
}

.switch i::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--md-sys-color-outline);
  translate: 0 -50%;
  transition: left var(--md-motion-spatial-fast), width var(--md-motion-spatial-fast), height var(--md-motion-spatial-fast), background-color var(--md-motion-effects-default);
}

.switch input:checked + i {
  border-color: var(--md-sys-color-primary);
  background: var(--md-sys-color-primary);
}

.switch input:checked + i::after {
  left: 22px;
  width: 24px;
  height: 24px;
  background: var(--md-sys-color-on-primary);
}

.switch input:focus-visible + i {
  outline: 3px solid var(--md-sys-color-secondary);
  outline-offset: 3px;
}

.field {
  display: grid;
}

.field input,
.join__field input {
  width: 100%;
  min-height: 56px;
  padding: 0 20px;
  border: 0;
  border-radius: 20px;
  outline: 2px solid transparent;
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-body-medium);
  transition: outline-color var(--md-motion-effects-default);
}

.field input::placeholder,
.join__field input::placeholder {
  color: var(--md-sys-color-outline);
}

.field input:focus-visible,
.join__field input:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 0;
}

.field > small {
  margin-top: 8px;
  color: var(--md-sys-color-on-surface-variant);
}

.create__error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font: var(--md-sys-typescale-body-medium);
}

.create__error .icon {
  font-size: 20px;
}

.create > .btn {
  margin-top: 4px;
}

.join {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 16px;
  padding: 24px clamp(24px, 3.4vw, 36px);
  border-radius: 28px 28px 44px 28px;
  background: var(--md-sys-color-surface-container-low);
}

.join h2 {
  font: var(--md-sys-typescale-title-large);
}

.join p {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium);
}

.join__field {
  display: flex;
  flex: 0 1 340px;
  gap: 8px;
}

.join__field input {
  background: var(--md-sys-color-surface-container-high);
  font-family: ui-monospace, monospace;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.join__field .icon-button {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 20px;
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

@media (max-width: 900px) {
  .home__hero {
    grid-template-columns: 1fr;
  }

  .home__copy {
    border-radius: 32px 32px 14px 32px;
  }

  .home__steps {
    padding-top: 32px;
  }

  .create {
    border-radius: 14px 32px 32px 32px;
  }
}

@media (max-width: 600px) {
  .home__copy {
    padding: 28px 22px;
  }

  .topbar .btn {
    padding-inline: 14px;
  }

  .join__field {
    flex-basis: 100%;
  }
}
</style>
