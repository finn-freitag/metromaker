<script setup lang="ts">
import { formatDuration, type Track } from '../api'

defineProps<{ track: Track; note?: string; dimmed?: boolean }>()
</script>

<template>
  <div class="track" :class="{ 'track--dimmed': dimmed }">
    <slot name="lead" />
    <img class="track__art" :src="track.thumbnail" alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" @error="($event.target as HTMLImageElement).style.visibility = 'hidden'" />
    <div class="track__text">
      <strong>{{ track.title }}</strong>
      <span>
        {{ track.artist || 'Unknown artist' }}<template v-if="formatDuration(track.duration)"> · {{ formatDuration(track.duration) }}</template
        ><template v-if="note"> · {{ note }}</template>
      </span>
    </div>
    <div class="track__actions"><slot /></div>
  </div>
</template>

<style scoped>
.track {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 72px;
  padding: 8px 10px 8px 12px;
  border-radius: 20px;
  background: var(--md-sys-color-surface-container);
}

.track--dimmed {
  background: transparent;
  opacity: 0.72;
}

.track__art {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: var(--md-sys-color-surface-container-highest);
  object-fit: cover;
}

.track__text {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 2px;
}

.track__text strong,
.track__text span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track__text strong {
  font: var(--md-sys-typescale-title-small);
  font-size: 0.9375rem;
}

.track__text span {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small);
  font-size: 0.8125rem;
}

.track__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

@media (max-width: 600px) {
  .track {
    gap: 10px;
    padding-left: 8px;
  }

  .track__art {
    width: 48px;
    height: 48px;
    border-radius: 12px;
  }

  /* Vote buttons leave little room on phones, so titles get a second line. */
  .track__text strong {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: 1.25;
    white-space: normal;
  }
}
</style>
