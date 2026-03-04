<script>
  import { push, location } from 'svelte-spa-router';
  import { auth, currentUser } from '../stores/auth.js';
  import { logout as apiLogout } from '../lib/api.js';

  const navItems = [
    { label: 'Home',     path: '/',        icon: 'home'   },
    { label: 'Library',  path: '/library', icon: 'library' },
    { label: 'Downloads',path: '/downloads',icon: 'downloads' },
    { label: 'Search',   path: '/search',  icon: 'search' },
    { label: 'Settings', path: '/settings',icon: 'settings'},
  ];

  async function handleLogout() {
    await apiLogout($auth?.authKey).catch(() => {});
    auth.logout();
    push('/');
  }

  $: activePath = $location;
</script>

<nav class="navbar">
  <div class="logo">
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#7c3aed"/>
      <path d="M10 10l12 6-12 6V10z" fill="white"/>
    </svg>
    <span>Stremio</span>
  </div>

  <ul class="nav-links">
    {#each navItems as item}
      <li>
        <button
          data-focusable="true"
          class="nav-btn"
          class:active={activePath === item.path}
          on:click={() => push(item.path)}
        >
          {#if item.icon === 'home'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          {:else if item.icon === 'library'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 6h16"/>
              <path d="M4 12h16"/>
              <path d="M4 18h10"/>
            </svg>
          {:else if item.icon === 'search'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          {:else if item.icon === 'downloads'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>
            </svg>
          {:else if item.icon === 'settings'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
          {/if}
          <span>{item.label}</span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="user-area">
    {#if $currentUser}
      <div class="user-info">
        <img
          class="avatar"
          src={$currentUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent($currentUser.email)}&background=7c3aed&color=fff&size=40`}
          alt="avatar"
          on:error={e => { e.target.src = `https://ui-avatars.com/api/?name=U&background=7c3aed&color=fff&size=40`; }}
        />
        <span class="email truncate">{$currentUser.email}</span>
      </div>
    {/if}
    <button data-focusable="true" class="logout-btn" on:click={handleLogout} title="Logout">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
    </button>
  </div>
</nav>

<style>
  .navbar {
    height: var(--nav-h);
    background: linear-gradient(to bottom, rgba(10,10,15,0.98) 0%, rgba(10,10,15,0.85) 100%);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 40px;
    gap: 32px;
    flex-shrink: 0;
    z-index: 100;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 1.2rem;
    letter-spacing: -0.5px;
    flex-shrink: 0;
  }

  .nav-links {
    display: flex;
    list-style: none;
    gap: 4px;
    flex: 1;
  }

  .nav-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.95rem;
    font-weight: 500;
    transition: color var(--transition), background var(--transition);
  }

  .nav-btn:hover,
  .nav-btn.active {
    color: var(--text-primary);
    background: rgba(255,255,255,0.07);
  }

  .nav-btn.active {
    color: var(--accent-light);
  }

  .user-area {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 200px;
  }

  .avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    flex-shrink: 0;
    object-fit: cover;
  }

  .email {
    font-size: 0.85rem;
    color: var(--text-muted);
    max-width: 150px;
  }

  .logout-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: color var(--transition), background var(--transition);
  }

  .logout-btn:hover {
    color: var(--red);
    background: rgba(239,68,68,0.1);
  }

  /* ── TV-scale ──────────────────────────────────────────── */
  @media (min-width: 960px) {
    .navbar   { padding: 0 var(--page-x, 48px); gap: 36px; }
    .logo     { font-size: 1.35rem; }
    .logo svg { width: 32px; height: 32px; }
    .nav-btn  { padding: 10px 22px; font-size: 1rem; gap: 10px; }
    .nav-btn svg { width: 20px; height: 20px; }
    .avatar   { width: 38px; height: 38px; }
    .email    { font-size: 0.9rem; }
    .logout-btn { width: 40px; height: 40px; }
    .logout-btn svg { width: 22px; height: 22px; }
  }
</style>
