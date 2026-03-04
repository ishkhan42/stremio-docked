<script>
  import { onMount } from 'svelte';
  import MetaCard from './MetaCard.svelte';
  import { fetchCatalog } from '../lib/addons.js';

  export let row;       // { addon, catalogId, type, name, addonName }
  export let featured = false; // Show larger cards

  let metas = [];
  let loading = true;
  let error = null;
  let scrollEl;

  onMount(async () => {
    try {
      const res = await fetchCatalog(row.addon, row.type, row.catalogId);
      metas = res.metas?.slice(0, 30) || [];
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  });

  function scrollLeft()  { scrollEl?.scrollBy({ left: -600, behavior: 'smooth' }); }
  function scrollRight() { scrollEl?.scrollBy({ left:  600, behavior: 'smooth' }); }
</script>

{#if loading || metas.length > 0}
  <section class="catalog-row" class:featured>
    <div class="row-header">
      <h2 class="row-title">{row.name}</h2>
      <span class="addon-name">{row.addonName}</span>
    </div>

    <div class="scroll-area">
      <button class="scroll-btn left" on:click={scrollLeft} aria-label="Scroll left">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>

      <div class="items-track" bind:this={scrollEl}>
        {#if loading}
          {#each Array(8) as _}
            <div class="skeleton-card" class:large={featured}></div>
          {/each}
        {:else if error}
          <p class="row-error">Failed to load</p>
        {:else}
          {#each metas as meta (meta.id)}
            <MetaCard {meta} size={featured ? 'large' : 'normal'} defaultType={row.type} />
          {/each}
        {/if}
      </div>

      <button class="scroll-btn right" on:click={scrollRight} aria-label="Scroll right">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
    </div>
  </section>
{/if}

<style>
  .catalog-row {
    padding: 0 0 32px;
  }

  .row-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 0 48px 12px;
  }

  .row-title {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .addon-name {
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  .scroll-area {
    position: relative;
    display: flex;
    align-items: center;
  }

  .items-track {
    display: flex;
    gap: 14px;
    overflow-x: auto;
    padding: 8px 48px;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
  }

  .items-track > :global(.meta-card) {
    scroll-snap-align: start;
  }

  .skeleton-card {
    flex-shrink: 0;
    width: 150px;
    aspect-ratio: 2/3;
    background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-elevated) 50%, var(--bg-card) 75%);
    background-size: 200%;
    animation: shimmer 1.5s infinite;
    border-radius: var(--radius);
  }

  .skeleton-card.large { width: 200px; }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .scroll-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 5;
    width: 40px; height: 80px;
    background: linear-gradient(to right, rgba(10,10,15,0.9), transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    transition: color var(--transition);
    border-radius: 0;
  }

  .scroll-btn:hover { color: var(--text-primary); }
  .scroll-btn.left  { left: 0; background: linear-gradient(to right, rgba(10,10,15,0.95), transparent); }
  .scroll-btn.right { right: 0; background: linear-gradient(to left, rgba(10,10,15,0.95), transparent); }

  .row-error {
    color: var(--text-dim);
    font-size: 0.85rem;
    padding: 24px 0;
  }

  /* ── TV-scale ─────────────────────────── */
  @media (min-width: 960px) {
    .row-header    { padding: 0 var(--page-x, 48px) 14px; }
    .row-title     { font-size: 1.3rem; }
    .addon-name    { font-size: 0.85rem; }
    .items-track   { gap: 18px; padding: 10px var(--page-x, 48px); }
    .scroll-btn    { width: 48px; height: 90px; }
    .skeleton-card { width: var(--card-w, 175px); }
    .skeleton-card.large { width: var(--card-w-lg, 230px); }
    .catalog-row   { padding-bottom: 36px; }
  }
</style>
