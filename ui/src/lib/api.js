/**
 * Stremio Account API client.
 * All calls go through our backend proxy to avoid CORS issues.
 */

const BASE = '/api';

async function call(path, opts = {}) {
    const res = await fetch(BASE + path, {
        headers: { 'Content-Type': 'application/json' },
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

/** Check stremio-server status. */
export async function serverStatus() {
    return call('/server-status');
}
