<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { fetchCatalog } from '../lib/addons.js';

  export let addons = [];

  let items = [];
  let currentIndex = 0;
  let timer;
  let loading = true;

  $: current = items[currentIndex] || null;

  $: bgStyle = current?.background
    ? `background-image: url('/api/image-proxy?url=${encodeURIComponent(current.background)}')`
    : current?.poster
    ? `background-image: url('/api/image-proxy?url=${encodeURIComponent(current.poster)}')`
    : '';

  onMount(async () => {
    // Find Cinemeta or first catalog addon with movies
    const cinemetaAddon = addons.find(a =>
      a.manifest?.id?.includes('cinemeta') ||
      a.manifest?.id?.includes('linvo')
    );

    if (!cinemetaAddon) { loading = false; return; }

    try {
      const res = await fetchCatalog(cinemetaAddon, 'movie', 'top');
      items = (res.metas || []).slice(0, 10);
    } catch (e) {
      // hero silent fail
    } finally {
      loading = false;
    }

    if (items.length > 1) {
      timer = setInterval(() => {
        currentIndex = (currentIndex + 1) % items.length;
      }, 7000);
    }
  });

  onDestroy(() => { clearInterval(timer); });

  function goTo(idx) {
    currentIndex = idx;
    clearInterval(timer);
    timer = setInterval(() => {
      currentIndex = (currentIndex + 1) % items.length;
    }, 7000);
  }

  function watch() {
    if (current) push(`/meta/${current.type || 'movie'}/${current.id}`);
  }
</script>

{#if !loading && current}
  <div class="hero" style={bgStyle}>
    <div class="hero-gradient"></div>

    <div class="hero-content">
      {#if current.logo}
        <img
          class="hero-logo"
          src="/api/image-proxy?url={encodeURIComponent(current.logo)}"
          alt={current.name}
          on:error={e => { e.target.style.display = 'none'; }}
        />
      {:else}
        <h1 class="hero-title">{current.name}</h1>
      {/if}

      <div class="hero-meta">
        {#if current.year || current.releaseInfo}
          <span class="badge">{current.year || current.releaseInfo}</span>
        {/if}
        {#if current.imdbRating}
          <span class="badge rating">
            ⭐ {current.imdbRating}
          </span>
        {/if}
        {#if current.genres?.length}
          <span class="badge">{current.genres.slice(0,2).join(' · ')}</span>
        {/if}
      </div>

      {#if current.description}
        <p class="hero-desc">{current.description.slice(0, 220)}{current.description.length > 220 ? '…' : ''}</p>
      {/if}

      <div class="hero-actions">
        <button class="btn-primary" data-focusable="true" on:click={watch}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Watch Now
        </button>
        <button class="btn-secondary" data-focusable="true" on:click={() => push(`/meta/${current.type || 'movie'}/${current.id}`)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          More Info
        </button>
      </div>
    </div>

    <!-- Dot navigation -->
    {#if items.length > 1}
      <div class="hero-dots">
        {#each items as _, i}
          <button
            class="dot"
            class:active={i === currentIndex}
            on:click={() => goTo(i)}
            aria-label="Go to item {i+1}"
          ></button>
        {/each}
      </div>
    {/if}
  </div>
{:else if loading}
  <div class="hero-skeleton"></div>
{/if}

<style>
  .hero {
    position: relative;
    height: 520px;
    background-size: cover;
    background-position: center top;
    background-color: var(--bg-card);
    overflow: hidden;
  }

  .hero-gradient {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to right,  rgba(10,10,15,0.95) 0%,  rgba(10,10,15,0.6) 55%,  rgba(10,10,15,0.1) 100%),
      linear-gradient(to top,    rgba(10,10,15,1)    0%,  rgba(10,10,15,0.0) 40%);
  }

  .hero-content {
    position: relative;
    z-index: 2;
    padding: 80px 56px 0;
    max-width: 600px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    height: 100%;
  }

  .hero-logo {
    max-width: 300px;
    max-height: 100px;
    object-fit: contain;
    object-position: left;
  }

  .hero-title {
    font-size: 2.4rem;
    font-weight: 800;
    letter-spacing: -1px;
    line-height: 1.1;
    text-shadow: 0 2px 12px rgba(0,0,0,0.6);
  }

  .hero-meta {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .badge {
    padding: 3px 10px;
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: 4px;
    font-size: 0.8rem;
    color: var(--text-muted);
    backdrop-filter: blur(4px);
  }

  .badge.rating { color: #f59e0b; border-color: rgba(245,158,11,0.3); }

  .hero-desc {
    font-size: 0.95rem;
    color: rgba(255,255,255,0.7);
    line-height: 1.6;
    max-width: 500px;
  }

  .hero-actions {
    display: flex;
    gap: 12px;
    padding-top: 4px;
  }

  .btn-primary, .btn-secondary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 28px;
    border-radius: var(--radius-sm);
    font-size: 0.95rem;
    font-weight: 600;
    transition: all var(--transition);
  }

  .btn-primary {
    background: var(--accent);
    color: #fff;
    box-shadow: 0 4px 20px var(--accent-glow);
  }

  .btn-primary:hover { background: var(--accent-light); }

  .btn-secondary {
    background: rgba(255,255,255,0.12);
    color: var(--text-primary);
    border: 1px solid rgba(255,255,255,0.15);
    backdrop-filter: blur(4px);
  }

  .btn-secondary:hover { background: rgba(255,255,255,0.2); }

  .hero-dots {
    position: absolute;
    bottom: 28px;
    left: 56px;
    display: flex;
    gap: 8px;
    z-index: 3;
  }

  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: rgba(255,255,255,0.3);
    transition: all var(--transition);
  }

  .dot.active {
    background: var(--accent-light);
    width: 24px;
    border-radius: 4px;
  }

  .hero-skeleton {
    height: 520px;
    background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-elevated) 50%, var(--bg-card) 75%);
    background-size: 200%;
    animation: shimmer 1.5s infinite;
  }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
