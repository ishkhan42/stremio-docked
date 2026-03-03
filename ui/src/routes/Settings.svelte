<script>
  import { get }    from 'svelte/store';
  import { push }   from 'svelte-spa-router';
  import { auth, currentUser } from '../stores/auth.js';
  import { prefs }  from '../stores/progress.js';
  import { addons as addonsStore, loadAddons } from '../stores/addons.js';
  import { authKey } from '../stores/auth.js';
  import { serverStatus } from '../lib/api.js';

  // ── Local editable prefs ──────────────────────────────────────────────────
  let localPrefs = { ...$prefs };
  let saved = false;
  let reloadMsg = '';

  // Server info
  let serverInfo = null;
  let checkingServer = false;

  // Addons
  let addonList = [];
  $: addonList = $addonsStore.map(a => ({ ...a, manifest: a.manifest || a }));

  async function checkServer() {
    checkingServer = true;
    try { serverInfo = await serverStatus(); }
    catch (e) { serverInfo = { error: e.message }; }
    finally { checkingServer = false; }
  }

  async function reloadAddons() {
    reloadMsg = 'Reloading…';
    try {
      await loadAddons($authKey);
      reloadMsg = '✓ Add-ons refreshed';
    } catch (e) {
      reloadMsg = 'Failed: ' + e.message;
    }
    setTimeout(() => reloadMsg = '', 3000);
  }

  function save() {
    prefs.update(p => ({ ...p, ...localPrefs }));
    saved = true;
    setTimeout(() => saved = false, 2200);
  }

  const QUALITY_OPTIONS = ['auto', '4k', '1080p', '720p', '480p'];
  const LANG_OPTIONS    = [
    { code: 'eng', label: 'English' },
    { code: 'spa', label: 'Spanish' },
    { code: 'por', label: 'Portuguese' },
    { code: 'fra', label: 'French' },
    { code: 'deu', label: 'German' },
    { code: 'ita', label: 'Italian' },
    { code: 'jpn', label: 'Japanese' },
    { code: 'kor', label: 'Korean' },
    { code: 'zho', label: 'Chinese' },
    { code: 'ara', label: 'Arabic' },
    { code: 'rus', label: 'Russian' },
    { code: 'hin', label: 'Hindi' },
    { code: 'nld', label: 'Dutch' },
    { code: 'tur', label: 'Turkish' },
    { code: 'pol', label: 'Polish' },
    { code: 'swe', label: 'Swedish' },
    { code: 'nor', label: 'Norwegian' },
    { code: 'dan', label: 'Danish' },
    { code: 'fin', label: 'Finnish' },
    { code: 'ces', label: 'Czech' },
  ];
</script>

<div class="settings-page">
  <div class="settings-wrap">
    <h1 class="page-title">Settings</h1>

    <!-- ── Account section ───────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2 class="section-title">Account</h2>
      <div class="card">
        <div class="account-row">
          <div class="avatar">
            {#if $currentUser?.avatar}
              <img src={$currentUser.avatar} alt="" />
            {:else}
              <span>{($currentUser?.email?.[0] || '?').toUpperCase()}</span>
            {/if}
          </div>
          <div class="account-info">
            <p class="account-email">{$currentUser?.email || 'Unknown'}</p>
            <p class="account-type">Stremio Account</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Playback preferences ──────────────────────────────────────────── -->
    <section class="settings-section">
      <h2 class="section-title">Playback</h2>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label">
            <span>Preferred Quality</span>
            <p>Stream quality to prioritize in the picker</p>
          </div>
          <select class="setting-select" bind:value={localPrefs.quality} data-focusable="true">
            {#each QUALITY_OPTIONS as q}
              <option value={q}>{q.toUpperCase()}</option>
            {/each}
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Preferred Audio Language</span>
            <p>Auto-select this audio track when available</p>
          </div>
          <select class="setting-select" bind:value={localPrefs.audioLanguage} data-focusable="true">
            {#each LANG_OPTIONS as l}
              <option value={l.code}>{l.label} ({l.code})</option>
            {/each}
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Preferred Subtitle Language</span>
            <p>Auto-select this subtitle track when available</p>
          </div>
          <select class="setting-select" bind:value={localPrefs.subtitleLanguage} data-focusable="true">
            <option value="">None / Off</option>
            {#each LANG_OPTIONS as l}
              <option value={l.code}>{l.label} ({l.code})</option>
            {/each}
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Subtitle Size</span>
            <p>Base font size for subtitles</p>
          </div>
          <select class="setting-select" bind:value={localPrefs.subtitleSize} data-focusable="true">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
            <option value="xlarge">Extra Large</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Auto-play Next Episode</span>
            <p>Automatically prompt next episode when one ends</p>
          </div>
          <label class="toggle" data-focusable="true">
            <input type="checkbox" bind:checked={localPrefs.autoPlayNext} />
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            <span>Default Volume</span>
            <p>Volume level on player start (0–100)</p>
          </div>
          <div class="volume-row">
            <input
              type="range"
              min="0" max="1" step="0.05"
              bind:value={localPrefs.volume}
              data-focusable="true"
            />
            <span class="vol-label">{Math.round((localPrefs.volume ?? 1) * 100)}%</span>
          </div>
        </div>

        <div class="setting-actions">
          <button
            class="btn-save"
            data-focusable="true"
            on:click={save}
          >
            {#if saved}✓ Saved{:else}Save Preferences{/if}
          </button>
        </div>
      </div>
    </section>

    <!-- ── Add-ons ─────────────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2 class="section-title">
        Add-ons
        <button class="btn-inline" data-focusable="true" on:click={reloadAddons}>
          {#if reloadMsg}{reloadMsg}{:else}Refresh{/if}
        </button>
      </h2>
      <div class="card addon-list">
        {#each addonList as addon}
          <div class="addon-row">
            <div class="addon-icon">
              {#if addon.manifest?.logo}
                <img src={addon.manifest.logo} alt="" />
              {:else}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                  <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
                </svg>
              {/if}
            </div>
            <div class="addon-info">
              <p class="addon-name">{addon.manifest?.name || addon.name || 'Unknown'}</p>
              <p class="addon-desc">{addon.manifest?.description || addon.description || ''}</p>
              <div class="addon-tags">
                {#each (addon.manifest?.types || addon.types || []) as t}
                  <span class="tag">{t}</span>
                {/each}
                {#if addon.manifest?.catalogs?.length}
                  <span class="tag tag-catalog">{addon.manifest.catalogs.length} catalog{addon.manifest.catalogs.length !== 1 ? 's':''}</span>
                {/if}
              </div>
            </div>
          </div>
        {:else}
          <p class="addon-empty">No add-ons loaded. <button class="btn-text" on:click={reloadAddons}>Refresh</button></p>
        {/each}
      </div>
    </section>

    <!-- ── Server ─────────────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2 class="section-title">
        Streaming Server
        <button class="btn-inline" data-focusable="true" on:click={checkServer} disabled={checkingServer}>
          {checkingServer ? 'Checking…' : 'Check Status'}
        </button>
      </h2>
      <div class="card">
        {#if serverInfo}
          {#if serverInfo.error}
            <p class="server-error">⚠ {serverInfo.error}</p>
          {:else}
            <div class="server-row"><span>Status</span><span class="server-ok">● Online</span></div>
            {#if serverInfo.version}<div class="server-row"><span>Version</span><span>{serverInfo.version}</span></div>{/if}
            {#if serverInfo.appVersion}<div class="server-row"><span>App Version</span><span>{serverInfo.appVersion}</span></div>{/if}
          {/if}
        {:else}
          <p class="server-hint">Click "Check Status" to query the streaming server.</p>
        {/if}
      </div>
    </section>

    <!-- ── About ───────────────────────────────────────────────────────────── -->
    <section class="settings-section">
      <h2 class="section-title">About</h2>
      <div class="card about-card">
        <p>Stremio TV — Lightweight TV UI for Stremio</p>
        <p class="about-note">This is an unofficial lightweight web interface designed for TV browsers. Streaming is powered by the official Stremio server.</p>
      </div>
    </section>
  </div>
</div>

<style>
  .settings-page {
    min-height: 100vh;
    padding-bottom: 80px;
  }

  .settings-wrap {
    max-width: 760px;
    margin: 0 auto;
    padding: 80px var(--page-x) 0;
  }

  .page-title {
    font-size: 2rem;
    font-weight: 900;
    margin-bottom: 40px;
  }

  /* ── Sections ─────────────────────────────────────────────────────────────── */
  .settings-section { margin-bottom: 36px; }

  .section-title {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    font-weight: 700;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .btn-inline {
    font-size: 0.78rem;
    padding: 4px 12px;
    background: var(--bg-surface);
    border-radius: 20px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    transition: all var(--transition);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
  }
  .btn-inline:hover { background: var(--bg-elevated); color: var(--text-primary); }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  /* ── Account ──────────────────────────────────────────────────────────────── */
  .account-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 20px 24px;
  }

  .avatar {
    width: 48px; height: 48px;
    border-radius: 50%;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    font-size: 1.2rem;
    font-weight: 700;
    overflow: hidden;
    flex-shrink: 0;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }

  .account-email { font-weight: 600; font-size: 0.95rem; }
  .account-type  { font-size: 0.78rem; color: var(--text-dim); margin-top: 2px; }

  /* ── Setting rows ─────────────────────────────────────────────────────────── */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
  }
  .setting-row:last-of-type { border-bottom: none; }

  .setting-label { flex: 1; }
  .setting-label span { font-size: 0.93rem; font-weight: 500; }
  .setting-label p { font-size: 0.78rem; color: var(--text-dim); margin-top: 2px; }

  .setting-select {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    padding: 8px 12px;
    font-size: 0.88rem;
    min-width: 160px;
    cursor: pointer;
  }
  .setting-select:focus { outline: none; border-color: var(--accent); }

  .volume-row { display: flex; align-items: center; gap: 10px; }
  .volume-row input { width: 120px; accent-color: var(--accent); }
  .vol-label { font-size: 0.82rem; color: var(--text-muted); min-width: 36px; text-align: right; }

  /* ── Toggle ──────────────────────────────────────────────────────────────── */
  .toggle { position: relative; display: inline-block; width: 48px; height: 26px; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-track {
    position: absolute; inset: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 26px;
    transition: background 200ms;
  }
  .toggle-track::after {
    content: '';
    position: absolute;
    top: 3px; left: 3px;
    width: 18px; height: 18px;
    background: var(--text-dim);
    border-radius: 50%;
    transition: transform 200ms, background 200ms;
  }
  .toggle input:checked + .toggle-track { background: var(--accent); border-color: var(--accent); }
  .toggle input:checked + .toggle-track::after { transform: translateX(22px); background: #fff; }

  .setting-actions {
    padding: 16px 24px;
    display: flex;
    justify-content: flex-end;
    border-top: 1px solid var(--border);
  }

  .btn-save {
    padding: 10px 28px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-weight: 600;
    font-size: 0.9rem;
    transition: all var(--transition);
    min-width: 160px;
  }
  .btn-save:hover, .btn-save.focused { background: var(--accent-light); }

  /* ── Add-ons ─────────────────────────────────────────────────────────────── */
  .addon-list { max-height: 480px; overflow-y: auto; }

  .addon-row {
    display: flex;
    gap: 14px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    align-items: flex-start;
  }
  .addon-row:last-child { border-bottom: none; }

  .addon-icon {
    width: 40px; height: 40px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .addon-icon img { width: 36px; height: 36px; object-fit: contain; }

  .addon-name { font-size: 0.9rem; font-weight: 600; }
  .addon-desc {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .addon-tags {
    display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px;
  }
  .tag {
    font-size: 0.68rem;
    padding: 2px 8px;
    background: var(--bg-elevated);
    border-radius: 3px;
    color: var(--text-dim);
    text-transform: capitalize;
  }
  .tag-catalog { background: rgba(124,58,237,0.15); color: var(--accent-light); }

  .addon-empty {
    padding: 32px;
    text-align: center;
    color: var(--text-dim);
    font-size: 0.9rem;
  }
  .btn-text { color: var(--accent-light); font-weight: 600; }

  /* ── Server ──────────────────────────────────────────────────────────────── */
  .server-row {
    display: flex;
    justify-content: space-between;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    font-size: 0.88rem;
    color: var(--text-muted);
  }
  .server-row:last-child { border-bottom: none; }
  .server-ok { color: #4ade80; font-weight: 600; }
  .server-error { padding: 16px 24px; color: #f87171; font-size: 0.88rem; }
  .server-hint { padding: 16px 24px; color: var(--text-dim); font-size: 0.88rem; }

  /* ── About ───────────────────────────────────────────────────────────────── */
  .about-card { padding: 20px 24px; }
  .about-card p { font-size: 0.9rem; font-weight: 500; }
  .about-note { color: var(--text-dim); font-size: 0.78rem; margin-top: 8px; line-height: 1.6; font-weight: 400; }
</style>
