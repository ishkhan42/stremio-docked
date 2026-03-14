/**
 * Tests for backend/utils.js pure utility functions.
 *
 * Run with: npx vitest run --config backend/vitest.config.js
 */
import { describe, it, expect } from 'vitest';
import {
    normalizeStreamUrl,
    extractHashFileFromPath,
    srtToVtt,
    normalizeLibraryItems,
    buildTimelineDiscontinuities,
} from '../utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// normalizeStreamUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeStreamUrl', () => {
    const HOST = 'http://myhost.local:6080';

    it('rewrites absolute local path to /ss/ with host', () => {
        const url = '/abc123abc123abc123abc123abc123abc123abcd/0/master.m3u8';
        expect(normalizeStreamUrl(url, HOST)).toBe(`${HOST}/ss${url}`);
    });

    it('rewrites absolute local path to /ss/ without host', () => {
        const url = '/abc123abc123abc123abc123abc123abc123abcd/0/master.m3u8';
        expect(normalizeStreamUrl(url, '')).toBe(`/ss${url}`);
    });

    it('rewrites localhost:11470 full URL through /ss/', () => {
        const url = 'http://127.0.0.1:11470/abc123abc123abc123abc123abc123abc123abcd/0/master.m3u8';
        const result = normalizeStreamUrl(url, HOST);
        expect(result).toBe(`${HOST}/ss/abc123abc123abc123abc123abc123abc123abcd/0/master.m3u8`);
    });

    it('rewrites localhost URL with query string', () => {
        const url = 'http://localhost:11470/stream/some-video.mp4?token=abc';
        const result = normalizeStreamUrl(url, HOST);
        expect(result).toBe(`${HOST}/ss/stream/some-video.mp4?token=abc`);
    });

    it('leaves external URLs unchanged', () => {
        const url = 'https://cdn.example.com/video.mp4';
        expect(normalizeStreamUrl(url, HOST)).toBe(url);
    });

    it('returns null/undefined as-is', () => {
        expect(normalizeStreamUrl(null, HOST)).toBeNull();
        expect(normalizeStreamUrl(undefined, HOST)).toBeUndefined();
    });

    it('returns empty string as-is', () => {
        expect(normalizeStreamUrl('', HOST)).toBe('');
    });

    it('handles /hlsv2/ paths', () => {
        const url = '/hlsv2/some-id/master.m3u8';
        expect(normalizeStreamUrl(url, HOST)).toBe(`${HOST}/ss${url}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractHashFileFromPath
// ─────────────────────────────────────────────────────────────────────────────

describe('extractHashFileFromPath', () => {
    const HASH = 'aabbccddee11223344556677889900aabbccddee';

    it('extracts hash and fileIdx from valid path', () => {
        const result = extractHashFileFromPath(`/${HASH}/3/master.m3u8`);
        expect(result).toEqual({ infoHash: HASH.toLowerCase(), fileIdx: 3 });
    });

    it('extracts hash with fileIdx 0', () => {
        const result = extractHashFileFromPath(`/${HASH}/0`);
        expect(result).toEqual({ infoHash: HASH.toLowerCase(), fileIdx: 0 });
    });

    it('handles uppercase hash', () => {
        const upper = HASH.toUpperCase();
        const result = extractHashFileFromPath(`/${upper}/7`);
        expect(result).toEqual({ infoHash: HASH.toLowerCase(), fileIdx: 7 });
    });

    it('returns null for non-hash paths', () => {
        expect(extractHashFileFromPath('/api/login')).toBeNull();
        expect(extractHashFileFromPath('/stream/video.mp4')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(extractHashFileFromPath('')).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(extractHashFileFromPath()).toBeNull();
    });

    it('returns null for too-short hash', () => {
        expect(extractHashFileFromPath('/aabbccdd/0')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// srtToVtt
// ─────────────────────────────────────────────────────────────────────────────

describe('srtToVtt', () => {
    it('prepends WEBVTT header', () => {
        const result = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nHello');
        expect(result.startsWith('WEBVTT\n\n')).toBe(true);
    });

    it('converts comma timestamps to dot', () => {
        const srt = '1\n00:01:23,456 --> 00:01:25,789\nTest line';
        const result = srtToVtt(srt);
        expect(result).toContain('00:01:23.456 --> 00:01:25.789');
    });

    it('normalizes \\r\\n to \\n', () => {
        const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n';
        const result = srtToVtt(srt);
        expect(result).not.toContain('\r');
    });

    it('handles already-clean SRT without \\r', () => {
        const srt = '1\n00:00:10,500 --> 00:00:12,300\nClean';
        const result = srtToVtt(srt);
        expect(result).toContain('00:00:10.500 --> 00:00:12.300');
        expect(result).toContain('Clean');
    });

    it('handles multi-cue SRT', () => {
        const srt = [
            '1', '00:00:01,000 --> 00:00:03,000', 'First cue',
            '', '2', '00:00:04,000 --> 00:00:06,000', 'Second cue',
        ].join('\n');
        const result = srtToVtt(srt);
        expect(result).toContain('First cue');
        expect(result).toContain('Second cue');
        expect(result).toContain('00:00:01.000');
        expect(result).toContain('00:00:06.000');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeLibraryItems
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeLibraryItems', () => {
    it('extracts items from { result: [...] } shape', () => {
        const data = {
            result: [
                { _id: 'tt123', type: 'movie', name: 'Test', poster: 'http://img/1.jpg' },
            ],
        };
        const items = normalizeLibraryItems(data);
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('tt123');
        expect(items[0].name).toBe('Test');
    });

    it('extracts items from raw array', () => {
        const data = [
            { _id: 'tt456', type: 'series', name: 'Show' },
        ];
        const items = normalizeLibraryItems(data);
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('series');
    });

    it('extracts items from { result: { items: [...] } } shape', () => {
        const data = {
            result: {
                items: [{ _id: 'tt789', name: 'Nested' }],
            },
        };
        const items = normalizeLibraryItems(data);
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('tt789');
    });

    it('filters out removed items', () => {
        const data = {
            result: [
                { _id: 'tt1', name: 'Keep' },
                { _id: 'tt2', name: 'Gone', removed: true },
            ],
        };
        expect(normalizeLibraryItems(data)).toHaveLength(1);
    });

    it('filters out items without _id', () => {
        const data = { result: [{ name: 'No id' }, { _id: 'tt3', name: 'Has id' }] };
        expect(normalizeLibraryItems(data)).toHaveLength(1);
    });

    it('provides defaults for optional fields', () => {
        const data = { result: [{ _id: 'tt100' }] };
        const item = normalizeLibraryItems(data)[0];
        expect(item.type).toBe('movie');
        expect(item.name).toBe('tt100');
        expect(item.poster).toBe('');
        expect(item.posterShape).toBe('poster');
    });

    it('returns empty array for null/undefined', () => {
        expect(normalizeLibraryItems(null)).toEqual([]);
        expect(normalizeLibraryItems(undefined)).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildTimelineDiscontinuities
// ─────────────────────────────────────────────────────────────────────────────

describe('buildTimelineDiscontinuities', () => {
    it('detects forward timestamp gaps', () => {
        const packets = [
            { dts_time: '0.00', pts_time: '0.00' },
            { dts_time: '0.04', pts_time: '0.04' },
            { dts_time: '0.08', pts_time: '0.08' },
            { dts_time: '2.30', pts_time: '2.30' },
        ];
        const result = buildTimelineDiscontinuities(packets, { forwardGapSec: 0.9 });
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('forward-gap');
        expect(result[0].atSec).toBeCloseTo(0.08, 3);
        expect(result[0].resumeAtSec).toBeGreaterThan(2.30);
    });

    it('detects backward jumps', () => {
        const packets = [
            { dts_time: '9.20' },
            { dts_time: '9.24' },
            { dts_time: '8.10' },
        ];
        const result = buildTimelineDiscontinuities(packets);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('backward-jump');
        expect(result[0].deltaSec).toBeLessThan(0);
    });

    it('returns empty for monotonic packet sequence', () => {
        const packets = [
            { dts_time: '10.00' },
            { dts_time: '10.04' },
            { dts_time: '10.08' },
            { dts_time: '10.12' },
        ];
        expect(buildTimelineDiscontinuities(packets)).toEqual([]);
    });

    it('merges clustered anomalies into one hint', () => {
        const packets = [
            { dts_time: '15.00' },
            { dts_time: '15.04' },
            { dts_time: '15.60' }, // forward gap
            { dts_time: '15.20' }, // backward jump nearby
        ];
        const result = buildTimelineDiscontinuities(packets, { forwardGapSec: 0.4 });
        expect(result).toHaveLength(1);
        expect(result[0].atSec).toBeCloseTo(15.04, 2);
    });
});
