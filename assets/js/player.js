/* eslint-disable */
/**
 * Player controller — symmetric to admin.js, but reads only their
 * own data + public progress + public Round 1 reveals.
 *
 * Privacy is enforced by the provider (which filters
 * listenToOwnWords by ownerUid and strips activeWordId for
 * non-explainers). This file just consumes the filtered views.
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const { $, showToast, showScreen, Log, PHASE, GameError } = U;

  let provider = null;
  let gameId = null;
  let gameCode = null;
  let playerId = null;
  let unsubs = [];
  const snapshot = {
    gameId: null, gameCode: null,
    game: null, players: [], teams: [],
    me: null, myWords: [],
    // `round` is the currently active round's view (round 1/2/3).
    // No `publicGuessed` field — under strict privacy, players never
    // see guessed/remaining/validation word text.
    round: null,
    uid: null,
  };

  const actions = {
    onUpdateWord: (id, text) => mutate(() => provider.updateWord(gameId, id, text)),
    onDeleteWord: (id, ev) => mutate(() => provider.deleteWord(gameId, id), btn(ev)),
    onResubmitRevisedWord: (id, text, ev) =>
      mutate(() => provider.resubmitRevisedWord(gameId, id, text), btn(ev)),
  };

  function btn(ev) {
    if (!ev) return null;
    const el = ev.currentTarget || ev.target;
    return (el && el.tagName === 'BUTTON') ? el : null;
  }

  async function mutate(fn, button) {
    // Disable the source button while the action is in flight — this
    // is our double-click guard for Guessed / Submit Word / etc.
    if (button) button.disabled = true;
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof GameError) showToast(e.message, 'error');
      else { Log.error(e); showToast('Unexpected error: ' + e.message, 'error'); }
      return false;
    } finally {
      // Re-enable our guard so non-state-driven buttons (form
      // submit, etc.) come back, then force a render so any
      // state-driven button (submit at cap, guessed when not the
      // explainer) gets re-disabled to the right value. Order
      // matters — our re-enable runs first, render's setDisabled
      // runs last and wins.
      if (button) button.disabled = false;
      try { render(); } catch (e) { Log.error('render failed', e); }
    }
  }

  // Session persistence is delegated to U.savePlayerSession /
  // loadPlayerSession / clearPlayerSession (utils.js) so app.js and
  // tests can read the same record via a stable API.
  function persistSession() {
    const me = (snapshot.players || []).find(p => p.id === playerId);
    U.savePlayerSession({
      gameCode: gameCode,
      gameId: gameId,
      playerId: playerId,
      uid: provider && provider.currentUid,
      nickname: me ? me.name : null,
    });
  }
  function clearSession() { U.clearPlayerSession(); }
  function loadSession() { return U.loadPlayerSession(); }

  function detach() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = [];
  }

  function render() {
    HG.UI.renderPlayer(snapshot, actions);
    if (HG.Debug) HG.Debug.update(buildDebugInfo());
  }

  function buildDebugInfo() {
    return {
      role: 'player',
      provider: provider ? provider.name : 'none',
      gameCode: gameCode,
      gameId: gameId,
      playerId: playerId,
      uid: provider ? provider.currentUid : null,
      phase: snapshot.game ? snapshot.game.phase : null,
      players: (snapshot.players || []).length,
      myWords: (snapshot.myWords || []).length,
      currentRound: snapshot.round ? snapshot.round.roundNumber : null,
      round: snapshot.round,
    };
  }

  function attachListeners() {
    detach();
    unsubs.push(provider.listenToGame(gameId, g => { snapshot.game = g; recomputeMe(); render(); }));
    unsubs.push(provider.listenToPlayers(gameId, ps => { snapshot.players = ps; recomputeMe(); render(); }));
    unsubs.push(provider.listenToTeams(gameId, ts => { snapshot.teams = ts; render(); }));
    unsubs.push(provider.listenToOwnWords(gameId, provider.currentUid, ws => {
      snapshot.myWords = ws;
      render();
    }));
    unsubs.push(provider.listenToCurrentRound(gameId, r => { snapshot.round = r; render(); }));
    // Intentionally NOT subscribing to listenToPublicGuessedWords —
    // under strict privacy, the player UI never renders guessed
    // word text. Defense in depth: the provider also returns [] for
    // non-admin subscribers.
  }

  // `wasEverPresent` flips to true the first time we see ourselves
  // in the players listener. After that, if `me` becomes null while
  // the game still exists, the admin must have removed us — show the
  // removal message and tear down the player session.
  let wasEverPresent = false;
  let removedNotified = false;
  function recomputeMe() {
    const uid = provider && provider.currentUid;
    snapshot.uid = uid;
    const me = (snapshot.players || []).find(p =>
      (uid && p.uid === uid) || (playerId && p.id === playerId)
    ) || null;
    snapshot.me = me;
    if (me) {
      wasEverPresent = true;
      return;
    }
    // Game doc still present + we were here before + we no longer
    // are = admin removed us. Fire the removal flow exactly once.
    if (wasEverPresent && snapshot.game && !removedNotified) {
      removedNotified = true;
      handleRemovedByAdmin();
    }
  }

  function handleRemovedByAdmin() {
    showToast('You were removed from this game by the host.', 'error');
    // Tear down listeners + clear the player session immediately so
    // a refresh doesn't try to resume the (gone) slot. We deliberately
    // do NOT change screens — the banner stays visible on top of
    // whichever screen the user was on. They click "Back to home" to
    // return to the landing, or refresh.
    try { unmount(); } catch (e) {}
    U.setLastRestoreError('removed by admin');
    showRemovalBanner();
  }

  // Render a removal banner outside any `.screen` container so it
  // remains visible regardless of which screen the player is on.
  // The banner has its own "Back to home" button — we don't
  // auto-redirect so the user (and tests) can read the message
  // without a race.
  function showRemovalBanner() {
    let banner = document.getElementById('player-removed-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'player-removed-banner';
      banner.className = 'player-removed-banner';
      banner.setAttribute('data-testid', 'player-removed-message');
      const text = document.createElement('div');
      text.className = 'player-removed-text';
      text.textContent = 'You were removed from this game by the host.';
      banner.appendChild(text);
      const homeBtn = document.createElement('button');
      homeBtn.className = 'btn btn-secondary';
      homeBtn.textContent = 'Back to home';
      homeBtn.setAttribute('data-testid', 'player-removed-home-button');
      homeBtn.addEventListener('click', () => {
        banner.classList.add('hidden');
        showScreen('screen-landing');
      });
      banner.appendChild(homeBtn);
      // Pin to the body so it sits above .screen containers and is
      // unaffected by screen toggling.
      document.body.appendChild(banner);
    }
    banner.classList.remove('hidden');
  }
  function hideRemovalBanner() {
    const banner = document.getElementById('player-removed-banner');
    if (banner) banner.classList.add('hidden');
  }

  let tickerHandle = null;
  let heartbeatHandle = null;

  async function mount(opts) {
    provider = HG.getProvider();
    await provider.init();
    await provider.signInAnonymous();
    gameId = opts.gameId;
    gameCode = opts.gameCode;
    playerId = opts.playerId;
    snapshot.gameId = gameId;
    snapshot.gameCode = gameCode;
    // Reset removal-detection flags for the new session.
    wasEverPresent = false;
    removedNotified = false;
    // Hide any stale removal banner from a prior session.
    hideRemovalBanner();
    persistSession();
    attachListeners();
    wireEvents();
    startTicker();
    startHeartbeat();
    showScreen('screen-player');
  }

  function unmount() {
    detach();
    stopTicker();
    stopHeartbeat();
    gameId = null; gameCode = null; playerId = null;
    snapshot.game = null; snapshot.players = []; snapshot.teams = [];
    snapshot.me = null; snapshot.myWords = [];
    snapshot.round = null;
    clearSession();
  }

  // Ticker on the player side:
  //   - re-render the countdown every 500ms
  //   - if THIS tab is the active explainer and the turn's deadline
  //     has passed, call provider.endTurn. The admin's tab also
  //     does this; provider.endTurn is idempotent, so the race is
  //     safe — whichever tab wins triggers the single state
  //     transition. Having the explainer drive it too matters in
  //     Chromium because non-focused tabs (often the admin's,
  //     when Playwright has many tabs open) may throttle
  //     setInterval and miss the deadline.
  let autoEndPending = false;
  function startTicker() {
    stopTicker();
    tickerHandle = setInterval(() => {
      // Tick the countdown text WITHOUT rebuilding buttons (full
      // render only fires on real state changes).
      try { HG.UI.tickRoundTimer(snapshot); }
      catch (e) { Log.error('player ticker', e); }
      const r = snapshot.round;
      if (!r || r.status !== U.R_STATUS.ACTIVE || !r.turnEndsAt) return;
      const meIsExplainer = provider && r.activeExplainerUid === provider.currentUid;
      if (!meIsExplainer) return;
      if (autoEndPending) return;
      const remaining = new Date(r.turnEndsAt).getTime() - Date.now();
      if (remaining > 0) return;
      autoEndPending = true;
      provider.endTurn(gameId)
        .catch(e => {
          if (!(e instanceof HG.GameError)) Log.error('player auto endTurn', e);
        })
        .finally(() => { autoEndPending = false; });
    }, 500);
  }
  function stopTicker() {
    if (tickerHandle) { clearInterval(tickerHandle); tickerHandle = null; }
    autoEndPending = false;
  }

  // Heartbeat: refresh the player's lastSeenAt so the admin's
  // online/offline classification stays current. The presence
  // window is 45s; we beat every 25s so a single missed beat
  // still keeps the player "online" instead of jumping straight
  // to "recently active".
  function startHeartbeat() {
    stopHeartbeat();
    // Touch immediately so the admin sees fresh state without
    // waiting for the first interval tick.
    if (provider && provider.touchPlayerPresence && gameId) {
      try { provider.touchPlayerPresence(gameId); } catch (e) {}
    }
    heartbeatHandle = setInterval(() => {
      if (!provider || !gameId) return;
      if (typeof provider.touchPlayerPresence !== 'function') return;
      try { provider.touchPlayerPresence(gameId); }
      catch (e) { Log.error('player heartbeat', e); }
    }, 25 * 1000);
  }
  function stopHeartbeat() {
    if (heartbeatHandle) { clearInterval(heartbeatHandle); heartbeatHandle = null; }
  }

  let wired = false;
  function wireEvents() {
    if (wired) return;
    wired = true;

    $('add-word-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $('word-input');
      const text = input.value.trim();
      if (!text) {
        showToast('Word cannot be empty.', 'error');
        return;
      }
      const submitBtn = ev.target.querySelector('button[type="submit"]');
      mutate(() => provider.submitWord(gameId, text), submitBtn).then(ok => {
        if (ok) { input.value = ''; input.focus(); }
      });
    });
    $('btn-guessed').addEventListener('click', (ev) => {
      mutate(() => provider.markGuessed(gameId), btn(ev));
    });
    $('btn-turn-start').addEventListener('click', (ev) => {
      mutate(() => provider.startTurnTimer(gameId), btn(ev));
    });
    // Wrong: Round 3 only. The button is hidden outside of Round 3
    // by the UI renderer; the provider also rejects calls from any
    // other round so this is double-protected.
    const wrongBtn = $('btn-wrong');
    if (wrongBtn) {
      wrongBtn.addEventListener('click', (ev) => {
        mutate(() => provider.markWrong(gameId), btn(ev));
      });
    }
    // "Leave game" on the player's final-results card. Tears down
    // the listeners and returns to the landing screen. The remote
    // game state is left untouched so the player can rejoin later.
    const leaveBtn = $('btn-leave-game-player');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => {
        unmount();
        showScreen('screen-landing');
      });
    }
  }

  // Restore an in-progress session if the player refreshed.
  //
  // Sources, in order:
  //   1. sessionStorage (player joined this tab earlier)
  //   2. URL ?game=CODE deep link, *if* this browser already has a
  //      player slot in that game (findMyPlayer returns non-null).
  //
  // If we can't find the player, the caller should fall back to the
  // join screen and ask for a nickname.
  async function tryResume(opts) {
    opts = opts || {};
    provider = HG.getProvider();
    try { await provider.init(); }
    catch (e) { Log.error('player resume init failed', e); return false; }
    try { await provider.signInAnonymous(); }
    catch (e) { Log.error('player resume signin failed', e); return false; }

    const sess = loadSession();
    const candidates = [];
    if (sess && sess.gameCode) candidates.push(sess.gameCode);
    if (opts.gameCode && candidates.indexOf(opts.gameCode) === -1) {
      candidates.push(opts.gameCode);
    }

    // Track whether we had a stored session that we couldn't
    // restore — that's how we distinguish "fresh visitor" (no
    // toast) from "removed by admin" (show toast).
    const hadStashedSession = candidates.length > 0;
    for (const code of candidates) {
      try {
        const me = await provider.findMyPlayer(code);
        if (me) {
          gameId = me.gameId; gameCode = me.gameCode; playerId = me.playerId;
          snapshot.gameId = gameId; snapshot.gameCode = gameCode;
          wasEverPresent = false;
          removedNotified = false;
          persistSession();
          attachListeners();
          wireEvents();
          startTicker();
          startHeartbeat();
          showScreen('screen-player');
          return true;
        }
      } catch (e) {
        Log.error('player resume probe failed', e);
      }
    }
    // No live slot — clear any stale session so we don't loop. If
    // the stash existed at all, the game either no longer has us
    // (removed by admin) or no longer exists at all. Either way
    // surface a friendly toast.
    clearSession();
    if (hadStashedSession) {
      U.setLastRestoreError('player slot gone — possibly removed by admin');
      showToast(
        'Your previous session could not be restored. You may have been removed from the game.',
        'error'
      );
    }
    return false;
  }

  global.HatGame.Player = { mount: mount, unmount: unmount, tryResume: tryResume };
})(window);
