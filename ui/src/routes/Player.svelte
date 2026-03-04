<script>
  import { onMount } from 'svelte';
  import { pop, push } from 'svelte-spa-router';
  import VideoPlayer from '../components/VideoPlayer.svelte';
  import { loadPlayerState, savePlayerState, clearPlayerState } from '../lib/storage.js';

  // Player state is passed via history.state from MetaDetails
  let playerState = null;
  let stateError  = false;

  onMount(() => {
    playerState = history.state;
    if (!playerState?.streamUrl && !playerState?.directUrl) {
      playerState = loadPlayerState();
    }

    if (!playerState?.streamUrl && !playerState?.directUrl) {
      stateError = true;
      return;
    }

    // Prevent browser back from exiting video unexpectedly
    savePlayerState(playerState);
    history.replaceState(playerState, '');
  });

  function handleBack() {
    clearPlayerState();
    pop();
  }

  function handleEnded() {
    clearPlayerState();
    if (playerState?.hasNext && playerState?.nextEpisodeId) {
      // Next episode: pop back to meta page where user can pick next stream
      pop();
    } else {
      pop();
    }
  }
</script>

{#if stateError}
  <div class="player-error">
    <p>No stream to play. Please go back and select a stream.</p>
    <button class="back-btn" data-focusable="true" on:click={pop}>← Back</button>
  </div>
{:else if playerState}
  <VideoPlayer
    streamUrl={playerState.streamUrl}
    directUrl={playerState.directUrl}
    hlsUrl={playerState.hlsUrl || ''}
    infoHash={playerState.infoHash || ''}
    fileIdx={playerState.fileIdx ?? 0}
    streamType={playerState.streamType}
    title={playerState.title}
    metaName={playerState.metaName || playerState.title || ''}
    metaPoster={playerState.metaPoster || ''}
    type={playerState.type}
    metaId={playerState.metaId || ''}
    videoId={playerState.videoId}
    resumePos={playerState.resumePos}
    isDownloaded={!!playerState.isDownloaded}
    subtitleTracks={playerState.subtitleTracks || []}
    hasNext={playerState.hasNext}
    on:back={handleBack}
    on:ended={handleEnded}
    on:next={handleEnded}
  />
{:else}
  <div class="player-loading">
    <div class="spinner"></div>
    <p>Preparing player…</p>
  </div>
{/if}

<style>
  .player-error, .player-loading {
    position: fixed;
    inset: 0;
    background: #000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    color: rgba(255,255,255,0.7);
  }

  .back-btn {
    padding: 12px 28px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-weight: 600;
    font-size: 1rem;
  }

  .spinner {
    width: 36px; height: 36px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: rgba(255,255,255,0.7);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
