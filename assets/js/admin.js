/* eslint-disable */
/**
 * Admin controller: owns the admin's snapshot of the game, listens
 * to the provider, wires UI events to provider mutations.
 *
 * Snapshot shape (what we pass to UI.renderAdminDashboard):
 *   { gameId, gameCode, game, players, teams, hat, round, hostHatContents }
 *
 * `hostHatContents` is the host-only remaining-deck view (see
 * provider.listenToHostHatContents). Replaced the older
 * `publicGuessed` field: under strict privacy there is no public
 * guessed list on the host screen — the host sees pending words via
 * the validation panel and remaining words via Hat Contents.
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const { $, showToast, showScreen, Log, PHASE, GameError } = U;

  let provider = null;
  let gameId = null;
  let gameCode = null;
  let unsubs = [];
  const snapshot = {
    gameId: null, gameCode: null,
    game: null, players: [], teams: [], hat: [],
    // `round` is the currently active round's view (round 1/2/3),
    // emitted by listenToCurrentRound. The UI is round-agnostic.
    round: null,
    // Host-only remaining-deck view, emitted by
    // listenToHostHatContents. Empty payload until the hat is locked.
    hostHatContents: {
      remaining: [], roundNumber: 0, roundName: '', originalCount: 0,
    },
    uid: null,
  };

  // Actions receive their source button as the second argument so the
  // mutate() wrapper can disable it for the duration of the call —
  // that's our double-click guard. Without it, a fast double click
  // queues two phase transitions and the second throws a confusing
  // "Word collection has already started" error.
  const actions = {
    onLockHat: (ev) => mutate(() => provider.lockHat(gameId), btn(ev)),
    onStartWordReview: (ev) => mutate(() => provider.startWordReview(gameId), btn(ev)),
    onReopenWordCollection: (ev) => mutate(() => provider.reopenWordCollection(gameId), btn(ev)),
    onApproveWord: (id, ev) => mutate(() => provider.approveWord(gameId, id), btn(ev)),
    onRemoveWord: (id, ev) => mutate(() => provider.hostRemoveWord(gameId, id), btn(ev)),
    onApproveAllWords: (ev) => mutate(() => provider.approveAllWords(gameId), btn(ev)),
    onEditWord: (id, text) => mutate(() => provider.hostEditWord(gameId, id, text)),
    onRequestRevision: (id, reason, ev) =>
      mutate(() => provider.requestWordRevision(gameId, id, reason), btn(ev)),
    onStartRound1Placeholder: (ev) => mutate(() => provider.startRound1Placeholder(gameId), btn(ev)),
    // "Start first turn" advances ROUND_1_READY → ROUND_1_ACTIVE and
    // queues the first turn (status = WAITING_TO_START). The timer
    // itself does NOT start here — the active explainer must press
    // their Start button.
    onStartRound1Game: (ev) => mutate(async () => {
      await provider.startRound1(gameId);
      await provider.startNextTurn(gameId);
    }, btn(ev)),
    // Generic "next round" entrypoint: transitions ROUND_X_FINISHED
    // → ROUND_(X+1)_ACTIVE and queues the first turn of the new
    // round. The provider handles both steps in one call.
    onStartNextRound: (ev) => mutate(() => provider.startNextRound(gameId), btn(ev)),
    onFinishGame: (ev) => mutate(() => provider.finishGame(gameId), btn(ev)),
    onStartNextTurn: (ev) => mutate(() => provider.startNextTurn(gameId), btn(ev)),
    onEndTurn: (ev) => mutate(() => provider.endTurn(gameId), btn(ev)),
    onConfirmGuessedWord: (id, ev) => mutate(() => provider.confirmGuessedWord(gameId, id), btn(ev)),
    onRejectGuessedWord: (id, ev) => mutate(() => provider.rejectGuessedWord(gameId, id), btn(ev)),
    onAssignPlayerToTeam: (pid, tid) => mutate(() => provider.assignPlayerToTeam(gameId, pid, tid)),
    onDeleteTeam: (tid) => mutate(() => provider.deleteTeam(gameId, tid)),
    onRenameTeam: (tid, name) => mutate(() => provider.renameTeam(gameId, tid, name)),
    onRandomizeTeams: (options, ev) =>
      mutate(() => provider.randomizeTeams(gameId, options), btn(ev)),
    onRematch: (options, ev) =>
      mutate(() => provider.rematchGame(gameId, options), btn(ev)),
    // Remove player is gated to the LOBBY/TEAMS_SETUP phases by the
    // provider; the UI only renders the button during inSetup so a
    // double-guard. The confirm dialog uses the standard browser
    // confirm() — Playwright tests hook `page.on('dialog')`.
    onRemovePlayer: (pid, name, ev) => {
      if (!confirm('Remove player ' + (name || 'this player') + ' from the game?')) return;
      return mutate(() => provider.removePlayer(gameId, pid), btn(ev));
    },
  };

  // Helper: grab the source button from a click event, if any. Some
  // actions are wired without an event (e.g. selectOption); they just
  // get no button-disable behavior.
  function btn(ev) {
    if (!ev) return null;
    const el = ev.currentTarget || ev.target;
    return (el && el.tagName === 'BUTTON') ? el : null;
  }

  async function mutate(fn, button) {
    if (button) button.disabled = true;
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof GameError) showToast(e.message, 'error');
      else { Log.error(e); showToast('Unexpected error: ' + e.message, 'error'); }
      return false;
    } finally {
      // Re-enable our guard, then force a render so any state-driven
      // button (start-word-collection when ready, lock-hat when all
      // submitted, etc.) gets its correct disabled state set. Order:
      // our re-enable first, render's setDisabled last → render wins.
      if (button) button.disabled = false;
      try { render(); } catch (e) { Log.error('render failed', e); }
    }
  }

  function render() {
    HG.UI.renderAdminDashboard(snapshot, actions);
    if (HG.Debug) HG.Debug.update(buildDebugInfo());
  }

  function buildDebugInfo() {
    const r = snapshot.round || null;
    const t = r && r.currentTurn;
    return {
      role: 'admin',
      provider: provider ? provider.name : 'none',
      gameCode: gameCode,
      gameId: gameId,
      uid: provider ? provider.currentUid : null,
      phase: snapshot.game ? snapshot.game.phase : null,
      registrationLocked: snapshot.game ? snapshot.game.registrationLocked : null,
      currentRound: r ? r.roundNumber : null,
      players: (snapshot.players || []).length,
      teams: (snapshot.teams || []).length,
      hatWords: (snapshot.hat || []).length,
      round: r,
      // Validation visibility — these are the arrays that the
      // "2 pending / 0 cards" bug was caused by drifting. Putting
      // them in the debug overlay means any future drift is
      // immediately visible.
      validation: r ? {
        phase: r.phase,
        remainingCount: r.remainingCount,
        pendingValidationWordIds: r.pendingValidationWordIds || [],
        pendingValidationCount: r.pendingValidationCount || 0,
        currentTurnGuessed: t ? t.guessedWordIds : [],
        currentTurnConfirmed: t ? t.confirmedWordIds : [],
        currentTurnRejected: t ? t.rejectedWordIds : [],
        confirmedAllTurns: r.confirmedGuessedWordIds || [],
        rejectedAllTurns: r.rejectedWordIds || [],
      } : null,
      // Tail of the audit log — surfaced as a separate panel in
      // debug-panel.js so you can see exactly what just happened.
      events: snapshot.game && snapshot.game.recentEvents,
    };
  }

  function detach() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = [];
  }

  function attachListeners() {
    detach();
    unsubs.push(provider.listenToGame(gameId, g => {
      snapshot.game = g;
      render();
    }));
    unsubs.push(provider.listenToPlayers(gameId, ps => {
      snapshot.players = ps;
      render();
    }));
    unsubs.push(provider.listenToTeams(gameId, ts => {
      snapshot.teams = ts;
      render();
    }));
    // The hat is only populated once HAT_LOCKED+; before that the
    // provider returns an empty array, which keeps admin-side word
    // text hidden during collection.
    unsubs.push(provider.listenToHat(gameId, hat => {
      snapshot.hat = hat;
      render();
    }));
    // Subscribe to the currently active round (round 1, 2, or 3).
    // The provider emits the correct subdoc based on the game phase.
    unsubs.push(provider.listenToCurrentRound(gameId, r => {
      snapshot.round = r;
      render();
    }));
    // Host Hat Contents = currentRound.remainingWordIds resolved to
    // word objects. Replaces the legacy `listenToPublicGuessedWords`
    // subscription: under strict privacy there is no "public guessed"
    // surface on the host screen — the host sees pending words via
    // the validation panel and remaining words via Hat Contents.
    if (typeof provider.listenToHostHatContents === 'function') {
      unsubs.push(provider.listenToHostHatContents(gameId, hhc => {
        snapshot.hostHatContents = hhc || {
          remaining: [], roundNumber: 0, roundName: '', originalCount: 0,
        };
        render();
      }));
    }
  }

  let tickerHandle = null;
  let autoEndPending = false;

  async function mount(opts) {
    provider = HG.getProvider();
    await provider.init();
    await provider.signInAnonymous();
    gameId = opts.gameId;
    gameCode = opts.gameCode;
    snapshot.gameId = gameId;
    snapshot.gameCode = gameCode;
    snapshot.uid = provider.currentUid;
    attachListeners();
    wireEvents();
    startTicker();
    showScreen('screen-admin');
  }

  function unmount() {
    detach();
    stopTicker();
    gameId = null;
    gameCode = null;
    snapshot.game = null;
    snapshot.players = [];
    snapshot.teams = [];
    snapshot.hat = [];
    snapshot.round = null;
    snapshot.hostHatContents = {
      remaining: [], roundNumber: 0, roundName: '', originalCount: 0,
    };
    snapshot.uid = null;
  }

  /**
   * Ticker drives two things on the admin side:
   *   1. Re-render every 500ms so the countdown stays accurate even
   *      when no state change has fired a listener callback.
   *   2. Detect timer expiration and call `endTurn` exactly once.
   *      `endTurn` is idempotent on the provider, so a race with
   *      another tab is harmless.
   */
  function startTicker() {
    stopTicker();
    tickerHandle = setInterval(() => {
      // Lightweight countdown tick — does NOT rebuild buttons.
      // Buttons rebuild only when a real state change fires the
      // listener, so they stay stable for clicks.
      try { HG.UI.tickRoundTimer(snapshot); }
      catch (e) { Log.error('ticker timer', e); }
      // Auto-end if expired. Reads `snapshot.round` so it works for
      // any of the 3 rounds.
      const r = snapshot.round;
      if (!r || r.status !== U.R_STATUS.ACTIVE || !r.turnEndsAt) return;
      if (autoEndPending) return;
      const remaining = new Date(r.turnEndsAt).getTime() - Date.now();
      if (remaining > 0) return;
      autoEndPending = true;
      provider.endTurn(gameId)
        .catch(e => { if (!(e instanceof GameError)) Log.error('auto endTurn', e); })
        .finally(() => { autoEndPending = false; });
    }, 500);
  }
  function stopTicker() {
    if (tickerHandle) { clearInterval(tickerHandle); tickerHandle = null; }
    autoEndPending = false;
  }

  let wired = false;
  function wireEvents() {
    if (wired) return;
    wired = true;

    $('btn-save-words-per-player').addEventListener('click', (ev) => {
      mutate(() => provider.updateGameSettings(gameId, {
        wordsPerPlayer: $('words-per-player').value,
      }), btn(ev));
    });
    // Per-round duration save buttons. Each one writes to
    // `roundSettings.round{N}.durationSeconds` via the generic
    // `updateRoundDuration` provider method.
    [1, 2, 3].forEach(n => {
      const saveDurBtn = $('btn-save-round' + n + '-duration');
      const input = $('round' + n + '-duration-input');
      if (saveDurBtn && input) {
        saveDurBtn.addEventListener('click', (ev) => {
          const v = input.value;
          mutate(() => provider.updateRoundDuration(gameId, n, v), btn(ev));
        });
      }
    });
    $('btn-start-word-collection').addEventListener('click', (ev) => {
      mutate(() => provider.startWordCollection(gameId), btn(ev));
    });
    $('add-team-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $('new-team-name');
      const name = input.value.trim();
      if (!name) return;
      // The submit button inside the form is the one to disable.
      const submitBtn = ev.target.querySelector('button[type="submit"]');
      mutate(() => provider.createTeam(gameId, name), submitBtn)
        .then(ok => { if (ok) input.value = ''; });
    });

    // Team Randomizer: radio + numeric inputs are static, but the
    // preview text + button-enable state depend on them, so we just
    // re-render on any change. The render reads the live DOM values.
    function renderOnFormChange() { try { render(); } catch (e) { Log.error(e); } }
    document.querySelectorAll('input[name="randomizer-mode"]').forEach(r => {
      r.addEventListener('change', renderOnFormChange);
    });
    const tcInput = $('randomizer-team-count-input');
    const tsInput = $('randomizer-target-size-input');
    if (tcInput) tcInput.addEventListener('input', renderOnFormChange);
    if (tsInput) tsInput.addEventListener('input', renderOnFormChange);
    const randomizeBtn = $('btn-randomize-teams');
    if (randomizeBtn) {
      randomizeBtn.addEventListener('click', (ev) => {
        const modeRadio = document.querySelector('input[name="randomizer-mode"]:checked');
        const mode = modeRadio ? modeRadio.value : 'teamCount';
        const opts = mode === 'teamCount'
          ? { mode: mode, desiredTeamCount: parseInt(tcInput.value, 10) }
          : { mode: mode, targetTeamSize: parseInt(tsInput.value, 10) };
        if (!confirm('Randomize teams? Current team assignments will be replaced.')) return;
        mutate(() => provider.randomizeTeams(gameId, opts), btn(ev))
          .then(ok => { if (ok) U.showToast('Teams randomized successfully.', 'info'); });
      });
    }

    // Rematch flow: button on final-results opens the options modal.
    const newGameSameBtn = $('btn-new-game-same-players');
    const rematchModal = $('rematch-options-modal');
    const cancelRematchBtn = $('btn-cancel-rematch');
    const confirmRematchBtn = $('btn-confirm-rematch');
    if (newGameSameBtn && rematchModal) {
      newGameSameBtn.addEventListener('click', () => {
        rematchModal.classList.remove('hidden');
      });
    }
    if (cancelRematchBtn && rematchModal) {
      cancelRematchBtn.addEventListener('click', () => {
        rematchModal.classList.add('hidden');
      });
    }
    if (confirmRematchBtn && rematchModal) {
      confirmRematchBtn.addEventListener('click', (ev) => {
        const modeRadio = document.querySelector('input[name="rematch-mode"]:checked');
        const mode = modeRadio ? modeRadio.value : 'keep';
        const opts = { reshufflePlayers: mode === 'reshuffle' };
        mutate(() => provider.rematchGame(gameId, opts), btn(ev))
          .then(ok => {
            if (ok) {
              rematchModal.classList.add('hidden');
              U.showToast('New game started.', 'info');
            }
          });
      });
    }
    $('btn-finish-validation').addEventListener('click', (ev) => {
      mutate(() => provider.finishValidation(gameId), btn(ev));
    });
    // Word Review actions: approve all is the only bulk button; the
    // per-card Approve / Remove buttons are wired by ui.js when each
    // card is rendered.
    const approveAllBtn = $('btn-approve-all-words');
    if (approveAllBtn) {
      approveAllBtn.addEventListener('click', (ev) => {
        mutate(() => provider.approveAllWords(gameId), btn(ev));
      });
    }

    $('btn-copy-invite').addEventListener('click', () => {
      const link = U.inviteLink(gameCode);
      navigator.clipboard.writeText(link)
        .then(() => showToast('Invite link copied: ' + link, 'info'))
        .catch(() => showToast(link, 'info'));
    });
    $('btn-export-state').addEventListener('click', async () => {
      try {
        const state = await provider.exportState(gameId);
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hat-game-' + (gameCode || 'state') + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (e) {
        showToast(e.message || 'Export failed.', 'error');
      }
    });
    $('file-import-state').addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await provider.importState(gameId, data);
        showToast('Imported.', 'info');
      } catch (e) {
        showToast(e.message || 'Import failed.', 'error');
      } finally {
        ev.target.value = '';
      }
    });

    $('btn-reset-game').addEventListener('click', () => {
      if (!confirm('Reset this game? All players, teams, words, and round state will be cleared.')) return;
      mutate(() => provider.resetGame(gameId));
    });
    $('btn-logout').addEventListener('click', () => {
      unmount();
      HG.App.logoutAdmin();
    });

    // Final-results actions. Shown only when phase = GAME_FINISHED.
    const newGameBtn = $('btn-new-game');
    if (newGameBtn) {
      newGameBtn.addEventListener('click', () => {
        if (!confirm('Start a brand new game? The current game state will be reset.')) return;
        mutate(() => provider.resetGame(gameId));
      });
    }
    const exportFinalBtn = $('btn-export-final-results');
    if (exportFinalBtn) {
      exportFinalBtn.addEventListener('click', async () => {
        try {
          const state = await provider.exportState(gameId);
          const standings = HG.UI.calculateFinalStandings(state.teams || []);
          const payload = {
            gameId: state.gameId,
            gameCode: state.gameCode,
            finishedAt: state.updatedAt,
            standings: standings,
            winner: HG.UI.getWinner(standings),
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'hat-game-final-' + (gameCode || 'results') + '.json';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (e) {
          showToast(e.message || 'Export failed.', 'error');
        }
      });
    }
    const leaveBtn = $('btn-leave-game');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => {
        unmount();
        HG.App.logoutAdmin();
      });
    }
  }

  global.HatGame.Admin = { mount: mount, unmount: unmount };
})(window);
