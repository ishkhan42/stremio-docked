<script>
  import { createEventDispatcher } from 'svelte';
  import { parseStreamInfo } from '../lib/addons.js';
  import { getMediaInfo } from '../lib/api.js';

  export let streams = [];
  export let loading = false;

  const dispatch = createEventDispatcher();

  let filterQuality = 'all';
  let diagnosticsByKey = {};
  let diagnosticsReqSeq = 0;

  const qualityOptions = ['all', '4K', '1080p', '720p', '480p'];

  $: parsed = streams
    .map((s, i) => ({ ...s, _info: parseStreamInfo(s), _originalIndex: i }))
    .sort((a, b) => {
      const sa = Number.isFinite(a?._info?.seeds) ? Number(a._info.seeds) : -1;
      const sb = Number.isFinite(b?._info?.seeds) ? Number(b._info.seeds) : -1;
      if (sb !== sa) return sb - sa;
      return a._originalIndex - b._originalIndex;
    });

  $: filtered = filterQuality === 'all'
    ? parsed
    : parsed.filter(s => s._info.quality === filterQuality);

  $: if (parsed.length) {
    hydrateDiagnostics(parsed);
  }

  function pickStream(stream) {
    dispatch('select', stream);
  }

  function seedColor(seeds) {
    if (!seeds) return 'var(--text-dim)';
    if (seeds > 50) return 'var(--green)';
    if (seeds > 10) return 'var(--yellow)';
    return 'var(--red)';
  }

  function extractTorrentRef(stream) {
    const hash = String(stream?.infoHash || '').toLowerCase();
    const idx = Number(stream?.fileIdx || 0);
    if (/^[a-f0-9]{40}$/i.test(hash)) {
      return { infoHash: hash, fileIdx: Number.isInteger(idx) && idx >= 0 ? idx : 0 };
    }

    const urlStr = String(stream?.url || '');
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr, window.location.origin);
      const m = u.pathname.match(/^\/([a-f0-9]{40})\/(\d+)(?:\/.*)?$/i);
      if (!m) return null;
      return { infoHash: m[1].toLowerCase(), fileIdx: Number(m[2]) || 0 };
    } catch {
      return null;
    }
  }

  function diagKey(ref) {
    if (!ref) return '';
    return `${ref.infoHash}:${ref.fileIdx}`;
  }

  async function hydrateDiagnostics(rows) {
    const seq = ++diagnosticsReqSeq;
    const refs = rows
      .map(extractTorrentRef)
      .filter(Boolean);
    const keys = [...new Set(refs.map(diagKey).filter(Boolean))];
    if (!keys.length) return;

    for (const key of keys) {
      if (diagnosticsByKey[key] || seq !== diagnosticsReqSeq) continue;
      const [infoHash, fileIdxStr] = key.split(':');
      try {
        const info = await getMediaInfo(infoHash, Number(fileIdxStr || 0));
        if (seq !== diagnosticsReqSeq) return;
        diagnosticsByKey = {
          ...diagnosticsByKey,
          [key]: {
            audio: Array.isArray(info?.audio) ? info.audio : [],
            subtitles: Array.isArray(info?.subtitles) ? info.subtitles : [],
          },
        };
      } catch {
        if (seq !== diagnosticsReqSeq) return;
        diagnosticsByKey = { ...diagnosticsByKey, [key]: { audio: [], subtitles: [] } };
      }
    }
  }

  const FLAG_BY_LANG = {
    en: 'US', eng: 'US',
    es: 'ES', spa: 'ES',
    pt: 'PT', por: 'PT',
    fr: 'FR', fra: 'FR',
    de: 'DE', deu: 'DE',
    it: 'IT', ita: 'IT',
    ru: 'RU', rus: 'RU',
    uk: 'UA', ukr: 'UA',
    pl: 'PL', pol: 'PL',
    tr: 'TR', tur: 'TR',
    ar: 'SA', ara: 'SA',
    hi: 'IN', hin: 'IN',
    ja: 'JP', jpn: 'JP',
    ko: 'KR', kor: 'KR',
    zh: 'CN', zho: 'CN', cmn: 'CN',
    nl: 'NL', nld: 'NL',
    sv: 'SE', swe: 'SE',
    fi: 'FI', fin: 'FI',
    no: 'NO', nor: 'NO',
    da: 'DK', dan: 'DK',
    cs: 'CZ', ces: 'CZ',
    el: 'GR', ell: 'GR',
    he: 'IL', heb: 'IL',
    ro: 'RO', ron: 'RO', rum: 'RO',
    hu: 'HU', hun: 'HU',
    id: 'ID', ind: 'ID',
    th: 'TH', tha: 'TH',
    vi: 'VN', vie: 'VN',
  };

  function toFlagEmoji(countryCode) {
    const cc = String(countryCode || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
    const codePoints = [...cc].map((c) => 127397 + c.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  }

  function audioFlagSummary(stream) {
    const hinted = Array.isArray(stream?._info?.audioLangs) ? stream._info.audioLangs : [];
    if (hinted.length) {
      return [...new Set(hinted)].slice(0, 5).map((lang) => ({
        lang,
        flag: toFlagEmoji(FLAG_BY_LANG[lang] || FLAG_BY_LANG[String(lang).slice(0, 2)] || ''),
      }));
    }

    const ref = extractTorrentRef(stream);
    if (!ref) return [];
    const diag = diagnosticsByKey[diagKey(ref)];
    if (!diag?.audio?.length) return [];
    const langs = [...new Set(diag.audio.map((a) => String(a?.language || '').toLowerCase()).filter(Boolean))];
    return langs.slice(0, 5).map((lang) => ({
      lang,
      flag: toFlagEmoji(FLAG_BY_LANG[lang] || FLAG_BY_LANG[lang.slice(0, 2)] || ''),
    }));
  }

  function subtitleCount(stream) {
    if (stream?._info?.subtitlesEmbedded) return 1;

    const ref = extractTorrentRef(stream);
    if (!ref) return 0;
    const diag = diagnosticsByKey[diagKey(ref)];
    return Array.isArray(diag?.subtitles) ? diag.subtitles.length : 0;
  }
</script>

<div class="stream-picker">
  <!-- Quality filter chips -->
  <div class="filter-chips">
    {#each qualityOptions as q}
      <button
        class="chip"
        class:active={filterQuality === q}
        data-focusable="true"
        on:click={() => filterQuality = q}
      >{q === 'all' ? 'All' : q}</button>
    {/each}
  </div>

  {#if loading}
    <div class="stream-loading">
      <div class="spinner"></div>
      <span>Loading streams…</span>
    </div>
  {:else if filtered.length === 0}
    <p class="no-streams">No streams available{filterQuality !== 'all' ? ` for ${filterQuality}` : ''}.</p>
  {:else}
    <div class="stream-list">
      {#each filtered as stream, i (i)}
        <button
          class="stream-item"
          data-focusable="true"
          on:click={() => pickStream(stream)}
        >
          <div class="stream-main">
            <div class="stream-badges">
              {#if stream._info.quality}
                <span class="badge quality q-{stream._info.quality.replace('p','')}">{stream._info.quality}</span>
              {/if}
              {#if stream._info.hdr}
                <span class="badge hdr">{stream._info.hdr}</span>
              {/if}
              {#if stream._info.codec}
                <span class="badge codec">{stream._info.codec}</span>
              {/if}
              {#if stream._info.audio}
                <span class="badge audio">{stream._info.audio}</span>
              {/if}
              {#if audioFlagSummary(stream).length}
                <span class="badge audio-langs" title="Embedded audio tracks">
                  Audio {audioFlagSummary(stream).map((x) => x.flag).join(' ')}
                </span>
              {/if}
              {#if subtitleCount(stream) > 0}
                <span class="badge subs">Subs {subtitleCount(stream)}</span>
              {/if}
            </div>

            <p class="stream-name">{stream._info.name || stream.name || 'Stream'}</p>

            {#if stream._info.desc && stream._info.desc !== stream._info.name}
              <p class="stream-desc">{stream._info.desc}</p>
            {/if}
          </div>

          <div class="stream-stats">
            {#if stream._info.seeds !== null}
              <span class="seeds" style="color:{seedColor(stream._info.seeds)}">
                👤 {stream._info.seeds}
              </span>
            {/if}
            {#if stream._info.size}
              <span class="size">💾 {stream._info.size}</span>
            {/if}
          </div>

          <div class="stream-arrow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .stream-picker { display: flex; flex-direction: column; gap: 12px; }

  .filter-chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .chip {
    padding: 5px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-muted);
    font-size: 0.82rem;
    font-weight: 500;
    transition: all var(--transition);
  }

  .chip.active, .chip:hover {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .stream-loading {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 24px 0;
    color: var(--text-muted);
  }

  .no-streams {
    color: var(--text-dim);
    padding: 16px 0;
    font-size: 0.9rem;
  }

  .stream-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 400px;
    overflow-y: auto;
  }

  .stream-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    border: 1px solid var(--border);
    text-align: left;
    transition: all var(--transition);
    width: 100%;
  }

  .stream-item:hover,
  .stream-item.focused {
    background: var(--bg-elevated);
    border-color: var(--accent);
  }

  .stream-main { flex: 1; min-width: 0; }

  .stream-badges {
    display: flex;
    gap: 4px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .badge {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .badge.quality  { background: rgba(124,58,237,0.2); color: var(--accent-light); border: 1px solid rgba(124,58,237,0.3); }
  .badge.q-2160   { background: rgba(245,158,11,0.2); color: #f59e0b; border-color: rgba(245,158,11,0.3); }
  .badge.hdr      { background: rgba(6,182,212,0.15); color: var(--cyan); border: 1px solid rgba(6,182,212,0.3); }
  .badge.codec    { background: rgba(255,255,255,0.06); color: var(--text-muted); border: 1px solid var(--border); }
  .badge.audio    { background: rgba(34,197,94,0.1); color: var(--green); border: 1px solid rgba(34,197,94,0.2); }
  .badge.audio-langs { background: rgba(16,185,129,0.12); color: #9af4d0; border: 1px solid rgba(16,185,129,0.24); }
  .badge.subs { background: rgba(56,189,248,0.16); color: #93dbff; border: 1px solid rgba(56,189,248,0.28); }

  .stream-name {
    font-size: 0.88rem;
    font-weight: 500;
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .stream-desc {
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stream-stats {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    font-size: 0.78rem;
    flex-shrink: 0;
  }

  .seeds, .size { white-space: nowrap; }

  .stream-arrow { color: var(--text-dim); flex-shrink: 0; }

  /* ── TV-scale ──────────────────────────────── */
  @media (min-width: 960px) {
    .chip          { padding: 7px 18px; font-size: 0.9rem; }
    .stream-item   { padding: 16px 18px; gap: 14px; }
    .stream-name   { font-size: 0.95rem; }
    .stream-desc   { font-size: 0.84rem; }
    .badge         { font-size: 0.74rem; padding: 3px 9px; }
    .stream-stats  { font-size: 0.84rem; }
    .stream-list   { max-height: 450px; }
    .stream-arrow svg { width: 18px; height: 18px; }
  }
</style>
