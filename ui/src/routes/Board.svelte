<script>
  import { onMount } from 'svelte';
  import { push }    from 'svelte-spa-router';
  import { addons, catalogRows, loadAddons } from '../stores/addons.js';
  import { authKey }  from '../stores/auth.js';
  import { getContinueItems } from '../stores/progress.js';
  import { getRecentlyPlayed } from '../lib/api.js';
  import HeroBanner   from '../components/HeroBanner.svelte';
  import CatalogRow   from '../components/CatalogRow.svelte';
  import MetaCard     from '../components/MetaCard.svelte';

  let continueItems  = [];
  let loadingContinue = true;
  let boardError = '';

  onMount(async () => {
    let syncedItems = [];
    try {
      if ($authKey && $catalogRows.length === 0) {
        await loadAddons($authKey);
      }
    } catch (e) {
      boardError = 'Failed to load content. ' + e.message;
    }

    try {
      if ($authKey) {
        const synced = await getRecentlyPlayed($authKey, 24);
        syncedItems = (synced.items || []).map(item => ({
          ...item,
          _progress: item?.state?.duration > 0
            ? Math.round(((item.state.timeOffset || 0) / item.state.duration) * 100)
            : 0,
        }));
      }
    } catch (_) {
      syncedItems = [];
    }

    const localItems = getContinueItems().map(item => ({
      ...item,
      id: item.videoId,
      name: item.name || item.videoId,
      _progress: item.duration > 0 ? Math.round((item.position / item.duration) * 100) : 0,
      updatedAt: item.updatedAt || 0,
    }));

    const merged = new Map();
    for (const item of [...syncedItems, ...localItems]) {
      const key = `${item.type || 'movie'}:${item.id || item.videoId || item.name}`;
      const prev = merged.get(key);
      const itemTime = new Date(item?.state?.lastWatched || item?.updatedAt || 0).getTime();
      const prevTime = prev
        ? new Date(prev?.state?.lastWatched || prev?.updatedAt || 0).getTime()
        : -1;
      if (!prev || itemTime >= prevTime) merged.set(key, item);
    }

    continueItems = [...merged.values()].sort((a, b) => {
      const at = new Date(a?.state?.lastWatched || a?.updatedAt || 0).getTime();
      const bt = new Date(b?.state?.lastWatched || b?.updatedAt || 0).getTime();
      return bt - at;
    }).slice(0, 24);

    loadingContinue = false;
  });

  function goToMeta(item) {
    push(`/meta/${item.type}/${item.id}`);
  }
</script>

<div class="board">
  <!-- Hero banner (uses first catalog row to source featured items) -->
  <HeroBanner addons={$addons} />

  <!-- My Library / Recently Played -->
  <div class="section">
    <h2 class="section-title">My Library · Recently Played</h2>
    {#if loadingContinue}
      <div class="library-empty">Loading recent activity…</div>
    {:else if continueItems.length > 0}
      <div class="card-grid continue-grid">
        {#each continueItems as item}
          <MetaCard
            meta={item}
            size="normal"
            defaultType={item.type || 'movie'}
            on:click={() => goToMeta(item)}
          />
        {/each}
      </div>
    {:else}
      <div class="library-empty">No recent playback yet. Start watching a title and it will appear here.</div>
    {/if}
  </div>

  <!-- Addon catalog rows -->
  {#if boardError}
    <div class="board-error">
      <p>{boardError}</p>
      <button class="retry-btn" data-focusable="true" on:click={() => loadAddons($authKey)}>Retry</button>
    </div>
  {:else}
    {#each $catalogRows as row}
      <CatalogRow
        {row}
      />
    {/each}

    {#if $catalogRows.length === 0}
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <h3>No content yet</h3>
        <p>Your add-on catalogs are loading, or no catalog add-ons are installed.</p>
        <p>Go to <strong>Settings</strong> to check your add-on configuration.</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .board {
    min-height: 100vh;
    padding-bottom: 60px;
  }

  .section {
    padding: 8px var(--page-x) 0;
  }

  .section-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: 14px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }

  .continue-grid {
    display: flex;
    gap: 14px;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 6px;
    scrollbar-width: none;
  }
  .continue-grid::-webkit-scrollbar { display: none; }

  .library-empty {
    padding: 14px 2px;
    color: var(--text-dim);
    font-size: 0.88rem;
  }

  .board-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 60px var(--page-x);
    color: var(--text-muted);
    text-align: center;
  }

  .retry-btn {
    padding: 10px 28px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-weight: 600;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 80px 24px;
    text-align: center;
    color: var(--text-dim);
  }

  .empty-icon {
    width: 80px; height: 80px;
    border-radius: 50%;
    background: var(--bg-surface);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 8px;
    color: var(--text-dim);
  }

  .empty-state h3 {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--text-muted);
  }

  .empty-state p {
    font-size: 0.9rem;
    max-width: 340px;
    line-height: 1.6;
  }
</style>
