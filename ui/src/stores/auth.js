import { writable, derived } from 'svelte/store';
import { loadAuth, saveAuth, clearAuth } from '../lib/storage.js';

function createAuthStore() {
    const saved = loadAuth();
    const { subscribe, set, update } = writable(saved);

    return {
        subscribe,
        login(authKey, user) {
            const val = { authKey, user };
            saveAuth(authKey, user);
            set(val);
        },
        logout() {
            clearAuth();
            set(null);
        },
    };
}

export const auth = createAuthStore();
export const isLoggedIn = derived(auth, $auth => !!$auth?.authKey);
export const authKey = derived(auth, $auth => $auth?.authKey ?? null);
export const currentUser = derived(auth, $auth => $auth?.user ?? null);
