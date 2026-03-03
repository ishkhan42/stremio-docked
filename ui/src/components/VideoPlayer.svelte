<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import Hls from 'hls.js';
  import { recordProgress } from '../stores/progress.js';
  import { matchKey, KEYS } from '../lib/keyboard.js';
  import { subtitleProxyUrl } from '../lib/api.js';
  import { prefs } from '../stores/progress.js';

  const dispatch = createEventDispatcher();

  // ── Props ───────────────────────────────────────────────────────────────────
  export let streamUrl   = '';          // HLS m3u8 or direct URL
  export let directUrl   = '';          // Direct file url fallback
  export let streamType  = 'torrent';   // 'torrent' | 'http' | 'hls'
  export let subtitleTracks = [];       // [{ lang, label, url }] from add-ons
  export let title       = '';
  export let type        = 'movie';     // 'movie' | 'series'
  export let videoId     = '';
  export let resumePos   = 0;           // seconds to resume from
  export let hasNext     = false;       // show next episode button
  export let metaName    = '';           // for continue watching label
  export let metaPoster  = '';           // for continue watching card

  // ── State ───────────────────────────────────────────────────────────────────
  let videoEl;
  let hls;
  let playing = false;
  let buffering = false;
  let currentTime = 0;
  let duration = 0;
  let volume = 1;
  let muted = false;
  let fullscreen = false;
  let showControls = true;
  let controlTimer;
  let errorMsg = '';
  let hlsFailed = false;

  // Tracks
  let audioTracks = [];
  let currentAudioTrack = 0;
  let hlsSubtitleTracks = [];
  let currentHlsSubTrack = -1;
  let activeSubTrack = -1;   // index into subtitleTracks (external)

  // UI toggles
  let showSubMenu = false;
  let showAudioMenu = false;
  let seekPreview = false;
  let seeking = false;
  let volumeSliderVisible = false;

  // Progress saving interval
  let saveTimer;

  // ── Computed ─────────────────────────────────────────────────────────────────
  $: progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  $: allSubTracks = [
    { lang: 'off', label: 'Off',  url: null, source: 'none'     },
    ...subtitleTracks.map(s => ({ ...s, source: 'external'      })),
    ...hlsSubtitleTracks.map((t, i) => ({ lang: t.lang, label: t.name, hlsIdx: i, source: 'hls' })),
  ];

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  onMount(() => {
    document.addEventListener('keydown', handleKey, { capture: true });
    document.addEventListener('fullscreenchange', onFullscreenChange);
    setupPlayer();
    if (resumePos > 10) {
      // Prompt to resume handled by parent, position set via seekTo after load
    }
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKey, { capture: true });
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    cleanupHls();
    clearInterval(saveTimer);
    clearTimeout(controlTimer);
  });

  // ── Player setup ──────────────────────────────────────────────────────────
  function setupPlayer() {
    const url = streamUrl || directUrl;
    if (!url || !videoEl) return;

    errorMsg = '';
    hlsFailed = false;

    const isHlsUrl = url.includes('.m3u8') || url.includes('/master') || url.includes('/hlsv2');
    const useHlsJs = isHlsUrl && Hls.isSupported();
    const nativeHls = isHlsUrl && !Hls.isSupported() && videoEl.canPlayType('application/vnd.apple.mpegurl');

    if (useHlsJs) {
      initHlsJs(url);
    } else if (nativeHls || !isHlsUrl) {
      // Direct src - native playback (for direct URLs or native HLS browsers)
      videoEl.src = url;
      videoEl.load();
    } else {
      // Try direct URL as fallback
      videoEl.src = directUrl || url;
      videoEl.load();
    }

    videoEl.volume = $prefs.volume ?? 1;
    volume = videoEl.volume;

    // Progress save every 5s
    saveTimer = setInterval(() => {
      if (videoEl && !videoEl.paused && duration > 0) {
        recordProgress(type, videoId, currentTime, duration, { name: metaName, poster: metaPoster });
      }
    }, 5000);
  }

  function initHlsJs(url) {
    cleanupHls();
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 60,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      startLevel: -1,            // auto quality
      // Do NOT hard-ban any levels – let hls.js choose
      capLevelToPlayerSize: true,
    });

    hls.loadSource(url);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      audioTracks = hls.audioTracks || [];
      hlsSubtitleTracks = hls.subtitleTracks || [];

      // Apply preferred audio language
      applyPreferredAudio();

      videoEl.play().catch(() => { /* autoplay blocked, user must tap */ });
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      audioTracks = hls.audioTracks || [];
    });

    hls.on(Hls.Events.SUBTITLE_TRACK_UPDATED, () => {
      hlsSubtitleTracks = hls.subtitleTracks || [];
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        console.error('[hls.js] Fatal error:', data);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          // Fall back to direct URL
          hlsFailed = true;
          if (directUrl && directUrl !== url) {
            console.log('[player] HLS failed, falling back to direct URL');
            cleanupHls();
            videoEl.src = directUrl;
            videoEl.load();
            videoEl.play().catch(() => {});
          } else {
            errorMsg = 'Playback error. The stream may be loading or incompatible.';
          }
        }
      }
    });
  }

  function cleanupHls() {
    if (hls) {
      hls.stopLoad();
      hls.detachMedia();
      hls.destroy();
      hls = null;
    }
  }

  function applyPreferredAudio() {
    if (!hls || !audioTracks.length) return;
    const preferred = $prefs.audioLanguage || 'eng';
    const idx = audioTracks.findIndex(t =>
      t.lang?.toLowerCase().includes(preferred.toLowerCase()) ||
      t.name?.toLowerCase().includes(preferred.toLowerCase())
    );
    if (idx >= 0) { hls.audioTrack = idx; currentAudioTrack = idx; }
  }

  // ── Video event handlers ──────────────────────────────────────────────────
  function onPlay()       { playing = true;    buffering = false; }
  function onPause()      { playing = false; }
  function onWaiting()    { buffering = true; }
  function onPlaying()    { buffering = false; buffering = false; playing = true; }
  function onLoadedMeta() {
    duration = videoEl.duration || 0;
    // Seek to resume position
    if (resumePos > 10 && resumePos < duration - 30) {
      videoEl.currentTime = resumePos;
    }
    videoEl.play().catch(() => {});
  }
  function onTimeUpdate() {
    currentTime = videoEl.currentTime;
  }
  function onEnded() {
    recordProgress(type, videoId, duration, duration, { name: metaName, poster: metaPoster });
    dispatch('ended');
  }
  function onError() {
    if (!hlsFailed && directUrl && videoEl.src !== directUrl) {
      console.log('[player] Video error, fallback to direct URL');
      cleanupHls();
      videoEl.src = directUrl;
      videoEl.load();
      videoEl.play().catch(() => {});
      return;
    }
    errorMsg = 'Cannot play this stream. Format may be unsupported by your browser.';
  }
  function onFullscreenChange() {
    fullscreen = !!document.fullscreenElement;
  }

  // ── Controls ──────────────────────────────────────────────────────────────
  function showControlsTemporarily() {
    showControls = true;
    clearTimeout(controlTimer);
    if (playing) {
      controlTimer = setTimeout(() => {
        showControls = false;
        showSubMenu = false;
        showAudioMenu = false;
        volumeSliderVisible = false;
      }, 4000);
    }
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) videoEl.play().catch(()=>{});
    else               videoEl.pause();
    showControlsTemporarily();
  }

  function seek(toTime) {
    if (!videoEl || !duration) return;
    videoEl.currentTime = Math.max(0, Math.min(duration, toTime));
    showControlsTemporarily();
  }

  function seekRelative(delta) {
    seek(currentTime + delta);
  }

  function toggleMute() {
    videoEl.muted = !videoEl.muted;
    muted = videoEl.muted;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    videoEl.volume = volume;
    videoEl.muted = volume === 0;
    muted = videoEl.muted;
  }

  function toggleFullscreen() {
    const el = videoEl?.parentElement?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  function setAudioTrack(idx) {
    if (hls) { hls.audioTrack = idx; currentAudioTrack = idx; }
    showAudioMenu = false;
    showControlsTemporarily();
  }

  function setSubtitleTrack(track) {
    if (!videoEl) return;

    // Remove all existing external tracks
    Array.from(videoEl.querySelectorAll('track')).forEach(t => t.remove());

    if (track.source === 'none') {
      activeSubTrack = -1;
      currentHlsSubTrack = -1;
      if (hls) hls.subtitleTrack = -1;
    } else if (track.source === 'hls') {
      if (hls) { hls.subtitleTrack = track.hlsIdx; currentHlsSubTrack = track.hlsIdx; }
      activeSubTrack = -1;
    } else if (track.source === 'external' && track.url) {
      // Add external track
      if (hls) hls.subtitleTrack = -1;
      currentHlsSubTrack = -1;
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = track.label;
      t.srclang = track.lang;
      t.src = subtitleProxyUrl(track.url);
      t.default = true;
      videoEl.appendChild(t);
      t.addEventListener('load', () => {
        videoEl.textTracks[videoEl.textTracks.length - 1].mode = 'showing';
      });
      activeSubTrack = subtitleTracks.findIndex(s => s.url === track.url);
    }

    showSubMenu = false;
    showControlsTemporarily();
  }

  // ── Keydown handler (TV remote) ────────────────────────────────────────────
  function handleKey(e) {
    // Don't override if a text input is focused
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    showControlsTemporarily();

    if (matchKey(e, 'ENTER') || matchKey(e, 'PLAY')) {
      e.preventDefault();
      togglePlay();
      return;
    }

    if (matchKey(e, 'FF')) {
      e.preventDefault(); seekRelative(10); return;
    }
    if (matchKey(e, 'RW')) {
      e.preventDefault(); seekRelative(-10); return;
    }
    if (matchKey(e, 'RIGHT') && !showSubMenu && !showAudioMenu) {
      e.preventDefault(); seekRelative(10); return;
    }
    if (matchKey(e, 'LEFT') && !showSubMenu && !showAudioMenu) {
      e.preventDefault(); seekRelative(-10); return;
    }
    if (matchKey(e, 'BACK')) {
      if (showSubMenu || showAudioMenu) {
        showSubMenu = false; showAudioMenu = false;
        e.preventDefault(); return;
      }
      e.preventDefault();
      dispatch('back');
      return;
    }
    if (matchKey(e, 'UP')) {
      e.preventDefault(); setVolume(volume + 0.1); return;
    }
    if (matchKey(e, 'DOWN')) {
      e.preventDefault(); setVolume(volume - 0.1); return;
    }
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }

  function onSeekBarInput(e) {
    const pct = parseFloat(e.target.value);
    seek((pct / 100) * duration);
  }
</script>

<div
  class="player-container"
  on:mousemove={showControlsTemporarily}
  on:click={e => { if (!e.target.closest('.controls')) togglePlay(); }}
  role="application"
>
  <!-- Video element -->
  <video
    bind:this={videoEl}
    class="video"
    playsinline
    preload="auto"
    on:play={onPlay}
    on:pause={onPause}
    on:waiting={onWaiting}
    on:playing={onPlaying}
    on:loadedmetadata={onLoadedMeta}
    on:timeupdate={onTimeUpdate}
    on:ended={onEnded}
    on:error={onError}
  ></video>

  <!-- Buffering spinner -->
  {#if buffering}
    <div class="buffering-overlay">
      <div class="spinner"></div>
      <p>Buffering…</p>
    </div>
  {/if}

  <!-- Error overlay -->
  {#if errorMsg}
    <div class="error-overlay">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <p>{errorMsg}</p>
      <button class="btn-retry" data-focusable="true" on:click={() => { errorMsg=''; setupPlayer(); }}>
        Retry
      </button>
    </div>
  {/if}

  <!-- Controls overlay -->
  <div class="controls" class:hidden={!showControls && playing && !errorMsg}>
    <!-- Top bar: title + actions -->
    <div class="controls-top">
      <div class="top-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>{title}</span>
      </div>
      <div class="top-actions">
        <!-- Subtitles button -->
        {#if allSubTracks.length > 1}
          <button
            class="ctrl-btn"
            data-focusable="true"
            class:active={activeSubTrack >= 0 || currentHlsSubTrack >= 0}
            on:click|stopPropagation={() => { showSubMenu = !showSubMenu; showAudioMenu = false; }}
            title="Subtitles"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="7" width="20" height="15" rx="2"/>
              <path d="M17 12H7M12 17H7"/>
            </svg>
          </button>
        {/if}

        <!-- Audio track button -->
        {#if audioTracks.length > 1}
          <button
            class="ctrl-btn"
            data-focusable="true"
            class:active={currentAudioTrack > 0}
            on:click|stopPropagation={() => { showAudioMenu = !showAudioMenu; showSubMenu = false; }}
            title="Audio Track"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
          </button>
        {/if}

        <!-- Fullscreen -->
        <button class="ctrl-btn" data-focusable="true" on:click|stopPropagation={toggleFullscreen} title="Fullscreen">
          {#if fullscreen}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
            </svg>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          {/if}
        </button>

        <!-- Back -->
        <button class="ctrl-btn" data-focusable="true" on:click|stopPropagation={() => dispatch('back')} title="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Subtitle popup menu -->
    {#if showSubMenu}
      <div class="popup-menu sub-menu" on:click|stopPropagation>
        <p class="menu-title">Subtitles</p>
        {#each allSubTracks as track, i}
          <button
            class="menu-item"
            data-focusable="true"
            class:active={
              (track.source === 'none' && activeSubTrack === -1 && currentHlsSubTrack === -1) ||
              (track.source === 'external' && subtitleTracks.findIndex(s=>s.url===track.url) === activeSubTrack) ||
              (track.source === 'hls' && track.hlsIdx === currentHlsSubTrack)
            }
            on:click={() => setSubtitleTrack(track)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="check">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            {track.label}
            {#if track.lang && track.lang !== 'off'}<span class="lang-tag">{track.lang}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Audio track popup menu -->
    {#if showAudioMenu}
      <div class="popup-menu audio-menu" on:click|stopPropagation>
        <p class="menu-title">Audio Track</p>
        {#each audioTracks as track, i}
          <button
            class="menu-item"
            data-focusable="true"
            class:active={i === currentAudioTrack}
            on:click={() => setAudioTrack(i)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="check">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            {track.name}
            {#if track.lang}<span class="lang-tag">{track.lang}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Bottom controls -->
    <div class="controls-bottom">
      <!-- Seek bar -->
      <div class="seek-row">
        <span class="time-label">{formatTime(currentTime)}</span>
        <div class="seek-bar-wrap">
          <input
            type="range"
            class="seek-bar"
            min="0" max="100"
            step="0.01"
            value={progressPct}
            on:input={onSeekBarInput}
            on:click|stopPropagation
          />
          <div class="seek-fill" style="width:{progressPct}%"></div>
        </div>
        <span class="time-label">{formatTime(duration)}</span>
      </div>

      <!-- Playback controls row -->
      <div class="playback-row">
        <div class="playback-left">
          <!-- Play/Pause -->
          <button
            class="ctrl-btn play-pause"
            data-focusable="true"
            on:click|stopPropagation={togglePlay}
          >
            {#if playing}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            {:else}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            {/if}
          </button>

          <!-- -10s -->
          <button class="ctrl-btn" data-focusable="true" on:click|stopPropagation={() => seekRelative(-10)} title="-10s">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 17a6 6 0 1 1 0-10.66"/>
              <path d="M11 17V7l-4 4"/>
              <text x="13" y="16" font-size="5" fill="currentColor" stroke="none">10</text>
            </svg>
          </button>

          <!-- +10s -->
          <button class="ctrl-btn" data-focusable="true" on:click|stopPropagation={() => seekRelative(10)} title="+10s">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 17a6 6 0 1 0 0-10.66"/>
              <path d="M13 17V7l4 4"/>
            </svg>
          </button>

          <!-- Volume -->
          <div class="volume-wrap" on:mouseenter={() => volumeSliderVisible=true} on:mouseleave={() => volumeSliderVisible=false}>
            <button class="ctrl-btn" data-focusable="true" on:click|stopPropagation={toggleMute} title="Mute">
              {#if muted || volume === 0}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <line x1="23" y1="9" x2="17" y2="15"/>
                  <line x1="17" y1="9" x2="23" y2="15"/>
                </svg>
              {:else}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
              {/if}
            </button>
            {#if volumeSliderVisible}
              <input
                type="range" class="volume-slider"
                min="0" max="1" step="0.05"
                value={volume}
                on:input={e => setVolume(parseFloat(e.target.value))}
                on:click|stopPropagation
              />
            {/if}
          </div>
        </div>

        <div class="playback-right">
          {#if hasNext}
            <button
              class="ctrl-btn next-ep"
              data-focusable="true"
              on:click|stopPropagation={() => dispatch('next')}
            >
              Next Episode
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .player-container {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 1000;
    cursor: default;
  }

  .video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ── Overlays ─────────────────────────────────────────────────────────────── */
  .buffering-overlay,
  .error-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: rgba(0,0,0,0.5);
    color: #fff;
    pointer-events: none;
    z-index: 10;
  }

  .error-overlay { pointer-events: all; }
  .error-overlay p { max-width: 400px; text-align: center; color: rgba(255,255,255,0.8); }
  .btn-retry {
    padding: 10px 28px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-weight: 600;
    margin-top: 8px;
    pointer-events: all;
  }

  /* ── Controls ──────────────────────────────────────────────────────────────── */
  .controls {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
    transition: opacity 300ms ease;
    z-index: 20;
  }

  .controls.hidden { opacity: 0; }

  .controls > * { pointer-events: all; }

  .controls-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 24px 32px 80px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%);
  }

  .top-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1rem;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
  }

  .top-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .controls-bottom {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 80px 32px 28px;
    background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%);
  }

  /* ── Seek bar ──────────────────────────────────────────────────────────────── */
  .seek-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .time-label {
    font-size: 0.82rem;
    color: rgba(255,255,255,0.75);
    white-space: nowrap;
    min-width: 45px;
    font-variant-numeric: tabular-nums;
  }

  .seek-bar-wrap {
    position: relative;
    flex: 1;
    height: 4px;
    background: rgba(255,255,255,0.25);
    border-radius: 2px;
    cursor: pointer;
  }

  .seek-fill {
    position: absolute;
    left: 0; top: 0;
    height: 100%;
    background: var(--accent-light);
    border-radius: 2px;
    pointer-events: none;
    transition: width 0.1s;
  }

  .seek-bar {
    position: absolute;
    inset: -8px 0;
    width: 100%;
    opacity: 0;
    height: 20px;
    cursor: pointer;
    margin: 0;
  }

  .seek-bar-wrap:hover .seek-fill { height: 6px; top: -1px; }

  /* ── Playback rows ─────────────────────────────────────────────────────────── */
  .playback-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .playback-left, .playback-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px;
    border-radius: var(--radius-sm);
    color: rgba(255,255,255,0.8);
    transition: all var(--transition);
    font-size: 0.85rem;
  }

  .ctrl-btn:hover,
  .ctrl-btn.focused,
  .ctrl-btn.active {
    background: rgba(255,255,255,0.12);
    color: #fff;
  }

  .ctrl-btn.active { color: var(--accent-light); }

  .ctrl-btn.play-pause {
    width: 48px; height: 48px;
    border-radius: 50%;
    background: rgba(255,255,255,0.12);
    justify-content: center;
  }

  .ctrl-btn.play-pause:hover {
    background: var(--accent);
  }

  .ctrl-btn.next-ep {
    padding: 8px 18px;
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: var(--radius-sm);
    font-weight: 500;
  }

  /* ── Volume ──────────────────────────────────────────────────────────────── */
  .volume-wrap { position: relative; display: flex; align-items: center; }

  .volume-slider {
    position: absolute;
    left: 44px;
    width: 100px;
    background: rgba(0,0,0,0.8);
    border-radius: 4px;
    padding: 4px;
    accent-color: var(--accent-light);
  }

  /* ── Popup menus ─────────────────────────────────────────────────────────── */
  .popup-menu {
    position: absolute;
    top: 70px;
    right: 32px;
    background: rgba(15, 15, 25, 0.97);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px;
    min-width: 220px;
    backdrop-filter: blur(16px);
    z-index: 50;
    max-height: 360px;
    overflow-y: auto;
  }

  .menu-title {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    padding: 6px 12px 10px;
    font-weight: 700;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.88rem;
    transition: all var(--transition);
    text-align: left;
  }

  .menu-item:hover, .menu-item.focused { background: var(--bg-elevated); color: #fff; }
  .menu-item.active { color: var(--accent-light); }
  .menu-item .check { opacity: 0; flex-shrink: 0; }
  .menu-item.active .check { opacity: 1; }

  .lang-tag {
    margin-left: auto;
    font-size: 0.7rem;
    text-transform: uppercase;
    background: var(--bg-elevated);
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--text-dim);
    flex-shrink: 0;
  }
</style>
