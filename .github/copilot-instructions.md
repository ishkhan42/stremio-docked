Adhere to the following principles in **all** code within this repository:

## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One tack per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

---

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

---

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

# Project guidelines

## Big picture
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
