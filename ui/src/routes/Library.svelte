<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { authKey } from '../stores/auth.js';
  import { getLibrary } from '../lib/api.js';
  import MetaCard from '../components/MetaCard.svelte';

  let loading = true;
  let error = '';
  let items = [];

  $: movies = items.filter(item => item.type === 'movie');
  $: series = items.filter(item => item.type === 'series');
  $: other = items.filter(item => item.type !== 'movie' && item.type !== 'series');

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
</script>

<div class="library-page">
  <div class="library-header">
    <h1>My Library</h1>
    <p>Synced from your Stremio account</p>
  </div>

  {#if loading}
    <div class="state-box">Loading library…</div>
  {:else if error}
    <div class="state-box error">
      <p>{error}</p>
      <button data-focusable="true" class="retry-btn" on:click={loadLibrary}>Retry</button>
    </div>
  {:else if items.length === 0}
    <div class="state-box">No synced library items yet.</div>
  {:else}
    {#if movies.length}
      <section class="group">
        <h2>Movies · {movies.length}</h2>
        <div class="grid">
          {#each movies as item (item.id)}
            <MetaCard meta={item} defaultType="movie" on:click={() => goToMeta(item)} />
          {/each}
        </div>
      </section>
    {/if}

    {#if series.length}
      <section class="group">
        <h2>Series · {series.length}</h2>
        <div class="grid">
          {#each series as item (item.id)}
            <MetaCard meta={item} defaultType="series" on:click={() => goToMeta(item)} />
          {/each}
        </div>
      </section>
    {/if}

    {#if other.length}
      <section class="group">
        <h2>Other · {other.length}</h2>
        <div class="grid">
          {#each other as item (item.id)}
            <MetaCard meta={item} defaultType={item.type || 'movie'} on:click={() => goToMeta(item)} />
          {/each}
        </div>
      </section>
    {/if}
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
