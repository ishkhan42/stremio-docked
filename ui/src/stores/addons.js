import { writable, derived } from 'svelte/store';
import { get as storeGet } from 'svelte/store';
import { getAddons } from '../lib/api.js';
import { getAddonCatalogs, getStreamAddons, getSubtitleAddons, getMetaAddons } from '../lib/addons.js';
import { authKey } from './auth.js';

export const addons = writable([]);
export const addonsLoading = writable(false);
export const addonsError = writable(null);

/** Fetch addon collection for the current user. */
export async function loadAddons(keyOverride) {
    const key = keyOverride || storeGet(authKey);
    if (!key) return;
    addonsLoading.set(true);
    addonsError.set(null);
    try {
        const list = await getAddons(key);
        addons.set(list || []);
    } catch (err) {
        addonsError.set(err.message);
    } finally {
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
