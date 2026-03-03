/**
 * Persistent storage helpers.
 * Wraps localStorage with JSON serialization and namespacing.
 */

const NS = 'stremio_docked_';

function key(name) { return NS + name; }

export function get(name, fallback = null) {
    try {
        const raw = localStorage.getItem(key(name));
        return raw !== null ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

export function set(name, value) {
    try {
        localStorage.setItem(key(name), JSON.stringify(value));
    } catch (e) {
        console.warn('[storage] write failed:', e);
    }
}

export function remove(name) {
    localStorage.removeItem(key(name));
}

// ── Auth persistence ─────────────────────────────────────────────────────────

export function saveAuth(authKey, user) {
    set('auth', { authKey, user });
}

export function loadAuth() {
    return get('auth', null);
}

export function clearAuth() {
    remove('auth');
}

// ── Player state handoff ────────────────────────────────────────────────────

export function savePlayerState(state) {
    set('player_state', state);
}

export function loadPlayerState() {
    return get('player_state', null);
}

export function clearPlayerState() {
    remove('player_state');
}

// ── Watch progress ────────────────────────────────────────────────────────────
// Key: `progress_${type}_${videoId}` → { position, duration, updatedAt }

export function saveProgress(type, videoId, position, duration, meta = {}) {
    const existing = get(`progress_${type}_${videoId}`, {});
    set(`progress_${type}_${videoId}`, {
        ...existing,
        position,
        duration,
        updatedAt: Date.now(),
        name: meta.name || existing.name,
        poster: meta.poster || existing.poster,
        id: videoId,
        type,
    });
}

export function loadProgress(type, videoId) {
    return get(`progress_${type}_${videoId}`, null);
}

/** Get all items with non-trivial progress (>5% and <95% complete). */
export function getContinueWatching() {
    const results = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith(NS + 'progress_')) continue;
        try {
            const data = JSON.parse(localStorage.getItem(k));
            if (!data || !data.duration) continue;
            const pct = data.position / data.duration;
            if (pct > 0.05 && pct < 0.92) {
                const rest = k.slice((NS + 'progress_').length);
                const [type, ...idParts] = rest.split('_');
                results.push({ type, videoId: idParts.join('_'), ...data });
            }
        } catch { }
    }
    // Sort by most recently watched
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
}

// ── User preferences ─────────────────────────────────────────────────────────

export const defaultPrefs = {
    preferredQuality: 'auto',   // '4K' | '1080p' | '720p' | 'auto'
    subtitleLanguage: 'eng',
    audioLanguage: 'eng',
    subtitleSize: 100,           // %
    autoPlay: true,
    bingeWatching: true,
};

export function loadPrefs() {
    return { ...defaultPrefs, ...get('prefs', {}) };
}

export function savePrefs(prefs) {
    set('prefs', prefs);
}
