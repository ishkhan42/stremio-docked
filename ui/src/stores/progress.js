import { writable } from 'svelte/store';
import { saveProgress, loadProgress, getContinueWatching, loadPrefs, savePrefs } from '../lib/storage.js';

// Current playback state (used by VideoPlayer)
export const playbackState = writable({
    type: null,
    videoId: null,
    position: 0,
    duration: 0,
});

/** Save progress for a video. */
export function recordProgress(type, videoId, position, duration, meta = {}) {
    saveProgress(type, videoId, position, duration, meta);
}

/** Get saved position for a video. Returns null or { position, duration }. */
export function getProgress(type, videoId) {
    return loadProgress(type, videoId);
}

/** Get all continue-watching items. */
export function getContinueItems() {
    return getContinueWatching();
}

// ── User preferences store ────────────────────────────────────────────────────
export const prefs = writable(loadPrefs());

prefs.subscribe(val => savePrefs(val));
