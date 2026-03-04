/**
 * Stremio Add-on Protocol Client
 *
 * All requests are proxied through our backend to avoid CORS issues on TV browsers.
 * The add-on protocol spec: https://github.com/Stremio/stremio-addon-sdk
 */

const PROXY = '/api/addon-proxy?url=';

/** Proxy-wrap a full add-on URL. */
function proxy(url) {
    return PROXY + encodeURIComponent(url);
}

/** Build the base URL for an add-on from its transportUrl. */
function baseUrl(addon) {
    return addon.transportUrl.replace('/manifest.json', '');
}

function resolveManifest(addon) {
    if (!addon) return null;
    if (addon.manifest) return addon.manifest;
    if (addon.resources || addon.types || addon.catalogs || addon.id) return addon;
    return null;
}

/**
 * Fetch the manifest for an add-on URL.
 */
export async function fetchManifest(transportUrl) {
    const url = transportUrl.endsWith('/manifest.json')
        ? transportUrl
        : transportUrl + '/manifest.json';
    const res = await fetch(proxy(url));
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    const data = await res.json();
    return data;
}

/**
 * Fetch a catalog from an add-on.
 * @param {object} addon - Addon descriptor with transportUrl
 * @param {string} type  - Content type: 'movie', 'series', etc.
 * @param {string} id    - Catalog id
 * @param {object} extra - Extra params: { genre, search, skip }
 */
export async function fetchCatalog(addon, type, id, extra = {}) {
    const base = baseUrl(addon);
    let url = `${base}/catalog/${type}/${id}`;

    // Build extra path segment
    const extraParts = [];
    if (extra.search) extraParts.push(`search=${encodeURIComponent(extra.search)}`);
    if (extra.genre) extraParts.push(`genre=${encodeURIComponent(extra.genre)}`);
    if (extra.skip) extraParts.push(`skip=${extra.skip}`);

    if (extraParts.length) url += '/' + extraParts.join('&');
    url += '.json';

    const res = await fetch(proxy(url));
    if (!res.ok) {
        if (res.status === 404) return { metas: [] };
        throw new Error(`Catalog fetch failed: ${res.status}`);
    }
    return res.json(); // { metas: [...] }
}

/**
 * Fetch full meta details for an item.
 * @param {object} addon
 * @param {string} type  - 'movie' | 'series'
 * @param {string} id    - IMDB id or other id
 */
export async function fetchMeta(addon, type, id) {
    const url = `${baseUrl(addon)}/meta/${type}/${id}.json`;
    const res = await fetch(proxy(url));
    if (!res.ok) throw new Error(`Meta fetch failed: ${res.status}`);
    return res.json(); // { meta: {...} }
}

/**
 * Fetch streams for a video item.
 * @param {object} addon
 * @param {string} type    - 'movie' | 'series'
 * @param {string} videoId - For movies: IMDB id. For series: imdbId:season:episode
 */
export async function fetchStreams(addon, type, videoId) {
    const url = `${baseUrl(addon)}/stream/${type}/${videoId}.json`;
    const res = await fetch(proxy(url));
    if (!res.ok) {
        if (res.status === 404) return { streams: [] };
        throw new Error(`Streams fetch failed: ${res.status}`);
    }
    return res.json(); // { streams: [...] }
}

/**
 * Fetch subtitles for a video item.
 * @param {object} addon
 * @param {string} type    - 'movie' | 'series'
 * @param {string} videoId
 * @param {object} extra   - { videoHash, videoSize } for hash-based matching
 */
export async function fetchSubtitles(addon, type, videoId, extra = {}) {
    let url = `${baseUrl(addon)}/subtitles/${type}/${videoId}`;

    const extraParts = [];
    if (extra.videoHash) extraParts.push(`videoHash=${extra.videoHash}`);
    if (extra.videoSize) extraParts.push(`videoSize=${extra.videoSize}`);
    if (extraParts.length) url += '/' + extraParts.join('&');
    url += '.json';

    const res = await fetch(proxy(url));
    if (!res.ok) {
        if (res.status === 404) return { subtitles: [] };
        return { subtitles: [] };
    }
    return res.json(); // { subtitles: [...] }
}

/**
 * Collect catalogs from all add-ons that have catalog resources.
 * Returns an array of { addon, catalog, type, name }.
 */
export function getAddonCatalogs(addons) {
    const rows = [];
    for (const addon of addons) {
        const manifest = resolveManifest(addon);
        if (!manifest?.catalogs?.length) continue;
        // Check if addon has catalog resource
        const hasCatalog = !manifest.resources ||
            manifest.resources.includes('catalog') ||
            manifest.resources.some?.(r => r === 'catalog' || r?.name === 'catalog');
        if (!hasCatalog) continue;

        for (const cat of manifest.catalogs) {
            // Only include catalogs that don't require extra params (good for homepage)
            const hasRequiredExtra = cat.extra?.some?.(e => e.isRequired);
            if (!hasRequiredExtra) {
                rows.push({
                    addon,
                    catalogId: cat.id,
                    type: cat.type,
                    name: cat.name || `${manifest.name} – ${cat.type}`,
                    addonName: manifest.name,
                    supportsGenre: cat.extra?.some?.(e => e.name === 'genre') ?? false,
                    supportsSearch: cat.extra?.some?.(e => e.name === 'search') ?? false,
                    genres: cat.extra?.find?.(e => e.name === 'genre')?.options ?? [],
                });
            }
        }
    }
    return rows;
}

/**
 * Get all add-ons that can provide streams for a given type+id.
 */
export function getStreamAddons(addons, type, id) {
    return addons.filter(addon => {
        const manifest = resolveManifest(addon);
        if (!manifest) return false;

        const hasStream = !manifest.resources ||
            manifest.resources.includes('stream') ||
            manifest.resources.some?.(r => r === 'stream' || r?.name === 'stream');
        if (!hasStream) return false;

        // Type check
        if (manifest.types && !manifest.types.includes(type)) return false;

        // idPrefixes check
        if (manifest.idPrefixes && !manifest.idPrefixes.some(p => id.startsWith(p))) return false;

        return true;
    });
}

/**
 * Get all add-ons that can provide subtitles.
 */
export function getSubtitleAddons(addons, type, id) {
    return addons.filter(addon => {
        const manifest = resolveManifest(addon);
        if (!manifest) return false;
        const hasSubs = manifest.resources?.includes('subtitles') ||
            manifest.resources?.some?.(r => r === 'subtitles' || r?.name === 'subtitles');
        if (!hasSubs) return false;
        if (manifest.types && !manifest.types.includes(type)) return false;
        if (manifest.idPrefixes && !manifest.idPrefixes.some(p => id.startsWith(p))) return false;
        return true;
    });
}

/**
 * Get all add-ons that can provide meta.
 */
export function getMetaAddons(addons, type, id) {
    return addons.filter(addon => {
        const manifest = resolveManifest(addon);
        if (!manifest) return false;

        const resources = manifest.resources || [];
        const hasMeta = resources.includes('meta') ||
            resources.some?.(r => r === 'meta' || r?.name === 'meta');
        // Local addon & cinemeta always provide meta
        if (!hasMeta && manifest.id !== 'com.linvo.cinemeta') return false;

        if (manifest.types && !manifest.types.includes(type)) return false;
        if (manifest.idPrefixes && !manifest.idPrefixes.some(p => id.startsWith(p))) return false;
        return true;
    });
}

/**
 * Parse stream title/name for quality badges.
 * Returns { quality, source, title, seeds, peers, size }
 */
export function parseStreamInfo(stream) {
    const name = stream.name || stream.title || '';
    const desc = stream.description || stream.title || '';
    const combined = `${name} ${desc}`.toUpperCase();

    const quality =
        combined.includes('2160') || combined.includes('4K') || combined.includes('UHD') ? '4K' :
            combined.includes('1080') ? '1080p' :
                combined.includes('720') ? '720p' :
                    combined.includes('480') ? '480p' : '';

    const hdr =
        combined.includes('HDR10+') ? 'HDR10+' :
            combined.includes('HDR10') ? 'HDR10' :
                combined.includes('DOLBY VISION') || combined.includes('DV') ? 'DV' :
                    combined.includes('HDR') ? 'HDR' : '';

    const audio =
        combined.includes('ATMOS') ? 'Atmos' :
            combined.includes('DOLBY DIGITAL PLUS') ||
                combined.includes('EAC3') ? 'DD+' :
                combined.includes('DOLBY DIGITAL') ||
                    combined.includes('DD ') ? 'DD' :
                    combined.includes('DTS-HD') ? 'DTS-HD' :
                        combined.includes('DTS') ? 'DTS' :
                            combined.includes('AAC') ? 'AAC' : '';

    const codec =
        combined.includes('HEVC') || combined.includes('H.265') || combined.includes('X265') ? 'HEVC' :
            combined.includes('AVC') || combined.includes('H.264') || combined.includes('X264') ? 'AVC' :
                combined.includes('AV1') ? 'AV1' : '';

    // Extract seeds from description "👤 1234" pattern
    const seedMatch = desc.match(/👤\s*(\d+)/);
    const seeds = seedMatch ? parseInt(seedMatch[1]) : null;

    // Size extraction "💾 X.XX GB"
    const sizeMatch = desc.match(/💾\s*([\d.]+\s*(?:GB|MB))/i);
    const size = sizeMatch ? sizeMatch[1] : null;

    return { quality, hdr, audio, codec, seeds, size, name: stream.name || '', desc };
}
