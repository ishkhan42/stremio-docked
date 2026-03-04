<script>
  import { createEventDispatcher } from 'svelte';

  export let videos = [];     // meta.videos array from Stremio
  export let selectedSeason = 1;
  export let watchedMap = {};  // { videoId: progressPct }

  const dispatch = createEventDispatcher();

  $: seasons = [...new Set(videos.map(v => v.season).filter(Boolean))].sort((a,b) => a-b);
  $: episodes = videos
    .filter(v => v.season === selectedSeason || (!v.season && selectedSeason === 1))
    .sort((a,b) => (a.episode || 0) - (b.episode || 0));

  function selectEpisode(video) {
    dispatch('select', video);
  }

  function formatDate(released) {
    if (!released) return '';
    try {
      return new Date(released).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric'});
    } catch { return ''; }
  }
</script>

<div class="episode-grid">
  <!-- Season tabs -->
  {#if seasons.length > 1}
    <div class="season-tabs">
      {#each seasons as season}
        <button
          class="season-tab"
          class:active={season === selectedSeason}
          data-focusable="true"
          on:click={() => selectedSeason = season}
        >
          Season {season}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Episode list -->
  <div class="episodes">
    {#each episodes as video (video.id)}
      {@const progress = watchedMap[video.id] || 0}
      <div
        class="episode"
        data-focusable="true"
        role="button"
        tabindex="0"
        on:click={() => selectEpisode(video)}
        on:keydown={e => e.key === 'Enter' && selectEpisode(video)}
      >
        <div class="ep-thumb">
          {#if video.thumbnail}
            <img
              src="/api/image-proxy?url={encodeURIComponent(video.thumbnail)}"
              alt="Episode {video.episode}"
              loading="lazy"
            />
          {:else}
            <div class="ep-thumb-placeholder">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
          {/if}

          {#if progress > 0}
            <div class="ep-progress"><div style="width:{progress}%"></div></div>
          {/if}

          <div class="ep-play-overlay">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        </div>

        <div class="ep-info">
          <p class="ep-title">
            {#if video.episode}
              <span class="ep-num">E{video.episode}</span>
            {/if}
            {video.name || video.title || `Episode ${video.episode}`}
          </p>
          {#if video.released}
            <p class="ep-date">{formatDate(video.released)}</p>
          {/if}
            {#if video.overview || video.description}
            {@const desc = video.overview || video.description}
            <p class="ep-overview">{desc.length > 150 ? desc.slice(0, 150) + '…' : desc}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .episode-grid { display: flex; flex-direction: column; gap: 0; }

  .season-tabs {
    display: flex;
    gap: 4px;
    padding: 0 0 16px;
    flex-wrap: wrap;
  }

  .season-tab {
    padding: 7px 18px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-muted);
    font-size: 0.88rem;
    font-weight: 500;
    border: 1px solid var(--border);
    transition: all var(--transition);
  }

  .season-tab.active,
  .season-tab:hover {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .episodes { display: flex; flex-direction: column; gap: 2px; }

  .episode {
    display: flex;
    gap: 16px;
    padding: 12px 16px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition);
    align-items: center;
    outline: none;
  }

  .episode:hover,
  .episode.focused {
    background: var(--bg-elevated);
  }

  .ep-thumb {
    position: relative;
    width: 160px;
    min-width: 160px;
    aspect-ratio: 16/9;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-card);
    flex-shrink: 0;
  }

  .ep-thumb img {
    width: 100%; height: 100%;
    object-fit: cover;
  }

  .ep-thumb-placeholder {
    width: 100%; height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
  }

  .ep-progress {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: rgba(255,255,255,0.2);
  }

  .ep-progress > div {
    height: 100%;
    background: var(--accent-light);
  }

  .ep-play-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity var(--transition);
  }

  .episode:hover .ep-play-overlay,
  .episode.focused .ep-play-overlay {
    opacity: 1;
  }

  .ep-info {
    flex: 1;
    min-width: 0;
  }

  .ep-title {
    font-size: 0.95rem;
    font-weight: 500;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ep-num {
    font-size: 0.78rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    padding: 1px 7px;
    border-radius: 4px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .ep-date {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-bottom: 6px;
  }

  .ep-overview {
    font-size: 0.82rem;
    color: var(--text-muted);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ── TV-scale ──────────────────────────────── */
  @media (min-width: 960px) {
    .season-tab    { padding: 9px 22px; font-size: 0.95rem; }
    .episode       { padding: 14px 18px; gap: 20px; }
    .ep-thumb      { width: 190px; min-width: 190px; }
    .ep-title      { font-size: 1.02rem; }
    .ep-num        { font-size: 0.82rem; padding: 2px 8px; }
    .ep-date       { font-size: 0.82rem; }
    .ep-overview   { font-size: 0.88rem; }
    .ep-progress   { height: 4px; }
  }
</style>
