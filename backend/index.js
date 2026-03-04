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
const fsSync = require('fs');
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
const PREFETCH_TTL_MS = 20 * 60 * 1000;
const PREFETCH_MAX_JOBS = 2;
const DOWNLOAD_INDEX_PATH = '/root/.stremio-server/stremio-docked-downloads.json';
const STREMIO_CACHE_ROOT = '/root/.stremio-server/stremio-cache';
const SYNC_MIN_INTERVAL_MS = 15000;

const audioSessions = new Map();
const prefetchJobs = new Map();
const recentSyncLastAt = new Map();

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

async function stopPrefetchJob(sessionId) {
    const job = prefetchJobs.get(sessionId);
    if (!job) return;
    prefetchJobs.delete(sessionId);
    if (job.status === 'running' || job.status === 'starting') {
        job.status = 'stopped';
    }
    if (job.mode === 'download' && job.downloadId) {
        await updateDownloadRecord(job.downloadId, {
            sessionId: null,
            status: job.status,
            updatedAt: Date.now(),
        });
    }
    try { job.controller?.abort(); } catch { }
}

async function cleanupExpiredPrefetchJobs() {
    const now = Date.now();
    const stale = [];
    for (const [id, job] of prefetchJobs.entries()) {
        const expired = now - (job.lastAccess || job.createdAt || 0) > PREFETCH_TTL_MS;
        const finalized = job.status === 'done' || job.status === 'failed' || job.status === 'stopped';
        if (expired || (finalized && now - (job.updatedAt || job.lastAccess || 0) > 3 * 60 * 1000)) {
            stale.push(id);
        }
    }
    await Promise.all(stale.map(stopPrefetchJob));
}

function readDownloadIndex() {
    try {
        if (!fsSync.existsSync(DOWNLOAD_INDEX_PATH)) return [];
        const raw = fsSync.readFileSync(DOWNLOAD_INDEX_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writeDownloadIndex(entries) {
    const safeEntries = Array.isArray(entries) ? entries : [];
    await fs.mkdir(path.dirname(DOWNLOAD_INDEX_PATH), { recursive: true });
    await fs.writeFile(DOWNLOAD_INDEX_PATH, JSON.stringify(safeEntries, null, 2), 'utf-8');
}

async function updateDownloadRecord(downloadId, patch = {}) {
    const now = Date.now();
    const entries = readDownloadIndex();
    const idx = entries.findIndex(e => e.id === downloadId);
    if (idx >= 0) {
        entries[idx] = {
            ...entries[idx],
            ...patch,
            updatedAt: now,
        };
    } else {
        entries.push({
            id: downloadId,
            createdAt: now,
            updatedAt: now,
            status: 'queued',
            ...patch,
        });
    }
    await writeDownloadIndex(entries);
}

function toDownloadId(infoHash, fileIdx) {
    return `${infoHash}:${fileIdx}`;
}

function estimateCachePath(infoHash) {
    return /^[a-f0-9]{40}$/i.test(infoHash)
        ? path.join(STREMIO_CACHE_ROOT, infoHash.toLowerCase())
        : null;
}

async function removeDownloadArtifacts(infoHash) {
    const cachePath = estimateCachePath(infoHash);
    if (!cachePath) return { removedBytes: 0, removedFiles: 0 };

    let removedBytes = 0;
    let removedFiles = 0;
    async function walkSize(dirPath) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                await walkSize(full);
            } else if (entry.isFile()) {
                const st = await fs.stat(full).catch(() => null);
                if (st) {
                    removedBytes += st.size;
                    removedFiles += 1;
                }
            }
        }
    }

    const exists = await fs.access(cachePath).then(() => true).catch(() => false);
    if (!exists) return { removedBytes: 0, removedFiles: 0 };

    await walkSize(cachePath).catch(() => { });
    await fs.rm(cachePath, { recursive: true, force: true }).catch(() => { });
    return { removedBytes, removedFiles };
}

setInterval(() => {
    cleanupExpiredAudioSessions().catch(() => { });
    cleanupExpiredPrefetchJobs().catch(() => { });
}, 5 * 60 * 1000).unref();

async function startPrefetchJob({ infoHash, fileIdx, startTimeSec = 0, durationSec = 0, mode = 'prefetch', metadata = {} }) {
    if (prefetchJobs.size >= PREFETCH_MAX_JOBS) {
        const oldest = [...prefetchJobs.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))[0];
        if (oldest) await stopPrefetchJob(oldest[0]);
    }

    const streamUrl = `${STREMIO_SERVER}/${infoHash}/${fileIdx}`;
    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    const headers = {};

    let startedAtByte = 0;
    const start = Math.max(0, Number(startTimeSec) || 0);
    const total = Math.max(0, Number(durationSec) || 0);

    if (start > 0 && total > 0) {
        try {
            const head = await fetch(streamUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
            const contentLength = Number(head.headers.get('content-length') || '0');
            if (Number.isFinite(contentLength) && contentLength > 0) {
                const ratio = Math.min(0.98, Math.max(0, start / total));
                startedAtByte = Math.floor(contentLength * ratio);
                headers.Range = `bytes=${startedAtByte}-`;
            }
        } catch {
            // continue without range
        }
    }

    const normalizedMode = mode === 'download' ? 'download' : 'prefetch';
    const downloadId = normalizedMode === 'download' ? toDownloadId(infoHash, fileIdx) : null;

    const job = {
        id: sessionId,
        infoHash,
        fileIdx,
        mode: normalizedMode,
        metadata,
        downloadId,
        status: 'starting',
        createdAt: Date.now(),
        lastAccess: Date.now(),
        updatedAt: Date.now(),
        controller,
        startedAtByte,
        bytesDownloaded: 0,
        totalBytes: 0,
        speedBps: 0,
        startedAt: Date.now(),
        lastByteAt: Date.now(),
    };
    prefetchJobs.set(sessionId, job);

    if (normalizedMode === 'download' && downloadId) {
        await updateDownloadRecord(downloadId, {
            infoHash,
            fileIdx,
            title: metadata.title || '',
            type: metadata.type || '',
            videoId: metadata.videoId || '',
            metaName: metadata.metaName || '',
            metaPoster: metadata.metaPoster || '',
            status: 'starting',
            sessionId,
            cachePath: estimateCachePath(infoHash),
            bytesDownloaded: 0,
            totalBytes: 0,
            speedBps: 0,
        });
    }

    (async () => {
        try {
            const response = await fetch(streamUrl, { headers, signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            job.status = 'running';
            job.totalBytes = Number(response.headers.get('content-length') || '0') || 0;
            job.updatedAt = Date.now();

            if (normalizedMode === 'download' && downloadId) {
                await updateDownloadRecord(downloadId, {
                    status: 'running',
                    sessionId,
                    totalBytes: job.totalBytes,
                });
            }

            let lastPersistAt = 0;

            await new Promise((resolve, reject) => {
                response.body.on('data', (chunk) => {
                    const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ''));
                    const now = Date.now();
                    const elapsedSec = Math.max(1, (now - job.startedAt) / 1000);
                    job.bytesDownloaded += size;
                    job.speedBps = Math.round(job.bytesDownloaded / elapsedSec);
                    job.lastAccess = Date.now();
                    job.updatedAt = now;
                    job.lastByteAt = now;

                    if (normalizedMode === 'download' && downloadId && (now - lastPersistAt > 1200)) {
                        lastPersistAt = now;
                        updateDownloadRecord(downloadId, {
                            status: 'running',
                            sessionId,
                            bytesDownloaded: job.bytesDownloaded,
                            totalBytes: job.totalBytes,
                            speedBps: job.speedBps,
                        }).catch(() => { });
                    }
                });
                response.body.on('end', resolve);
                response.body.on('error', reject);
            });

            job.status = 'done';
            job.updatedAt = Date.now();
            if (normalizedMode === 'download' && downloadId) {
                await updateDownloadRecord(downloadId, {
                    sessionId: null,
                    status: 'done',
                    bytesDownloaded: job.bytesDownloaded,
                    totalBytes: job.totalBytes,
                    speedBps: 0,
                });
            }
        } catch (err) {
            if (controller.signal.aborted) {
                job.status = 'stopped';
            } else {
                job.status = 'failed';
                job.error = err.message;
            }
            job.updatedAt = Date.now();
            if (normalizedMode === 'download' && downloadId) {
                await updateDownloadRecord(downloadId, {
                    sessionId: null,
                    status: job.status,
                    lastError: job.error || '',
                    bytesDownloaded: job.bytesDownloaded,
                    totalBytes: job.totalBytes,
                    speedBps: 0,
                });
            }
        }
    })();

    return { sessionId, startedAtByte, mode: normalizedMode, downloadId };
}

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
// Direct stream prefetch /stream-prefetch/*
// Warm cache ahead of playback for high bitrate direct streams.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/stream-prefetch/start', async (req, res) => {
    try {
        const infoHash = String(req.body?.infoHash || '').toLowerCase();
        const fileIdx = toNumber(req.body?.fileIdx, 0);
        const startTimeSec = Math.max(0, toNumber(req.body?.startTimeSec, 0));
        const durationSec = Math.max(0, toNumber(req.body?.durationSec, 0));
        const mode = req.body?.mode === 'download' ? 'download' : 'prefetch';
        const metadata = {
            title: String(req.body?.title || ''),
            type: String(req.body?.type || ''),
            videoId: String(req.body?.videoId || ''),
            metaName: String(req.body?.metaName || ''),
            metaPoster: String(req.body?.metaPoster || ''),
        };

        if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
            return res.status(400).json({ error: 'Invalid infoHash' });
        }
        if (!Number.isInteger(fileIdx) || fileIdx < 0) {
            return res.status(400).json({ error: 'Invalid fileIdx' });
        }

        const started = await startPrefetchJob({ infoHash, fileIdx, startTimeSec, durationSec, mode, metadata });
        return res.json({ ok: true, ...started });
    } catch (err) {
        return res.status(500).json({ error: `Prefetch start failed: ${err.message}` });
    }
});

app.get('/stream-prefetch/:sessionId/status', async (req, res) => {
    const { sessionId } = req.params;
    const job = prefetchJobs.get(sessionId);
    if (!job) return res.status(404).json({ error: 'Prefetch session not found' });

    job.lastAccess = Date.now();
    const progress = job.totalBytes > 0
        ? Math.min(100, (job.bytesDownloaded / job.totalBytes) * 100)
        : null;

    return res.json({
        sessionId: job.id,
        mode: job.mode,
        status: job.status,
        infoHash: job.infoHash,
        fileIdx: job.fileIdx,
        bytesDownloaded: job.bytesDownloaded,
        totalBytes: job.totalBytes,
        speedBps: job.speedBps,
        startedAtByte: job.startedAtByte,
        progress,
        error: job.error || null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt || job.lastAccess,
    });
});

app.get('/stream-prefetch/downloads', async (req, res) => {
    const entries = readDownloadIndex();
    const items = entries.map((item) => {
        const active = item.sessionId ? prefetchJobs.get(item.sessionId) : null;
        const bytesDownloaded = active ? active.bytesDownloaded : (item.bytesDownloaded || 0);
        const totalBytes = active ? active.totalBytes : (item.totalBytes || 0);
        const speedBps = active ? active.speedBps : (item.speedBps || 0);
        const progress = totalBytes > 0 ? Math.min(100, (bytesDownloaded / totalBytes) * 100) : null;
        return {
            ...item,
            status: active ? active.status : item.status,
            bytesDownloaded,
            totalBytes,
            speedBps,
            progress,
            activeSessionId: active?.id || null,
        };
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ items });
});

app.delete('/stream-prefetch/downloads/:downloadId', async (req, res) => {
    const downloadId = String(req.params.downloadId || '');
    const entries = readDownloadIndex();
    const current = entries.find(item => item.id === downloadId);
    if (!current) return res.status(404).json({ error: 'Download not found' });

    if (current.sessionId) {
        await stopPrefetchJob(current.sessionId).catch(() => { });
    }

    const cleaned = await removeDownloadArtifacts(current.infoHash).catch(() => ({ removedBytes: 0, removedFiles: 0 }));
    const next = entries.filter(item => item.id !== downloadId);
    await writeDownloadIndex(next);

    res.json({
        ok: true,
        removedBytes: cleaned.removedBytes || 0,
        removedFiles: cleaned.removedFiles || 0,
    });
});

app.delete('/stream-prefetch/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    await stopPrefetchJob(sessionId).catch(() => { });
    res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recently played sync-up /recently-played/sync
// Best-effort write-back from local playback progress to Stremio account.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/recently-played/sync', async (req, res) => {
    try {
        const authKey = String(req.body?.authKey || '');
        const mediaId = String(req.body?.mediaId || req.body?.videoId || '');
        const type = String(req.body?.type || 'movie');
        const name = String(req.body?.name || req.body?.metaName || mediaId || 'Unknown');
        const poster = String(req.body?.poster || req.body?.metaPoster || '');
        const background = String(req.body?.background || '');
        const position = Math.max(0, toNumber(req.body?.position, 0));
        const duration = Math.max(0, toNumber(req.body?.duration, 0));

        if (!authKey) return res.status(400).json({ error: 'Missing authKey' });
        if (!mediaId) return res.status(400).json({ error: 'Missing mediaId/videoId' });

        const dedupeKey = `${authKey}:${type}:${mediaId}`;
        const now = Date.now();
        const lastAt = recentSyncLastAt.get(dedupeKey) || 0;
        if (now - lastAt < SYNC_MIN_INTERVAL_MS) {
            return res.json({ ok: true, skipped: true });
        }
        recentSyncLastAt.set(dedupeKey, now);

        const state = {
            timeOffset: Math.floor(position),
            duration: Math.floor(duration),
            lastWatched: new Date(now).toISOString(),
        };

        const itemId = mediaId.includes(':') ? mediaId : `${type}:${mediaId}`;
        const item = {
            _id: itemId,
            type,
            name,
            poster,
            background,
            state,
            mtime: now,
        };

        const payloads = [
            { type: 'DatastorePut', authKey, collection: 'libraryItem', key: itemId, value: item },
            { type: 'DatastorePut', authKey, collection: 'libraryItem', item },
            { type: 'DatastorePut', authKey, collection: 'libraryItem', changes: [item] },
        ];

        let synced = false;
        let lastError = null;
        for (const payload of payloads) {
            try {
                const response = await stremioApiCall('/api/datastorePut', payload);
                if (response?.result || response?.ok || response === true) {
                    synced = true;
                    break;
                }
            } catch (err) {
                lastError = err;
            }
        }

        if (!synced) {
            return res.status(502).json({ error: `Stremio sync failed: ${lastError?.message || 'unknown error'}` });
        }

        return res.json({ ok: true, id: itemId });
    } catch (err) {
        return res.status(500).json({ error: `Sync failed: ${err.message}` });
    }
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
