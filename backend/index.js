/**
 * stremio-docked Backend API
 *
 * Provides:
 *  - Stremio account auth proxy  (api.strem.io requests — blocked by CORS)
 *  - Add-on request proxy        (bypasses CORS for TV browser)
 *  - Stream URL resolution       (coordinates with local stremio-server)
 *  - Subtitle proxying + SRT→VTT conversion
 */

'use strict';

const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const { Readable } = require('stream');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { normalizeStreamUrl, extractHashFileFromPath, srtToVtt, normalizeLibraryItems } = require('./utils');

/** Run ffprobe and return parsed JSON. */
function ffprobe(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-analyzeduration', '2000000',  // 2s — just enough to read container headers
            '-probesize', '2000000',        // 2MB
            url,
        ];
        execFile('/usr/bin/ffprobe', args, { timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
        });
    });
}

const app = express();
const PORT = 3001;
const STREMIO_SERVER = process.env.STREMIO_SERVER_URL || 'http://127.0.0.1:11470';
const STREMIO_API = 'https://api.strem.io';
const AUDIO_SWITCH_ROOT = '/tmp/stremio-audio-switch';
const AUDIO_SESSION_TTL_MS = 45 * 60 * 1000;

const audioSessions = new Map();

function safeSessionPath(sessionId) {
    return path.join(AUDIO_SWITCH_ROOT, sessionId);
}

async function ensureAudioSwitchRoot() {
    await fs.mkdir(AUDIO_SWITCH_ROOT, { recursive: true });
}

async function removeSessionArtifacts(sessionId) {
    const dir = safeSessionPath(sessionId);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
}

async function stopAudioSession(sessionId) {
    const session = audioSessions.get(sessionId);
    if (!session) return;
    audioSessions.delete(sessionId);
    if (session.proc && !session.proc.killed) {
        try { session.proc.kill('SIGTERM'); } catch { }
    }
    await removeSessionArtifacts(sessionId);
}

async function cleanupExpiredAudioSessions() {
    const now = Date.now();
    const toDrop = [];
    for (const [id, session] of audioSessions.entries()) {
        const stale = now - (session.lastAccess || session.createdAt || 0) > AUDIO_SESSION_TTL_MS;
        if (stale || session.status === 'failed') toDrop.push(id);
    }
    await Promise.all(toDrop.map(stopAudioSession));
}

setInterval(() => {
    cleanupExpiredAudioSessions().catch(() => { });
}, 5 * 60 * 1000).unref();

async function waitForFile(filePath, timeoutMs = 10000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            await new Promise(r => setTimeout(r, 250));
        }
    }
    return false;
}

async function startAudioSwitchSession({ infoHash, fileIdx, audioTrackIndex, startTimeSec = 0, audioMode = 'copy' }) {
    await ensureAudioSwitchRoot();

    const sessionId = crypto.randomUUID();
    const dir = safeSessionPath(sessionId);
    await fs.mkdir(dir, { recursive: true });

    const inputUrl = `${STREMIO_SERVER}/${infoHash}/${fileIdx}`;
    const playlistPath = path.join(dir, 'index.m3u8');
    const segmentPath = path.join(dir, 'seg_%05d.m4s');

    const startAt = Math.max(0, Number(startTimeSec) || 0);
    const mode = audioMode === 'aac' ? 'aac' : 'copy';

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-ss', String(startAt),
        '-i', inputUrl,
        '-map', '0:v:0',
        '-map', `0:a:${audioTrackIndex}`,
        '-sn',
        '-c:v', 'copy',
        '-c:a', mode === 'aac' ? 'aac' : 'copy',
        ...(mode === 'aac' ? ['-b:a', '192k'] : []),
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+append_list+temp_file',
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', segmentPath,
        playlistPath,
    ];

    const proc = spawn('/usr/bin/ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
        const line = chunk.toString();
        stderrTail = (stderrTail + line).slice(-5000);
    });

    const session = {
        id: sessionId,
        infoHash,
        fileIdx,
        audioTrackIndex,
        audioMode: mode,
        createdAt: Date.now(),
        lastAccess: Date.now(),
        status: 'starting',
        proc,
        stderrTail,
    };
    audioSessions.set(sessionId, session);

    proc.on('exit', (code, signal) => {
        const s = audioSessions.get(sessionId);
        if (!s) return;
        s.stderrTail = stderrTail;
        if (s.status !== 'ready') {
            s.status = 'failed';
            s.error = `ffmpeg exited before ready (${code ?? signal ?? 'unknown'})`;
        }
    });

    const ready = await waitForFile(playlistPath, 12000);
    const current = audioSessions.get(sessionId);
    if (!ready || !current || current.status === 'failed') {
        await stopAudioSession(sessionId);
        throw new Error(current?.error || `Audio-switch stream failed to start (${mode})`);
    }

    current.status = 'ready';
    current.lastAccess = Date.now();
    current.stderrTail = stderrTail;

    return {
        sessionId,
        url: `/api/audio-switch/${sessionId}/index.m3u8`,
        mode,
    };
}

// Trust proxy headers from nginx
app.set('trust proxy', 1);
app.use(express.json());
app.use('/audio-switch', async (req, res, next) => {
    const match = req.path.match(/^\/([^/]+)\//);
    if (match?.[1]) {
        const session = audioSessions.get(match[1]);
        if (session) session.lastAccess = Date.now();
    }
    next();
}, express.static(AUDIO_SWITCH_ROOT, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-store');
        }
        if (filePath.endsWith('.m4s') || filePath.endsWith('.mp4')) {
            res.setHeader('Cache-Control', 'public, max-age=60');
        }
    },
}));

// ── CORS: allow the UI origin (nginx serves both on same port, but just in case)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Forward a JSON body to api.strem.io and return the result. */
async function stremioApiCall(path, body) {
    const res = await fetch(`${STREMIO_API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Stremio API error: ${res.status}`);
    return res.json();
}

/** Generic JSON GET from a URL (used for add-on calls). */
async function fetchJson(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    } finally {
        clearTimeout(timer);
    }
}

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth routes /auth/*
// ─────────────────────────────────────────────────────────────────────────────

/** POST /auth/login  { email, password } → { authKey, user } */
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

        const data = await stremioApiCall('/api/login', {
            type: 'Login',
            email,
            password,
            facebook: false,
        });

        if (!data.result) throw new Error(data.error || 'Login failed');
        res.json({ authKey: data.result.authKey, user: data.result.user });
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

/** POST /auth/logout  { authKey } */
app.post('/auth/logout', async (req, res) => {
    try {
        const { authKey } = req.body;
        await stremioApiCall('/api/logout', { type: 'Logout', authKey }).catch(() => { });
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: true }); // logout always succeeds client-side
    }
});

/** GET /auth/user?authKey=... → stremio user object */
app.get('/auth/user', async (req, res) => {
    try {
        const { authKey } = req.query;
        if (!authKey) return res.status(400).json({ error: 'Missing authKey' });
        const data = await stremioApiCall('/api/getUser', { type: 'GetUser', authKey });
        if (!data.result) throw new Error(data.error || 'Failed');
        res.json(data.result);
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Add-on collection /addons/*
// ─────────────────────────────────────────────────────────────────────────────

/** GET /addons?authKey=... → array of addon descriptors */
app.get('/addons', async (req, res) => {
    try {
        const { authKey } = req.query;
        if (!authKey) return res.status(400).json({ error: 'Missing authKey' });

        const data = await stremioApiCall('/api/addonCollectionGet', {
            type: 'AddonCollectionGet',
            authKey,
            update: false,
        });

        if (!data.result) throw new Error(data.error || 'Failed to fetch addons');
        res.json(data.result.addons || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Account synced library /library, /recently-played
// Uses Stremio datastore collection: libraryItem
// ─────────────────────────────────────────────────────────────────────────────

app.get('/library', async (req, res) => {
    try {
        const { authKey, type = 'all' } = req.query;
        const limit = Math.max(1, Math.min(500, toNumber(req.query.limit, 500)));

        if (!authKey) return res.status(400).json({ error: 'Missing authKey' });

        const data = await stremioApiCall('/api/datastoreGet', {
            type: 'DatastoreGet',
            authKey,
            collection: 'libraryItem',
            all: true,
        });

        let items = normalizeLibraryItems(data);
        if (type !== 'all') {
            items = items.filter(item => item.type === type);
        }

        items.sort((a, b) => {
            const at = new Date(a.updatedAt || 0).getTime();
            const bt = new Date(b.updatedAt || 0).getTime();
            return bt - at;
        });

        res.json({ items: items.slice(0, limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/recently-played', async (req, res) => {
    try {
        const { authKey } = req.query;
        const limit = Math.max(1, Math.min(200, toNumber(req.query.limit, 30)));

        if (!authKey) return res.status(400).json({ error: 'Missing authKey' });

        const data = await stremioApiCall('/api/datastoreGet', {
            type: 'DatastoreGet',
            authKey,
            collection: 'libraryItem',
            all: true,
        });

        const items = normalizeLibraryItems(data)
            .filter(item => item.state?.lastWatched)
            .sort((a, b) => {
                const at = new Date(a.state?.lastWatched || 0).getTime();
                const bt = new Date(b.state?.lastWatched || 0).getTime();
                return bt - at;
            })
            .slice(0, limit);

        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Add-on proxy /addon-proxy
// Proxies any add-on HTTP GET request to bypass TV-browser CORS restrictions
// Usage: GET /addon-proxy?url=https%3A%2F%2Fv3-cinemeta.strem.io%2Fcatalog%2Fmovie%2Ftop.json
// ─────────────────────────────────────────────────────────────────────────────

app.get('/addon-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    try {
        const decoded = decodeURIComponent(url);
        // Safety: only allow http/https
        if (!/^https?:\/\//.test(decoded)) return res.status(400).json({ error: 'Invalid URL' });

        const upstream = await fetch(decoded, {
            headers: {
                'User-Agent': 'Stremio/5.0 (+https://www.stremio.com/)',
                'Accept': 'application/json',
            },
        });

        if (!upstream.ok) {
            return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
        }

        const body = await upstream.json();
        res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min catalog cache
        res.json(body);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream URL resolution /stream-url
// Takes a Stremio stream object and returns a playback URL the TV can use.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /stream-url
 * Body: { stream: StreamObject, host: 'http://192.168.1.x:8080' }
 * Returns: { url, hlsUrl, type, canSeek }
 */
app.post('/stream-url', async (req, res) => {
    try {
        const { stream, host } = req.body;
        if (!stream) return res.status(400).json({ error: 'Missing stream' });

        const serverBase = `${host || ''}/ss`;

        // ── 1. External HTTP stream ─────────────────────────────────────────
        if (stream.url) {
            // Some streams are externally hosted (HTTP direct links)
            const normalizedUrl = normalizeStreamUrl(stream.url, host);
            const isHls = /\.m3u8($|\?)/i.test(normalizedUrl);

            // Some local stremio-server playlist URLs (e.g. /hash/idx/stream-1.m3u8)
            // are not directly playable and return 404/warnings unless extra params are present.
            // For these, route to direct file URL under /ss/<hash>/<idx>.
            try {
                const parsed = new URL(normalizedUrl, host || 'http://localhost');
                const localMatch = extractHashFileFromPath(parsed.pathname);
                // Any local stremio-server media path (stream-N.m3u8, direct hash URL, etc.)
                // Route to the master.m3u8 so hls.js can expose multi-audio and subtitle tracks.
                if (localMatch) {
                    const base = `${host || ''}/ss/${localMatch.infoHash}/${localMatch.fileIdx}`;
                    const direct = base;
                    const hlsUrl = `${base}/master.m3u8`;
                    // Warm-up ping
                    fetch(`http://127.0.0.1:11470/${localMatch.infoHash}/${localMatch.fileIdx}`, {
                        method: 'HEAD', signal: AbortSignal.timeout(2000),
                    }).catch(() => { });
                    return res.json({
                        url: direct,
                        hlsUrl,
                        infoHash: localMatch.infoHash,
                        fileIdx: localMatch.fileIdx,
                        type: 'torrent',
                        canSeek: true,
                    });
                }
            } catch {
                // ignore parse failures and continue with normalized URL
            }

            return res.json({
                url: normalizedUrl,
                hlsUrl: isHls ? normalizedUrl : null,
                type: 'http',
                canSeek: true,
            });
        }

        // ── 2. BitTorrent / infoHash stream ─────────────────────────────────
        if (stream.infoHash) {
            const infoHash = stream.infoHash.toLowerCase();
            const fileIdx = stream.fileIdx ?? 0;

            // Announce the stream to the server by hitting the direct URL
            // (non-blocking — we don't wait for download to start)
            const directUrl = `${serverBase}/${infoHash}/${fileIdx}`;

            // stremio-server also accepts a magnetUrl for explicit torrent fetch
            let magnetUrl = stream.magnetUrl || null;
            if (!magnetUrl) {
                const announces = (stream.sources || [])
                    .filter(s => s.startsWith('tracker:'))
                    .map(s => `&tr=${encodeURIComponent(s.replace('tracker:', ''))}`)
                    .join('');
                magnetUrl = `magnet:?xt=urn:btih:${infoHash}${announces}`;
            }

            // Ping the server to warm up the torrent (fire and forget)
            fetch(`http://127.0.0.1:11470/${infoHash}/${fileIdx}`, {
                method: 'HEAD',
                signal: AbortSignal.timeout(2000),
            }).catch(() => { });

            return res.json({
                url: directUrl,
                // Some builds of stremio-server support appending /master.m3u8
                // for on-the-fly HLS transcode. We return it and the player tries it.
                hlsUrl: `${serverBase}/${infoHash}/${fileIdx}/master.m3u8`,
                infoHash,
                fileIdx,
                type: 'torrent',
                canSeek: true,
                magnetUrl,
            });
        }

        // ── 3. YouTube / other protocol streams ─────────────────────────────
        if (stream.ytId) {
            return res.json({
                url: `https://www.youtube.com/watch?v=${stream.ytId}`,
                hlsUrl: null,
                type: 'youtube',
                canSeek: false,
                needsExternal: true,
            });
        }

        // ── 4. External player streams ──────────────────────────────────────
        if (stream.externalUrl) {
            return res.json({
                url: stream.externalUrl,
                hlsUrl: null,
                type: 'external',
                canSeek: false,
            });
        }

        res.status(400).json({ error: 'Unrecognised stream format' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Audio switch remux /audio-switch-url
// Creates a dedicated HLS session with selected audio track (video copy).
// POST /audio-switch-url { infoHash, fileIdx, audioTrackIndex, startTimeSec }
// ─────────────────────────────────────────────────────────────────────────────

app.post('/audio-switch-url', async (req, res) => {
    try {
        const infoHash = String(req.body?.infoHash || '').toLowerCase();
        const fileIdx = toNumber(req.body?.fileIdx, 0);
        const audioTrackIndex = toNumber(req.body?.audioTrackIndex, -1);
        const startTimeSec = Math.max(0, toNumber(req.body?.startTimeSec, 0));

        if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
            return res.status(400).json({ error: 'Invalid infoHash' });
        }
        if (!Number.isInteger(fileIdx) || fileIdx < 0) {
            return res.status(400).json({ error: 'Invalid fileIdx' });
        }
        if (!Number.isInteger(audioTrackIndex) || audioTrackIndex < 0) {
            return res.status(400).json({ error: 'Invalid audioTrackIndex' });
        }

        // Copy-first policy: preserve original audio bitstream when possible.
        try {
            const result = await startAudioSwitchSession({
                infoHash,
                fileIdx,
                audioTrackIndex,
                startTimeSec,
                audioMode: 'copy',
            });
            return res.json({ ...result, transcoding: false });
        } catch (copyErr) {
            // Fallback: audio-only transcode to AAC for maximum browser compatibility.
            const result = await startAudioSwitchSession({
                infoHash,
                fileIdx,
                audioTrackIndex,
                startTimeSec,
                audioMode: 'aac',
            });
            return res.json({ ...result, transcoding: true, note: `copy-mode failed: ${copyErr.message}` });
        }
    } catch (err) {
        return res.status(500).json({ error: `Audio switch session failed: ${err.message}` });
    }
});

app.delete('/audio-switch/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    await stopAudioSession(sessionId).catch(() => { });
    res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subtitle proxy /subtitle-proxy
// Fetches an SRT or VTT subtitle file and converts to VTT for the <track> element
// GET /subtitle-proxy?url=...
// ─────────────────────────────────────────────────────────────────────────────

app.get('/subtitle-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');

    try {
        const decoded = decodeURIComponent(url);
        if (!/^https?:\/\//.test(decoded)) return res.status(400).send('Invalid URL');

        const upstream = await fetch(decoded);
        if (!upstream.ok) return res.status(upstream.status).send('Upstream error');

        let text = await upstream.text();

        // Convert SRT to WebVTT if necessary
        if (!text.startsWith('WEBVTT') && !decoded.endsWith('.vtt')) {
            text = srtToVtt(text);
        }

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(text);
    } catch (err) {
        res.status(502).send(err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Image proxy /image-proxy?url=...
// Proxies poster/thumbnail images to avoid CORS/mixed-content issues on TV
// ─────────────────────────────────────────────────────────────────────────────

app.get('/image-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');

    try {
        const decoded = decodeURIComponent(url);
        if (!/^https?:\/\//.test(decoded)) return res.status(400).send('Invalid URL');

        const upstream = await fetch(decoded, { redirect: 'follow' });
        if (!upstream.ok) return res.status(upstream.status).send('Not found');

        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h cache
        upstream.body.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
        upstream.body.pipe(res);
    } catch (err) {
        res.status(502).send(err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// stremio-server health check proxy
// ─────────────────────────────────────────────────────────────────────────────

app.get('/server-status', async (req, res) => {
    try {
        const manifest = await fetchJson(`${STREMIO_SERVER}/local-addon/manifest.json`, 3000);
        res.json({
            ok: true,
            server: {
                id: manifest?.id || 'org.stremio.local',
                version: manifest?.version || null,
                name: manifest?.name || 'Local addon',
            },
        });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Media info — ffprobe-based track discovery for direct playback
// GET /media-info?infoHash=X&fileIdx=Y
// ─────────────────────────────────────────────────────────────────────────────

app.get('/media-info', async (req, res) => {
    const { infoHash, fileIdx = '0' } = req.query;
    if (!infoHash) return res.status(400).json({ error: 'Missing infoHash' });

    const streamUrl = `${STREMIO_SERVER}/${infoHash}/${fileIdx}`;

    try {
        const data = await ffprobe(streamUrl);
        const streams = data.streams || [];

        const audio = streams
            .filter(s => s.codec_type === 'audio')
            .map(s => ({
                index: s.index,
                language: s.tags?.language || '',
                title: s.tags?.title || '',
                codec: s.codec_name || '',
                profile: s.profile || '',
                channels: s.channels || 0,
                channelLayout: s.channel_layout || '',
                default: !!(s.disposition?.default),
            }));

        const subtitles = streams
            .filter(s => s.codec_type === 'subtitle')
            .map(s => ({
                index: s.index,
                language: s.tags?.language || '',
                title: s.tags?.title || '',
                codec: s.codec_name || '',
                default: !!(s.disposition?.default),
                forced: !!(s.disposition?.forced),
            }));

        const video = streams
            .filter(s => s.codec_type === 'video')
            .map(s => ({
                index: s.index,
                codec: s.codec_name || '',
                width: s.width || 0,
                height: s.height || 0,
                hdr: (s.color_transfer || '').includes('smpte2084') ||
                    (s.color_transfer || '').includes('arib-std-b67') ||
                    (s.color_primaries || '').includes('bt2020'),
            }));

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json({ audio, subtitles, video });
    } catch (err) {
        console.warn('[media-info] ffprobe failed for', infoHash, err.message);
        res.status(500).json({ error: 'Failed to probe media: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[backend] Listening on http://127.0.0.1:${PORT}`);
    console.log(`[backend] Stremio server: ${STREMIO_SERVER}`);
});
