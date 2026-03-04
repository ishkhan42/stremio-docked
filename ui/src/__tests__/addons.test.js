import { describe, it, expect } from 'vitest';
import { parseStreamInfo, getAddonCatalogs, getStreamAddons, getSubtitleAddons, getMetaAddons } from '../lib/addons.js';

// ── parseStreamInfo ──────────────────────────────────────────────────────────
describe('parseStreamInfo', () => {
    it('detects 4K from name', () => {
        const info = parseStreamInfo({ name: 'Torrentio', description: '4K UHD HDR DV' });
        expect(info.quality).toBe('4K');
        expect(info.hdr).toBe('DV');
    });

    it('detects 1080p from title', () => {
        const info = parseStreamInfo({ name: 'My Stream', description: 'BluRay 1080p x265 DTS-HD' });
        expect(info.quality).toBe('1080p');
        expect(info.codec).toBe('HEVC');
        expect(info.audio).toBe('DTS-HD');
    });

    it('detects 720p and AVC codec', () => {
        const info = parseStreamInfo({ name: '720p', description: 'WEB-DL H.264 AAC 👤 42 💾 1.2 GB' });
        expect(info.quality).toBe('720p');
        expect(info.codec).toBe('AVC');
        expect(info.audio).toBe('AAC');
        expect(info.seeds).toBe(42);
        expect(info.size).toBe('1.2 GB');
    });

    it('handles empty stream', () => {
        const info = parseStreamInfo({});
        expect(info.quality).toBe('');
        expect(info.hdr).toBe('');
        expect(info.audio).toBe('');
        expect(info.codec).toBe('');
        expect(info.seeds).toBeNull();
        expect(info.size).toBeNull();
    });

    it('detects HDR10+ and Dolby Atmos', () => {
        const info = parseStreamInfo({ name: 'Test', description: 'HDR10+ Atmos HEVC' });
        expect(info.hdr).toBe('HDR10+');
        expect(info.audio).toBe('Atmos');
        expect(info.codec).toBe('HEVC');
    });

    it('detects EAC3 as DD+', () => {
        const info = parseStreamInfo({ name: 'Torrentio', description: '1080p EAC3 x264' });
        expect(info.audio).toBe('DD+');
    });

    it('detects AV1 codec', () => {
        const info = parseStreamInfo({ name: '', description: 'AV1 720p' });
        expect(info.codec).toBe('AV1');
    });
});

// ── getAddonCatalogs ─────────────────────────────────────────────────────────
describe('getAddonCatalogs', () => {
    it('returns catalogs from addons with catalog resource', () => {
        const addons = [{
            transportUrl: 'https://example.com/manifest.json',
            manifest: {
                id: 'test',
                name: 'Test Addon',
                resources: ['catalog'],
                catalogs: [
                    { id: 'top', type: 'movie', name: 'Top Movies' },
                    { id: 'new', type: 'series', name: 'New Series' },
                ],
            },
        }];
        const rows = getAddonCatalogs(addons);
        expect(rows).toHaveLength(2);
        expect(rows[0].catalogId).toBe('top');
        expect(rows[0].type).toBe('movie');
        expect(rows[1].catalogId).toBe('new');
    });

    it('skips catalogs with required extra', () => {
        const addons = [{
            transportUrl: 'https://example.com/manifest.json',
            manifest: {
                id: 'test',
                name: 'Test',
                resources: ['catalog'],
                catalogs: [
                    { id: 'search', type: 'movie', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
                ],
            },
        }];
        expect(getAddonCatalogs(addons)).toHaveLength(0);
    });

    it('skips addons without catalog resource', () => {
        const addons = [{
            transportUrl: 'https://example.com/manifest.json',
            manifest: {
                id: 'test', name: 'StreamOnly',
                resources: ['stream'],
                catalogs: [{ id: 'movies', type: 'movie', name: 'Movies' }],
            },
        }];
        expect(getAddonCatalogs(addons)).toHaveLength(0);
    });
});

// ── getStreamAddons ──────────────────────────────────────────────────────────
describe('getStreamAddons', () => {
    const addons = [
        {
            transportUrl: 'https://torrentio.com/manifest.json',
            manifest: { id: 'torrentio', name: 'Torrentio', resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'] },
        },
        {
            transportUrl: 'https://other.com/manifest.json',
            manifest: { id: 'other', name: 'Other', resources: ['catalog'], types: ['movie'] },
        },
    ];

    it('finds stream addons for matching type/id', () => {
        expect(getStreamAddons(addons, 'movie', 'tt1234567')).toHaveLength(1);
        expect(getStreamAddons(addons, 'movie', 'tt1234567')[0].manifest.id).toBe('torrentio');
    });

    it('excludes non-stream addons', () => {
        expect(getStreamAddons(addons, 'movie', 'tt1234567')).toHaveLength(1);
    });

    it('excludes addons whose idPrefixes dont match', () => {
        expect(getStreamAddons(addons, 'movie', 'kitsu:1234')).toHaveLength(0);
    });
});

// ── getSubtitleAddons ────────────────────────────────────────────────────────
describe('getSubtitleAddons', () => {
    it('matches addons with subtitle resource', () => {
        const addons = [{
            transportUrl: 'https://subs.com/manifest.json',
            manifest: { id: 'subs', name: 'Subs', resources: ['subtitles'], types: ['movie', 'series'] },
        }];
        expect(getSubtitleAddons(addons, 'movie', 'tt9999')).toHaveLength(1);
    });
});

// ── getMetaAddons ────────────────────────────────────────────────────────────
describe('getMetaAddons', () => {
    it('matches cinemeta addon', () => {
        const addons = [{
            transportUrl: 'https://cinemeta.com/manifest.json',
            manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta', resources: ['meta', 'catalog'], types: ['movie', 'series'] },
        }];
        expect(getMetaAddons(addons, 'movie', 'tt1234567')).toHaveLength(1);
    });
});
