<script>
  import { push } from 'svelte-spa-router';
  import { auth }  from '../stores/auth.js';
  import { loadAddons } from '../stores/addons.js';
  import { login }  from '../lib/api.js';

  let email    = '';
  let password = '';
  let loading  = false;
  let errorMsg = '';

  async function handleLogin() {
    if (!email.trim() || !password) { errorMsg = 'Please enter email and password.'; return; }
    loading  = true;
    errorMsg = '';

    try {
      const data = await login(email.trim(), password);
      auth.login(data.authKey, data.user);
      await loadAddons(data.authKey);
      push('/');
    } catch (e) {
      errorMsg = e.message || 'Login failed. Check your credentials.';
    } finally {
      loading = false;
    }
  }

  function onKeydown(e) {
    if (e.key === 'Enter') handleLogin();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="login-page">
  <div class="login-card">
    <!-- Logo / Brand -->
    <div class="brand">
      <svg class="brand-icon" viewBox="0 0 48 48" width="48" height="48">
        <circle cx="24" cy="24" r="22" fill="var(--accent)"/>
        <polygon points="20 14 34 24 20 34" fill="#fff"/>
      </svg>
      <h1>Stremio TV</h1>
    </div>

    <p class="subtitle">Sign in with your Stremio account to continue</p>

    <div class="form">
      <div class="field">
        <label for="email">Email</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          placeholder="your@email.com"
          autocomplete="username"
          data-focusable="true"
          disabled={loading}
        />
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          placeholder="••••••••"
          autocomplete="current-password"
          data-focusable="true"
          disabled={loading}
        />
      </div>

      {#if errorMsg}
        <p class="error-msg">{errorMsg}</p>
      {/if}

      <button
        class="btn-login"
        data-focusable="true"
        disabled={loading}
        on:click={handleLogin}
      >
        {#if loading}
          <span class="spin"></span> Signing in…
        {:else}
          Sign In
        {/if}
      </button>
    </div>

    <p class="note">
      Your credentials are used only to authenticate with the official Stremio API and are not stored on this server.
    </p>
  </div>
</div>

<style>
  .login-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-primary);
    padding: 24px;
  }

  .login-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 48px 40px;
    width: 100%;
    max-width: 440px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .brand h1 {
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.5px;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 0.95rem;
    margin-top: -12px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .field input {
    padding: 14px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 1rem;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.25);
  }

  .field input:disabled { opacity: 0.6; }

  .error-msg {
    padding: 12px 16px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius-sm);
    color: #f87171;
    font-size: 0.88rem;
  }

  .btn-login {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: #fff;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.3px;
    transition: all var(--transition);
    margin-top: 4px;
  }

  .btn-login:hover:not(:disabled), .btn-login.focused:not(:disabled) {
    background: var(--accent-light);
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(124,58,237,0.4);
  }
  .btn-login:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

  .spin {
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .note {
    font-size: 0.76rem;
    color: var(--text-dim);
    text-align: center;
    line-height: 1.5;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }
</style>
