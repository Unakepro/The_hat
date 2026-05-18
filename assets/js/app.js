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

  // --- DEV-ONLY credentials. See README. ---------------------------
  const ADMIN_USERNAME = 'admin';
  const ADMIN_PASSWORD = 'admin';

  const ADMIN_AUTH_KEY = 'hat_admin_auth';

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
      if (isAdminAuthed()) showScreen('screen-admin-home');
      else showScreen('screen-admin-login');
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
    $('admin-login-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const u = $('admin-username').value.trim();
      const p = $('admin-password').value;
      // ⚠️ DEV-ONLY: this check is cosmetic; anyone can flip the
      // session flag in devtools. Real auth must live behind a
      // server or proper auth provider.
      if (u === ADMIN_USERNAME && p === ADMIN_PASSWORD) {
        setAdminAuthed(true);
        $('admin-password').value = '';
        showScreen('screen-admin-home');
      } else {
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
