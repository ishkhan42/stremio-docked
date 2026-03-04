/**
 * Pure utility functions extracted for testability.
 * Used by both index.js (main server) and tests.
 */
'use strict';

/** Normalize a stremio-server URL to route through /ss/ proxy. */
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

/** Extract infohash + file index from a stremio-server path. */
function extractHashFileFromPath(pathname = '') {
    const match = pathname.match(/^\/([a-f0-9]{40})\/(\d+)(?:\/.*)?$/i);
    if (!match) return null;
    return { infoHash: match[1].toLowerCase(), fileIdx: Number(match[2]) || 0 };
}

/** Minimal SRT → WebVTT converter. */
function srtToVtt(srt) {
    let vtt = 'WEBVTT\n\n';
    vtt += srt
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .trim();
    return vtt;
}

/** Normalize library items from various Stremio API response shapes. */
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

module.exports = {
    normalizeStreamUrl,
    extractHashFileFromPath,
    srtToVtt,
    normalizeLibraryItems,
};
