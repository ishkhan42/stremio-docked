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

/**
 * Build discontinuity hints from ffprobe packet timestamps.
 *
 * We treat strong DTS/PTS jumps (backward or unexpectedly large forward gaps)
 * as potential browser demux trouble points and return tiny hop targets.
 */
function buildTimelineDiscontinuities(packets = [], options = {}) {
    const backwardJumpSec = Math.max(0.02, Number(options.backwardJumpSec ?? 0.04));
    const forwardGapSec = Math.max(0.2, Number(options.forwardGapSec ?? 0.9));
    const hopPaddingSec = Math.max(0.05, Number(options.hopPaddingSec ?? 0.12));

    if (!Array.isArray(packets) || packets.length < 2) {
        return [];
    }

    const timeline = packets
        .map((pkt, idx) => {
            const dts = Number(pkt?.dts_time);
            const pts = Number(pkt?.pts_time);
            const t = Number.isFinite(dts) ? dts : (Number.isFinite(pts) ? pts : NaN);
            return Number.isFinite(t) ? { t, pts, dts, idx } : null;
        })
        .filter(Boolean);

    if (timeline.length < 2) return [];

    const raw = [];
    for (let i = 1; i < timeline.length; i += 1) {
        const prev = timeline[i - 1];
        const cur = timeline[i];
        const delta = cur.t - prev.t;

        if (delta < -backwardJumpSec) {
            const safeTarget = Math.max(cur.t + hopPaddingSec, prev.t + hopPaddingSec);
            raw.push({
                type: 'backward-jump',
                atSec: Math.max(0, prev.t),
                deltaSec: delta,
                resumeAtSec: safeTarget,
                packetIndex: cur.idx,
            });
            continue;
        }

        if (delta > forwardGapSec) {
            raw.push({
                type: 'forward-gap',
                atSec: Math.max(0, prev.t),
                deltaSec: delta,
                resumeAtSec: Math.max(cur.t + hopPaddingSec, prev.t + hopPaddingSec),
                packetIndex: cur.idx,
            });
        }
    }

    // Merge nearby events into one stronger hint so the player won't chain-jump.
    const merged = [];
    for (const item of raw) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(item.atSec - last.atSec) < 0.7) {
            if (Math.abs(item.deltaSec) > Math.abs(last.deltaSec)) {
                last.type = item.type;
                last.deltaSec = item.deltaSec;
                last.resumeAtSec = Math.max(last.resumeAtSec, item.resumeAtSec);
                last.packetIndex = item.packetIndex;
            }
            continue;
        }
        merged.push(item);
    }

    return merged;
}

module.exports = {
    normalizeStreamUrl,
    extractHashFileFromPath,
    srtToVtt,
    normalizeLibraryItems,
    buildTimelineDiscontinuities,
};
