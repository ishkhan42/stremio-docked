/**
 * TV / D-Pad Keyboard Navigation
 *
 * Handles spatial navigation for TV remote controls.
 * Any element with data-focusable="true" participates in the nav system.
 * Current focus is tracked via the "focused" CSS class.
 *
 * Usage:
 *   import { initNav, destroyNav, focusFirst } from './keyboard.js';
 *   onMount(initNav);
 *   onDestroy(destroyNav);
 */

// Key codes for various TV remotes / HID remote controls
const KEYS = {
    UP: [38, 'ArrowUp'],
    DOWN: [40, 'ArrowDown'],
    LEFT: [37, 'ArrowLeft'],
    RIGHT: [39, 'ArrowRight'],
    ENTER: [13, 'Enter'],
    BACK: [8, 27, 461, 10009, 'Backspace', 'Escape', 'GoBack'],
    PLAY: [415, 179, 'MediaPlayPause', 'MediaPlay'],
    PAUSE: [19, 179, 'MediaPlayPause', 'MediaPause'],
    STOP: [413, 'MediaStop'],
    FF: [417, 'MediaFastForward'],
    RW: [412, 'MediaRewind'],
    BACK_KEY: [461, 10009, 'GoBack', 'BrowserBack'],
};

function matchKey(e, group) {
    return KEYS[group].includes(e.keyCode) || KEYS[group].includes(e.key);
}

let _listeners = [];
let _enabled = false;

function focusableEls() {
    return Array.from(document.querySelectorAll('[data-focusable="true"]'))
        .filter(el => !el.hidden && el.offsetParent !== null);
}

function focusedEl() {
    return document.querySelector('[data-focusable="true"].focused');
}

function focusEl(el) {
    if (!el) return;
    // Remove focus from previous
    document.querySelectorAll('.focused').forEach(e => e.classList.remove('focused'));
    el.classList.add('focused');
    // For form controls, also give real browser focus so users can type
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        el.focus();
    }
    // Scroll into view smoothly
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

/** Focus the first focusable element in the document (or optional container). */
export function focusFirst(container = document) {
    const el = container.querySelector('[data-focusable="true"]');
    if (el) focusEl(el);
}

/** Focus a specific element by selector. */
export function focusSelector(selector) {
    const el = document.querySelector(selector);
    if (el) focusEl(el);
}

/** Focus a specific DOM element. */
export function focusElement(el) {
    if (el) focusEl(el);
}

/**
 * Spatial navigation: find the closest focusable element in direction dir.
 * Returns the nearest element or null.
 */
function findNearest(current, dir) {
    const els = focusableEls().filter(e => e !== current);
    if (!els.length) return null;

    const cr = current.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;

    let best = null;
    let bestScore = Infinity;

    for (const el of els) {
        const r = el.getBoundingClientRect();
        const ex = r.left + r.width / 2;
        const ey = r.top + r.height / 2;
        const dx = ex - cx;
        const dy = ey - cy;

        // Filter by direction
        const inDirection =
            dir === 'UP' && dy < -5 ||
            dir === 'DOWN' && dy > 5 ||
            dir === 'LEFT' && dx < -5 ||
            dir === 'RIGHT' && dx > 5;

        if (!inDirection) continue;

        // Score: weighted Manhattan distance favouring axis alignment
        let score;
        if (dir === 'UP' || dir === 'DOWN') {
            // Primary: vertical distance, Secondary: horizontal alignment
            score = Math.abs(dy) + Math.abs(dx) * 2.5;
        } else {
            // Primary: horizontal distance, Secondary: vertical alignment
            score = Math.abs(dx) + Math.abs(dy) * 2.5;
        }

        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }

    return best;
}

function onKeyDown(e) {
    if (!_enabled) return;

    const current = focusedEl();

    // ── Navigation keys ────────────────────────────────────────────────────
    let dir = null;
    if (matchKey(e, 'UP')) dir = 'UP';
    if (matchKey(e, 'DOWN')) dir = 'DOWN';
    if (matchKey(e, 'LEFT')) dir = 'LEFT';
    if (matchKey(e, 'RIGHT')) dir = 'RIGHT';

    if (dir) {
        e.preventDefault();
        if (!current) {
            focusFirst();
            return;
        }
        const target = findNearest(current, dir);
        if (target) focusEl(target);
        return;
    }

    // ── Enter / OK ─────────────────────────────────────────────────────────
    if (matchKey(e, 'ENTER')) {
        if (current) {
            e.preventDefault();
            current.click();
        }
        return;
    }

    // ── Back / Escape ──────────────────────────────────────────────────────
    if (matchKey(e, 'BACK')) {
        // Let the browser go back in SPA history (svelte-spa-router uses hash)
        if (window.history.length > 1) {
            e.preventDefault();
            window.history.back();
        }
        return;
    }

    // Media keys are handled by VideoPlayer directly – don't swallow them here
}

/** Call from onMount in the top-level player/nav page. */
export function initNav() {
    if (_enabled) return;
    _enabled = true;
    document.addEventListener('keydown', onKeyDown, { capture: true });
}

/** Call from onDestroy. */
export function destroyNav() {
    _enabled = false;
    document.removeEventListener('keydown', onKeyDown, { capture: true });
}

/** Temporarily disable navigation (e.g. while a modal is open). */
export function disableNav() { _enabled = false; }
export function enableNav() { _enabled = true; }

/** Check key helpers exposed so components can handle BACK etc. */
export { matchKey, KEYS };
