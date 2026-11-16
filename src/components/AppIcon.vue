<script lang="ts">
// Material Symbols (Rounded), inlined at build time so only the icons used here ship.
const files = import.meta.glob<string>(
  [
    '/node_modules/@material-symbols/svg-400/rounded/{add,arrow_back,arrow_forward,block,celebration,check,close,content_copy,delete,dns,graphic_eq,groups,headphones,history,how_to_vote,link,logout,music_note,open_in_new,pause,play_arrow,playlist_play,qr_code_2,queue_music,repeat,search,share,skip_next,wifi_off}-fill.svg',
    '/node_modules/@material-symbols/svg-400/rounded/{thumb_up,thumb_down}.svg',
    '/node_modules/@material-symbols/svg-400/rounded/{thumb_up,thumb_down}-fill.svg',
  ],
  { query: '?raw', import: 'default', eager: true },
)

const icons: Record<string, string> = {}
for (const [path, svg] of Object.entries(files)) {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.svg'.length)
  icons[name] = svg
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ name: string; outlined?: boolean }>()
const svg = computed(() => (props.outlined ? icons[props.name] : undefined) ?? icons[`${props.name}-fill`] ?? icons[props.name] ?? '')
</script>

<template>
  <span class="icon" aria-hidden="true" v-html="svg" />
</template>
