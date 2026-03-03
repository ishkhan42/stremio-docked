<script>
  import { onMount, onDestroy } from 'svelte';
  import { push }  from 'svelte-spa-router';
  import { get }   from 'svelte/store';
  import { addons as addonsStore } from '../stores/addons.js';
  import { fetchCatalog, getAddonCatalogs } from '../lib/addons.js';
  import MetaCard  from '../components/MetaCard.svelte';

  let query      = '';
  let results    = [];
  let loading    = false;
  let debounceTimer;
  let inputEl;

  onMount(() => {
    inputEl?.focus();
  });

  onDestroy(() => clearTimeout(debounceTimer));

  function onInput() {
    clearTimeout(debounceTimer);
    if (!query.trim()) { results = []; loading = false; return; }
    loading = true;
    debounceTimer = setTimeout(doSearch, 450);
  }

  async function doSearch() {
    const q = query.trim();
    if (!q) { loading = false; return; }

    const addons = get(addonsStore);
    if (!addons.length) { loading = false; results = []; return; }

    // Find addons that support search (have a catalog with 'search' extra)
    const searchCatalogs = addons.flatMap(addon => {
      const manifest = addon.manifest || addon;
      if (!manifest.catalogs) return [];
      return manifest.catalogs
        .filter(cat =>
          cat.extraSupported?.includes('search') ||
          cat.extra?.some(e => e.name === 'search')
        )
        .map(cat => ({ addon, catalog: cat }));
    });

    const searchResults = await Promise.allSettled(
      searchCatalogs.map(({ addon, catalog }) =>
        fetchCatalog(addon, catalog.type, catalog.id, { search: q })
      )
    );

    // Deduplicate by id
    const seen = new Set();
    results = searchResults
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
      .flatMap(r => r.value)
      .filter(item => {
        if (!item?.id) return false;
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });

    loading = false;
  }

  function goToMeta(item) {
    push(`/meta/${item.type || 'movie'}/${item.id}`);
  }
</script>

<div class="search-page">
  <div class="search-header">
    <div class="search-box-wrap">
      <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input
        bind:this={inputEl}
        class="search-input"
        type="search"
        placeholder="Search movies, series…"
        bind:value={query}
        on:input={onInput}
        autocomplete="off"
        spellcheck="false"
        data-focusable="true"
      />
      {#if loading}
        <span class="spinner-small"></span>
      {:else if query}
        <button class="clear-btn" on:click={() => { query=''; results=[]; inputEl?.focus(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6"  y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <div class="results-area">
    {#if !query.trim()}
      <div class="empty-prompt">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p>Type to search across all your add-ons</p>
      </div>
    {:else if loading && results.length === 0}
      <div class="loading-prompt">
        <div class="spinner-med"></div>
        <p>Searching…</p>
      </div>
    {:else if results.length === 0 && !loading}
      <div class="no-results">
        <p>No results found for <strong>"{query}"</strong></p>
        <p class="hint">Try a different search term, or install a search-capable add-on.</p>
      </div>
    {:else}
      <p class="result-count">{results.length} result{results.length !== 1 ? 's' : ''}</p>
      <div class="results-grid">
        {#each results as item (item.id)}
          <MetaCard
            meta={item}
            width={160}
            on:click={() => goToMeta(item)}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .search-page {
    min-height: 100vh;
    padding-bottom: 60px;
  }

  /* ── Search bar ──────────────────────────────────────────────────────────── */
  .search-header {
    padding: 80px var(--page-x) 32px;
    background: linear-gradient(to bottom, var(--bg-primary), transparent);
    position: sticky;
    top: 64px;
    z-index: 10;
    backdrop-filter: blur(16px);
  }

  .search-box-wrap {
    position: relative;
    display: flex;
    align-items: center;
    max-width: 700px;
  }

  .search-icon {
    position: absolute;
    left: 16px;
    color: var(--text-dim);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 16px 52px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 50px;
    color: var(--text-primary);
    font-size: 1.1rem;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(124,58,237,0.2);
  }

  .search-input::placeholder { color: var(--text-dim); }

  .clear-btn {
    position: absolute;
    right: 16px;
    color: var(--text-dim);
    display: flex; align-items: center;
    padding: 6px;
    border-radius: 50%;
    transition: all var(--transition);
  }
  .clear-btn:hover { background: var(--bg-surface); color: var(--text-primary); }

  .spinner-small {
    position: absolute;
    right: 16px;
    width: 18px; height: 18px;
    border: 2px solid var(--bg-surface);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  /* ── Results ──────────────────────────────────────────────────────────────── */
  .results-area {
    padding: 0 var(--page-x);
  }

  .result-count {
    font-size: 0.82rem;
    color: var(--text-dim);
    margin-bottom: 20px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }

  .results-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  /* ── Empty / Loading states ───────────────────────────────────────────────── */
  .empty-prompt, .loading-prompt, .no-results {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 80px 24px;
    text-align: center;
    color: var(--text-dim);
  }

  .loading-prompt p, .empty-prompt p { font-size: 0.95rem; }

  .no-results p { font-size: 0.95rem; color: var(--text-muted); }
  .no-results strong { color: var(--text-primary); }
  .no-results .hint { font-size: 0.83rem; color: var(--text-dim); }

  .spinner-med {
    width: 32px; height: 32px;
    border: 3px solid var(--bg-surface);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
