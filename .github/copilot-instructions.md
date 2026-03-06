# Copilot Instructions for `stremio-docked`

## Big picture (read this first)
- This repo is a **single-container stack**: Nginx + Express backend + `stremio-server` binary + built Svelte UI.
- Runtime wiring is defined by `entrypoint.sh` and `nginx/default.conf`:
  - Browser UI served by Nginx on `:8080`
  - UI calls backend under `/api/*` (Nginx rewrites to backend `:3001`)
  - Backend and UI access `stremio-server` via `/ss/*` (Nginx rewrites to `:11470`)
- Primary design goal is **TV browser reliability** (CORS bypass, subtitle conversion, robust stream startup/fallbacks).

## Service boundaries and data flow
- UI never calls Stremio APIs directly; it calls `ui/src/lib/api.js` (`BASE = '/api'`).
- Backend (`backend/index.js`) is the only component that talks to:
  - `https://api.strem.io` (auth, addons, library)
  - Add-on manifests/catalog/meta/stream URLs via `/addon-proxy`
  - Local `stremio-server` (`STREMIO_SERVER_URL`, default `http://127.0.0.1:11470`)
- Stream URL normalization logic lives in `backend/utils.js` (`normalizeStreamUrl`, `extractHashFileFromPath`). Reuse these before adding new URL rules.

## Developer workflows
- Local npm/nodejs commands are not allowed. Use Docker for all local build/test/development to ensure environment parity.
- Full stack (recommended): `docker compose up -d --build` from repo root.
- UI local dev: `cd ui && npm install && npm run dev` (Vite proxies `/api`→`3001`, `/ss`→`11470` in `ui/vite.config.js`).
- Backend local dev: `cd backend && npm install && npm run dev`.
- Tests:
  - UI tests: `cd ui && npm test`
  - Backend tests (from repo root): `npx vitest run --config vitest.backend.config.js`

## Repo-specific coding patterns
- Backend is CommonJS; UI is ESM/Svelte. Match the existing module style per folder.
- Backend routes are **flat and explicit** in `backend/index.js` (no controller layer). Keep new endpoints close to related route groups.
- CORS and proxy safety are deliberate:
  - `/addon-proxy`, `/subtitle-proxy`, `/image-proxy` allow only `http/https` URLs.
  - Preserve this validation when extending proxy endpoints.
- Playback resilience patterns to preserve:
  - `/stream-url` returns both direct and HLS candidates when possible.
  - `/audio-switch-url` uses copy-first ffmpeg remux, then AAC fallback.
  - `/stream-prefetch/*` supports prefetch + persistent download tracking.
- UI state is store-driven (`ui/src/stores/*`) with persistent localStorage helpers in `ui/src/lib/storage.js` using `stremio_docked_` key prefix.
- TV remote navigation depends on `data-focusable="true"` + `.focused` class and `ui/src/lib/keyboard.js`. New interactive UI elements should opt into this.

## Integration points that often break
- Nginx location precedence for stream paths (`/^\/[a-f0-9]{40}\//`, `/ss/`, `/api/`) is critical; avoid conflicting route additions.
- `stremio-server` config persistence uses `/root/.stremio-server/server.js.localStorage` and seeded `server-localStorage.json` on first run.
- Download metadata index is persisted at `/root/.stremio-server/stremio-docked-downloads.json`; keep schema-compatible changes minimal.

## Change strategy for agents
- Prefer minimal, surgical changes in the existing file layout (do not introduce abstractions unless repeated pain is obvious).
- When touching stream/proxy behavior, verify both Docker runtime path (`/api`, `/ss`) and local Vite proxy behavior.
- Add/update tests alongside utility logic changes (`backend/__tests__/utils.test.js`, `ui/src/__tests__/addons.test.js`).
