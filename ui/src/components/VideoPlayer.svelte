<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import Hls from 'hls.js';
  import { recordProgress } from '../stores/progress.js';
  import { matchKey, KEYS } from '../lib/keyboard.js';
  import { subtitleProxyUrl } from '../lib/api.js';
  import { prefs } from '../stores/progress.js';

  const dispatch = createEventDispatcher();

  // ── ISO 639 language code → full name ─────────────────────────────────────
  const LANG_NAMES = {
    eng:'English', und:'Unknown', zxx:'No Dialogue',
    ara:'Arabic',  zho:'Chinese', cmn:'Chinese (Mandarin)',
    ces:'Czech',   dan:'Danish',  nld:'Dutch',
    fin:'Finnish', fra:'French',  deu:'German',
    ell:'Greek',   heb:'Hebrew',  hin:'Hindi',
    hun:'Hungarian', ind:'Indonesian', ita:'Italian',
    jpn:'Japanese',  kor:'Korean',    nor:'Norwegian',
    fas:'Persian',   pol:'Polish',    por:'Portuguese',
    rum:'Romanian',  ron:'Romanian',  rus:'Russian',
    spa:'Spanish',   swe:'Swedish',   tha:'Thai',
    tur:'Turkish',   ukr:'Ukrainian', vie:'Vietnamese',
    bul:'Bulgarian', hrv:'Croatian',  slk:'Slovak',
    slv:'Slovenian', srp:'Serbian',   mkd:'Macedonian',
    lit:'Lithuanian',lav:'Latvian',   est:'Estonian',
    cat:'Catalan',   glg:'Galician',  eus:'Basque',
    mal:'Malayalam', tam:'Tamil',     tel:'Telugu',
    ben:'Bengali',   urd:'Urdu',      mar:'Marathi',
    guj:'Gujarati',  kan:'Kannada',   pan:'Punjabi',
    msa:'Malay',     tgl:'Tagalog',
    // 2-letter ISO 639-1 fallbacks
    en:'English', ar:'Arabic',  zh:'Chinese', cs:'Czech',
    da:'Danish',  nl:'Dutch',   fi:'Finnish', fr:'French',
    de:'German',  el:'Greek',   he:'Hebrew',  hi:'Hindi',
    hu:'Hungarian', id:'Indonesian', it:'Italian', ja:'Japanese',
    ko:'Korean',  nb:'Norwegian', no:'Norwegian', fa:'Persian',
    pl:'Polish',  pt:'Portuguese', ro:'Romanian',  ru:'Russian',
    es:'Spanish', sv:'Swedish',   th:'Thai',    tr:'Turkish',
    uk:'Ukrainian', vi:'Vietnamese', bg:'Bulgarian', hr:'Croatian',
    sk:'Slovak',  sl:'Slovenian', sr:'Serbian', mk:'Macedonian',
    lt:'Lithuanian',lv:'Latvian', et:'Estonian', ca:'Catalan',
    gl:'Galician', eu:'Basque',  ms:'Malay',   tl:'Tagalog',
  };

  function langName(code) {
    if (!code || code === 'off') return '';
    return LANG_NAMES[code.toLowerCase()] ||
           LANG_NAMES[code.toLowerCase().slice(0,2)] ||
           code.toUpperCase();
  }

  // ── Props ──────────────────────────────────────────────────────────────────
  export let streamUrl      = '';
  export let directUrl      = '';
  export let streamType     = 'torrent';
  export let subtitleTracks = [];        // [{ lang, label, url }] from addons
  export let title          = '';
  export let type           = 'movie';
  export let videoId        = '';
  export let resumePos      = 0;
  export let hasNext        = false;
  export let metaName       = '';
  export let metaPoster     = '';

  // ── Player state ──────────────────────────────────────────────────────────
  let videoEl;
  let hls;
  let playing    = false;
  let buffering  = false;
  let currentTime = 0;
  let duration   = 0;
  let volume     = 1;
  let muted      = false;
  let fullscreen = false;
  let errorMsg   = '';
  let hlsFailed  = false;

  // Controls visibility
  let showControls   = true;
  let controlTimer;
  let feedbackIcon   = '';   // 'play'|'pause'|'ff'|'rw' — shown briefly in centre
  let feedbackTimer;

  // Tracks
  let audioTracks        = [];
  let currentAudioTrack  = -1;
  let hlsSubtitleTracks  = [];
  let currentHlsSubTrack = -1;
  let activeSubTrack     = -1;

  // Panel: 'audio' | 'subs' | ''
  let activePanel = '';

  // Seek hover tooltip
  let seekWrapEl;
  let hoverPct  = null;
  let hoverTime = null;

  // Progress save interval
  let saveTimer;

  // ── Derived ────────────────────────────────────────────────────────────────
  $: progressPct  = duration > 0 ? (currentTime / duration) * 100 : 0;
  $: isSubActive  = activeSubTrack >= 0 || currentHlsSubTrack >= 0;
  $: hasAnySubs   = hlsSubtitleTracks.length > 0 || subtitleTracks.length > 0;
  $: hasAudio     = audioTracks.length > 1;

  /** Grouped subtitle sections: embedded HLS + addon, grouped by language */
  $: subGroups = buildSubGroups(hlsSubtitleTracks, subtitleTracks, $prefs.subtitleLanguage || 'eng');

  function buildSubGroups(hlsTracks, addonTracks, prefLang) {
    function sortKey(code) {
      const c = (code || '').toLowerCase();
      const p = prefLang.toLowerCase();
      return (c === p || c.slice(0,2) === p.slice(0,2)) ? 0 : 1;
    }
    const groups = [];

    if (hlsTracks.length) {
      // Group HLS embedded tracks by language
      const byLang = {};
      hlsTracks.forEach((t) => {
        const code = (t.lang || 'und').toLowerCase();
        if (!byLang[code]) byLang[code] = [];
        byLang[code].push({
          lang:   code,
          label:  t.name && t.name !== code ? t.name : langName(code),
          hlsIdx: t.id,   // use hls.js track .id, not array index
          source: 'hls',
        });
      });
      // Sort languages by user preference
      const sorted = Object.entries(byLang).sort(([a],[b]) => sortKey(a) - sortKey(b));
      for (const [, tracks] of sorted) {
        groups.push({ label: langName(tracks[0].lang) || 'Embedded', tracks });
      }
    }

    if (addonTracks.length) {
      // Group addon tracks by language too
      const byLang = {};
      addonTracks.forEach(s => {
        const code = (s.lang || 'und').toLowerCase();
        if (!byLang[code]) byLang[code] = [];
        byLang[code].push({ ...s, lang: code, source: 'external' });
      });
      const sorted = Object.entries(byLang).sort(([a],[b]) => sortKey(a) - sortKey(b));
      for (const [, tracks] of sorted) {
        const name = langName(tracks[0].lang);
        groups.push({ label: `${name} (Add-on)`, tracks });
      }
    }

    return groups;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onMount(() => {
    document.addEventListener('keydown', handleKey, { capture: true });
    document.addEventListener('fullscreenchange', onFullscreenChange);
    setupPlayer();
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKey, { capture: true });
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    cleanupHls();
    clearInterval(saveTimer);
    clearTimeout(controlTimer);
    clearTimeout(feedbackTimer);
  });

  // ── Player setup ──────────────────────────────────────────────────────────
  function setupPlayer() {
    if (!videoEl) return;
    const url = normalizePlayableUrl(streamUrl || directUrl);
    if (!url) return;

    errorMsg     = '';
    hlsFailed    = false;
    audioTracks  = [];
    clearInterval(saveTimer);  // prevent stacking intervals on retry

    const isHlsUrl  = url.includes('.m3u8') || url.includes('/master') || url.includes('/hlsv2');
    const useHlsJs  = isHlsUrl && Hls.isSupported();
    const nativeHls = isHlsUrl && !Hls.isSupported() && videoEl.canPlayType('application/vnd.apple.mpegurl');

    if (useHlsJs) {
      initHlsJs(url);
    } else {
      const src = (!isHlsUrl || nativeHls) ? url : (normalizePlayableUrl(directUrl) || url);
      videoEl.src = src;
      videoEl.load();
    }

    videoEl.volume = $prefs.volume ?? 1;
    volume         = videoEl.volume;

    saveTimer = setInterval(() => {
      if (videoEl && !videoEl.paused && duration > 0) {
        recordProgress(type, videoId, currentTime, duration, { name: metaName, poster: metaPoster });
      }
    }, 5000);
  }

  function initHlsJs(url) {
    cleanupHls();
    hls = new Hls({
      enableWorker:         true,
      lowLatencyMode:       false,
      // Rewrite sub-manifest / segment URLs that stremio-server returns
      // with absolute paths (missing /ss/ prefix)
      xhrSetup(xhr, urlStr) {
        try {
          const u = new URL(urlStr, window.location.origin);
          const needs = /^\/[a-f0-9]{40}\//i.test(u.pathname) && !u.pathname.startsWith('/ss/');
          if (needs) {
            xhr.open('GET', `${u.origin}/ss${u.pathname}${u.search}`, true);
          }
        } catch { /* keep original */ }
      },
      // Buffer: keep back-buffer small (TV memory), front-buffer generous
      backBufferLength:     30,
      maxBufferLength:      60,
      maxMaxBufferLength:   120,
      startLevel:           -1,
      capLevelToPlayerSize: false,
      // ── Retry settings for stremio-server on-demand transcoding ──
      fragLoadingMaxRetry:           12,
      fragLoadingRetryDelay:         1500,
      fragLoadingMaxRetryTimeout:    45000,
      manifestLoadingMaxRetry:       6,
      manifestLoadingRetryDelay:     1500,
      manifestLoadingMaxRetryTimeout:20000,
      levelLoadingMaxRetry:          8,
      levelLoadingRetryDelay:        1500,
      levelLoadingMaxRetryTimeout:   20000,
      // ── Stall recovery ──
      highBufferWatchdogPeriod:      4,
      nudgeOffset:                   0.3,
      nudgeMaxRetry:                 10,
      maxStarvationDelay:            6,
      maxLoadingDelay:               8,
    });
    hls.loadSource(url);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      audioTracks       = [...(hls.audioTracks      || [])];
      hlsSubtitleTracks = [...(hls.subtitleTracks   || [])];
      // Sync currentAudioTrack to what hls.js defaulted to
      currentAudioTrack = hls.audioTrack;
      console.log('[hls] manifest parsed. Audio:', audioTracks.length,
        audioTracks.map(t => `id=${t.id} ${t.name}/${t.lang}`));
      console.log('[hls] Subtitle:', hlsSubtitleTracks.length,
        hlsSubtitleTracks.map(t => `id=${t.id} ${t.name}/${t.lang}`));
      applyPreferredAudio();
      videoEl.play().catch(() => {});
    });

    // Track list updates (may fire after MANIFEST_PARSED for late-arriving tracks)
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      audioTracks = [...(hls.audioTracks || [])];
      if (currentAudioTrack < 0) currentAudioTrack = hls.audioTrack;
    });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      hlsSubtitleTracks = [...(hls.subtitleTracks || [])];
    });

    // Sync when hls.js actually switches audio
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, d) => {
      currentAudioTrack = d.id;
      console.log('[hls] Audio switched to track id:', d.id);
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      console.warn('[hls] Error:', data.type, data.details, data.fatal);
      if (!data.fatal) return;
      console.error('[hls] Fatal error:', data);
      const fallback = normalizePlayableUrl(directUrl);
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // Try recovery first, then fallback after delay
        hls.startLoad();
        setTimeout(() => {
          if (!videoEl) return;  // component destroyed
          if (buffering || !playing) {
            if (fallback && fallback !== url) {
              cleanupHls(); videoEl.src = fallback; videoEl.load(); videoEl.play().catch(() => {});
            } else { errorMsg = 'Network error — stream may still be loading. Try again in a moment.'; }
          }
        }, 5000);
        return;
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        hlsFailed = true;
        if (fallback && fallback !== url && videoEl) {
          cleanupHls(); videoEl.src = fallback; videoEl.load(); videoEl.play().catch(() => {});
        } else { errorMsg = 'Playback error — format may be incompatible with your browser.'; }
      }
    });
  }

  function cleanupHls() {
    if (hls) { hls.stopLoad(); hls.detachMedia(); hls.destroy(); hls = null; }
  }

  function applyPreferredAudio() {
    if (!hls || !audioTracks.length) return;
    const pref = ($prefs.audioLanguage || 'eng').toLowerCase();
    const found = audioTracks.find(t =>
      t.lang?.toLowerCase() === pref ||
      t.lang?.toLowerCase().startsWith(pref.slice(0,2)) ||
      t.name?.toLowerCase().includes(pref)
    );
    if (found != null) {
      hls.audioTrack = found.id;
      currentAudioTrack = found.id;
    } else {
      currentAudioTrack = hls.audioTrack;
    }
  }

  // ── Video events ──────────────────────────────────────────────────────────
  function onPlay()    { playing = true;  buffering = false; }
  function onPause()   { playing = false; }
  function onWaiting() { buffering = true; }
  function onPlaying() { buffering = false; playing = true; }

  function onLoadedMeta() {
    duration = videoEl.duration || 0;
    if (resumePos > 10 && resumePos < duration - 30) {
      videoEl.currentTime = resumePos;
    }
    // Populate native audio tracks for direct video files (non-HLS)
    if (!hls && videoEl.audioTracks && videoEl.audioTracks.length > 1) {
      audioTracks = Array.from(videoEl.audioTracks).map((t, i) => ({
        id:      i,
        name:    t.label || t.language || `Track ${i + 1}`,
        lang:    t.language || '',
        _native: true,
      }));
    }
    videoEl.play().catch(() => {});
  }

  function onTimeUpdate()  { currentTime = videoEl.currentTime; }

  function onEnded() {
    recordProgress(type, videoId, duration, duration, { name: metaName, poster: metaPoster });
    dispatch('ended');
  }

  function onError() {
    if (!videoEl) return;
    const fallback = normalizePlayableUrl(directUrl);
    if (!hlsFailed && fallback && videoEl.src !== fallback) {
      cleanupHls();
      videoEl.src = fallback; videoEl.load(); videoEl.play().catch(() => {});
      return;
    }
    errorMsg = 'Cannot play this stream. Format may be unsupported by your browser.';
  }

  function onFullscreenChange() { fullscreen = !!document.fullscreenElement; }

  // ── URL normalization ─────────────────────────────────────────────────────
  function normalizePlayableUrl(url) {
    if (!url) return url;
    const localMediaPath = /^\/([a-f0-9]{40}|stream|hlsv2)\//i;
    try {
      const base   = window.location.origin;
      const parsed = new URL(url, base);
      const same   = parsed.origin === base;
      const needs  = localMediaPath.test(parsed.pathname) && !parsed.pathname.startsWith('/ss/');
      if (needs && same)             return `${base}/ss${parsed.pathname}${parsed.search || ''}`;
      if (needs && url.startsWith('/')) return `/ss${url}`;
      return parsed.toString();
    } catch { return url; }
  }

  // ── Controls helpers ──────────────────────────────────────────────────────
  function resetControlTimer() {
    showControls = true;
    clearTimeout(controlTimer);
    if (playing && !activePanel) {
      controlTimer = setTimeout(() => { showControls = false; }, 4000);
    }
  }

  function showFeedback(icon) {
    feedbackIcon = icon;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { feedbackIcon = ''; }, 700);
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) { videoEl.play().catch(() => {}); showFeedback('play'); }
    else                { videoEl.pause();                showFeedback('pause'); }
    resetControlTimer();
  }

  function seek(t) {
    if (!videoEl || !duration) return;
    videoEl.currentTime = Math.max(0, Math.min(duration, t));
  }

  function seekRelative(delta) {
    seek(currentTime + delta);
    showFeedback(delta > 0 ? 'ff' : 'rw');
    resetControlTimer();
  }

  function toggleMute() {
    videoEl.muted = !videoEl.muted;
    muted = videoEl.muted;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    videoEl.volume = volume;
    videoEl.muted  = volume === 0;
    muted          = videoEl.muted;
  }

  function toggleFullscreen() {
    const el = videoEl?.parentElement?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  function togglePanel(name) {
    activePanel = activePanel === name ? '' : name;
    resetControlTimer();
  }

  // ── Track selection ───────────────────────────────────────────────────────
  function setAudioTrack(trackId) {
    if (hls) {
      hls.audioTrack    = trackId;
      currentAudioTrack = trackId;
      console.log('[player] Switching audio to track id:', trackId);
    } else if (videoEl?.audioTracks) {
      // Native <video> audio tracks — id is the array index
      for (let i = 0; i < videoEl.audioTracks.length; i++) {
        videoEl.audioTracks[i].enabled = (i === trackId);
      }
      currentAudioTrack = trackId;
    }
    // Keep panel open so user sees the selection change
    resetControlTimer();
  }

  function setSubtitleTrack(track) {
    if (!videoEl) return;
    Array.from(videoEl.querySelectorAll('track')).forEach(t => t.remove());

    if (track.source === 'none') {
      activeSubTrack = -1; currentHlsSubTrack = -1;
      if (hls) hls.subtitleTrack = -1;
    } else if (track.source === 'hls') {
      if (hls) { hls.subtitleTrack = track.hlsIdx; currentHlsSubTrack = track.hlsIdx; }
      activeSubTrack = -1;
    } else if (track.source === 'external' && track.url) {
      if (hls) hls.subtitleTrack = -1;
      currentHlsSubTrack = -1;
      const t   = document.createElement('track');
      t.kind    = 'subtitles'; t.label = track.label;
      t.srclang = track.lang;  t.src   = subtitleProxyUrl(track.url);
      t.default = true;
      videoEl.appendChild(t);
      t.addEventListener('load', () => {
        videoEl.textTracks[videoEl.textTracks.length - 1].mode = 'showing';
      });
      activeSubTrack = subtitleTracks.findIndex(s => s.url === track.url);
    }
    // Keep panel open so user sees the selection change
    resetControlTimer();
  }

  // ── Seek bar ──────────────────────────────────────────────────────────────
  function onSeekInput(e) {
    const pct = parseFloat(e.target.value);
    seek((pct / 100) * duration);
  }

  function onSeekMouseMove(e) {
    if (!seekWrapEl || !duration) return;
    const rect = seekWrapEl.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    hoverPct   = pct * 100;
    hoverTime  = pct * duration;
  }

  function onSeekMouseLeave() { hoverPct = null; hoverTime = null; }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  function handleKey(e) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    resetControlTimer();

    if (matchKey(e, 'ENTER') || matchKey(e, 'PLAY')) { e.preventDefault(); e.stopImmediatePropagation(); togglePlay(); return; }
    if (matchKey(e, 'FF'))   { e.preventDefault(); e.stopImmediatePropagation(); seekRelative(30);  return; }
    if (matchKey(e, 'RW'))   { e.preventDefault(); e.stopImmediatePropagation(); seekRelative(-30); return; }
    if (matchKey(e, 'RIGHT') && !activePanel) { e.preventDefault(); e.stopImmediatePropagation(); seekRelative(10);  return; }
    if (matchKey(e, 'LEFT')  && !activePanel) { e.preventDefault(); e.stopImmediatePropagation(); seekRelative(-10); return; }
    if (matchKey(e, 'UP'))   { e.preventDefault(); e.stopImmediatePropagation(); setVolume(volume + 0.1); return; }
    if (matchKey(e, 'DOWN')) { e.preventDefault(); e.stopImmediatePropagation(); setVolume(volume - 0.1); return; }
    if (matchKey(e, 'BACK')) {
      e.stopImmediatePropagation();
      if (activePanel) { activePanel = ''; e.preventDefault(); return; }
      e.preventDefault(); dispatch('back'); return;
    }
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }
</script>

<!-- Player container -->
<div
  class="player"
  on:mousemove={resetControlTimer}
  on:click={() => { if (activePanel) { activePanel = ''; return; } togglePlay(); }}
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
  {#if buffering && !errorMsg}
    <div class="overlay-centre">
      <div class="buffer-ring"></div>
    </div>
  {/if}

  <!-- Error overlay -->
  {#if errorMsg}
    <div class="overlay-centre error-bg" on:click|stopPropagation>
      <svg class="err-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="13"/>
        <circle cx="12" cy="16" r="0.5" fill="currentColor"/>
      </svg>
      <p class="err-txt">{errorMsg}</p>
      <button class="err-retry" data-focusable="true" on:click={() => { errorMsg = ''; setupPlayer(); }}>
        Try again
      </button>
    </div>
  {/if}

  <!-- Centre feedback animation (play / pause / seek) -->
  {#if feedbackIcon}
    <div class="feedback" aria-hidden="true">
      {#if feedbackIcon === 'play'}
        <svg viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg>
      {:else if feedbackIcon === 'pause'}
        <svg viewBox="0 0 24 24" fill="white">
          <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
        </svg>
      {:else if feedbackIcon === 'ff'}
        <svg viewBox="0 0 24 24" fill="white">
          <polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>
        </svg>
      {:else if feedbackIcon === 'rw'}
        <svg viewBox="0 0 24 24" fill="white">
          <polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>
        </svg>
      {/if}
    </div>
  {/if}

  <!-- ───────────── Controls ──────────────────────────────────────────────── -->
  <div class="controls" class:visible={showControls || !playing || !!errorMsg || !!activePanel} on:click|stopPropagation>

    <div class="grad-top"    aria-hidden="true"></div>
    <div class="grad-bottom" aria-hidden="true"></div>

    <!-- Top bar -->
    <div class="top-bar">
      <button class="icon-btn back-pill" data-focusable="true" on:click={() => dispatch('back')} title="Back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span class="back-lbl">Back</span>
      </button>

      <p class="top-title" title={title}>{title}</p>

      <div class="top-actions">
        {#if hasAudio}
          <button
            class="icon-btn" class:active={activePanel === 'audio'}
            data-focusable="true"
            on:click|stopPropagation={() => togglePanel('audio')}
            title="Audio track"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
          </button>
        {/if}

        {#if hasAnySubs}
          <button
            class="icon-btn" class:active={activePanel === 'subs' || isSubActive}
            data-focusable="true"
            on:click|stopPropagation={() => togglePanel('subs')}
            title="Subtitles / CC"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="7" width="20" height="15" rx="2"/><path d="M17 12H7M12 17H7"/>
            </svg>
          </button>
        {/if}

        <button
          class="icon-btn" data-focusable="true"
          on:click|stopPropagation={toggleFullscreen}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {#if fullscreen}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
            </svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          {/if}
        </button>
      </div>
    </div>

    <!-- Bottom bar -->
    <div class="bottom-bar">

      <!-- Seek row -->
      <div
        class="seek-row"
        bind:this={seekWrapEl}
        on:mousemove={onSeekMouseMove}
        on:mouseleave={onSeekMouseLeave}
      >
        <span class="t-lbl">{formatTime(currentTime)}</span>

        <div class="seek-track">
          <div class="seek-fill"  style="width:{progressPct}%"></div>
          {#if hoverPct !== null}
            <div class="seek-ghost" style="width:{hoverPct}%"></div>
            <div
              class="seek-tip"
              style="left:{hoverPct}%;
                     transform:translateX(-{hoverPct < 8 ? 0 : hoverPct > 92 ? 100 : 50}%)"
            >{formatTime(hoverTime)}</div>
          {/if}
          <div class="seek-knob" style="left:{progressPct}%"></div>
          <input
            type="range" class="seek-input"
            min="0" max="100" step="0.05"
            value={progressPct}
            on:input={onSeekInput}
            on:click|stopPropagation
          />
        </div>

        <span class="t-lbl right">{formatTime(duration)}</span>
      </div>

      <!-- Button row -->
      <div class="btn-row">
        <div class="btn-grp">
          <!-- -30s -->
          <button class="icon-btn skip-btn" data-focusable="true"
            on:click|stopPropagation={() => seekRelative(-30)} title="-30s">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 17a6 6 0 1 1 0-10.66"/>
              <path d="M11 17V7l-4 4"/>
            </svg>
            <span class="skip-lbl">30</span>
          </button>

          <!-- Play / Pause -->
          <button class="icon-btn play-btn" data-focusable="true"
            on:click|stopPropagation={togglePlay} title={playing ? 'Pause' : 'Play'}>
            {#if playing}
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>
            {:else}
              <svg viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21"/>
              </svg>
            {/if}
          </button>

          <!-- +30s -->
          <button class="icon-btn skip-btn" data-focusable="true"
            on:click|stopPropagation={() => seekRelative(30)} title="+30s">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 17a6 6 0 1 0 0-10.66"/>
              <path d="M13 17V7l4 4"/>
            </svg>
            <span class="skip-lbl">30</span>
          </button>

          <!-- Volume -->
          <div class="vol-wrap" on:click|stopPropagation>
            <button class="icon-btn" data-focusable="true"
              on:click={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
              {#if muted || volume === 0}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                </svg>
              {:else if volume < 0.5}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
              {:else}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
              {/if}
            </button>
            <input
              class="vol-slider" type="range"
              min="0" max="1" step="0.05"
              value={volume}
              on:input={e => setVolume(parseFloat(e.target.value))}
            />
          </div>
        </div>

        <!-- Right group -->
        <div class="btn-grp right">
          {#if hasNext}
            <button
              class="icon-btn next-btn" data-focusable="true"
              on:click|stopPropagation={() => dispatch('next')}
            >
              Next episode
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div><!-- /controls -->

  <!-- ──────────── Side panel (Audio / Subtitles) ──────────────────────────── -->
  {#if activePanel}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="panel-backdrop" on:click={() => activePanel = ''} aria-hidden="true"></div>

    <div class="side-panel" role="dialog"
      aria-label={activePanel === 'audio' ? 'Audio tracks' : 'Subtitles'}
      on:click|stopPropagation
    >
      <div class="ph">
        <span class="ph-title">
          {#if activePanel === 'audio'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
            Audio
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="7" width="20" height="15" rx="2"/><path d="M17 12H7M12 17H7"/>
            </svg>
            Subtitles
          {/if}
        </span>
        <button class="icon-btn close-btn" on:click={() => activePanel = ''} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="pb">
        {#if activePanel === 'audio'}
          {#each audioTracks as track}
            <button
              class="pi" class:active={track.id === currentAudioTrack}
              data-focusable="true" on:click={() => setAudioTrack(track.id)}
            >
              <span class="pi-check">
                {#if track.id === currentAudioTrack}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                {/if}
              </span>
              <span class="pi-lbl">{langName(track.lang) || track.name || `Track ${track.id + 1}`}</span>
              {#if track.lang}<span class="pi-tag">{track.lang.toUpperCase()}</span>{/if}
            </button>
          {/each}

        {:else}
          <!-- Subtitles — Off option -->
          <button
            class="pi" class:active={!isSubActive}
            data-focusable="true"
            on:click={() => setSubtitleTrack({ source: 'none' })}
          >
            <span class="pi-check">
              {#if !isSubActive}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              {/if}
            </span>
            <span class="pi-lbl">Off</span>
          </button>

          <!-- Grouped sections -->
          {#each subGroups as group}
            <p class="ps-label">{group.label}</p>
            {#each group.tracks as track}
              {@const isActive =
                (track.source === 'hls'      && track.hlsIdx === currentHlsSubTrack) ||
                (track.source === 'external' && subtitleTracks.findIndex(s => s.url === track.url) === activeSubTrack)
              }
              <button
                class="pi" class:active={isActive}
                data-focusable="true" on:click={() => setSubtitleTrack(track)}
              >
                <span class="pi-check">
                  {#if isActive}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  {/if}
                </span>
                <span class="pi-lbl">{track.label}</span>
              </button>
            {/each}
          {/each}

          {#if subGroups.length === 0}
            <p class="p-empty">No subtitle tracks available.</p>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

</div>

<style>
  /* ── Root ──────────────────────────────────────────────────────────────────── */
  .player {
    position: fixed; inset: 0;
    background: #000;
    z-index: 1000;
    cursor: default;
    user-select: none;
    -webkit-user-select: none;
  }

  .video {
    width: 100%; height: 100%;
    object-fit: contain;
    display: block;
  }

  /* ── Centre overlays ─────────────────────────────────────────────────────── */
  .overlay-centre {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 18px;
    z-index: 20;
    pointer-events: none;
  }

  .buffer-ring {
    width: 56px; height: 56px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: rgba(255,255,255,0.9);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-bg { pointer-events: all; background: rgba(0,0,0,0.78); gap: 22px; }
  .err-icon { width: 56px; height: 56px; color: rgba(255,90,90,0.85); }
  .err-txt {
    color: rgba(255,255,255,0.72); font-size: 1rem; line-height: 1.55;
    max-width: 440px; text-align: center;
  }
  .err-retry {
    padding: 12px 32px; border-radius: 8px;
    background: var(--accent, #7c3aed); color: #fff;
    font-weight: 600; font-size: 1rem; cursor: pointer;
  }
  .err-retry:hover { background: var(--accent-light, #8b5cf6); }

  /* ── Feedback flash ──────────────────────────────────────────────────────── */
  .feedback {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 80px; height: 80px;
    background: rgba(0,0,0,0.52);
    backdrop-filter: blur(6px);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none; z-index: 35;
    animation: fbPop 0.7s ease forwards;
  }
  .feedback svg { width: 36px; height: 36px; }
  @keyframes fbPop {
    0%   { opacity: 0; transform: translate(-50%,-50%) scale(0.65); }
    20%  { opacity: 1; transform: translate(-50%,-50%) scale(1.06); }
    70%  { opacity: 1; transform: translate(-50%,-50%) scale(1);    }
    100% { opacity: 0; transform: translate(-50%,-50%) scale(0.92); }
  }

  /* ── Controls layer ──────────────────────────────────────────────────────── */
  .controls {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; justify-content: space-between;
    z-index: 30;
    opacity: 0; transition: opacity 0.28s ease;
    pointer-events: none;
  }
  .controls.visible { opacity: 1; pointer-events: all; }

  .grad-top {
    position: absolute; top: 0; left: 0; right: 0; height: 200px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, transparent 100%);
    pointer-events: none;
  }
  .grad-bottom {
    position: absolute; bottom: 0; left: 0; right: 0; height: 240px;
    background: linear-gradient(to top, rgba(0,0,0,0.92) 0%, transparent 100%);
    pointer-events: none;
  }

  /* ── Top bar ─────────────────────────────────────────────────────────────── */
  .top-bar {
    position: relative; z-index: 1;
    display: flex; align-items: center; gap: 12px;
    padding: 20px 28px 16px;
    pointer-events: all;
  }

  .back-pill {
    display: flex; align-items: center; gap: 6px;
    padding: 9px 18px 9px 12px;
    background: rgba(255,255,255,0.1);
    border-radius: 24px;
    font-size: 0.95rem; font-weight: 500;
    flex-shrink: 0;
    color: rgba(255,255,255,0.88);
  }
  .back-pill svg { width: 18px; height: 18px; }
  .back-lbl { color: inherit; }

  .top-title {
    flex: 1; margin: 0;
    font-size: 1.05rem; font-weight: 600;
    color: rgba(255,255,255,0.9);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-align: center;
  }

  .top-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

  /* ── Bottom bar ──────────────────────────────────────────────────────────── */
  .bottom-bar {
    position: relative; z-index: 1;
    display: flex; flex-direction: column; gap: 10px;
    padding: 16px 28px 30px;
    pointer-events: all;
  }

  /* Seek row */
  .seek-row {
    display: flex; align-items: center; gap: 14px;
  }
  .t-lbl {
    font-size: 0.9rem; font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,0.7); white-space: nowrap;
    min-width: 50px; flex-shrink: 0;
  }
  .t-lbl.right { text-align: right; }

  .seek-track {
    position: relative; flex: 1;
    height: 5px; border-radius: 4px;
    background: rgba(255,255,255,0.2);
    cursor: pointer;
    transition: height 0.14s;
  }
  .seek-row:hover .seek-track { height: 8px; }

  .seek-fill {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: var(--accent-light, #8b5cf6);
    border-radius: 4px; pointer-events: none;
    transition: width 0.1s linear;
  }
  .seek-ghost {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: rgba(255,255,255,0.3);
    border-radius: 4px; pointer-events: none;
  }
  .seek-knob {
    position: absolute; top: 50%;
    width: 16px; height: 16px;
    background: #fff; border-radius: 50%;
    transform: translate(-50%, -50%) scale(0.75);
    pointer-events: none;
    transition: transform 0.14s;
    box-shadow: 0 1px 5px rgba(0,0,0,0.5);
  }
  .seek-row:hover .seek-knob { transform: translate(-50%, -50%) scale(1); }

  .seek-tip {
    position: absolute; bottom: 22px;
    background: rgba(8,8,18,0.95); color: #fff;
    font-size: 0.8rem; font-variant-numeric: tabular-nums;
    padding: 4px 10px; border-radius: 5px;
    pointer-events: none; white-space: nowrap;
  }

  .seek-input {
    position: absolute; inset: -12px 0;
    width: 100%; height: calc(100% + 24px);
    opacity: 0; cursor: pointer; margin: 0;
    -webkit-appearance: none;
  }

  /* Button row */
  .btn-row {
    display: flex; align-items: center; justify-content: space-between;
  }
  .btn-grp { display: flex; align-items: center; gap: 4px; }
  .btn-grp.right { margin-left: auto; }

  /* SVG icon sizing — controls scale via the container, not inline attrs */
  .icon-btn svg       { width: 22px; height: 22px; }
  .play-btn svg       { width: 28px; height: 28px; }
  .close-btn svg      { width: 18px; height: 18px; }
  .ph-title svg       { width: 16px; height: 16px; }
  .pi-check svg       { width: 14px; height: 14px; }
  .next-btn svg       { width: 14px; height: 14px; }

  /* Generic icon button */
  .icon-btn {
    display: flex; align-items: center; justify-content: center;
    padding: 11px; border-radius: 8px;
    color: rgba(255,255,255,0.8);
    transition: color 0.13s, background 0.13s;
    cursor: pointer;
  }
  .icon-btn:hover, .icon-btn:focus-visible {
    color: #fff; background: rgba(255,255,255,0.12); outline: none;
  }
  .icon-btn:focus-visible {
    outline: 2px solid rgba(139,92,246,0.75); outline-offset: 2px;
  }
  .icon-btn.active { color: var(--accent-light, #8b5cf6); }
  .icon-btn.active:hover { background: rgba(139,92,246,0.15); }

  .play-btn {
    width: 62px; height: 62px; border-radius: 50%;
    background: rgba(255,255,255,0.12); padding: 0; color: #fff;
  }
  .play-btn:hover { background: var(--accent, #7c3aed); color: #fff; }

  /* Skip button: icon + text label */
  .skip-btn { position: relative; }
  .skip-lbl {
    position: absolute; bottom: 2px; right: 4px;
    font-size: 0.55rem; font-weight: 700;
    color: rgba(255,255,255,0.6);
    pointer-events: none;
  }

  /* Volume */
  .vol-wrap { display: flex; align-items: center; }
  .vol-slider {
    width: 110px; height: 4px;
    accent-color: var(--accent-light, #8b5cf6);
    cursor: pointer; border-radius: 2px;
    margin: 0 6px;
  }

  /* Next episode */
  .next-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 20px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    font-size: 0.9rem; font-weight: 500;
    color: rgba(255,255,255,0.85);
  }
  .next-btn:hover { background: var(--accent, #7c3aed); border-color: transparent; color: #fff; }

  /* ── Side panel ──────────────────────────────────────────────────────────── */
  .panel-backdrop {
    position: absolute; inset: 0; z-index: 40;
  }

  .side-panel {
    position: absolute; top: 0; right: 0; bottom: 0;
    width: 320px; max-width: 92vw;
    background: rgba(8, 8, 16, 0.97);
    backdrop-filter: blur(22px);
    border-left: 1px solid rgba(255,255,255,0.07);
    z-index: 50;
    display: flex; flex-direction: column;
    animation: slideIn 0.22s ease;
  }
  @keyframes slideIn {
    from { transform: translateX(40px); opacity: 0; }
    to   { transform: translateX(0);    opacity: 1; }
  }

  /* Panel header */
  .ph {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 16px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
  }
  .ph-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.82rem; font-weight: 700;
    color: rgba(255,255,255,0.6);
    text-transform: uppercase; letter-spacing: 0.8px;
  }

  /* Panel body */
  .pb {
    flex: 1; overflow-y: auto; padding: 8px;
  }
  .pb::-webkit-scrollbar { width: 3px; }
  .pb::-webkit-scrollbar-track { background: transparent; }
  .pb::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.12); border-radius: 2px;
  }

  .ps-label {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1.1px;
    color: rgba(255,255,255,0.3); padding: 16px 10px 6px;
    font-weight: 700;
  }

  /* Panel item */
  .pi {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 12px 10px;
    border-radius: 8px; text-align: left;
    color: rgba(255,255,255,0.65); font-size: 0.95rem;
    transition: background 0.1s, color 0.1s; cursor: pointer;
  }
  .pi:hover, .pi:focus-visible {
    background: rgba(255,255,255,0.09); color: #fff; outline: none;
  }
  .pi:focus-visible {
    outline: 2px solid rgba(139,92,246,0.7); outline-offset: -2px;
  }
  .pi.active { color: var(--accent-light, #8b5cf6); }
  .pi.active:hover { background: rgba(139,92,246,0.1); }

  .pi-check {
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; color: var(--accent-light, #8b5cf6);
  }
  .pi-lbl { flex: 1; }
  .pi-tag {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.4px;
    background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.38);
    padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
  }
  .p-empty {
    padding: 28px 12px; text-align: center;
    color: rgba(255,255,255,0.28); font-size: 0.9rem;
  }

  /* ── TV-scale (HD 960px+) ─────────────────────────────────────────────── */
  @media (min-width: 960px) {
    .top-bar         { padding: 24px 36px 18px; gap: 16px; }
    .bottom-bar      { padding: 18px 36px 36px; gap: 12px; }
    .seek-row        { gap: 18px; }
    .t-lbl           { font-size: 1rem; min-width: 60px; }
    .seek-track      { height: 6px; }
    .seek-row:hover .seek-track { height: 10px; }
    .seek-knob       { width: 20px; height: 20px; }
    .seek-tip        { font-size: 0.88rem; padding: 5px 12px; bottom: 26px; }

    .icon-btn        { padding: 14px; }
    .icon-btn svg    { width: 26px; height: 26px; }
    .play-btn        { width: 72px; height: 72px; }
    .play-btn svg    { width: 34px; height: 34px; }
    .skip-lbl        { font-size: 0.62rem; }

    .vol-slider      { width: 130px; }
    .top-title       { font-size: 1.15rem; }
    .back-pill       { font-size: 1rem; padding: 10px 20px 10px 14px; }
    .back-pill svg   { width: 20px; height: 20px; }
    .next-btn        { font-size: 0.95rem; padding: 11px 22px; }
    .next-btn svg    { width: 16px; height: 16px; }
    .btn-grp         { gap: 6px; }

    .side-panel      { width: 380px; }
    .ph              { padding: 20px 18px 16px; }
    .ph-title        { font-size: 0.88rem; }
    .ph-title svg    { width: 18px; height: 18px; }
    .pb              { padding: 10px; }
    .pi              { padding: 14px 12px; font-size: 1.05rem; gap: 12px; }
    .pi-check        { width: 22px; height: 22px; }
    .pi-check svg    { width: 16px; height: 16px; }
    .ps-label        { font-size: 0.78rem; padding: 20px 12px 8px; }
    .pi-tag          { font-size: 0.72rem; padding: 3px 7px; }

    .feedback        { width: 90px; height: 90px; }
    .feedback svg    { width: 40px; height: 40px; }
    .buffer-ring     { width: 60px; height: 60px; }
    .err-txt         { font-size: 1.1rem; max-width: 500px; }
    .err-retry       { padding: 14px 36px; font-size: 1.05rem; }
  }

  /* ── Small screens ──────────────────────────────────────────────────────── */
  @media (max-width: 600px) {
    .top-bar, .bottom-bar { padding-left: 14px; padding-right: 14px; }
    .side-panel { width: 100%; max-width: 100%; border-left: none; }
    .vol-slider { width: 70px; }
    .back-lbl   { display: none; }
    .top-title  { font-size: 0.82rem; }
    .play-btn   { width: 50px; height: 50px; }
    .play-btn svg { width: 24px; height: 24px; }
    .icon-btn svg { width: 20px; height: 20px; }
  }
</style>
