<script>
  import { onMount } from 'svelte';
  import { push, pop } from 'svelte-spa-router';
  import { addons, metaAddons, streamAddons, subtitleAddons, loadAddons } from '../stores/addons.js';
  import { authKey } from '../stores/auth.js';
  import { getProgress }  from '../stores/progress.js';

  import {
    fetchMeta,
    fetchStreams,
    fetchSubtitles,
  } from '../lib/addons.js';
  import { resolveStreamUrl, imageProxyUrl, getLibraryContains, addLibraryItem, removeLibraryItem } from '../lib/api.js';
  import { savePlayerState } from '../lib/storage.js';
  import EpisodeGrid    from '../components/EpisodeGrid.svelte';
  import StreamPicker   from '../components/StreamPicker.svelte';

  export let params = {};

  // ── Route params ─────────────────────────────────────────────────────────
  $: type = params.type;   // 'movie' | 'series'
  $: id   = params.id;     // e.g. 'tt1234567'

  // ── State ─────────────────────────────────────────────────────────────────
  let meta       = null;
  let loading    = true;
  let loadError  = '';

  // Streams
  let streams    = [];
  let loadingStreams = false;
  let showStreamPicker = false;

  // Episode selection (series)
  let selectedEpisode = null;  // { videoId, title, season, episode, thumbnail }

  // Build a map of episode videoId → progress % for EpisodeGrid
  $: watchedMap = (() => {
    if (!meta?.videos?.length) return {};
    const map = {};
    for (const v of meta.videos) {
      if (!v.id) continue;
      const prog = getProgress('series', v.id);
      if (prog?.duration > 0) {
        map[v.id] = Math.round((prog.position / prog.duration) * 100);
      }
    }
    return map;
  })();

  // Subtitles for stream
  let subtitles  = [];
  let inLibrary = false;
  let libraryBusy = false;

  // ── Fetch meta ─────────────────────────────────────────────────────────────
  // Use reactive statement only — avoids double-fetch from onMount + $:
  let lastFetchedKey = '';
  $: {
    const key = `${params.type}/${params.id}/${$authKey || ''}/${$addons.length}`;
    if (params.type && params.id && key !== lastFetchedKey) {
      lastFetchedKey = key;
      fetchMetaData();
    }
  }

  onMount(async () => {
    if ($authKey && $addons.length === 0) {
      await loadAddons($authKey).catch(() => {});
    }
  });

  async function fetchMetaData() {
    loading   = true;
    loadError = '';
    meta      = null;

    try {
      let mAddons = metaAddons(type, id);
      if (mAddons.length === 0 && $authKey) {
        await loadAddons($authKey);
        mAddons = metaAddons(type, id);
      }

      // Try each meta addon until we get a result
      for (const addon of mAddons) {
        try {
          const result = await fetchMeta(addon, type, id);
          if (result?.meta) { meta = result.meta; break; }
          if (result) { meta = result; break; }
        } catch (_) {}
      }

      if (!meta) {
        const fallback = await fetchCinemetaMeta(type, id);
        if (fallback) meta = fallback;
      }

      if (!meta) throw new Error('This title was not found in any of your add-ons.');

      await refreshLibraryStatus();
    } catch (e) {
      loadError = e.message;
    } finally {
      loading = false;
    }
  }

  async function refreshLibraryStatus() {
    if (!$authKey || !id) {
      inLibrary = false;
      return;
    }
    try {
      const check = await getLibraryContains($authKey, id, type || 'movie');
      inLibrary = !!check?.inLibrary;
    } catch {
      inLibrary = false;
    }
  }

  async function toggleLibrary() {
    if (!$authKey || !meta || libraryBusy) return;
    libraryBusy = true;
    try {
      if (inLibrary) {
        await removeLibraryItem($authKey, id, type || 'movie');
      } else {
        await addLibraryItem({
          authKey: $authKey,
          id,
          type: type || 'movie',
          name: meta?.name || '',
          poster: meta?.poster || '',
          background: meta?.background || '',
          year: meta?.year || '',
        });
      }
      await refreshLibraryStatus();
    } catch (err) {
      alert(`Library sync failed: ${err.message}`);
    } finally {
      libraryBusy = false;
    }
  }

  async function fetchCinemetaMeta(kind, mediaId) {
    try {
      const url = `https://v3-cinemeta.strem.io/meta/${kind}/${mediaId}.json`;
      const res = await fetch(`/api/addon-proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return null;
      const payload = await res.json();
      return payload?.meta || null;
    } catch {
      return null;
    }
  }

  // ── Streams ────────────────────────────────────────────────────────────────
  let streamReqSeq = 0;   // guards stale stream results

  async function openStreams(videoId) {
    streams = [];
    subtitles = [];
    loadingStreams = true;
    showStreamPicker = true;
    const seq = ++streamReqSeq;

    const sAddons  = streamAddons(type, videoId);
    const stAddons = subtitleAddons(type, videoId);

    // Parallel: streams from all stream addons
    const streamResults = await Promise.allSettled(
      sAddons.map(a => fetchStreams(a, type, videoId))
    );
    if (seq !== streamReqSeq) return; // stale — user selected another episode
    streams = streamResults
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value?.streams))
      .flatMap(r => r.value.streams);

    // Parallel: subtitles from all subtitle addons
    const subResults = await Promise.allSettled(
      stAddons.map(a => fetchSubtitles(a, type, videoId, {}))
    );
    if (seq !== streamReqSeq) return;
    subtitles = subResults
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value?.subtitles))
      .flatMap(r => r.value.subtitles);

    loadingStreams = false;
  }

  async function handlePlayMovie() {
    openStreams(id);
  }

  async function handleEpisodeSelect(e) {
    selectedEpisode = e.detail;
    openStreams(e.detail.id);
  }

  async function handleStreamSelect(e) {
    const stream = e.detail;
    showStreamPicker = false;

    // Resolve stream URL through backend
    let resolved;
    try {
      resolved = await resolveStreamUrl(stream, window.location.origin);
    } catch (err) {
      alert('Failed to resolve stream URL: ' + err.message);
      return;
    }

    // Get resume position
    const vidId = selectedEpisode ? selectedEpisode.id : id;
    const prog  = getProgress(type, vidId);

    // Navigate to player with history state
    const playerState = {
      streamUrl:      resolved.url    || '',
      directUrl:      resolved.url    || '',
      hlsUrl:         resolved.hlsUrl || '',
      infoHash:       resolved.infoHash || '',
      fileIdx:        resolved.fileIdx ?? 0,
      streamType:     resolved.type   || 'http',
      title:          selectedEpisode
        ? `${meta?.name} – S${selectedEpisode.season}E${selectedEpisode.episode || selectedEpisode.number || '?'} ${selectedEpisode.title || selectedEpisode.name || ''}`
        : (meta?.name || ''),
      metaName:       meta?.name || '',
      metaPoster:     meta?.poster || '',
      type,
      metaId:         id,
      videoId:        vidId,
      resumePos:      prog?.position || 0,
      subtitleTracks: subtitles.map(s => ({
        lang:  s.lang || s.id || 'und',
        label: s.lang || s.id || 'Unknown',
        url:   s.url,
      })),
      hasNext: !!(selectedEpisode && nextEpisodeId(selectedEpisode)),
      nextEpisodeId: nextEpisodeId(selectedEpisode),
    };

    // Pass state via history API, then navigate
    savePlayerState(playerState);
    history.pushState(playerState, '');
    push('/player');
  }

  function nextEpisodeId(ep) {
    if (!ep || !meta?.videos) return null;
    const vids = meta.videos.filter(v => v.season === ep.season);
    const idx  = vids.findIndex(v => v.episode === ep.episode || v.number === ep.number || v.id === ep.id);
    if (idx >= 0 && idx < vids.length - 1) return vids[idx + 1].id;
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function formatRuntime(r) {
    if (!r) return '';
    if (typeof r === 'number') return `${Math.floor(r/60)}h ${r%60}m`;
    return r;
  }

  function fmtGenres(genres) {
    if (!genres?.length) return '';
    return genres.slice(0, 4).join(' · ');
  }
</script>

<div class="meta-page">
  <!-- Back button (fixed) -->
  <button class="back-btn" data-focusable="true" on:click={pop}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
    Back
  </button>

  {#if loading}
    <div class="loading-state">
      <div class="spinner-large"></div>
      <p>Loading…</p>
    </div>
  {:else if loadError}
    <div class="error-state">
      <p>{loadError}</p>
      <button data-focusable="true" class="retry-btn" on:click={fetchMetaData}>Retry</button>
    </div>
  {:else if meta}
    <!-- Backdrop -->
    <div class="backdrop-wrap">
      {#if meta.background || meta.poster}
        <img
          class="backdrop-img"
          src={imageProxyUrl(meta.background || meta.poster)}
          alt=""
        />
      {/if}
      <div class="backdrop-overlay"></div>
    </div>

    <!-- Hero info section -->
    <div class="hero-section">
      <div class="poster-col">
        {#if meta.poster}
          <img class="poster" src={imageProxyUrl(meta.poster)} alt={meta.name} />
        {:else}
          <div class="poster-placeholder">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
        {/if}
      </div>

      <div class="info-col">
        <h1 class="title">{meta.name}</h1>

        <!-- Meta row: year · runtime · rating · genres -->
        <div class="meta-row">
          {#if meta.year}      <span class="meta-tag">{meta.year}</span>{/if}
          {#if meta.runtime}   <span class="meta-tag">{formatRuntime(meta.runtime)}</span>{/if}
          {#if meta.imdbRating}<span class="meta-tag imdb">⭐ {meta.imdbRating}</span>{/if}
          {#if meta.certification}<span class="meta-tag cert">{meta.certification}</span>{/if}
        </div>

        {#if meta.genres?.length}
          <p class="genres">{fmtGenres(meta.genres)}</p>
        {/if}

        {#if meta.description}
          <p class="description">{meta.description}</p>
        {/if}

        {#if meta.cast?.length}
          <div class="cast">
            <span class="cast-label">Cast: </span>
            {meta.cast.slice(0, 5).join(', ')}
          </div>
        {/if}

        {#if meta.director?.length}
          <div class="cast">
            <span class="cast-label">Director: </span>
            {Array.isArray(meta.director) ? meta.director.join(', ') : meta.director}
          </div>
        {/if}

        <!-- Action buttons -->
        <div class="action-row">
          {#if type === 'movie'}
            <button class="btn-primary" data-focusable="true" on:click={handlePlayMovie}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Play
            </button>
          {:else}
            <!-- For series, there's an episode browser below -->
            <span class="series-hint">Select an episode below</span>
          {/if}

          <button
            class="btn-secondary"
            data-focusable="true"
            disabled={libraryBusy}
            on:click={toggleLibrary}
          >
            {libraryBusy ? 'Syncing…' : inLibrary ? 'Remove from Library' : 'Add to Library'}
          </button>

          <!-- Resume button if progress exists -->
          {#if type === 'movie'}
            {#if getProgress('movie', id)?.position > 30}
              <button
                class="btn-secondary"
                data-focusable="true"
                on:click={() => { handlePlayMovie(); }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Resume {Math.floor(getProgress('movie', id)?.position / 60)}m
              </button>
            {/if}
          {/if}
        </div>
      </div>
    </div>

    <!-- Series: episode browser -->
    {#if type === 'series' && meta.videos?.length}
      <div class="episodes-section">
        <EpisodeGrid
          videos={meta.videos}
          watchedMap={watchedMap}
          title={meta.name}
          on:select={handleEpisodeSelect}
        />
      </div>
    {/if}
  {/if}

  <!-- Stream picker modal -->
  {#if showStreamPicker}
    <div class="modal-overlay" on:click|self={() => showStreamPicker = false} role="dialog">
      <div class="modal-box">
        <StreamPicker
          streams={streams}
          loading={loadingStreams}
          title={selectedEpisode
            ? `S${selectedEpisode.season}E${selectedEpisode.number} – ${selectedEpisode.title || 'Episode'}`
            : (meta?.name || '')}
          on:select={handleStreamSelect}
          on:close={() => showStreamPicker = false}
        />
      </div>
    </div>
  {/if}
</div>

<style>
  .meta-page {
    position: relative;
    min-height: 100vh;
    background: var(--bg-primary);
    overflow-x: hidden;
  }

  /* ── Back ─────────────────────────────────────────────────────────────────── */
  .back-btn {
    position: fixed;
    top: 80px;
    left: var(--page-x);
    display: flex;
    align-items: center;
    gap: 6px;
    color: rgba(255,255,255,0.7);
    font-size: 0.9rem;
    font-weight: 500;
    z-index: 50;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: rgba(0,0,0,0.4);
    backdrop-filter: blur(6px);
    transition: all var(--transition);
  }
  .back-btn:hover, .back-btn.focused { color: #fff; background: rgba(0,0,0,0.7); }

  /* ── Backdrop ─────────────────────────────────────────────────────────────── */
  .backdrop-wrap {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
  }

  .backdrop-img {
    width: 100%; height: 100%;
    object-fit: cover;
    object-position: center top;
    filter: blur(2px) brightness(0.35);
    transform: scale(1.05);
  }

  .backdrop-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgba(10,10,15,0.4) 0%,
      rgba(10,10,15,0.65) 50%,
      rgba(10,10,15,1) 100%
    );
  }

  /* ── Hero section ─────────────────────────────────────────────────────────── */
  .hero-section {
    position: relative;
    z-index: 1;
    display: flex;
    gap: 40px;
    padding: 100px var(--page-x) 48px;
    align-items: flex-start;
  }

  .poster-col { flex-shrink: 0; }

  .poster {
    width: 200px;
    border-radius: var(--radius);
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    display: block;
  }

  .poster-placeholder {
    width: 200px; height: 300px;
    background: var(--bg-surface);
    border-radius: var(--radius);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-dim);
  }

  .info-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 16px;
  }

  .title {
    font-size: 2.4rem;
    font-weight: 900;
    letter-spacing: -0.5px;
    line-height: 1.1;
  }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .meta-tag {
    padding: 3px 10px;
    background: rgba(255,255,255,0.1);
    border-radius: 4px;
    font-size: 0.82rem;
    color: rgba(255,255,255,0.75);
    font-weight: 500;
  }

  .meta-tag.imdb { background: rgba(245,197,24,0.15); color: #f5c518; }
  .meta-tag.cert { border: 1px solid rgba(255,255,255,0.25); background: transparent; }

  .genres {
    font-size: 0.88rem;
    color: var(--accent-light);
    font-weight: 500;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.93rem;
    line-height: 1.65;
    max-width: 600px;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .cast {
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .cast-label { color: var(--text-muted); font-weight: 600; }

  .action-row {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .btn-primary {
    display: flex; align-items: center; gap: 8px;
    padding: 14px 32px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-size: 1rem;
    font-weight: 700;
    transition: all var(--transition);
  }
  .btn-primary:hover, .btn-primary.focused {
    background: var(--accent-light);
    transform: translateY(-1px);
    box-shadow: 0 6px 24px rgba(124,58,237,0.4);
  }

  .btn-secondary {
    display: flex; align-items: center; gap: 8px;
    padding: 14px 24px;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: var(--radius-sm);
    color: rgba(255,255,255,0.85);
    font-size: 0.92rem;
    font-weight: 600;
    transition: all var(--transition);
  }
  .btn-secondary:hover, .btn-secondary.focused { background: rgba(255,255,255,0.18); }

  .series-hint {
    color: var(--text-dim);
    font-size: 0.88rem;
    font-style: italic;
  }

  /* ── Episodes ─────────────────────────────────────────────────────────────── */
  .episodes-section {
    position: relative;
    z-index: 1;
    padding: 0 0 80px;
  }

  /* ── Modal ──────────────────────────────────────────────────────────────────── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    backdrop-filter: blur(4px);
    padding: 24px;
  }

  .modal-box {
    width: 100%;
    max-width: 700px;
    max-height: 85vh;
    overflow-y: auto;
    border-radius: var(--radius);
  }

  /* ── Loading / Error ─────────────────────────────────────────────────────────── */
  .loading-state, .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    min-height: 60vh;
    color: var(--text-muted);
  }

  .spinner-large {
    width: 40px; height: 40px;
    border: 3px solid var(--bg-surface);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .retry-btn {
    padding: 10px 28px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-weight: 600;
  }

  /* ── TV-scale ────────────────────────────────────────────────── */
  @media (min-width: 960px) {
    .hero-section  { gap: 48px; padding: 110px var(--page-x) 52px; }
    .poster        { width: 230px; }
    .poster-placeholder { width: 230px; height: 345px; }
    .title         { font-size: 2.8rem; }
    .meta-tag      { font-size: 0.9rem; padding: 4px 12px; }
    .genres        { font-size: 0.95rem; }
    .description   { font-size: 1rem; max-width: 650px; }
    .cast          { font-size: 0.88rem; }
    .btn-primary   { font-size: 1.08rem; padding: 15px 36px; }
    .btn-secondary { font-size: 1rem; padding: 15px 28px; }
    .back-btn      { font-size: 0.95rem; padding: 10px 14px; }
    .modal-box     { max-width: 780px; }
  }
</style>
