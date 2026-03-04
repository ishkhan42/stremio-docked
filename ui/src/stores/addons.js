import { writable, derived } from 'svelte/store';
import { get as storeGet } from 'svelte/store';
import { getAddons } from '../lib/api.js';
import { fetchManifest, getAddonCatalogs, getStreamAddons, getSubtitleAddons, getMetaAddons } from '../lib/addons.js';
import { authKey } from './auth.js';

export const addons = writable([]);
export const addonsLoading = writable(false);
export const addonsError = writable(null);
let loadInFlight = null;
let loadedKey = '';

function hasManifestLike(addon) {
    return !!(addon?.manifest || addon?.resources || addon?.types || addon?.catalogs || addon?.id);
}

async function hydrateAddon(addon) {
    if (!addon) return addon;
    if (addon.manifest) return addon;
    if (hasManifestLike(addon)) return { ...addon, manifest: addon.manifest || addon };
    if (!addon.transportUrl) return addon;

    try {
        const manifest = await fetchManifest(addon.transportUrl);
        return { ...addon, manifest };
    } catch {
        return addon;
    }
}

/** Fetch addon collection for the current user. */
export async function loadAddons(keyOverride, options = {}) {
    const key = keyOverride || storeGet(authKey);
    if (!key) return;

    const force = !!options?.force;
    if (!force && loadedKey === key && storeGet(addons).length > 0) {
        return storeGet(addons);
    }

    if (loadInFlight && !force) {
        return loadInFlight;
    }

    addonsLoading.set(true);
    addonsError.set(null);
    loadInFlight = (async () => {
        const list = await getAddons(key);
        const normalized = await Promise.all((list || []).map(hydrateAddon));
        addons.set(normalized || []);
        loadedKey = key;
        return normalized;
    })();

    try {
        return await loadInFlight;
    } catch (err) {
        addonsError.set(err.message);
        throw err;
    } finally {
        loadInFlight = null;
        addonsLoading.set(false);
    }
}

/** Derived: catalogs eligible for the home board */
export const catalogRows = derived(addons, $addons => getAddonCatalogs($addons));

/** Helper functions re-exported using current addons state */
export function streamAddons(type, id) {
    return getStreamAddons(storeGet(addons), type, id);
}

export function subtitleAddons(type, id) {
    return getSubtitleAddons(storeGet(addons), type, id);
}

export function metaAddons(type, id) {
    return getMetaAddons(storeGet(addons), type, id);
}
