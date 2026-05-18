/* eslint-disable */
/**
 * App boot — picks the provider, routes to the right screen, wires
 * the landing/login flows. Admin and player flows live in admin.js
 * and player.js respectively; this file only handles "what screen
 * are we on right now".
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const { $, showToast, showScreen, Log } = U;

  // The hard-coded `admin / admin` credentials are a DEVELOPMENT
  // fallback used only when:
  //   - the provider is mock (single-browser demo / Playwright), OR
  //   - no `HG.adminPasswordHash` is set AND the page is on localhost.
  // In every other case the app refuses to authenticate locally and
  // relies on Firebase adminUid ownership instead (the host who
  // creates the game is the admin, by Firestore rule).
  const DEV_ADMIN_USERNAME = 'admin';
  const DEV_ADMIN_PASSWORD = 'admin';

  const ADMIN_AUTH_KEY = 'hat_admin_auth';

  function providerName() {
    try { return HG.getProvider().name; }
    catch (e) { return null; }
  }
  function isLocalDev() {
    const h = (global.location && global.location.hostname) || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '';
  }
  // Allow the mock/dev fallback path (admin/admin) only in mock mode
  // or on localhost. On production hosts with Firebase configured we
  // skip the local password gate entirely — admin authority is the
  // Firestore adminUid, not a client-side string.
  function devCredentialsAllowed() {
    const p = providerName();
    if (p === 'mock' || p === 'unavailable') return true;
    if (!HG.adminPasswordHash && isLocalDev()) return true;
    return false;
  }
  function adminGateIsRequired() {
    // The gate is required iff there is a configured password hash.
    // Without it, Firebase mode skips the prompt and goes straight
    // into admin-home (the user must still create a game to become
    // admin, and Firebase rules pin them to that game).
    return typeof HG.adminPasswordHash === 'string' && HG.adminPasswordHash.length > 0;
  }
  async function sha256Hex(text) {
    if (!(global.crypto && global.crypto.subtle)) return null;
    const data = new TextEncoder().encode(text);
    const buf = await global.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function verifyAdminCredentials(username, password) {
    if (adminGateIsRequired()) {
      const got = await sha256Hex(password);
      if (!got) {
        showToast(
          'Your browser does not support secure password hashing. Use a modern browser.',
          'error'
        );
        return false;
      }
      return got === HG.adminPasswordHash;
    }
    if (devCredentialsAllowed()) {
      return username === DEV_ADMIN_USERNAME && password === DEV_ADMIN_PASSWORD;
    }
    return false;
  }

  function isAdminAuthed() {
    return sessionStorage.getItem(ADMIN_AUTH_KEY) === '1';
  }
  function setAdminAuthed(on) {
    if (on) sessionStorage.setItem(ADMIN_AUTH_KEY, '1');
    else sessionStorage.removeItem(ADMIN_AUTH_KEY);
  }

  // Thin compatibility wrappers around the session helpers in
  // utils.js. The session itself lives in sessionStorage under
  // U.SESSION_KEYS.ADMIN — see the comment there for why we use
  // sessionStorage and not localStorage.
  function saveActiveAdminGame(gameId, gameCode) {
    U.saveAdminSession({ gameId: gameId, gameCode: gameCode });
  }
  function loadActiveAdminGame() {
    return U.loadAdminSession();
  }
  function clearActiveAdminGame() {
    U.clearAdminSession();
  }

  function logoutAdmin() {
    HG.Admin.unmount();
    setAdminAuthed(false);
    clearActiveAdminGame();
    showScreen('screen-landing');
  }

  function updateProviderBanner() {
    const banner = $('provider-banner');
    if (!banner) return;
    const provider = HG.getProvider();
    if (provider.name === 'firebase') {
      banner.textContent = 'Online multiplayer mode (Firebase).';
    } else {
      const q = U.getQuery();
      const note = q.mode === 'mock'
        ? 'Mock mode (?mode=mock) — single-browser only.'
        : 'Single-browser mode — Firebase is not configured. See README to enable online multiplayer.';
      banner.textContent = note;
    }
  }

  // ---- Landing screen handlers -----------------------------------
  function wireLanding() {
    $('landing-host').addEventListener('click', () => {
      if (isAdminAuthed()) { showScreen('screen-admin-home'); return; }
      // Firebase production hosts without an explicit password hash
      // skip the local gate entirely. The user becomes admin only by
      // creating a game (and the Firestore rules pin the adminUid).
      if (!adminGateIsRequired() && !devCredentialsAllowed()) {
        setAdminAuthed(true);
        showScreen('screen-admin-home');
        return;
      }
      // Surface dev-credentials hint only when the dev fallback is
      // actually available, so production hosts don't see the
      // "admin / admin" hint at all.
      const hint = $('admin-login-hint');
      if (hint) {
        hint.innerHTML = devCredentialsAllowed()
          ? 'Development login: <code>admin / admin</code>. ' +
            '<em>Replace with a per-deployment password hash via ' +
            '<code>HatGame.adminPasswordHash</code> before going public.</em>'
          : '<em>This local login is a UX convenience. Real authority comes from ' +
            'Firestore security rules — the host who creates a game becomes its ' +
            'admin via the game\'s <code>adminUid</code> field.</em>';
      }
      showScreen('screen-admin-login');
    });
    $('landing-join').addEventListener('click', () => {
      showScreen('screen-player-join');
    });
    $('admin-back-landing').addEventListener('click', (ev) => {
      ev.preventDefault(); showScreen('screen-landing');
    });
    $('player-back-landing').addEventListener('click', (ev) => {
      ev.preventDefault(); showScreen('screen-landing');
    });
  }

  // ---- Admin login + home ----------------------------------------
  function wireAdmin() {
    $('admin-login-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const u = $('admin-username').value.trim();
      const p = $('admin-password').value;
      const ok = await verifyAdminCredentials(u, p);
      if (ok) {
        setAdminAuthed(true);
        $('admin-password').value = '';
        showScreen('screen-admin-home');
      } else {
        // The local gate is a UX convenience — Firestore rules are
        // the real authority. We surface a generic English error so
        // we don't help an attacker enumerate valid usernames.
        showToast('Invalid username or password.', 'error');
      }
    });
    $('admin-home-logout').addEventListener('click', logoutAdmin);

    $('btn-create-game').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; // double-click guard
      const wpp = parseInt($('initial-words-per-player').value, 10) || 5;
      try {
        const provider = HG.getProvider();
        await provider.init();
        await provider.signInAnonymous();
        const { gameId, gameCode } = await provider.createGame({ wordsPerPlayer: wpp });
        saveActiveAdminGame(gameId, gameCode);
        await HG.Admin.mount({ gameId, gameCode });
      } catch (e) {
        Log.error(e);
        showToast(e.message || 'Failed to create game.', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---- Player join -----------------------------------------------
  function wirePlayer() {
    const q = U.getQuery();
    if (q.game) {
      const input = $('join-game-code');
      if (input) input.value = q.game;
    }
    $('join-game-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const submitBtn = ev.target.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true; // double-click guard
      const code = $('join-game-code').value.trim().toUpperCase();
      const name = $('nickname').value.trim();
      try {
        if (!code) { showToast('Game code is required.', 'error'); return; }
        if (!name) { showToast('Nickname cannot be empty.', 'error'); return; }
        const provider = HG.getProvider();
        await provider.init();
        await provider.signInAnonymous();
        const res = await provider.joinGame({ gameCode: code, nickname: name });
        await HG.Player.mount({
          gameId: res.gameId, gameCode: res.gameCode, playerId: res.playerId,
        });
      } catch (e) {
        showToast(e.message || 'Could not join the game.', 'error');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ---- Boot ------------------------------------------------------
  async function boot() {
    updateProviderBanner();
    wireLanding();
    wireAdmin();
    wirePlayer();
    // Clear last-restore flags before we attempt restoration so the
    // debug overlay reflects this boot's outcome only.
    U.setLastRestoreError(null);

    const q = U.getQuery();

    // Deep-link: ?game=CODE — if this browser already has a player
    // slot for the code, resume silently; otherwise show join screen
    // with the code pre-filled.
    if (q.game) {
      const resumed = await HG.Player.tryResume({ gameCode: q.game });
      U.setLastRestored(resumed);
      if (resumed) return;
      showScreen('screen-player-join');
      return;
    }

    // No deep link, but maybe a player session was stashed earlier
    // (refresh of /index.html with no ?game). Try the stashed code.
    // tryResume returns false if either the game or the player slot
    // is no longer reachable (e.g. admin reset the game) — in that
    // case the session has already been cleared and we surface a
    // friendly message before showing the landing screen.
    const hadPlayerSession = !!U.loadPlayerSession();
    const playerResumed = await HG.Player.tryResume();
    if (playerResumed) {
      U.setLastRestored(true);
      return;
    }
    if (hadPlayerSession) {
      // A session existed but couldn't be restored. The Player
      // controller has already cleared the stale entry. If it
      // already surfaced a more specific toast (e.g. "you may have
      // been removed by the host"), don't stomp it with the generic
      // message.
      U.setLastRestored(false);
      if (!U.getLastRestoreError()) {
        U.setLastRestoreError('player session could not be restored');
        showToast(
          'Your previous session could not be restored. Please join again.',
          'error'
        );
      }
    }

    // If the admin was mid-game on this tab, resume.
    const active = loadActiveAdminGame();
    if (isAdminAuthed() && active) {
      try {
        const provider = HG.getProvider();
        await provider.init();
        await provider.signInAnonymous();
        const canResume = await provider.resumeIfAdmin(active.gameCode);
        if (canResume) {
          await HG.Admin.mount({ gameId: active.gameId, gameCode: active.gameCode });
          U.setLastRestored(true);
          return;
        }
        // Game not found — wipe the stale pointer and tell the host.
        clearActiveAdminGame();
        U.setLastRestoreError('admin game no longer exists');
        U.setLastRestored(false);
        showToast('Your previous game is no longer available.', 'error');
      } catch (e) {
        Log.error('admin resume failed', e);
        clearActiveAdminGame();
        U.setLastRestoreError(e && e.message);
        U.setLastRestored(false);
      }
    }

    showScreen('screen-landing');
  }

  global.HatGame.App = { logoutAdmin: logoutAdmin };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
