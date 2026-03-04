<script>
  import { push } from 'svelte-spa-router';
  import { getProgress } from '../stores/progress.js';

  export let meta;
  export let size = 'normal'; // 'normal' | 'large' | 'small'
  export let defaultType = 'movie';

  $: resolvedType = meta?.type || defaultType;
  $: progress = getProgress(resolvedType, meta.id);
  $: progressPct = (progress && progress.duration > 0) ? Math.min((progress.position / progress.duration) * 100, 100) : 0;

  function navigate() {
    push(`/meta/${resolvedType}/${meta.id}`);
  }

  $: posterSrc = meta.poster
    ? `/api/image-proxy?url=${encodeURIComponent(meta.poster)}`
    : null;
</script>

<div
  class="meta-card size-{size}"
  data-focusable="true"
  role="button"
  tabindex="0"
  on:click={navigate}
  on:keydown={e => e.key === 'Enter' && navigate()}
  title={meta.name}
>
  <div class="poster-wrap">
    {#if posterSrc}
      <img class="poster" src={posterSrc} alt={meta.name} loading="lazy" />
    {:else}
      <div class="poster-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="2" width="20" height="20" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="m21 15-5-5L5 21"/>
        </svg>
        <span>{meta.name}</span>
      </div>
    {/if}

    <!-- Progress bar -->
    {#if progressPct > 0}
      <div class="progress-bar">
        <div class="progress-fill" style="width:{progressPct}%"></div>
      </div>
    {/if}

    <!-- Overlay on hover/focus -->
    <div class="overlay">
      <div class="play-btn">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
    </div>

    <!-- Type badge -->
    {#if resolvedType === 'series'}
      <span class="type-badge">Series</span>
    {/if}
  </div>

  <div class="meta-info">
    <p class="meta-name truncate">{meta.name}</p>
    {#if meta.year || meta.releaseInfo}
      <p class="meta-year">{meta.year || meta.releaseInfo}</p>
    {/if}
    {#if meta.imdbRating}
      <p class="meta-rating">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="#f59e0b"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        {meta.imdbRating}
      </p>
    {/if}
  </div>
</div>

<style>
  .meta-card {
    display: flex;
    flex-direction: column;
    cursor: pointer;
    border-radius: var(--radius);
    overflow: visible;
    flex-shrink: 0;
    outline: none;
  }

  .meta-card.size-normal { width: var(--card-w, 150px); }
  .meta-card.size-large  { width: var(--card-w-lg, 200px); }
  .meta-card.size-small  { width: 110px; }

  .poster-wrap {
    position: relative;
    border-radius: var(--radius);
    overflow: hidden;
    aspect-ratio: 2/3;
    background: var(--bg-card);
  }

  .poster {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 300ms ease;
    display: block;
  }

  .poster-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-dim);
    font-size: 0.7rem;
    text-align: center;
    padding: 12px;
  }

  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity var(--transition);
  }

  .meta-card:hover .overlay,
  .meta-card.focused .overlay {
    opacity: 1;
  }

  .meta-card.focused .poster {
    transform: scale(1.04);
  }

  .play-btn {
    width: 48px; height: 48px;
    background: rgba(124,58,237,0.9);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 20px rgba(124,58,237,0.5);
  }

  .type-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .progress-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: rgba(255,255,255,0.2);
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-light);
    transition: width 0.3s;
  }

  .meta-info {
    padding: 8px 4px 2px;
  }

  .meta-name {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-primary);
    line-height: 1.3;
    margin-bottom: 2px;
  }

  .meta-year {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .meta-rating {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 0.75rem;
    color: #f59e0b;
    margin-top: 2px;
  }

  /* ── TV-scale ────────────────────────── */
  @media (min-width: 960px) {
    .meta-info { padding: 10px 5px 3px; }
    .meta-name { font-size: 0.92rem; }
    .meta-year { font-size: 0.8rem; }
    .meta-rating { font-size: 0.8rem; }
    .progress-bar { height: 5px; }
    .type-badge { font-size: 0.7rem; padding: 3px 8px; }
    .play-btn { width: 54px; height: 54px; }
    .play-btn svg { width: 24px; height: 24px; }
  }
</style>
