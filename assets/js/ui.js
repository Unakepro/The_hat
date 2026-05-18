/* eslint-disable */
/**
 * UI helpers — renderers for the admin and player dashboards.
 *
 * Each function takes a plain state object + an `actions` map and
 * idempotently rebuilds a region of the DOM. They don't own any
 * state themselves; admin.js and player.js maintain the current
 * snapshot in closure variables and call these on every change.
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const { $, el, clear, PHASE } = U;

  function phasePillLabel(phase) {
    return phase || 'LOBBY';
  }

  function setProgressBar(fillId, submitted, required) {
    const pct = required > 0 ? Math.min(100, (submitted / required) * 100) : 0;
    $(fillId).style.width = pct.toFixed(1) + '%';
  }

  function phaseHelpText(phase, progress, allSubmitted) {
    switch (phase) {
      case PHASE.LOBBY: return 'Waiting for players to join. Create teams when you like.';
      case PHASE.TEAMS_SETUP: return 'Assign players to teams, then start word collection.';
      case PHASE.WORD_COLLECTION:
        if (allSubmitted) return 'All words are in the hat. Review them before locking.';
        // List the players who still owe words; falls back to the
        // count if the readiness helper isn't available.
        if (progress.readiness && progress.readiness.missingPlayers.length > 0) {
          return 'Still waiting on: ' + progress.readiness.missingPlayers
            .map(m => m.playerName + ' ' + m.submittedCount + '/' + m.requiredCount)
            .join(', ') + '.';
        }
        return 'Players are submitting their words. ' +
          Math.max(0, progress.total_required - progress.total_submitted) + ' to go.';
      case PHASE.WORD_REVIEW: return 'Review submitted words. Approve or remove each before locking the hat.';
      case PHASE.HAT_LOCKED: return 'Hat is locked. Start Round 1 when ready.';
      case PHASE.ROUND_1_READY: return 'Round 1 is ready. Start the first turn.';
      case PHASE.ROUND_1_ACTIVE: return 'Round 1 — a turn is in progress.';
      case PHASE.ROUND_1_TURN_VALIDATION: return 'Round 1 — validate the guessed words.';
      case PHASE.ROUND_1_FINISHED: return 'Round 1 is complete. Start Round 2 when ready.';
      case PHASE.ROUND_2_READY: return 'Round 2 is ready. Start the first turn.';
      case PHASE.ROUND_2_ACTIVE: return 'Round 2 — a turn is in progress.';
      case PHASE.ROUND_2_TURN_VALIDATION: return 'Round 2 — validate the guessed words.';
      case PHASE.ROUND_2_FINISHED: return 'Round 2 is complete. Start Round 3 when ready.';
      case PHASE.ROUND_3_READY: return 'Round 3 is ready. Start the first turn.';
      case PHASE.ROUND_3_ACTIVE: return 'Round 3 — a turn is in progress.';
      case PHASE.ROUND_3_TURN_VALIDATION: return 'Round 3 — validate the guessed words.';
      case PHASE.ROUND_3_FINISHED: return 'Round 3 is complete. Finish the game to see final results.';
      case PHASE.GAME_FINISHED: return 'Game over!';
      default: return '';
    }
  }

  // Convenience: collect every ROUND_* phase that means a round is
  // happening (any of READY/ACTIVE/TURN_VALIDATION/FINISHED for any
  // round). Used to gate visibility of the round info admin panel.
  function isRoundPhase(phase) {
    return U.roundNumberForPhase(phase) > 0;
  }

  // -------------------- Admin renderers --------------------------
  // Single source of truth for the admin's hat progress: the
  // getWordSubmissionReadiness helper, which counts actual word docs
  // (state.hat) rather than the cached player.wordCount. The same
  // helper backs the Review words button + the server-side gate, so
  // the UI and the backend can't disagree.
  function computeProgress(state) {
    const game = state.game || {};
    const r = U.getWordSubmissionReadiness(
      { wordsPerPlayer: game.wordsPerPlayer },
      state.players || [],
      state.hat || []
    );
    return {
      total_required: r.totalRequired,
      total_submitted: r.totalSubmitted,
      all_submitted: r.canReview,
      readiness: r,
    };
  }

  function renderAdminDashboard(state, actions) {
    const game = state.game || { phase: PHASE.LOBBY, wordsPerPlayer: 5 };
    const phase = game.phase;
    const progress = computeProgress(state);

    $('phase-pill').textContent = phasePillLabel(phase);
    $('code-badge').textContent = state.gameCode ? 'Code: ' + state.gameCode : '';
    $('hat-progress-text').textContent =
      progress.total_submitted + ' / ' + progress.total_required + ' words';
    setProgressBar('hat-progress-fill', progress.total_submitted, progress.total_required);

    $('phase-message').textContent = phaseHelpText(phase, progress, progress.all_submitted);
    $('phase-message').classList.toggle('success',
      (phase === PHASE.WORD_COLLECTION && progress.all_submitted) ||
      phase === PHASE.HAT_LOCKED ||
      phase === PHASE.ROUND_1_FINISHED ||
      phase === PHASE.ROUND_2_FINISHED ||
      phase === PHASE.ROUND_3_FINISHED ||
      phase === PHASE.GAME_FINISHED);

    // Phase action buttons
    const actionsRoot = $('phase-actions');
    clear(actionsRoot);
    if (phase === PHASE.WORD_COLLECTION && progress.all_submitted) {
      // Old label was "Lock hat". The host now goes through an
      // explicit review step first — the existing `lock-hat-button`
      // testid is kept so back-compat tests resolve, but the action
      // now transitions to WORD_REVIEW. The actual lock happens via
      // `lock-approved-hat-button` rendered during WORD_REVIEW.
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '📝 Review words',
        testId: 'lock-hat-button',
        on: { click: actions.onStartWordReview },
      }));
    }
    if (phase === PHASE.WORD_REVIEW) {
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '🔒 Lock approved hat',
        testId: 'lock-approved-hat-button',
        on: { click: actions.onLockHat },
      }));
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-ghost',
        text: '↩ Reopen word collection',
        testId: 'reopen-word-collection-button',
        on: { click: actions.onReopenWordCollection },
      }));
    }
    if (phase === PHASE.HAT_LOCKED) {
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '▶ Start Round 1',
        testId: 'start-round-1-button',
        on: { click: actions.onStartRound1Placeholder },
      }));
    }
    if (phase === PHASE.ROUND_1_READY) {
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '🎬 Start first turn',
        testId: 'start-turn-button',
        on: { click: actions.onStartRound1Game },
      }));
    }
    // Between-round transitions: ROUND_1_FINISHED → Start Round 2;
    // ROUND_2_FINISHED → Start Round 3; ROUND_3_FINISHED → Finish game.
    if (phase === PHASE.ROUND_1_FINISHED) {
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '▶ Start Round 2',
        testId: 'start-round-2-button',
        on: { click: actions.onStartNextRound },
      }));
    }
    if (phase === PHASE.ROUND_2_FINISHED) {
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '▶ Start Round 3',
        testId: 'start-round-3-button',
        on: { click: actions.onStartNextRound },
      }));
    }
    if (phase === PHASE.ROUND_3_FINISHED) {
      actionsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: '🏁 Finish game',
        testId: 'finish-game-button',
        on: { click: actions.onFinishGame },
      }));
    }

    // Settings row availability
    const inSetup = phase === PHASE.LOBBY || phase === PHASE.TEAMS_SETUP;
    $('words-per-player').disabled = !inSetup;
    $('btn-save-words-per-player').disabled = !inSetup;
    if (document.activeElement !== $('words-per-player')) {
      $('words-per-player').value = game.wordsPerPlayer;
    }

    // Registration badge + readiness checklist
    const regBadge = $('registration-badge');
    if (game.registrationLocked) {
      regBadge.textContent = 'LOCKED';
      regBadge.classList.add('locked');
    } else {
      regBadge.textContent = 'OPEN';
      regBadge.classList.remove('locked');
    }
    // Single canonical readiness oracle — drives both the checklist
    // and the Start button. Computed client-side so it works against
    // either provider (the Firebase provider doesn't ship a
    // server-side `readiness` field on the game doc).
    const readiness = U.getWordCollectionReadiness(game, state.players || [], state.teams || []);
    renderReadiness(readiness, inSetup);
    renderStartReasons(readiness, inSetup);

    const startBtn = $('btn-start-word-collection');
    startBtn.disabled = !inSetup || !readiness.canStart;
    startBtn.textContent = inSetup ? 'Start word collection' :
      (phase === PHASE.WORD_COLLECTION ? 'Word collection in progress…' :
       (phase === PHASE.HAT_LOCKED ? 'Hat is locked' : 'Round in progress'));

    // During setup we already render the precise Start requirements
    // checklist + per-rule failure reasons, so the vague phase-help
    // line would be redundant noise.
    $('phase-help').textContent = inSetup
      ? ''
      : phaseHelpText(phase, progress, progress.all_submitted);
    // Show a persistent warning when structure is locked so the host
    // can see why team/player edits are disabled.
    $('lock-warning').textContent = inSetup
      ? ''
      : 'Teams are locked after word collection starts.';

    renderAdminPlayers(state, actions, inSetup);
    renderAdminTeams(state, actions, inSetup);
    renderAdminProgress(state, progress);
    renderAdminWordReview(state, actions);
    renderAdminHatContents(state);
    renderRoundSettings(state, actions);
    renderRound1Admin(state, actions);
    renderRound1Validation(state, actions);
    renderFinalResults(state);
  }

  // Word Review panel — host-only, visible during WORD_REVIEW.
  // Reads `state.hat` (admin-only listener) and groups by submitter
  // for readability. Each card lets the host edit text inline,
  // approve, or remove the word. Approve All is rendered in the
  // panel header (index.html).
  function renderAdminWordReview(state, actions) {
    const section = $('section-word-review');
    if (!section) return;
    const game = state.game || {};
    const visible = game.phase === PHASE.WORD_REVIEW;
    section.classList.toggle('hidden', !visible);
    if (!visible) return;
    const list = $('word-review-list');
    const summary = $('word-review-summary');
    const empty = $('word-review-empty');
    const approveAllBtn = $('btn-approve-all-words');
    clear(list);
    const words = (state.hat || []).slice();
    // Count totals for the summary line.
    const submittedCount = words.filter(w => w.status === 'submitted').length;
    const approvedCount = words.filter(w => w.status === 'approved').length;
    const removedCount = words.filter(w => w.status === 'removed').length;
    const needsRevisionCount = words.filter(w => w.status === 'needs_revision').length;
    if (summary) {
      summary.textContent =
        'Submitted: ' + words.length +
        ' · Approved: ' + approvedCount +
        ' · Removed: ' + removedCount +
        ' · Needs revision: ' + needsRevisionCount +
        ' · Pending: ' + submittedCount;
    }
    if (empty) empty.classList.toggle('hidden', words.length > 0);
    if (approveAllBtn) approveAllBtn.disabled = submittedCount === 0;
    // Duplicate detection — case-insensitive normalized comparison
    // across all non-removed words. Build a set of normalized texts
    // that occur more than once.
    const normCount = {};
    words.forEach(w => {
      if (w.status === 'removed') return;
      const norm = U.normalizeWordForCompare(w.text);
      if (!norm) return;
      normCount[norm] = (normCount[norm] || 0) + 1;
    });
    // Sort by owner name so cards group naturally; ties keep stable
    // input order.
    words.sort((a, b) => {
      const an = (a.ownerName || '').toLowerCase();
      const bn = (b.ownerName || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    words.forEach(w => {
      const status = w.status || 'submitted';
      const li = el('li', {
        className: 'word-review-card status-' + status,
        testId: 'word-review-card',
        dataset: { wordId: w.id, status: status },
      });
      // Main column: text input + meta + (optional) revision reason
      // call-out + (toggled) reason composer. The grid layout in
      // style.css keeps the action buttons in their own column on
      // desktop and stacks everything vertically on mobile.
      const main = el('div', { className: 'word-card-main' });
      const input = el('input', {
        className: 'word-review-input word-card-text',
        attrs: { type: 'text', maxlength: '40', value: '' },
        testId: 'word-review-input',
      });
      input.value = w.text || '';
      input.disabled = w.status === 'removed';
      const commit = () => {
        const next = (input.value || '').trim();
        if (!next || next === w.text) {
          input.value = w.text || '';
          return;
        }
        actions.onEditWord(w.id, next).catch(() => { input.value = w.text || ''; });
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
      main.appendChild(input);
      const meta = el('div', { className: 'word-review-meta' });
      meta.appendChild(el('span', {
        className: 'word-review-owner muted small',
        text: w.ownerName || '—',
      }));
      const statusLabel = status === 'needs_revision' ? 'Needs revision' :
        status.charAt(0).toUpperCase() + status.slice(1);
      meta.appendChild(el('span', {
        className: 'word-review-status status-' + status,
        text: statusLabel,
        testId: 'word-review-status',
      }));
      if (status === 'needs_revision') {
        meta.appendChild(el('span', {
          className: 'word-review-status status-needs_revision',
          text: 'Needs revision',
          testId: 'needs-revision-badge',
        }));
      }
      if (w.editedByHost) {
        meta.appendChild(el('span', {
          className: 'word-review-edited muted small',
          text: '(edited)',
        }));
      }
      const norm = U.normalizeWordForCompare(w.text);
      if (norm && normCount[norm] > 1 && w.status !== 'removed') {
        meta.appendChild(el('span', {
          className: 'word-review-duplicate',
          text: 'Duplicate word',
          testId: 'duplicate-word-warning',
        }));
      }
      main.appendChild(meta);
      if (status === 'needs_revision' && w.revisionReason) {
        main.appendChild(el('div', {
          className: 'word-review-revision-reason',
          text: 'Reason: ' + w.revisionReason,
          testId: 'revision-reason-message',
        }));
      }
      // Inline composer: shown when host clicks "Request Revision".
      // Hidden by default; toggled directly on the DOM node so the
      // open/closed state survives until the next render (which is
      // fine — once the host submits, the status flips and the card
      // re-renders without the composer).
      const composer = el('div', {
        className: 'revision-reason-composer hidden',
      });
      const reasonInput = el('input', {
        attrs: { type: 'text', maxlength: '200',
                 placeholder: 'Reason (optional, e.g. "Fix spelling")' },
        testId: 'revision-reason-input',
      });
      const confirmBtn = el('button', {
        className: 'btn btn-primary btn-tiny',
        text: 'Send back',
        testId: 'confirm-request-revision-button',
        on: { click: (ev) => {
          actions.onRequestRevision(w.id, reasonInput.value || '', ev);
        } },
      });
      const cancelBtn = el('button', {
        className: 'btn btn-ghost btn-tiny',
        text: 'Cancel',
        on: { click: () => { composer.classList.add('hidden'); } },
      });
      reasonInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          actions.onRequestRevision(w.id, reasonInput.value || '', null);
        } else if (e.key === 'Escape') {
          composer.classList.add('hidden');
        }
      });
      composer.appendChild(reasonInput);
      composer.appendChild(confirmBtn);
      composer.appendChild(cancelBtn);
      main.appendChild(composer);
      li.appendChild(main);
      // Action buttons column.
      const buttons = el('div', { className: 'word-card-actions word-review-buttons' });
      const approveBtn = el('button', {
        className: 'btn btn-primary btn-tiny',
        text: 'Approve',
        testId: 'approve-word-button',
        on: { click: (ev) => actions.onApproveWord(w.id, ev) },
      });
      approveBtn.disabled =
        w.status === 'approved' ||
        w.status === 'removed' ||
        w.status === 'needs_revision';
      buttons.appendChild(approveBtn);
      const revisionBtn = el('button', {
        className: 'btn btn-ghost btn-tiny',
        text: 'Request Revision',
        testId: 'request-revision-button',
        on: { click: () => {
          composer.classList.toggle('hidden');
          if (!composer.classList.contains('hidden')) {
            reasonInput.value = w.revisionReason || '';
            reasonInput.focus();
          }
        } },
      });
      revisionBtn.disabled = w.status === 'removed';
      buttons.appendChild(revisionBtn);
      const removeBtn = el('button', {
        className: 'btn btn-ghost btn-danger btn-tiny',
        text: 'Remove',
        testId: 'remove-word-button',
        on: { click: (ev) => actions.onRemoveWord(w.id, ev) },
      });
      removeBtn.disabled = w.status === 'removed';
      buttons.appendChild(removeBtn);
      li.appendChild(buttons);
      list.appendChild(li);
    });
  }

  // Per-round duration inputs (round 1, 2, 3). Each input becomes
  // read-only once its round has been started (the provider rejects
  // the write anyway, but disabling the input is friendlier).
  function renderRoundSettings(state, actions) {
    const section = $('section-round-settings');
    const game = state.game || {};
    // Visible from HAT_LOCKED through any round-lifecycle phase. We
    // hide it during the lobby/setup so the admin doesn't see timer
    // settings before the hat is locked.
    const visible =
      game.phase === PHASE.HAT_LOCKED ||
      isRoundPhase(game.phase) ||
      game.phase === PHASE.GAME_FINISHED;
    section.classList.toggle('hidden', !visible);
    if (!visible) return;
    const settings = game.roundSettings || {};
    [1, 2, 3].forEach(n => {
      const input = $('round' + n + '-duration-input');
      const btn = $('btn-save-round' + n + '-duration');
      const key = 'round' + n;
      const s = settings[key] || {};
      const value = s.durationSeconds || U.defaultDurationForRound(n);
      if (input && document.activeElement !== input) input.value = value;
      // The duration is editable while the corresponding round subdoc
      // hasn't been created yet (i.e. we haven't entered ROUND_N_*
      // phases). Once entered, the input is frozen.
      const phaseRound = U.roundNumberForPhase(game.phase);
      const editable = phaseRound < n;
      if (input) input.disabled = !editable;
      if (btn) btn.disabled = !editable;
    });
  }

  // Compute final standings with explicit ranks. Tied teams share
  // the same rank. The list is sorted by total score descending,
  // then by team name for a stable order within ties.
  //
  // Exposed at HG.UI.calculateFinalStandings so tests and external
  // tooling can call it without scraping the DOM.
  function calculateFinalStandings(teams) {
    const list = (teams || []).map(t => {
      const rs = t.roundScores || { 1: 0, 2: 0, 3: 0 };
      return {
        teamId: t.id,
        teamName: t.name,
        round1Score: rs[1] || 0,
        round2Score: rs[2] || 0,
        round3Score: rs[3] || 0,
        totalScore: t.score || 0,
        rank: 0,
      };
    });
    list.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return a.teamName.localeCompare(b.teamName);
    });
    // Rank assignment: tied teams share the same rank.
    let rank = 0;
    let prevTotal = null;
    list.forEach((row, i) => {
      if (prevTotal === null || row.totalScore !== prevTotal) {
        rank = i + 1;
        prevTotal = row.totalScore;
      }
      row.rank = rank;
    });
    return list;
  }

  // Returns either the single winning team's name, or null if there's
  // a tie at the top. Callers should fall back to "Tie Game" in that
  // case rather than picking a random winner.
  function getWinner(standings) {
    if (!standings || !standings.length) return null;
    const top = standings.filter(s => s.rank === 1);
    if (top.length === 1) return top[0].teamName;
    return null; // tie
  }

  // Final scoreboard shown after Round 3 is done (admin side).
  function renderFinalResults(state) {
    const section = $('section-final-results');
    const game = state.game || {};
    const visible = game.phase === PHASE.GAME_FINISHED;
    section.classList.toggle('hidden', !visible);
    if (!visible) return;
    const standings = calculateFinalStandings(state.teams || []);
    // Table rendering.
    const tbody = $('final-score-tbody');
    if (tbody) {
      clear(tbody);
      standings.forEach(s => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'final-score-row');
        tr.dataset.teamId = s.teamId;
        const cells = [
          s.teamName,
          String(s.round1Score),
          String(s.round2Score),
          String(s.round3Score),
          String(s.totalScore),
        ];
        cells.forEach(text => {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    // Legacy list (kept so tests that read it still pass).
    const list = $('final-results-list');
    if (list) {
      clear(list);
      standings.forEach((s, i) => {
        const li = el('li', {
          className: 'final-result-row' + (i === 0 && s.rank === 1 ? ' winner' : ''),
          testId: 'final-result-row',
          dataset: { teamId: s.teamId },
        });
        li.appendChild(el('span', {
          className: 'final-result-name', text: s.teamName,
        }));
        li.appendChild(el('span', {
          className: 'final-result-total',
          text: s.totalScore + ' pt' + (s.totalScore === 1 ? '' : 's'),
          testId: 'final-result-total',
        }));
        li.appendChild(el('span', {
          className: 'final-result-breakdown muted small',
          text: 'R1: ' + s.round1Score +
                ' · R2: ' + s.round2Score +
                ' · R3: ' + s.round3Score,
          testId: 'final-result-breakdown',
        }));
        list.appendChild(li);
      });
    }
    // Winner section.
    const winnerName = getWinner(standings);
    const winnerEl = $('final-winner');
    const winnerNameEl = $('winner-name');
    if (winnerEl) {
      if (winnerName) {
        winnerEl.textContent = 'Winner: ' + winnerName;
      } else if (standings.length) {
        const tied = standings.filter(s => s.rank === 1).map(s => s.teamName);
        winnerEl.textContent = 'Tie Game — ' + tied.join(' and ');
      } else {
        winnerEl.textContent = '';
      }
    }
    if (winnerNameEl) {
      winnerNameEl.textContent = winnerName || 'Tie Game';
    }
  }

  // Rows are derived from the checks map on the readiness object.
  // testids match the legacy ids so existing specs continue to work.
  const READINESS_ROWS = [
    { id: 'min-teams',    key: 'hasEnoughTeams',               label: 'At least 2 teams' },
    { id: 'team-size',    key: 'eachTeamHasAtLeastTwoPlayers', label: 'Each team has at least 2 players' },
    { id: 'all-assigned', key: 'allPlayersAssigned',           label: 'Every player is assigned to a team' },
    { id: 'wpp',          key: 'wordsPerPlayerValid',          label: 'Words per player is at least 1' },
    { id: 'registration', key: 'registrationOpen',             label: 'Registration is open' },
  ];

  function renderReadiness(readiness, visible) {
    const root = $('readiness-checklist');
    clear(root);
    if (!readiness || !visible) { root.classList.add('hidden'); return; }
    root.classList.remove('hidden');
    root.appendChild(el('h3', {
      className: 'readiness-title',
      text: 'Start requirements',
    }));
    READINESS_ROWS.forEach(row => {
      const ok = !!(readiness.checks && readiness.checks[row.key]);
      const item = el('div', {
        className: 'readiness-item ' + (ok ? 'ok' : 'fail'),
        testId: 'readiness-' + row.id,
      });
      item.appendChild(el('span', { className: 'check', text: ok ? '✓' : '✗' }));
      item.appendChild(el('span', { text: row.label }));
      root.appendChild(item);
    });
  }

  function renderStartReasons(readiness, visible) {
    const root = $('start-reasons');
    if (!root) return;
    clear(root);
    if (!readiness || !visible) { root.classList.add('hidden'); return; }
    root.classList.remove('hidden');
    if (readiness.canStart) {
      root.appendChild(el('span', {
        className: 'start-reasons-ok',
        text: 'Ready to start word collection.',
      }));
      return;
    }
    readiness.reasons.forEach(text => {
      root.appendChild(el('div', { className: 'start-reasons-fail', text: text }));
    });
  }

  function renderAdminPlayers(state, actions, inSetup) {
    const list = $('player-list');
    clear(list);
    const players = state.players || [];
    $('players-empty').classList.toggle('hidden', players.length > 0);
    const submission = U.getWordSubmissionReadiness(
      { wordsPerPlayer: (state.game && state.game.wordsPerPlayer) || 0 },
      players, state.hat || []
    );

    players.forEach(p => {
      const row = el('li', {
        className: 'player-row',
        testId: 'player-row',
        dataset: { playerId: p.id || p.uid },
      });
      const main = el('div', { className: 'player-row-main' });
      main.appendChild(el('span', {
        className: 'player-name',
        text: p.name,
        testId: 'player-name',
      }));
      // Connected status badge — Online / Recently active / Offline.
      // Hidden in the normal admin UI because online/offline status
      // is NOT part of the Start Word Collection gate; showing it
      // misled hosts into thinking offline players blocked the game.
      // Heartbeat tracking (`lastSeenAt`, `connected`) is preserved
      // internally and surfaced only when ?debug=1.
      if (U.getQuery().debug === '1') {
        const presence = U.classifyPresence(p.lastSeenAt);
        main.appendChild(el('span', {
          className: 'presence-badge presence-' + presence,
          text: presence === 'online' ? 'Online' :
                presence === 'recent' ? 'Recently active' : 'Offline',
          testId: 'player-presence-' + presence,
        }));
      }
      const required = (state.game && state.game.wordsPerPlayer) || 0;
      const submitted = submission.perPlayerCounts[p.id || p.uid] || 0;
      const chip = el('span', {
        className: 'player-progress-chip' + (submitted >= required ? ' done' : ''),
        text: submitted + ' / ' + required,
      });
      main.appendChild(chip);
      const team = (state.teams || []).find(t => t.id === p.teamId);
      if (team) main.appendChild(el('span', { className: 'team-chip', text: team.name }));
      row.appendChild(main);

      const acts = el('div', { className: 'player-actions' });
      if (inSetup) {
        const sel = el('select', { testId: 'assign-team-select' });
        sel.appendChild(el('option', { text: 'No team', attrs: { value: '' } }));
        (state.teams || []).forEach(t => {
          const opt = el('option', { text: t.name, attrs: { value: t.id } });
          if (t.id === p.teamId) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () {
          actions.onAssignPlayerToTeam(p.id || p.uid, sel.value || null);
        });
        acts.appendChild(sel);
        // Remove button — only rendered before the game starts.
        // The provider also enforces this gate so a stale UI / direct
        // call can't bypass it.
        const removeBtn = el('button', {
          className: 'btn btn-ghost btn-danger btn-tiny',
          text: 'Remove',
          testId: 'remove-player-button',
          dataset: { playerId: p.id || p.uid, playerName: p.name },
          on: { click: (ev) => actions.onRemovePlayer(p.id || p.uid, p.name, ev) },
        });
        acts.appendChild(removeBtn);
      }
      row.appendChild(acts);
      list.appendChild(row);
    });
  }

  function renderAdminTeams(state, actions, inSetup) {
    const list = $('team-list');
    clear(list);
    const teams = state.teams || [];
    $('teams-empty').classList.toggle('hidden', teams.length > 0);
    const canEdit = U.canEditTeams(state.game || {});
    teams.forEach(t => {
      const row = el('li', {
        className: 'team-row',
        testId: 'team-row',
        dataset: { teamId: t.id },
      });
      const main = el('div', { className: 'team-row-main' });
      main.appendChild(el('span', {
        className: 'team-name',
        text: t.name,
        testId: 'team-name',
      }));
      const memberNames = (t.playerIds || [])
        .map(id => ((state.players || []).find(p => (p.id === id || p.uid === id)) || {}).name || '?')
        .join(', ');
      main.appendChild(el('span', {
        className: 'team-members',
        text: (t.playerIds || []).length === 0 ? 'No players yet' : memberNames,
      }));
      // Status chip: valid / warn / empty. Reflects "is this team
      // ready to start" — at least 2 players (helper constant).
      const size = (t.playerIds || []).length;
      let chipClass = 'team-status-chip ';
      let chipText = '';
      if (size === 0) { chipClass += 'empty'; chipText = 'Empty unused team'; }
      else if (size < U.MIN_PLAYERS_PER_TEAM) { chipClass += 'warn'; chipText = 'Needs at least 2 players'; }
      else { chipClass += 'ok'; chipText = 'Valid team'; }
      main.appendChild(el('span', {
        className: chipClass,
        text: chipText,
        testId: 'team-status-chip',
      }));
      if (typeof t.score === 'number' && t.score > 0) {
        main.appendChild(el('span', {
          className: 'team-chip',
          text: t.score + ' pt' + (t.score === 1 ? '' : 's'),
        }));
      }
      // Inline rename composer (hidden by default).
      const renameForm = el('form', { className: 'team-rename-form hidden' });
      const renameInput = el('input', {
        attrs: { type: 'text', maxlength: '30' },
        testId: 'team-rename-input',
      });
      renameInput.value = t.name || '';
      const saveBtn = el('button', {
        className: 'btn btn-primary btn-tiny',
        text: 'Save',
        attrs: { type: 'submit' },
        testId: 'save-team-name-button',
      });
      const cancelBtn = el('button', {
        className: 'btn btn-ghost btn-tiny',
        text: 'Cancel',
        attrs: { type: 'button' },
        on: { click: () => { renameForm.classList.add('hidden'); } },
      });
      renameForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const next = (renameInput.value || '').trim();
        if (!next) return;
        actions.onRenameTeam(t.id, next).then(ok => {
          if (ok) renameForm.classList.add('hidden');
        });
      });
      renameForm.appendChild(renameInput);
      renameForm.appendChild(saveBtn);
      renameForm.appendChild(cancelBtn);
      main.appendChild(renameForm);
      row.appendChild(main);

      const acts = el('div', { className: 'team-actions' });
      if (canEdit) {
        const editBtn = el('button', {
          className: 'btn btn-ghost btn-tiny',
          text: 'Edit Team Name',
          testId: 'edit-team-name-button',
          on: { click: () => {
            renameInput.value = t.name || '';
            renameForm.classList.remove('hidden');
            renameInput.focus();
            renameInput.select();
          } },
        });
        acts.appendChild(editBtn);
        acts.appendChild(el('button', {
          className: 'btn btn-ghost btn-danger btn-tiny',
          text: 'Remove',
          on: { click: () => actions.onDeleteTeam(t.id) },
        }));
      }
      row.appendChild(acts);
      list.appendChild(row);
    });
    renderTeamRandomizer(state, actions, canEdit);
  }

  // Renders the Team Randomizer panel state — preview text + button
  // enable. The radio buttons + numeric inputs are static DOM in
  // index.html; admin.js wires the actual submit. We just refresh
  // the preview, disable controls when teams are locked, and surface
  // a "locked" hint.
  function renderTeamRandomizer(state, actions, canEdit) {
    const panel = $('team-randomizer');
    if (!panel) return;
    panel.classList.toggle('locked', !canEdit);
    panel.classList.toggle('hidden', !canEdit);
    if (!canEdit) return;
    const btn = $('btn-randomize-teams');
    const preview = $('randomizer-preview');
    const players = state.players || [];
    const playerCount = players.length;
    // Read live form state.
    const modeRadio = document.querySelector('input[name="randomizer-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'teamCount';
    $('randomizer-team-count-row').classList.toggle('hidden', mode !== 'teamCount');
    $('randomizer-target-size-row').classList.toggle('hidden', mode !== 'targetSize');
    // Compute preview + enable state.
    let canRun = false;
    let previewText = '';
    if (playerCount < 4) {
      previewText = 'At least 4 players are required to randomize teams.';
    } else {
      try {
        const opts = mode === 'teamCount'
          ? { mode: mode, desiredTeamCount: parseInt($('randomizer-team-count-input').value, 10) }
          : { mode: mode, targetTeamSize: parseInt($('randomizer-target-size-input').value, 10) };
        const r = U.validateRandomizationOptions(playerCount, opts);
        canRun = true;
        const sizes = r.sizes;
        previewText = 'This will create ' + sizes.length + ' teams: ' + sizes.join(', ') + '.';
      } catch (e) {
        previewText = e.message || 'Invalid randomization options.';
      }
    }
    if (preview) preview.textContent = previewText;
    if (btn) btn.disabled = !canRun;
  }

  function renderAdminProgress(state, progress) {
    const list = $('progress-list');
    clear(list);
    const required = (state.game && state.game.wordsPerPlayer) || 0;
    const counts = (progress && progress.readiness && progress.readiness.perPlayerCounts) || {};
    (state.players || []).forEach(p => {
      const li = el('li', {
        className: 'progress-row',
        testId: 'progress-row',
        dataset: { playerId: p.id || p.uid },
      });
      li.appendChild(el('span', { className: 'progress-name', text: p.name }));
      const submitted = counts[p.id || p.uid] || 0;
      const isDone = submitted >= required;
      li.appendChild(el('span', {
        className: 'progress-chip' + (isDone ? ' done' : ''),
        text: submitted + ' / ' + required,
      }));
      list.appendChild(li);
    });
  }

  function renderAdminHatContents(state) {
    // Hat Contents = host-only view of the REMAINING deck for the
    // current round. Independent of the validation panel:
    //   Hat Contents     = remaining words in the current round
    //   Validation Panel = guessed words awaiting confirm/reject
    //
    // Data source: snapshot.hostHatContents, emitted by
    // provider.listenToHostHatContents. The provider already gates
    // by adminUid, so a non-host snapshot will always have an empty
    // `remaining` array even if the section were somehow rendered.
    const section = $('section-hat-contents');
    const list = $('hat-contents-list');
    const game = state.game || {};
    const hhc = state.hostHatContents || {
      remaining: [], roundNumber: 0, roundName: '', originalCount: 0,
    };
    // Visible from lock onward — across all in-round phases, the
    // panel just shows fewer chips. Pre-game phases keep it hidden.
    const showTexts =
      game.phase === PHASE.HAT_LOCKED ||
      U.roundNumberForPhase(game.phase) > 0 ||
      game.phase === PHASE.GAME_FINISHED;
    section.classList.toggle('hidden', !showTexts);
    clear(list);
    if (!showTexts) return;
    // Round label line. Between rounds (no active subdoc) the
    // provider emits roundNumber=0 and we show "All locked words" so
    // the host has a visual anchor for the pre-round state.
    const roundLabel = $('host-hat-round-label');
    if (roundLabel) {
      if (hhc.roundNumber > 0) {
        roundLabel.textContent = hhc.roundName ||
          ('Round ' + hhc.roundNumber);
      } else {
        roundLabel.textContent = 'All locked words';
      }
    }
    // Remaining count line: "K / N" if we're inside a round, plain
    // "N words" before any round has started. The text format is
    // load-bearing — `round-reset.spec.js` parses it.
    const remaining = (hhc.remaining || []).length;
    const original = hhc.originalCount || 0;
    const countEl = $('host-hat-remaining-count');
    if (countEl) {
      if (hhc.roundNumber > 0) {
        countEl.textContent = 'Remaining words: ' + remaining + ' / ' + original;
      } else {
        countEl.textContent = original + (original === 1 ? ' word' : ' words');
      }
    }
    // Empty-state message: only when we're inside a round and the
    // remaining deck is empty. Outside a round, "0 words" already
    // tells the host the hat hasn't been locked.
    const emptyEl = $('host-hat-empty');
    if (emptyEl) {
      const showEmpty = hhc.roundNumber > 0 && remaining === 0;
      emptyEl.classList.toggle('hidden', !showEmpty);
    }
    (hhc.remaining || []).forEach(w => {
      list.appendChild(el('li', {
        className: 'word-item locked',
        text: w.text,
        testId: 'host-hat-word-chip',
      }));
    });
  }

  // Round-agnostic admin panel for the active round. Reads
  // `state.round` (the current round's view, regardless of number).
  // Title + rule come from U.ROUND_CONFIG keyed by `state.round.roundNumber`.
  function renderRound1Admin(state, actions) {
    const section = $('section-round1-admin');
    const r = state.round;
    const game = state.game || {};
    // The admin section is visible during any ROUND_N_* phase. The
    // generic round settings panel handles HAT_LOCKED pre-game.
    const visible = isRoundPhase(game.phase);
    section.classList.toggle('hidden', !visible);
    if (!visible) return;

    // Update the title + rule from ROUND_CONFIG.
    const roundNum = (r && r.roundNumber) || U.roundNumberForPhase(game.phase) || 1;
    const cfg = U.ROUND_CONFIG[roundNum] || {};
    const titleEl = $('round-admin-title');
    const ruleEl = $('round-admin-rule');
    if (titleEl) titleEl.textContent = cfg.name || ('Round ' + roundNum);
    if (ruleEl) ruleEl.textContent = cfg.rule || '';

    // Turn status badge + admin-side countdown text.
    const status = r ? r.status : 'ready';
    const statusBadge = $('turn-status-badge');
    if (statusBadge) {
      statusBadge.textContent = status;
      statusBadge.classList.toggle('locked',
        status === U.R_STATUS.TURN_VALIDATION ||
        status === U.R_STATUS.WAITING_TO_START);
    }
    const adminTimer = $('round-timer-admin');
    if (adminTimer) {
      adminTimer.textContent = computeTimerLabel(r);
    }

    const meta = $('round1-admin-meta');
    clear(meta);
    if (game.phase === U.phaseForRound(roundNum, 'READY')) {
      meta.appendChild(el('div', {
        className: 'muted',
        text: 'Press "Start first turn" above to begin Round ' + roundNum + '.',
      }));
    } else if (game.phase === U.phaseForRound(roundNum, 'FINISHED')) {
      meta.appendChild(el('div', {
        className: 'muted',
        text: 'Round ' + roundNum + ' is complete.',
      }));
    } else if (r) {
      const team = (state.teams || []).find(t => t.id === r.activeTeamId);
      const explainer = (state.players || []).find(p => p.id === r.activeExplainerPlayerId);
      meta.appendChild(el('div', {
        className: 'round1-meta-row',
        text: 'Turn ' + r.turnNumber +
              ' · Team: ' + (team ? team.name : '—') +
              ' · Explainer: ' + (explainer ? explainer.name : '—'),
      }));
      meta.appendChild(el('div', {
        className: 'round1-meta-row muted small',
        text: r.remainingCount + ' words left in the deck',
      }));
    }

    // Per-round scoreboard: shows total + R1/R2/R3 subtotals per team.
    renderRoundScoreboard(state);

    // The legacy "public guessed" strip on the host screen has been
    // removed — under strict privacy the host's view of remaining
    // words lives in the Hat Contents section, and pending guesses
    // live in the Validation Panel. No third surface needed.

    // Admin's manual buttons:
    //   - During ACTIVE   : show "End turn" (early-end before timer).
    //   - During WAITING / READY between turns: show "Start next turn".
    //   - Never auto-show both; the state machine determines which.
    const actsRoot = $('round1-admin-actions');
    clear(actsRoot);
    const isActive = r && r.status === U.R_STATUS.ACTIVE;
    const isWaiting = r && r.status === U.R_STATUS.WAITING_TO_START;
    const isBetween = r && r.status === U.R_STATUS.READY;
    const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
    if (isActive) {
      actsRoot.appendChild(el('button', {
        className: 'btn btn-secondary',
        text: 'End turn',
        testId: 'end-turn-button',
        on: { click: actions.onEndTurn },
      }));
    } else if (isWaiting) {
      actsRoot.appendChild(el('div', {
        className: 'muted small',
        text: 'Waiting for the explainer to press Start.',
      }));
    } else if (isBetween && game.phase === activePhase && r.remainingCount > 0) {
      actsRoot.appendChild(el('button', {
        className: 'btn btn-primary',
        text: 'Start next turn',
        testId: 'start-turn-button',
        on: { click: actions.onStartNextTurn },
      }));
    }
  }

  // Scoreboard with total + per-round subtotals.
  function renderRoundScoreboard(state) {
    const root = $('round-scoreboard');
    if (!root) return;
    clear(root);
    const teams = (state.teams || []).slice().sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );
    teams.forEach(t => {
      const rs = t.roundScores || { 1: 0, 2: 0, 3: 0 };
      const row = el('div', {
        className: 'scoreboard-row',
        testId: 'scoreboard-row',
        dataset: { teamId: t.id },
      });
      row.appendChild(el('span', {
        className: 'scoreboard-name', text: t.name,
      }));
      row.appendChild(el('span', {
        className: 'scoreboard-total',
        text: (t.score || 0) + ' pt' + (t.score === 1 ? '' : 's'),
      }));
      row.appendChild(el('span', {
        className: 'scoreboard-breakdown muted small',
        text: 'R1: ' + (rs[1] || 0) +
              ' · R2: ' + (rs[2] || 0) +
              ' · R3: ' + (rs[3] || 0),
      }));
      root.appendChild(row);
    });
  }

  // Returns `MM:SS` for the current timer state, regardless of phase.
  //   - status=active   : remaining = turnEndsAt - now
  //   - status=waiting  : preview = durationSeconds
  //   - otherwise        : `—`
  function computeTimerLabel(r) {
    if (!r) return '—';
    if (r.status === U.R_STATUS.ACTIVE && r.turnEndsAt) {
      const remaining = (new Date(r.turnEndsAt).getTime() - Date.now()) / 1000;
      return U.formatTime(remaining);
    }
    if (r.status === U.R_STATUS.WAITING_TO_START) {
      return U.formatTime(r.durationSeconds || U.DEFAULT_DURATION_SECONDS);
    }
    return '—';
  }

  function renderRound1Validation(state, actions) {
    const section = $('section-round1-validation');
    const r = state.round;
    const game = state.game || {};
    const inValidation =
      game.phase === PHASE.ROUND_1_TURN_VALIDATION ||
      game.phase === PHASE.ROUND_2_TURN_VALIDATION ||
      game.phase === PHASE.ROUND_3_TURN_VALIDATION;
    section.classList.toggle('hidden', !inValidation);
    if (!inValidation || !r) return;

    // Single source of truth: the provider's pre-resolved list.
    // Both the badge and the rendered cards read from `pendingWords`
    // so they cannot drift. The provider derives this from the
    // canonical helper (current turn's guessed − confirmed − rejected).
    const pendingWords = r.pendingValidationWords || [];
    $('pending-validation-count').textContent = pendingWords.length;

    const list = $('validation-list');
    clear(list);
    pendingWords.forEach(w => {
      const li = el('li', {
        className: 'validation-row validation-word-card',
        testId: 'validation-row',
        dataset: { wordId: w.id },
      });
      const main = el('div', { className: 'word-card-main' });
      main.appendChild(el('span', { className: 'validation-text word-card-text', text: w.text }));
      li.appendChild(main);
      const actionsCol = el('div', { className: 'word-card-actions' });
      const confirm = el('button', {
        className: 'btn btn-primary btn-tiny',
        text: 'Confirm',
        testId: 'confirm-guessed-word-button',
        on: { click: (ev) => actions.onConfirmGuessedWord(w.id, ev) },
      });
      const reject = el('button', {
        className: 'btn btn-ghost btn-danger btn-tiny',
        text: 'Reject / Return to hat',
        testId: 'reject-guessed-word-button',
        on: { click: (ev) => actions.onRejectGuessedWord(w.id, ev) },
      });
      actionsCol.appendChild(confirm);
      actionsCol.appendChild(reject);
      li.appendChild(actionsCol);
      list.appendChild(li);
    });

    $('btn-finish-validation').disabled = pendingWords.length > 0;
  }

  // -------------------- Player renderers -------------------------
  function renderPlayer(state, actions) {
    const game = state.game || { phase: PHASE.LOBBY };
    const phase = game.phase;
    const me = state.me || {};
    const required = game.wordsPerPlayer || 0;
    const myWords = state.myWords || [];

    $('player-phase-pill').textContent = phasePillLabel(phase);
    $('me-name').textContent = me.name || '—';
    const team = (state.teams || []).find(t => t.id === me.teamId);
    $('me-team').textContent = team ? '· Team ' + team.name : '';

    // Hat progress (counts only)
    const totalSubmitted = (state.players || []).reduce((s, p) => s + (p.wordCount || 0), 0);
    const totalRequired = required * (state.players || []).length;
    $('player-hat-progress-text').textContent = totalSubmitted + ' / ' + totalRequired + ' words';
    setProgressBar('player-hat-progress-fill', totalSubmitted, totalRequired);

    $('my-progress-text').textContent = myWords.length + ' / ' + required;

    // Phase message
    const myRevisions = (myWords || []).filter(w => w.status === 'needs_revision');
    let msg = '';
    if (phase === PHASE.LOBBY || phase === PHASE.TEAMS_SETUP) {
      msg = 'Waiting for the host to start word collection…';
    } else if (phase === PHASE.WORD_COLLECTION) {
      if (myWords.length >= required) msg = 'You submitted all your words. Waiting for other players.';
      else msg = 'Enter ' + (required - myWords.length) + ' more word(s).';
    } else if (phase === PHASE.WORD_REVIEW) {
      msg = myRevisions.length > 0
        ? 'The host asked you to revise some of your words.'
        : 'The host is reviewing submitted words.';
    } else if (phase === PHASE.HAT_LOCKED) {
      msg = 'The hat is locked. Waiting for Round 1.';
    } else if (phase === PHASE.GAME_FINISHED) {
      msg = 'The game is over.';
    } else {
      const rn = U.roundNumberForPhase(phase);
      if (rn > 0) {
        if (phase === U.phaseForRound(rn, 'READY')) {
          msg = 'Round ' + rn + ' is ready. Waiting for the host to start the first turn.';
        } else if (phase === U.phaseForRound(rn, 'TURN_VALIDATION')) {
          msg = 'Turn over — the host is validating words.';
        } else if (phase === U.phaseForRound(rn, 'FINISHED')) {
          msg = 'Round ' + rn + ' is complete!';
        }
      }
    }
    $('player-phase-message').textContent = msg;

    // Word entry card visible only during collection.
    $('my-words-card').classList.toggle('hidden', phase !== PHASE.WORD_COLLECTION);

    // Words Need Revision panel: visible during WORD_REVIEW if the
    // player owns one or more words flagged needs_revision. The list
    // is filtered to this player's own words (provider already gates
    // `listenToOwnWords` by ownerUid).
    renderPlayerRevisionPanel(state, actions, myRevisions);

    if (phase === PHASE.WORD_COLLECTION) {
      const wordInput = $('word-input');
      const submitBtn = $('add-word-form').querySelector('[data-testid="submit-word-button"]');
      const atCap = myWords.length >= required;
      wordInput.disabled = atCap;
      if (submitBtn) submitBtn.disabled = atCap;
      wordInput.placeholder = atCap ? 'All ' + required + ' words submitted' : 'Type a word…';

      const list = $('my-word-list');
      clear(list);
      myWords.forEach(w => {
        const li = el('li', {
          className: 'word-item',
          testId: 'my-word-item',
          dataset: { wordId: w.id },
        });
        const inp = el('input', {
          className: 'word-edit',
          attrs: { type: 'text', value: w.text, maxlength: '40' },
          testId: 'my-word-edit',
        });
        inp.value = w.text;
        inp.addEventListener('change', function () {
          const next = inp.value.trim();
          if (!next || next === w.text) { inp.value = w.text; return; }
          actions.onUpdateWord(w.id, next).catch(() => { inp.value = w.text; });
        });
        li.appendChild(inp);
        const del = el('button', {
          className: 'btn btn-ghost btn-danger btn-tiny',
          text: '✕',
          attrs: { title: 'Delete word' },
          testId: 'delete-word-button',
          on: { click: (ev) => actions.onDeleteWord(w.id, ev) },
        });
        li.appendChild(del);
        list.appendChild(li);
      });
    }

    renderPlayerRound1(state, actions);
    renderPlayerFinalResults(state);
  }

  // Player-side: list of words the host has marked needs_revision.
  // Owner-only because `state.myWords` is provider-filtered to this
  // player's UID. Other players never see this panel — defense in
  // depth: the panel itself is gated on `revisions.length > 0`.
  function renderPlayerRevisionPanel(state, actions, revisions) {
    const section = $('section-player-revision');
    if (!section) return;
    const game = state.game || {};
    const visible = game.phase === PHASE.WORD_REVIEW && (revisions || []).length > 0;
    section.classList.toggle('hidden', !visible);
    if (!visible) return;
    const list = $('player-revision-list');
    if (!list) return;
    clear(list);
    revisions.forEach(w => {
      const li = el('li', {
        className: 'player-revision-card',
        testId: 'player-revision-card',
        dataset: { wordId: w.id },
      });
      const main = el('div', { className: 'word-card-main' });
      main.appendChild(el('div', {
        className: 'player-revision-current',
        text: w.text || '',
      }));
      if (w.revisionReason) {
        main.appendChild(el('div', {
          className: 'player-revision-reason',
          text: 'Host reason: ' + w.revisionReason,
          testId: 'revision-reason-message',
        }));
      }
      const inputRow = el('div', { className: 'player-revision-input-row' });
      const input = el('input', {
        attrs: { type: 'text', maxlength: '40' },
        testId: 'revised-word-input',
      });
      input.value = w.text || '';
      const resubmit = el('button', {
        className: 'btn btn-primary btn-tiny',
        text: 'Resubmit',
        testId: 'resubmit-revised-word-button',
        on: { click: (ev) => {
          const next = (input.value || '').trim();
          if (!next) return;
          actions.onResubmitRevisedWord(w.id, next, ev);
        } },
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const next = (input.value || '').trim();
          if (!next) return;
          actions.onResubmitRevisedWord(w.id, next, null);
        }
      });
      inputRow.appendChild(input);
      main.appendChild(inputRow);
      li.appendChild(main);
      const actionsCol = el('div', { className: 'word-card-actions' });
      actionsCol.appendChild(resubmit);
      li.appendChild(actionsCol);
      list.appendChild(li);
    });
  }

  function renderPlayerRound1(state, actions) {
    const card = $('round1-card');
    const game = state.game || {};
    const r = state.round;
    const roundNum = U.roundNumberForPhase(game.phase);
    // Card visible during any active-round phase. (READY's "waiting"
    // message is on the global phase line above, not on the card.)
    const inRound = roundNum > 0 && roundNum >= 1 && roundNum <= 3 &&
      (game.phase === U.phaseForRound(roundNum, 'ACTIVE') ||
       game.phase === U.phaseForRound(roundNum, 'TURN_VALIDATION') ||
       game.phase === U.phaseForRound(roundNum, 'FINISHED'));
    card.classList.toggle('hidden', !inRound);
    if (!inRound) return;

    // Round-info header (title + rule) — driven by ROUND_CONFIG.
    const cfg = U.ROUND_CONFIG[roundNum] || {};
    const titleEl = $('player-round-title');
    const ruleEl = $('player-round-rule');
    if (titleEl) titleEl.textContent = cfg.name || ('Round ' + roundNum);
    if (ruleEl) ruleEl.textContent = cfg.rule || '';

    const isExplainer = r && r.activeExplainerUid && r.activeExplainerUid === state.uid;
    const status = r ? r.status : null;
    const isWaiting = status === U.R_STATUS.WAITING_TO_START;
    const isActive = status === U.R_STATUS.ACTIVE;

    // Explainer view is visible during WAITING_TO_START (Start
    // button) and ACTIVE (Guessed button + word). Watcher view is
    // visible the rest of the time the round1-card is shown.
    $('round1-explainer-view').classList.toggle('hidden',
      !(isExplainer && (isWaiting || isActive)));
    $('round1-watcher-view').classList.toggle('hidden',
      isExplainer && (isWaiting || isActive));

    const meta = $('round1-meta-player');
    clear(meta);
    if (r) {
      const team = (state.teams || []).find(t => t.id === r.activeTeamId);
      const explainer = (state.players || []).find(p => p.id === r.activeExplainerPlayerId);
      meta.appendChild(el('div', {
        className: 'round1-meta-row',
        text: 'Turn ' + (r.turnNumber || 0) +
              ' · Team: ' + (team ? team.name : '—') +
              ' · Explainer: ' + (explainer ? explainer.name : '—'),
      }));
    }

    // Shared countdown / preview display (visible whenever round1-card is open).
    const timerEl = $('round-timer-player');
    if (timerEl) {
      timerEl.textContent = computeTimerLabel(r);
      timerEl.classList.toggle('is-active', !!isActive);
    }

    // Explainer-side controls
    const activeWordEl = $('active-word-text');
    const activeWordCard = $('active-word-card');
    const preStartMsg = $('pre-start-reveal-message');
    const startBtn = $('btn-turn-start');
    const guessedBtn = $('btn-guessed');
    const wrongBtn = $('btn-wrong');
    const timeOverEx = $('time-over-explainer');
    // Defense in depth: even though the provider strips
    // `activeWordText` for non-explainers, the renderer also gates
    // on canSeeActiveWord so a future bug or imported state can't
    // accidentally bleed a word into the DOM.
    const canWordShow = U.canSeeActiveWord(state);
    if (isExplainer && (isWaiting || isActive) && canWordShow) {
      // Word is only revealed once the turn is ACTIVE (i.e. the
      // explainer has pressed Start). During WAITING_TO_START we
      // intentionally hide it — no peeking before the timer runs.
      if (isActive) {
        activeWordEl.textContent = r.activeWordText || '…';
        if (activeWordCard) activeWordCard.classList.remove('hidden');
        if (preStartMsg) preStartMsg.classList.add('hidden');
      } else {
        // WAITING_TO_START: clear the word, show the pre-start
        // message so the explainer knows the word will appear on
        // Start.
        activeWordEl.textContent = '';
        if (activeWordCard) activeWordCard.classList.add('hidden');
        if (preStartMsg) preStartMsg.classList.remove('hidden');
      }
      // Start: only during WAITING_TO_START. Hide once timer rolls.
      startBtn.classList.toggle('hidden', !isWaiting);
      // Start is enabled even though activeWordId is null at this
      // point — the provider picks the word atomically with starting
      // the timer.
      startBtn.disabled = !isWaiting;
      // Guessed: only during ACTIVE and before the deadline.
      guessedBtn.classList.toggle('hidden', !isActive);
      const expired = !!r.turnEndsAt &&
        new Date(r.turnEndsAt).getTime() <= Date.now();
      guessedBtn.disabled = !isActive || !r.activeWordId || expired;
      // Wrong: only in rounds where ROUND_CONFIG.hasWrong is true
      // (Round 3), and only during ACTIVE before the deadline. Same
      // visibility rules as Guessed, but constrained to the right
      // round.
      if (wrongBtn) {
        const showWrong = !!cfg.hasWrong && isActive;
        wrongBtn.classList.toggle('hidden', !showWrong);
        wrongBtn.disabled = !showWrong || !r.activeWordId || expired;
      }
      if (timeOverEx) timeOverEx.classList.toggle('hidden', !expired);
    } else {
      // Not in an explainer state — make sure stale buttons are
      // hidden so a watcher never sees Guessed/Wrong even briefly.
      // Also clear any active-word text that might have lingered
      // from a previous render where the user WAS the explainer.
      if (activeWordEl) activeWordEl.textContent = '';
      if (activeWordCard) activeWordCard.classList.add('hidden');
      if (preStartMsg) preStartMsg.classList.add('hidden');
      if (wrongBtn) wrongBtn.classList.add('hidden');
      if (timeOverEx) timeOverEx.classList.add('hidden');
    }

    // Watcher-side messaging
    const waitingMsg = $('waiting-to-start-message');
    const watcherTimeOver = $('time-over-watcher');
    if (waitingMsg) {
      // Show "Waiting for X to start" to watchers while the
      // explainer hasn't pressed Start.
      const showWaiting = isWaiting && !isExplainer;
      waitingMsg.classList.toggle('hidden', !showWaiting);
      if (showWaiting) {
        const expName = ((state.players || [])
          .find(p => p.id === r.activeExplainerPlayerId) || {}).name || 'the explainer';
        waitingMsg.textContent = 'Waiting for ' + expName + ' to start.';
      }
    }
    const turnIsValidating = state.game && (
      state.game.phase === PHASE.ROUND_1_TURN_VALIDATION ||
      state.game.phase === PHASE.ROUND_2_TURN_VALIDATION ||
      state.game.phase === PHASE.ROUND_3_TURN_VALIDATION
    );
    if (watcherTimeOver) {
      // Watchers see "Time is over" the moment the active turn ends —
      // before validation kicks in. status=TURN_VALIDATION or active
      // but expired both count.
      const expired = isActive && !!r.turnEndsAt &&
        new Date(r.turnEndsAt).getTime() <= Date.now();
      watcherTimeOver.classList.toggle('hidden',
        isExplainer || (!expired && !turnIsValidating));
    }

    // Neutral status messages for non-explainer players. Exactly
    // one is shown at a time:
    //   - guessing  : turn is active, host will validate guesses
    //   - validating: turn ended, awaiting host validation
    //   - hidden    : default; "Words are hidden from players."
    //
    // The waiting-to-start message above wins over all three when
    // the explainer hasn't pressed Start yet.
    const guessingMsg = $('player-status-guessing');
    const validatingMsg = $('player-status-validating');
    const hiddenMsg = $('player-status-hidden');
    const inWatcherView = !isExplainer || !(isWaiting || isActive);
    if (guessingMsg && validatingMsg && hiddenMsg) {
      let shown = null;
      if (inWatcherView && !isWaiting) {
        if (turnIsValidating) shown = validatingMsg;
        else if (isActive) shown = guessingMsg;
        else shown = hiddenMsg;
      }
      guessingMsg.classList.toggle('hidden', shown !== guessingMsg);
      validatingMsg.classList.toggle('hidden', shown !== validatingMsg);
      hiddenMsg.classList.toggle('hidden', shown !== hiddenMsg);
    }
  }

  // Final results panel on the player side. Mirrors the admin's
  // final-results section so every participant sees the same totals.
  function renderPlayerFinalResults(state) {
    const section = $('section-final-results-player');
    if (!section) return;
    const game = state.game || {};
    const visible = game.phase === PHASE.GAME_FINISHED;
    section.classList.toggle('hidden', !visible);
    if (!visible) return;
    const standings = calculateFinalStandings(state.teams || []);
    const winnerName = getWinner(standings);
    const winnerEl = $('final-winner-player');
    if (winnerEl) {
      winnerEl.textContent = winnerName
        ? 'Winner: ' + winnerName
        : (standings.length ? 'Tie Game' : '');
    }
    const list = $('final-results-list-player');
    clear(list);
    standings.forEach(s => {
      const li = el('li', {
        className: 'final-result-row',
        text: s.teamName + ' — ' + s.totalScore + ' pts ' +
          '(R1: ' + s.round1Score +
          ', R2: ' + s.round2Score +
          ', R3: ' + s.round3Score + ')',
      });
      list.appendChild(li);
    });
  }

  // Lightweight timer-only updater. Called from the per-tab ticker
  // every 500ms so the countdown text refreshes without rebuilding
  // any buttons — that would make them unstable for tests + cause
  // mid-click cancellations.
  function tickRoundTimer(state) {
    const r = state && state.round;
    const adminEl = $('round-timer-admin');
    if (adminEl) adminEl.textContent = computeTimerLabel(r);
    const playerEl = $('round-timer-player');
    if (playerEl) playerEl.textContent = computeTimerLabel(r);
  }

  global.HatGame.UI = {
    renderAdminDashboard: renderAdminDashboard,
    renderPlayer: renderPlayer,
    computeProgress: computeProgress,
    tickRoundTimer: tickRoundTimer,
    calculateFinalStandings: calculateFinalStandings,
    getWinner: getWinner,
  };
})(window);
