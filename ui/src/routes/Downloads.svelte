<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { getDownloads, deleteDownload } from '../lib/api.js';
  import { imageProxyUrl } from '../lib/api.js';
  import { savePlayerState } from '../lib/storage.js';

  let items = [];
  let loading = true;
  let error = '';
  let refreshTimer;

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const scaled = value / (1024 ** idx);
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[idx]}`;
  }

  function formatRate(bps) {
    const value = Number(bps || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B/s';
    return `${formatBytes(value)}/s`;
  }

  function progressOf(item) {
    if (item.progress != null && Number.isFinite(item.progress)) return Math.max(0, Math.min(100, item.progress));
    if (item.totalBytes > 0) return Math.max(0, Math.min(100, (item.bytesDownloaded / item.totalBytes) * 100));
    return 0;
  }

  async function load() {
    try {
      const res = await getDownloads();
      items = res.items || [];
      error = '';
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function removeItem(item) {
    if (!item?.id) return;
    try {
      await deleteDownload(item.id);
      await load();
    } catch (err) {
      error = err.message;
    }
  }

  function formatDate(ts) {
    const d = Number(ts || 0);
    if (!d) return 'Unknown';
    return new Date(d).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function shortHash(hash = '') {
    if (!hash) return '';
    if (hash.length < 14) return hash;
    return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
  }

  function isPlayable(item) {
    return !!item?.infoHash && Number.isInteger(Number(item?.fileIdx));
  }

  function playItem(item) {
    if (!isPlayable(item)) return;
    const infoHash = String(item.infoHash || '').toLowerCase();
    const fileIdx = Number(item.fileIdx || 0);
    const state = {
      streamUrl: `/ss/${infoHash}/${fileIdx}`,
      directUrl: `/ss/${infoHash}/${fileIdx}`,
      hlsUrl: `/ss/${infoHash}/${fileIdx}/master.m3u8`,
      infoHash,
      fileIdx,
      streamType: 'torrent',
      title: item.title || item.metaName || item.videoId || 'Downloaded stream',
      metaName: item.metaName || item.title || '',
      metaPoster: item.metaPoster || '',
      type: item.type || 'movie',
      videoId: item.videoId || `${item.type || 'movie'}:${infoHash}:${fileIdx}`,
      resumePos: 0,
      subtitleTracks: [],
      hasNext: false,
      nextEpisodeId: null,
    };

    savePlayerState(state);
    history.pushState(state, '');
    push('/player');
  }

  $: hasActive = items.some(i => i.status === 'starting' || i.status === 'running');

  onMount(async () => {
    await load();
    refreshTimer = setInterval(() => {
      if (hasActive) load();
    }, 3000);
  });

  onDestroy(() => {
    clearInterval(refreshTimer);
  });
</script>

<div class="downloads-page">
  <div class="downloads-wrap">
    <div class="header-row">
      <h1 class="page-title">Downloads</h1>
      <button class="btn-refresh" data-focusable="true" on:click={load}>Refresh</button>
    </div>

    {#if loading}
      <p class="state-text">Loading downloads…</p>
    {:else if error}
      <p class="state-text error">{error}</p>
    {:else if items.length === 0}
      <p class="state-text">No downloaded streams yet. Use "Download" in the player to start one.</p>
    {:else}
      <div class="list">
        {#each items as item}
          {@const p = progressOf(item)}
          <article class="download-card">
            <div class="top">
              <div class="poster-wrap">
                {#if item.metaPoster}
                  <img class="poster" src={imageProxyUrl(item.metaPoster)} alt={item.metaName || item.title || 'Poster'} />
                {:else}
                  <div class="poster-fallback">No
                    <span>Poster</span>
                  </div>
                {/if}
              </div>

              <div>
                <h2 class="name">{item.metaName || item.title || item.videoId || item.id}</h2>
                <p class="meta">{item.type || 'video'} · {item.status || 'unknown'} · File {item.fileIdx ?? 0}</p>
                <p class="meta small">{item.videoId || 'Unknown ID'}</p>
                <p class="meta small">Hash {shortHash(item.infoHash)}</p>
                <p class="meta small">Updated {formatDate(item.updatedAt)}</p>
              </div>
              <div class="actions">
                <button
                  class="btn-play"
                  data-focusable="true"
                  disabled={!isPlayable(item)}
                  on:click={() => playItem(item)}
                >
                  Play
                </button>
                <button class="btn-delete" data-focusable="true" on:click={() => removeItem(item)}>
                  Delete
                </button>
              </div>
            </div>

            <div class="progress-wrap">
              <div class="bar"><div class="fill" style="width:{p}%"></div></div>
              <div class="stats">
                <span>{Math.round(p)}% · {formatBytes(item.bytesDownloaded)}{item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}</span>
                <span>{formatRate(item.speedBps)}</span>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .downloads-page { min-height: 100vh; padding-bottom: 80px; }
  .downloads-wrap { max-width: 860px; margin: 0 auto; padding: 80px var(--page-x) 0; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 24px; }
  .page-title { font-size: 2rem; font-weight: 900; }

  .btn-refresh {
    padding: 8px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .btn-refresh:hover { color: var(--text-primary); background: var(--bg-elevated); }

  .state-text { color: var(--text-dim); font-size: 0.92rem; }
  .state-text.error { color: var(--red); }

  .list { display: flex; flex-direction: column; gap: 12px; }
  .download-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }

  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
  .poster-wrap {
    width: 74px;
    min-width: 74px;
    height: 108px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .poster {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .poster-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    color: var(--text-dim);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    line-height: 1.2;
  }
  .poster-fallback span { font-size: 0.62rem; }

  .name { font-size: 0.98rem; font-weight: 700; line-height: 1.3; }
  .meta { color: var(--text-dim); font-size: 0.8rem; margin-top: 2px; }
  .meta.small { font-size: 0.74rem; }

  .actions {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .btn-play {
    padding: 7px 14px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    font-size: 0.8rem;
    font-weight: 700;
    min-width: 82px;
  }
  .btn-play:hover { background: var(--accent-light); }
  .btn-play:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-delete {
    padding: 7px 12px;
    border-radius: var(--radius-sm);
    background: rgba(239, 68, 68, 0.12);
    color: #fca5a5;
    font-size: 0.8rem;
    font-weight: 600;
  }

  .progress-wrap { margin-top: 12px; }
  .bar { height: 7px; border-radius: 99px; background: var(--bg-surface); overflow: hidden; }
  .fill { height: 100%; background: var(--accent-light); }
  .stats {
    margin-top: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>
