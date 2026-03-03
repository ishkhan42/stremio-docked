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

const app = express();
const PORT = 3001;
const STREMIO_SERVER = process.env.STREMIO_SERVER_URL || 'http://127.0.0.1:11470';
const STREMIO_API = 'https://api.strem.io';

// Trust proxy headers from nginx
app.set('trust proxy', 1);
app.use(express.json());

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

function normalizeLibraryItems(data) {
    const raw = Array.isArray(data?.result)
        ? data.result
        : Array.isArray(data)
            ? data
            : Array.isArray(data?.result?.items)
                ? data.result.items
                : [];

    return raw
        .filter(item => item && item._id && !item.removed)
        .map(item => ({
            id: item._id,
            type: item.type || 'movie',
            name: item.name || item._id,
            poster: item.poster || '',
            background: item.background || '',
            year: item.year || '',
            posterShape: item.posterShape || 'poster',
            state: item.state || {},
            updatedAt: item._mtime || item._ctime || null,
            createdAt: item._ctime || null,
        }));
}

function normalizeStreamUrl(url, host) {
    if (!url || typeof url !== 'string') return url;

    const publicHost = host || '';
    const localMediaPath = /^\/([a-f0-9]{40}|stream|hlsv2)\//i;

    if (url.startsWith('/')) {
        if (publicHost) {
            return `${publicHost}/ss${url}`;
        }
        return `/ss${url}`;
    }

    try {
        const parsed = new URL(url);
        const isLocalServer =
            parsed.hostname === '127.0.0.1' ||
            parsed.hostname === 'localhost' ||
            parsed.port === '11470';

        const looksLikeLocalMedia = localMediaPath.test(parsed.pathname);

        if ((isLocalServer || looksLikeLocalMedia) && publicHost) {
            return `${publicHost}/ss${parsed.pathname}${parsed.search || ''}`;
        }

        return url;
    } catch {
        return url;
    }
}

function extractHashFileFromPath(pathname = '') {
    const match = pathname.match(/^\/([a-f0-9]{40})\/(\d+)(?:\/.*)?$/i);
    if (!match) return null;
    return { infoHash: match[1].toLowerCase(), fileIdx: Number(match[2]) || 0 };
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
                const isLocalM3u8 = !!localMatch && /\/stream-\d+\.m3u8$/i.test(parsed.pathname);
                if (isLocalM3u8 && localMatch) {
                    const direct = `${host || ''}/ss/${localMatch.infoHash}/${localMatch.fileIdx}`;
                    return res.json({
                        url: direct,
                        hlsUrl: null,
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

/** Minimal SRT → WebVTT converter */
function srtToVtt(srt) {
    let vtt = 'WEBVTT\n\n';
    vtt += srt
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Convert SRT timestamps (00:00:00,000) to VTT (00:00:00.000)
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        // Remove <i>, <b>, <u> HTML tags (optional — VTT supports them but keep safe)
        // Keep as-is; VTT supports basic HTML
        .trim();
    return vtt;
}

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
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[backend] Listening on http://127.0.0.1:${PORT}`);
    console.log(`[backend] Stremio server: ${STREMIO_SERVER}`);
});
