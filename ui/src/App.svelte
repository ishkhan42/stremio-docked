<script>
  import Router from 'svelte-spa-router';
  import { push } from 'svelte-spa-router';
  import { onMount } from 'svelte';

  import Login      from './routes/Login.svelte';
  import Board      from './routes/Board.svelte';
  import MetaDetails from './routes/MetaDetails.svelte';
  import Player     from './routes/Player.svelte';
  import Search     from './routes/Search.svelte';
  import Settings   from './routes/Settings.svelte';

  import NavBar from './components/NavBar.svelte';

  import { isLoggedIn } from './stores/auth.js';
  import { initNav }    from './lib/keyboard.js';

  const routes = {
    '/':                  Board,
    '/search':            Search,
    '/meta/:type/:id':    MetaDetails,
    '/player':            Player,
    '/settings':          Settings,
    '*':                  Board,
  };

  let showNav = true;

  // Hide nav bar while in fullscreen player
  $: showNav = true; // player hides it via CSS

  onMount(() => {
    initNav();
    // Redirect to login if not authenticated
    if (!$isLoggedIn) push('/login');
  });

  // Extend routes conditionally
  $: if (!$isLoggedIn) {
    // Dynamic: login route handled below
  }
</script>

{#if !$isLoggedIn}
  <Login />
{:else}
  <div class="app-shell">
    <NavBar />
    <main class="page-content">
      <Router {routes} />
    </main>
  </div>
{/if}

<style>
  :global(*), :global(*::before), :global(*::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(:root) {
    --bg-primary:    #0a0a0f;
    --bg-card:       #141420;
    --bg-elevated:   #1c1c2e;
    --bg-overlay:    rgba(0, 0, 0, 0.85);
    --accent:        #7c3aed;
    --accent-light:  #a855f7;
    --accent-glow:   rgba(124, 58, 237, 0.4);
    --red:           #ef4444;
    --green:         #22c55e;
    --yellow:        #f59e0b;
    --cyan:          #06b6d4;
    --text-primary:  #f8fafc;
    --text-muted:    #94a3b8;
    --text-dim:      #475569;
    --border:        rgba(255, 255, 255, 0.08);
    --radius-sm:     6px;
    --radius:        12px;
    --radius-lg:     18px;
    --bg-surface:    #1c1c2e;
    --nav-h:         72px;
    --page-x:        40px;
    --transition:    200ms ease;
    font-size: 16px;
  }

  :global(html), :global(body), :global(#app) {
    width: 100%; height: 100%;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }

  :global(button) {
    cursor: pointer;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
  }

  :global(a) {
    color: inherit;
    text-decoration: none;
  }

  :global(img) {
    display: block;
    max-width: 100%;
  }

  /* ── Focus styles for TV navigation ───────────────────────────────────── */
  :global([data-focusable="true"]) {
    outline: none;
    transition: transform var(--transition), box-shadow var(--transition), border-color var(--transition);
  }

  :global([data-focusable="true"].focused) {
    transform: scale(1.06);
    box-shadow: 0 0 0 3px var(--accent), 0 0 24px var(--accent-glow);
    z-index: 10;
    position: relative;
  }

  /* Focused buttons / nav items */
  :global(button[data-focusable="true"].focused) {
    background: var(--accent) !important;
    color: #fff !important;
  }

  /* ── Scrollbars (hidden on TV) ─────────────────────────────────────────── */
  :global(::-webkit-scrollbar) { width: 0; height: 0; }

  /* ── Loading spinner ───────────────────────────────────────────────────── */
  /* ── Utility classes ───────────────────────────────────────────────────── */
  :global(.truncate) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.page-loading) {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 60vh;
    flex-direction: column;
    gap: 16px;
    color: var(--text-muted);
  }

  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }

  .page-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
  }
</style>
