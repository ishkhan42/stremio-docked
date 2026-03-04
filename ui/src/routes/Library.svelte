<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { authKey } from '../stores/auth.js';
  import { getLibrary } from '../lib/api.js';
  import MetaCard from '../components/MetaCard.svelte';

  let loading = true;
  let error = '';
  let items = [];
  let groupBy = 'type';
  let sortBy = 'updated';
  let sortOrder = 'desc';
  let statusFilter = 'all';

  $: filteredItems = statusFilter === 'all'
    ? items
    : items.filter(item => watchStatus(item) === statusFilter);

  $: sortedItems = [...filteredItems].sort((a, b) => {
    const dir = sortOrder === 'asc' ? 1 : -1;
    const av = sortValue(a, sortBy);
    const bv = sortValue(b, sortBy);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  $: grouped = groupItems(sortedItems, groupBy);

  onMount(async () => {
    await loadLibrary();
  });

  async function loadLibrary() {
    loading = true;
    error = '';

    try {
      if (!$authKey) throw new Error('Not authenticated');
      const response = await getLibrary($authKey, { limit: 500 });
      items = response.items || [];
    } catch (err) {
      error = err.message || 'Failed to load library';
    } finally {
      loading = false;
    }
  }

  function goToMeta(item) {
    push(`/meta/${item.type || 'movie'}/${item.id}`);
  }

  function sortValue(item, mode) {
    if (mode === 'name') return String(item?.name || '').toLowerCase();
    if (mode === 'year') return Number(item?.year || 0);
    if (mode === 'progress') return progressPct(item);
    return new Date(item?.updatedAt || item?.state?.lastWatched || 0).getTime();
  }

  function progressPct(item) {
    const duration = Number(item?.state?.duration || 0);
    const offset = Number(item?.state?.timeOffset || 0);
    if (!duration || duration <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((offset / duration) * 100)));
  }

  function watchStatus(item) {
    const pct = progressPct(item);
    const flagged = Number(item?.state?.flaggedWatched || 0) > 0;
    const timesWatched = Number(item?.state?.timesWatched || 0);

    if (flagged || timesWatched > 0 || pct >= 92) return 'watched';
    if (pct > 0) return 'partial';
    return 'unwatched';
  }

  function statusLabel(item) {
    const status = watchStatus(item);
    if (status === 'watched') return 'Watched';
    if (status === 'partial') return `In progress · ${progressPct(item)}%`;
    return 'Unwatched';
  }

  function episodeLabel(item) {
    if (item?.type !== 'series') return '';
    const season = Number(item?.state?.season || 0);
    const episode = Number(item?.state?.episode || 0);
    if (season > 0 && episode > 0) return `Last: S${season}E${episode}`;
    return '';
  }

  function groupKey(item, mode) {
    if (mode === 'status') {
      const status = watchStatus(item);
      if (status === 'watched') return 'Watched';
      if (status === 'partial') return 'In Progress';
      return 'Unwatched';
    }
    if (mode === 'year') {
      return item?.year ? String(item.year) : 'Unknown Year';
    }
    if (mode === 'none') {
      return 'All Items';
    }
    if (item?.type === 'movie') return 'Movies';
    if (item?.type === 'series') return 'Series';
    return 'Other';
  }

  function groupItems(list, mode) {
    const map = new Map();
    for (const item of list) {
      const key = groupKey(item, mode);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return [...map.entries()];
  }
</script>

<div class="library-page">
  <div class="library-header">
    <h1>My Library</h1>
    <p>Synced from your Stremio account</p>
  </div>

  <div class="toolbar">
    <label>Group
      <select bind:value={groupBy} data-focusable="true">
        <option value="type">By Type</option>
        <option value="status">By Status</option>
        <option value="year">By Year</option>
        <option value="none">Single Group</option>
      </select>
    </label>
    <label>Sort
      <select bind:value={sortBy} data-focusable="true">
        <option value="updated">Recently Updated</option>
        <option value="name">Name</option>
        <option value="year">Year</option>
        <option value="progress">Progress</option>
      </select>
    </label>
    <label>Order
      <select bind:value={sortOrder} data-focusable="true">
        <option value="desc">Descending</option>
        <option value="asc">Ascending</option>
      </select>
    </label>
    <label>Status
      <select bind:value={statusFilter} data-focusable="true">
        <option value="all">All</option>
        <option value="watched">Watched</option>
        <option value="partial">In Progress</option>
        <option value="unwatched">Unwatched</option>
      </select>
    </label>
  </div>

  {#if loading}
    <div class="state-box">Loading library…</div>
  {:else if error}
    <div class="state-box error">
      <p>{error}</p>
      <button data-focusable="true" class="retry-btn" on:click={loadLibrary}>Retry</button>
    </div>
  {:else if sortedItems.length === 0}
    <div class="state-box">No synced library items yet.</div>
  {:else}
    {#each grouped as [groupName, groupItems]}
      <section class="group">
        <h2>{groupName} · {groupItems.length}</h2>
        <div class="grid">
          {#each groupItems as item (item.id)}
            <div class="card-wrap" on:click={() => goToMeta(item)}>
              <MetaCard meta={item} defaultType={item.type || 'movie'} />
              <div class="status-row {watchStatus(item)}">
                <span>{statusLabel(item)}</span>
                {#if episodeLabel(item)}
                  <span class="ep-label">{episodeLabel(item)}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .library-page {
    min-height: 100vh;
    padding: 88px var(--page-x) 60px;
  }

  .library-header {
    margin-bottom: 22px;
  }

  .library-header h1 {
    font-size: 1.8rem;
    margin-bottom: 4px;
  }

  .library-header p {
    color: var(--text-dim);
    font-size: 0.9rem;
  }

  .group {
    margin-bottom: 24px;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 18px;
  }

  .toolbar label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    color: var(--text-muted);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
  }

  .toolbar select {
    background: transparent;
    color: var(--text-primary);
    border: none;
    outline: none;
    font-size: 0.82rem;
  }

  .group h2 {
    font-size: 1rem;
    color: var(--text-muted);
    margin-bottom: 10px;
  }

  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }

  .card-wrap {
    position: relative;
    cursor: pointer;
    width: 150px;
  }

  .status-row {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.2px;
  }

  .status-row.watched {
    color: var(--green);
  }

  .status-row.unwatched {
    color: var(--text-muted);
  }

  .status-row.partial {
    color: var(--accent-light);
  }

  .ep-label {
    color: var(--text-dim);
    font-weight: 600;
  }

  .state-box {
    color: var(--text-dim);
    padding: 24px 0;
  }

  .state-box.error {
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }

  .retry-btn {
    padding: 10px 22px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    font-weight: 600;
  }
</style>
