/**
 * Stremio Account API client.
 * All calls go through our backend proxy to avoid CORS issues.
 */

const BASE = '/api';

async function call(path, opts = {}) {
    const method = String(opts?.method || 'GET').toUpperCase();
    const res = await fetch(BASE + path, {
        headers: { 'Content-Type': 'application/json' },
        cache: method === 'GET' ? 'no-store' : 'default',
        ...opts,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

/** Log in with Stremio credentials. Returns { authKey, user }. */
export async function login(email, password) {
    return call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
    });
}

/** Log out. */
export async function logout(authKey) {
    return call('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ authKey }),
    });
}

/** Get current user info. */
export async function getUser(authKey) {
    return call(`/auth/user?authKey=${encodeURIComponent(authKey)}`);
}

/** Get all installed add-ons for the authenticated user. */
export async function getAddons(authKey) {
    return call(`/addons?authKey=${encodeURIComponent(authKey)}`);
}

export async function getLibrary(authKey, options = {}) {
    const params = new URLSearchParams({ authKey });
    if (options.type) params.set('type', options.type);
    if (options.limit) params.set('limit', String(options.limit));
    return call(`/library?${params.toString()}`);
}

export async function getLibraryContains(authKey, id, type = 'movie') {
    const params = new URLSearchParams({ authKey, id, type });
    return call(`/library/contains?${params.toString()}`);
}

export async function addLibraryItem({ authKey, id, type = 'movie', name = '', poster = '', background = '', year = '' }) {
    return call('/library/item', {
        method: 'POST',
        body: JSON.stringify({ authKey, id, type, name, poster, background, year }),
    });
}

export async function removeLibraryItem(authKey, id, type = 'movie') {
    const params = new URLSearchParams({ authKey, id, type });
    return call(`/library/item?${params.toString()}`, {
        method: 'DELETE',
    });
}

export async function getRecentlyPlayed(authKey, limit = 20) {
    const params = new URLSearchParams({ authKey, limit: String(limit) });
    return call(`/recently-played?${params.toString()}`);
}

/**
 * Resolve a stremio stream descriptor to playable URLs.
 * @param {object} stream - Stremio stream object (infoHash, url, etc.)
 * @returns {Promise<{url, hlsUrl, type, canSeek}>}
 */
export async function resolveStreamUrl(stream) {
    const host = `${window.location.protocol}//${window.location.host}`;
    return call('/stream-url', {
        method: 'POST',
        body: JSON.stringify({ stream, host }),
    });
}

/**
 * Build a proxied subtitle URL (SRT/VTT → always VTT).
 */
export function subtitleProxyUrl(originalUrl) {
    return `/api/subtitle-proxy?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * Build a proxied image URL (avoids TV browser CORS issues).
 */
export function imageProxyUrl(originalUrl) {
    if (!originalUrl) return null;
    // Only proxy https images (http images might be blocked on HTTPS pages)
    return `/api/image-proxy?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * Get media track info via ffprobe (audio, subtitle, video tracks).
 * @param {string} infoHash
 * @param {number} fileIdx
 * @returns {Promise<{audio: Array, subtitles: Array, video: Array}>}
 */
export async function getMediaInfo(infoHash, fileIdx = 0) {
    return call(`/media-info?infoHash=${encodeURIComponent(infoHash)}&fileIdx=${fileIdx}`);
}

/**
 * Create a server-side audio-switch playback URL for a selected track.
 * Uses remux (copy) first, then audio-only transcode fallback on backend.
 */
export async function createAudioSwitchUrl({ infoHash, fileIdx = 0, audioTrackIndex, startTimeSec = 0 }) {
    return call('/audio-switch-url', {
        method: 'POST',
        body: JSON.stringify({
            infoHash,
            fileIdx,
            audioTrackIndex,
            startTimeSec,
        }),
    });
}

/**
 * Start backend prefetch warming for direct playback.
 */
export async function startStreamPrefetch({ infoHash, fileIdx = 0, startTimeSec = 0, durationSec = 0 }) {
    return call('/stream-prefetch/start', {
        method: 'POST',
        body: JSON.stringify({ infoHash, fileIdx, startTimeSec, durationSec }),
    });
}

/**
 * Start backend prefetch in background download mode.
 */
export async function startBackgroundDownload({
    infoHash,
    fileIdx = 0,
    startTimeSec = 0,
    durationSec = 0,
    title = '',
    type = '',
    metaId = '',
    videoId = '',
    metaName = '',
    metaPoster = '',
}) {
    return call('/stream-prefetch/start', {
        method: 'POST',
        body: JSON.stringify({
            infoHash,
            fileIdx,
            startTimeSec,
            durationSec,
            mode: 'download',
            title,
            type,
            metaId,
            videoId,
            metaName,
            metaPoster,
        }),
    });
}

/**
 * Read a running prefetch session status.
 */
export async function getStreamPrefetchStatus(sessionId) {
    return call(`/stream-prefetch/${encodeURIComponent(sessionId)}/status`);
}

/**
 * List known downloads.
 */
export async function getDownloads() {
    return call('/stream-prefetch/downloads');
}

/**
 * Delete one download and clean local cache.
 */
export async function deleteDownload(downloadId) {
    return call(`/stream-prefetch/downloads/${encodeURIComponent(downloadId)}`, {
        method: 'DELETE',
    });
}

/**
 * Sync local recent-played progress back to Stremio account.
 */
export async function syncRecentlyPlayed({
    authKey,
    type,
    mediaId,
    videoId,
    name,
    poster,
    background = '',
    position,
    duration,
}) {
    return call('/recently-played/sync', {
        method: 'POST',
        body: JSON.stringify({
            authKey,
            type,
            mediaId,
            videoId,
            name,
            poster,
            background,
            position,
            duration,
        }),
    });
}

/**
 * Stop a running backend prefetch session.
 */
export async function stopStreamPrefetch(sessionId) {
    return call(`/stream-prefetch/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
    });
}

/** Check stremio-server status. */
export async function serverStatus() {
    return call('/server-status');
}
