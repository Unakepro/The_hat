/* eslint-disable */
/**
 * Shared helpers: DOM, logging, toasts, URL params, screen routing,
 * game-code generation, ID generation, basic input validation.
 *
 * All other modules consume these via the `window.HatGame.Utils` object
 * so we avoid a global function soup.
 */
(function (global) {
  'use strict';

  // ---- Constants ---------------------------------------------------
  const PHASE = {
    LOBBY: 'LOBBY',
    TEAMS_SETUP: 'TEAMS_SETUP',
    WORD_COLLECTION: 'WORD_COLLECTION',
    // Host-only review/approve step between collection and lock.
    // Only words with status='approved' end up in the locked hat.
    WORD_REVIEW: 'WORD_REVIEW',
    HAT_LOCKED: 'HAT_LOCKED',
    ROUND_1_READY: 'ROUND_1_READY',
    ROUND_1_ACTIVE: 'ROUND_1_ACTIVE',
    ROUND_1_TURN_VALIDATION: 'ROUND_1_TURN_VALIDATION',
    ROUND_1_FINISHED: 'ROUND_1_FINISHED',
    ROUND_2_READY: 'ROUND_2_READY',
    ROUND_2_ACTIVE: 'ROUND_2_ACTIVE',
    ROUND_2_TURN_VALIDATION: 'ROUND_2_TURN_VALIDATION',
    ROUND_2_FINISHED: 'ROUND_2_FINISHED',
    ROUND_3_READY: 'ROUND_3_READY',
    ROUND_3_ACTIVE: 'ROUND_3_ACTIVE',
    ROUND_3_TURN_VALIDATION: 'ROUND_3_TURN_VALIDATION',
    ROUND_3_FINISHED: 'ROUND_3_FINISHED',
    GAME_FINISHED: 'GAME_FINISHED',
  };
  const ALL_PHASES = [
    PHASE.LOBBY, PHASE.TEAMS_SETUP, PHASE.WORD_COLLECTION,
    PHASE.WORD_REVIEW,
    PHASE.HAT_LOCKED,
    PHASE.ROUND_1_READY, PHASE.ROUND_1_ACTIVE,
    PHASE.ROUND_1_TURN_VALIDATION, PHASE.ROUND_1_FINISHED,
    PHASE.ROUND_2_READY, PHASE.ROUND_2_ACTIVE,
    PHASE.ROUND_2_TURN_VALIDATION, PHASE.ROUND_2_FINISHED,
    PHASE.ROUND_3_READY, PHASE.ROUND_3_ACTIVE,
    PHASE.ROUND_3_TURN_VALIDATION, PHASE.ROUND_3_FINISHED,
    PHASE.GAME_FINISHED,
  ];

  // Round status enum (substate of the phases above). Applies to all
  // 3 rounds — the state machine is identical between rounds.
  //
  //   READY              — between turns; no turn picked yet
  //   WAITING_TO_START   — turn picked, awaiting explainer's Start click
  //   ACTIVE             — timer running, gameplay live
  //   TURN_VALIDATION    — timer ended, admin validating guesses
  //   FINISHED           — round complete
  const R_STATUS = {
    READY: 'ready',
    WAITING_TO_START: 'waiting_to_start',
    ACTIVE: 'active',
    TURN_VALIDATION: 'turn_validation',
    FINISHED: 'finished',
  };
  // Backwards-compatible alias — older code reads R1_STATUS.
  const R1_STATUS = R_STATUS;

  // Per-round timer constraints (apply uniformly to all rounds).
  const MIN_DURATION_SECONDS = 10;
  const MAX_DURATION_SECONDS = 300;
  const DEFAULT_DURATION_SECONDS = 60;

  // Round configuration. Each round has:
  //   name           — human-readable label shown in the UI
  //   rule           — one-line description of the round's rule
  //   defaultSeconds — default turn duration if the host doesn't override
  //   hasWrong       — whether the "Wrong" button is shown to the
  //                    explainer (Round 3 only). "Wrong" ends the turn
  //                    immediately with the current active word
  //                    remaining in the deck for the next explainer.
  const ROUND_CONFIG = {
    1: {
      name: 'Round 1 — Normal Explanation',
      rule: 'Describe the word with sentences. Do not say the word itself or its root.',
      defaultSeconds: 60,
      hasWrong: false,
    },
    2: {
      name: 'Round 2 — Charades',
      rule: 'No words, no sounds. Act it out.',
      defaultSeconds: 60,
      hasWrong: false,
    },
    3: {
      name: 'Round 3 — One-Word Association',
      rule: 'You may say exactly one associative word. If your team does not guess, press "Wrong" to end your turn.',
      defaultSeconds: 30,
      hasWrong: true,
    },
  };

  // Phase ↔ round number mapping. Returns 1/2/3 for any of the
  // ROUND_N_* phases, or 0 outside a round.
  function roundNumberForPhase(phase) {
    if (!phase) return 0;
    if (phase.indexOf('ROUND_1_') === 0) return 1;
    if (phase.indexOf('ROUND_2_') === 0) return 2;
    if (phase.indexOf('ROUND_3_') === 0) return 3;
    return 0;
  }
  function phaseForRound(roundNum, suffix) {
    const key = 'ROUND_' + roundNum + '_' + suffix;
    return PHASE[key] || null;
  }
  // Convenience: what phases are valid "round X is happening" phases?
  function roundLifecyclePhases(roundNum) {
    return [
      phaseForRound(roundNum, 'READY'),
      phaseForRound(roundNum, 'ACTIVE'),
      phaseForRound(roundNum, 'TURN_VALIDATION'),
      phaseForRound(roundNum, 'FINISHED'),
    ].filter(Boolean);
  }
  function defaultDurationForRound(roundNum) {
    const cfg = ROUND_CONFIG[roundNum];
    return (cfg && cfg.defaultSeconds) || DEFAULT_DURATION_SECONDS;
  }

  // Action types for the per-turn action log.
  const ACTION = {
    GUESSED: 'guessed',
    ADMIN_CONFIRMED: 'admin_confirmed',
    ADMIN_REJECTED: 'admin_rejected',
    TURN_ENDED: 'turn_ended',
  };

  const MAX_WORD_LENGTH = 40;
  const MAX_NAME_LENGTH = 30;
  const MIN_WORDS = 1;
  const MAX_WORDS = 20;

  // Unambiguous alphabet for game codes — no 0/O, 1/I/L confusion.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LENGTH = 6;

  // ---- Custom error type ------------------------------------------
  class GameError extends Error {
    constructor(message, source) {
      super(message);
      this.name = 'GameError';
      this.source = source || 'Validation';
    }
  }

  // ---- DOM helpers -------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function $$(selector, root) { return Array.from((root || document).querySelectorAll(selector)); }

  function el(tag, opts) {
    const node = document.createElement(tag);
    if (!opts) return node;
    if (opts.className) node.className = opts.className;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.html != null) node.innerHTML = opts.html;
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) {
      node.setAttribute(k, opts.attrs[k]);
    });
    if (opts.dataset) Object.keys(opts.dataset).forEach(function (k) {
      node.dataset[k] = opts.dataset[k];
    });
    if (opts.testId) node.setAttribute('data-testid', opts.testId);
    if (opts.on) Object.keys(opts.on).forEach(function (ev) {
      node.addEventListener(ev, opts.on[ev]);
    });
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- Logging -----------------------------------------------------
  // Standardised prefixes so QA can grep the console output for the
  // category of any given error.
  function log(category, level, args) {
    const prefix = '[AliasGame][' + category + ']';
    const fn = console[level] || console.log;
    fn.apply(console, [prefix].concat(Array.prototype.slice.call(args)));
  }
  const Log = {
    state: function () { log('State', 'log', arguments); },
    ui: function () { log('UI', 'log', arguments); },
    validation: function () { log('Validation', 'warn', arguments); },
    firebase: function () { log('Firebase', 'log', arguments); },
    firebaseError: function () { log('Firebase', 'error', arguments); },
    error: function () { log('Error', 'error', arguments); },
  };

  // ---- Toast -------------------------------------------------------
  let toastTimer = null;
  function showToast(message, kind) {
    const node = $('toast');
    if (!node) {
      console.warn('toast container missing; message:', message);
      return;
    }
    node.textContent = message;
    node.className = 'toast ' + (kind === 'error' ? 'error' : 'info');
    node.classList.remove('hidden');
    // Mark for tests: the latest error is reflected via the testid.
    if (kind === 'error') node.setAttribute('data-testid', 'error-message');
    else node.setAttribute('data-testid', 'info-message');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.add('hidden');
    }, kind === 'error' ? 4500 : 2500);
  }

  // ---- Screen routing ----------------------------------------------
  function showScreen(id) {
    $$('.screen').forEach(function (s) {
      s.classList.toggle('hidden', s.id !== id);
    });
    Log.ui('screen ->', id);
  }

  // ---- URL helpers -------------------------------------------------
  function getQuery() {
    const params = new URLSearchParams(global.location.search);
    return {
      mode: params.get('mode'),       // 'mock' for tests / local demo
      debug: params.get('debug'),     // '1' shows debug panel
      game: params.get('game'),       // ?game=ABC123 deep-link
      role: params.get('role'),       // 'admin' or 'player' (deep-link)
    };
  }

  function inviteLink(gameCode) {
    const url = new URL(global.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('game', gameCode);
    return url.toString();
  }

  // ---- ID and code generators --------------------------------------
  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function newGameCode() {
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }

  function nowIso() { return new Date().toISOString(); }

  // ---- Input validators (shared with state) ------------------------
  function requireNonEmpty(value, label) {
    if (value == null) throw new GameError(label + ' cannot be empty.');
    const trimmed = String(value).trim();
    if (!trimmed) throw new GameError(label + ' cannot be empty.');
    return trimmed;
  }

  function validateWordText(text) {
    const clean = requireNonEmpty(text, 'Word');
    if (clean.length > MAX_WORD_LENGTH) {
      throw new GameError('Word is too long (max ' + MAX_WORD_LENGTH + ' chars).');
    }
    return clean;
  }

  // Normalize a word for case-insensitive duplicate comparison.
  // Used by the host's Word Review surface to flag two players
  // submitting the same word with different spacing/casing.
  function normalizeWordForCompare(text) {
    if (!text) return '';
    return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // ---- Team randomization helpers ---------------------------------
  // Minimum players-per-team for a valid game. Mirrors MIN_PLAYERS_PER_TEAM
  // in the mock provider — kept in sync via a single constant.
  const MIN_PLAYERS_PER_TEAM = 2;
  const MIN_TEAMS = 2;

  // Fisher–Yates shuffle. Returns a NEW array; the input is left
  // untouched so callers can shuffle a copy without surprise.
  function shuffleArray(array) {
    const out = (array || []).slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  // Compute team sizes when the host specifies "I want N teams".
  // Returns an array of sizes summing to playerCount, sorted desc, so
  // the first `extra` teams have one more player than the rest.
  //   calculateTeamSizesByTeamCount(6, 2)  -> [3, 3]
  //   calculateTeamSizesByTeamCount(7, 2)  -> [4, 3]
  //   calculateTeamSizesByTeamCount(8, 3)  -> [3, 3, 2]
  //   calculateTeamSizesByTeamCount(10, 4) -> [3, 3, 2, 2]
  function calculateTeamSizesByTeamCount(playerCount, desiredTeamCount) {
    const pc = Math.max(0, parseInt(playerCount, 10) || 0);
    const tc = Math.max(0, parseInt(desiredTeamCount, 10) || 0);
    if (tc <= 0 || pc <= 0) return [];
    const base = Math.floor(pc / tc);
    const extra = pc % tc;
    const sizes = [];
    for (let i = 0; i < tc; i++) {
      sizes.push(i < extra ? base + 1 : base);
    }
    return sizes;
  }

  // Compute team sizes when the host specifies "target team size".
  // Picks the team count via ceil(playerCount / targetTeamSize), then
  // recomputes sizes via the team-count helper so the result is as
  // balanced as possible. Falls back gracefully when the naive count
  // would leave a team smaller than 2 — the count is reduced by 1.
  //
  //   calculateTeamSizesByTargetSize(4, 3)  -> [2, 2]
  //   calculateTeamSizesByTargetSize(5, 3)  -> [3, 2]
  //   calculateTeamSizesByTargetSize(6, 3)  -> [3, 3]
  //   calculateTeamSizesByTargetSize(7, 3)  -> [3, 2, 2]
  //   calculateTeamSizesByTargetSize(8, 3)  -> [3, 3, 2]
  //   calculateTeamSizesByTargetSize(10, 4) -> [4, 3, 3]
  function calculateTeamSizesByTargetSize(playerCount, targetTeamSize) {
    const pc = Math.max(0, parseInt(playerCount, 10) || 0);
    const ts = Math.max(0, parseInt(targetTeamSize, 10) || 0);
    if (pc <= 0 || ts <= 0) return [];
    let count = Math.ceil(pc / ts);
    if (count < 1) count = 1;
    // Avoid teams of 1 when possible by shrinking the count until the
    // smallest team is at least MIN_PLAYERS_PER_TEAM.
    while (count > 1) {
      const sizes = calculateTeamSizesByTeamCount(pc, count);
      const min = sizes[sizes.length - 1];
      if (min >= MIN_PLAYERS_PER_TEAM) return sizes;
      count -= 1;
    }
    return calculateTeamSizesByTeamCount(pc, count);
  }

  // Shape the host's input into a `{ mode, teamCount, targetSize }`
  // record and throw a friendly GameError on anything invalid for an
  // MVP randomization (4+ players, no teams of 1).
  function validateRandomizationOptions(playerCount, options) {
    const pc = parseInt(playerCount, 10) || 0;
    if (pc < 4) {
      throw new GameError('At least 4 players are required to create valid teams.');
    }
    const mode = options && options.mode;
    if (mode !== 'teamCount' && mode !== 'targetSize') {
      throw new GameError('Pick a randomization mode.');
    }
    if (mode === 'teamCount') {
      const tc = parseInt(options.desiredTeamCount, 10);
      if (!Number.isFinite(tc) || tc < 2) {
        throw new GameError('Choose at least 2 teams.');
      }
      const maxTeams = Math.floor(pc / MIN_PLAYERS_PER_TEAM);
      if (tc > maxTeams) {
        throw new GameError('Choose fewer teams. Each team must have at least 2 players.');
      }
      return { mode: mode, sizes: calculateTeamSizesByTeamCount(pc, tc) };
    }
    // targetSize
    const ts = parseInt(options.targetTeamSize, 10);
    if (!Number.isFinite(ts) || ts < MIN_PLAYERS_PER_TEAM) {
      throw new GameError('Target team size must be at least ' + MIN_PLAYERS_PER_TEAM + '.');
    }
    if (ts > pc) {
      throw new GameError('Target team size cannot exceed the player count.');
    }
    return { mode: mode, sizes: calculateTeamSizesByTargetSize(pc, ts) };
  }

  // Slice the (already-shuffled) player array into chunks per the
  // given size table, and produce updated team rows. `existingTeams`
  // contributes ids + names; new teams get default names ("Team A",
  // "Team B", ...). Extra existing teams beyond `sizes.length` are
  // returned with empty playerIds so callers can decide what to do
  // with them (we never auto-delete, per spec).
  //
  //   assignPlayersToBalancedTeams(
  //     [p1, p2, p3, p4, p5], [{id:'t1',name:'Reds'}], [3, 2]
  //   ) =>
  //     { assignments: { t1: ['p1','p2','p3'], 'new-...': ['p4','p5'] },
  //       teams: [
  //         { id:'t1', name:'Reds', playerIds:['p1','p2','p3'] },
  //         { id:'new-...', name:'Team B', playerIds:['p4','p5'] },
  //       ],
  //       emptyTeams: [] }
  function assignPlayersToBalancedTeams(players, existingTeams, sizes, newIdFn) {
    const ps = (players || []).slice();
    const existing = (existingTeams || []).slice();
    const idFor = typeof newIdFn === 'function' ? newIdFn : newId;
    const assignments = {};
    const used = [];
    const emptyTeams = [];
    let cursor = 0;
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      const chunk = ps.slice(cursor, cursor + size);
      cursor += size;
      let team = existing[i];
      if (!team) {
        team = { id: idFor(), name: defaultTeamName(i), playerIds: [] };
      }
      const ids = chunk.map(p => p.id || p.uid);
      assignments[team.id] = ids;
      used.push(Object.assign({}, team, { playerIds: ids }));
    }
    // Extra existing teams beyond `sizes.length` get emptied. The
    // caller's audit log can flag them.
    for (let i = sizes.length; i < existing.length; i++) {
      emptyTeams.push(Object.assign({}, existing[i], { playerIds: [] }));
    }
    return { assignments: assignments, teams: used, emptyTeams: emptyTeams };
  }

  // Default name for the i-th auto-created team — "Team A", "Team B",
  // ..., "Team Z", then "Team AA", "Team AB", ... once we run out of
  // single letters. A party game with >26 teams is hypothetical but
  // the helper degrades gracefully.
  function defaultTeamName(index) {
    let i = Math.max(0, parseInt(index, 10) || 0);
    let label = '';
    do {
      label = String.fromCharCode(65 + (i % 26)) + label;
      i = Math.floor(i / 26) - 1;
    } while (i >= 0);
    return 'Team ' + label;
  }

  // Validate a proposed team name. Returns the trimmed name on
  // success; throws GameError on any rule violation. `currentTeamId`
  // is the team being renamed (so its own current name doesn't count
  // as a duplicate of itself).
  function validateTeamName(name, existingTeams, currentTeamId) {
    const clean = validateName(name, 'Team name');
    const norm = clean.toLowerCase();
    const taken = (existingTeams || []).some(t =>
      t.id !== currentTeamId && (t.name || '').toLowerCase() === norm
    );
    if (taken) {
      throw new GameError('A team with that name already exists.');
    }
    return clean;
  }

  // Returns true when the host can still randomize / rename teams.
  // The provider also enforces this; the helper is for renderers to
  // toggle button enablement.
  function canEditTeams(gameState) {
    const g = gameState || {};
    if (g.registrationLocked) return false;
    return g.phase === PHASE.LOBBY || g.phase === PHASE.TEAMS_SETUP;
  }

  function validateName(text, label) {
    const clean = requireNonEmpty(text, label || 'Name');
    if (clean.length > MAX_NAME_LENGTH) {
      throw new GameError((label || 'Name') + ' is too long (max ' + MAX_NAME_LENGTH + ').');
    }
    return clean;
  }

  function validateGameCode(text) {
    const clean = requireNonEmpty(text, 'Game code').toUpperCase();
    if (clean.length < 4 || clean.length > 8) {
      throw new GameError('Game code looks invalid.');
    }
    return clean;
  }

  function validateDurationSeconds(value) {
    // Empty / unparseable falls back to the default rather than
    // throwing — the duration input on the host's screen is a number
    // field, and we'd rather quietly normalise than block a save.
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return DEFAULT_DURATION_SECONDS;
    if (n < MIN_DURATION_SECONDS) {
      throw new GameError(
        'Turn duration must be at least ' + MIN_DURATION_SECONDS + ' seconds.'
      );
    }
    if (n > MAX_DURATION_SECONDS) {
      throw new GameError(
        'Turn duration must be at most ' + MAX_DURATION_SECONDS + ' seconds.'
      );
    }
    return n;
  }

  // Format a non-negative seconds count as `MM:SS`. Used for the
  // countdown display on every client.
  function formatTime(secondsRemaining) {
    const s = Math.max(0, Math.floor(secondsRemaining));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }

  // ---- Round validation helpers -----------------------------------
  /**
   * Canonical "what is currently pending validation?" computation.
   *
   * Returns the de-duplicated list of word IDs that:
   *   - were guessed in the *current* turn
   *   - have NOT yet been confirmed in the current turn
   *   - have NOT yet been rejected in the current turn
   *
   * This is the single source of truth used by:
   *   - the provider's `finishValidation` gate
   *   - the validation panel badge
   *   - the validation panel cards
   *   - the state normalizer
   *
   * It deliberately does NOT consult game-level cumulative arrays
   * (`confirmedGuessedWordIds`, `rejectedWordIds`) — those record
   * history across turns, which is the wrong filter for "is this
   * word pending right now?". A word rejected in turn 1 and
   * re-guessed in turn 2 is once again pending; the cumulative
   * filter would incorrectly hide it.
   *
   * Round-agnostic: any round's turn object that exposes
   * `guessedWordIds` / `confirmedWordIds` / `rejectedWordIds` works.
   * Round 2 (when implemented) reuses this verbatim.
   */
  function getPendingValidationWordIds(round, currentTurn) {
    if (!currentTurn || !Array.isArray(currentTurn.guessedWordIds)) return [];
    const confirmed = new Set(currentTurn.confirmedWordIds || []);
    const rejected = new Set(currentTurn.rejectedWordIds || []);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < currentTurn.guessedWordIds.length; i++) {
      const id = currentTurn.guessedWordIds[i];
      if (seen.has(id)) continue;
      seen.add(id);
      if (confirmed.has(id) || rejected.has(id)) continue;
      out.push(id);
    }
    return out;
  }

  // ---- Role + privacy helpers -------------------------------------
  // These are pure, no DOM, no provider. They consume already-emitted
  // snapshot fields so the renderer can answer "what is this user
  // allowed to see / do?" without re-deriving the rules.
  //
  // Naming: a `snapshot` is the bag that admin.js and player.js
  // assemble from their listeners — { game, players, teams, round,
  // me, uid, ... }. Anywhere that field is missing we degrade to
  // `false` (i.e. deny) so a partial snapshot during boot can never
  // unlock a privileged surface.

  function isHost(gameOrSnapshot, currentUid) {
    if (!gameOrSnapshot) return false;
    const game = gameOrSnapshot.adminUid !== undefined
      ? gameOrSnapshot
      : (gameOrSnapshot.game || null);
    if (!game) return false;
    const uid = currentUid !== undefined
      ? currentUid
      : (gameOrSnapshot.uid || null);
    return !!uid && game.adminUid === uid;
  }

  function isActiveExplainer(roundOrSnapshot, currentUid) {
    if (!roundOrSnapshot) return false;
    const round = roundOrSnapshot.activeExplainerUid !== undefined
      ? roundOrSnapshot
      : (roundOrSnapshot.round || null);
    if (!round) return false;
    const uid = currentUid !== undefined
      ? currentUid
      : (roundOrSnapshot.uid || null);
    return !!uid && !!round.activeExplainerUid && round.activeExplainerUid === uid;
  }

  function isTeammateOfActiveExplainer(snapshot) {
    if (!snapshot) return false;
    const r = snapshot.round;
    if (!r || !r.activeTeamId) return false;
    if (isActiveExplainer(r, snapshot.uid)) return false;
    const me = snapshot.me || null;
    if (!me) return false;
    const team = (snapshot.teams || []).find(t => t.id === r.activeTeamId);
    if (!team) return false;
    return (team.playerIds || []).indexOf(me.id) !== -1;
  }

  // Returns 'host' | 'explainer' | 'teammate' | 'other'. 'other'
  // covers spectators and players whose team is not currently active.
  function getCurrentUserRole(snapshot) {
    if (!snapshot) return 'other';
    if (isHost(snapshot.game, snapshot.uid)) return 'host';
    if (isActiveExplainer(snapshot.round, snapshot.uid)) return 'explainer';
    if (isTeammateOfActiveExplainer(snapshot)) return 'teammate';
    return 'other';
  }

  // Word-text visibility — only the explainer can see the active
  // word text. Hat Contents and validation word texts are host-only.
  function canSeeActiveWord(snapshot) {
    return isActiveExplainer(snapshot && snapshot.round, snapshot && snapshot.uid);
  }
  function canSeeHostHatContents(snapshot) {
    return isHost(snapshot && snapshot.game, snapshot && snapshot.uid);
  }
  function canSeeValidationWords(snapshot) {
    return isHost(snapshot && snapshot.game, snapshot && snapshot.uid);
  }

  // Action permission gates. `action` is reserved for future use; we
  // currently allow any host action for the host and any explainer
  // action for the active explainer, with the Round-3-only Wrong
  // carve-out. These mirror the provider's mutation gates and exist
  // so the UI can pre-disable buttons rather than relying solely on
  // the server-side throw.
  function canPerformHostAction(snapshot, action) {
    return isHost(snapshot && snapshot.game, snapshot && snapshot.uid);
  }
  function canPerformExplainerAction(snapshot, action) {
    const r = snapshot && snapshot.round;
    if (!isActiveExplainer(r, snapshot && snapshot.uid)) return false;
    if (action === 'wrong') {
      const cfg = ROUND_CONFIG[r.roundNumber] || {};
      return !!cfg.hasWrong;
    }
    return true;
  }

  // ---- Round / Hat Contents helpers --------------------------------
  // The locked hat is the immutable word pool. Each round draws its
  // own deck from the same pool — words guessed in round 1 still
  // appear in round 2 and 3. The provider stores this as
  // `doc.originalLockedWordIds` (set at lockHat).
  function getOriginalLockedWordIds(gameState) {
    if (!gameState) return [];
    return (gameState.originalLockedWordIds || []).slice();
  }
  function getCurrentRoundState(snapshot) {
    return (snapshot && snapshot.round) || null;
  }
  function getCurrentRoundRemainingWordIds(snapshot) {
    const r = snapshot && snapshot.round;
    if (!r || !Array.isArray(r.remainingWordIds)) return [];
    return r.remainingWordIds.slice();
  }

  // Build the Host Hat Contents view from a snapshot. Word objects
  // are looked up from `words` (the locked hat). Returns:
  //   { remaining: [{id, text, ...}], roundNumber, roundName,
  //     originalCount }
  // For non-host snapshots returns an empty payload so even a
  // mis-wired UI can't leak text.
  function getHostHatContents(snapshot, words) {
    const empty = { remaining: [], roundNumber: 0, roundName: '', originalCount: 0 };
    if (!snapshot || !canSeeHostHatContents(snapshot)) return empty;
    const game = snapshot.game || null;
    if (!game) return empty;
    const origIds = (game.originalLockedWordIds || []).slice();
    const lookup = {};
    (words || []).forEach(w => { lookup[w.id] = w; });
    const r = snapshot.round;
    if (!r) {
      // Pre-round phases: show the full locked hat.
      const remaining = origIds.map(id => lookup[id]).filter(Boolean);
      return {
        remaining: remaining,
        roundNumber: 0,
        roundName: '',
        originalCount: origIds.length,
      };
    }
    const ids = (r.remainingWordIds || []).slice();
    const remaining = ids.map(id => lookup[id]).filter(Boolean);
    const cfg = ROUND_CONFIG[r.roundNumber] || {};
    return {
      remaining: remaining,
      roundNumber: r.roundNumber || 0,
      roundName: cfg.name || ('Round ' + (r.roundNumber || 0)),
      originalCount: origIds.length,
    };
  }

  // A round is finished when its deck is empty and nothing is pending.
  function isRoundComplete(round) {
    if (!round) return false;
    const remaining = (round.remainingWordIds || []).length;
    const pendingStored = (round.pendingValidationWordIds || []).length;
    return remaining === 0 && pendingStored === 0;
  }

  // Pure helper: filter `remainingWordIds` to the ids that are NOT
  // already pending validation, NOT already confirmed, and NOT
  // already guessed in the current turn. Returned in
  // `remainingWordIds` order so callers can choose a deterministic
  // pick (selectNextActiveWord) or a randomized one
  // (selectRandomActiveWord). Pure.
  function getEligibleActiveWordIds(round, currentTurn) {
    if (!round) return [];
    const remaining = round.remainingWordIds || [];
    if (remaining.length === 0) return [];
    const pending = new Set(round.pendingValidationWordIds || []);
    const confirmed = new Set(round.confirmedGuessedWordIds || []);
    const guessedThisTurn = new Set(
      (currentTurn && currentTurn.guessedWordIds) || []
    );
    const out = [];
    for (let i = 0; i < remaining.length; i++) {
      const id = remaining[i];
      if (pending.has(id)) continue;
      if (confirmed.has(id)) continue;
      if (guessedThisTurn.has(id)) continue;
      out.push(id);
    }
    return out;
  }

  // Deterministic next-word pick — first eligible id in deck order.
  // Used in places where stability is preferable (e.g. resuming a
  // turn after refresh in the future). Most live gameplay should use
  // selectRandomActiveWord instead.
  function selectNextActiveWord(round, currentTurn) {
    const eligible = getEligibleActiveWordIds(round, currentTurn);
    return eligible.length === 0 ? null : eligible[0];
  }

  // Random next-word pick — chosen from the same eligibility set as
  // selectNextActiveWord. Test mode can monkey-patch this via
  // `HatGame._randomFn` to get deterministic results without forcing
  // every consumer to wire through an RNG. `_randomFn` defaults to
  // Math.random in production.
  function selectRandomActiveWord(round, currentTurn) {
    const eligible = getEligibleActiveWordIds(round, currentTurn);
    if (eligible.length === 0) return null;
    if (eligible.length === 1) return eligible[0];
    const rng = (global.HatGame && typeof global.HatGame._randomFn === 'function')
      ? global.HatGame._randomFn
      : Math.random;
    const idx = Math.floor(rng() * eligible.length);
    // Defensive clamp — rng() that returns exactly 1.0 (rare in JS
    // but not impossible for user-installed RNGs) would index OOB.
    return eligible[Math.min(idx, eligible.length - 1)];
  }

  // Single-round normalization — same shape as the provider's
  // _normalizeRound1State, but operates on whichever round is current
  // (via doc.phase / doc.currentRound). Idempotent. Callers that need
  // a guaranteed-clean snapshot before reading remainingWordIds /
  // pendingValidationWordIds should run this first.
  //
  // Invariants enforced here (the provider runs the full normalizer
  // for the additional word.status sync; this leaner version covers
  // what UI / score helpers need):
  //   - All four ID arrays are deduped.
  //   - remainingWordIds is disjoint from confirmedGuessedWordIds.
  //   - remainingWordIds is disjoint from pendingValidationWordIds.
  //   - activeWordId is null if it is not in remainingWordIds.
  //   - activeWordId is null if it appears in pending/confirmed.
  function normalizeCurrentRoundState(doc) {
    if (!doc) return doc;
    const roundNum = roundNumberForPhase(doc.phase) || doc.currentRound || 0;
    if (roundNum === 0) return doc;
    const r = doc['round' + roundNum];
    if (!r) return doc;
    const dedup = (arr) => {
      if (!Array.isArray(arr)) return [];
      const seen = new Set();
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    };
    r.remainingWordIds = dedup(r.remainingWordIds);
    r.pendingValidationWordIds = dedup(r.pendingValidationWordIds);
    r.confirmedGuessedWordIds = dedup(r.confirmedGuessedWordIds);
    r.rejectedWordIds = dedup(r.rejectedWordIds);
    r.publicRevealedWordIds = dedup(r.publicRevealedWordIds);
    const confirmed = new Set(r.confirmedGuessedWordIds);
    const pending = new Set(r.pendingValidationWordIds);
    r.remainingWordIds = r.remainingWordIds.filter(id =>
      !confirmed.has(id) && !pending.has(id)
    );
    if (r.activeWordId && (
      r.remainingWordIds.indexOf(r.activeWordId) === -1 ||
      confirmed.has(r.activeWordId) ||
      pending.has(r.activeWordId)
    )) {
      r.activeWordId = null;
    }
    return doc;
  }

  // Compute conflict warnings for the host's debug panel. Returns an
  // array of human-readable strings, one per detected drift. Empty
  // array means the round state is consistent.
  function getRoundStateWarnings(doc) {
    const out = [];
    if (!doc) return out;
    const roundNum = roundNumberForPhase(doc.phase) || doc.currentRound || 0;
    if (roundNum === 0) return out;
    const r = doc['round' + roundNum];
    if (!r) return out;
    const remaining = new Set(r.remainingWordIds || []);
    const pending = new Set(r.pendingValidationWordIds || []);
    const confirmed = new Set(r.confirmedGuessedWordIds || []);
    pending.forEach(id => {
      if (remaining.has(id)) out.push('word ' + id + ' is in BOTH remaining and pending');
    });
    confirmed.forEach(id => {
      if (remaining.has(id)) out.push('word ' + id + ' is in BOTH remaining and confirmed');
    });
    if (r.activeWordId && !remaining.has(r.activeWordId)) {
      out.push('activeWordId ' + r.activeWordId + ' is NOT in remainingWordIds');
    }
    const seenIds = new Set();
    (r.remainingWordIds || []).forEach(id => {
      if (seenIds.has(id)) out.push('duplicate id ' + id + ' in remainingWordIds');
      else seenIds.add(id);
    });
    const origCount = (doc.originalLockedWordIds || []).length;
    (doc.teams || []).forEach(t => {
      const rs = (t.roundScores && t.roundScores[roundNum]) || 0;
      if (origCount > 0 && rs > origCount) {
        out.push('team ' + t.name + ' round ' + roundNum +
          ' score (' + rs + ') > original word count (' + origCount + ')');
      }
    });
    return out;
  }

  // Idempotent normalizer for migrated / hand-edited / imported state.
  // - Ensures `doc.originalLockedWordIds` exists once the hat is
  //   locked (back-compat with games created before this field).
  // - Strips duplicates from each round's remainingWordIds.
  // - Strips confirmed ids from that round's remainingWordIds.
  // - Restores rejected ids to that round's remainingWordIds.
  // - Never mutates `originalLockedWordIds` after it is set.
  // Returns the same `doc` for chaining.
  function normalizeRoundDecks(doc) {
    if (!doc) return doc;
    const postLockPhases = [
      PHASE.HAT_LOCKED,
      PHASE.ROUND_1_READY, PHASE.ROUND_1_ACTIVE,
      PHASE.ROUND_1_TURN_VALIDATION, PHASE.ROUND_1_FINISHED,
      PHASE.ROUND_2_READY, PHASE.ROUND_2_ACTIVE,
      PHASE.ROUND_2_TURN_VALIDATION, PHASE.ROUND_2_FINISHED,
      PHASE.ROUND_3_READY, PHASE.ROUND_3_ACTIVE,
      PHASE.ROUND_3_TURN_VALIDATION, PHASE.ROUND_3_FINISHED,
      PHASE.GAME_FINISHED,
    ];
    if (!Array.isArray(doc.originalLockedWordIds) ||
        doc.originalLockedWordIds.length === 0) {
      if (postLockPhases.indexOf(doc.phase) !== -1) {
        doc.originalLockedWordIds = (doc.words || []).map(w => w.id);
      } else {
        doc.originalLockedWordIds = doc.originalLockedWordIds || [];
      }
    }
    [1, 2, 3].forEach(n => {
      const r = doc['round' + n];
      if (!r) return;
      const confirmed = new Set(r.confirmedGuessedWordIds || []);
      const rejected = new Set(r.rejectedWordIds || []);
      // Dedup remainingWordIds and strip confirmed.
      const seen = new Set();
      r.remainingWordIds = (r.remainingWordIds || []).filter(id => {
        if (seen.has(id)) return false;
        seen.add(id);
        return !confirmed.has(id);
      });
      // Make sure rejected ids are present in the deck (the admin
      // returned them to the hat).
      rejected.forEach(id => {
        if (!seen.has(id)) {
          r.remainingWordIds.push(id);
          seen.add(id);
        }
      });
    });
    return doc;
  }

  // ---- Session store ----------------------------------------------
  //
  // The app keeps two session records — one for the player and one
  // for the admin — so an app reload can drop the user back into
  // their game without re-prompting for a nickname or re-creating a
  // game.
  //
  // Storage choice: `sessionStorage` (per-tab). Playwright tests open
  // multiple tabs of the same browser context to simulate multiple
  // players + the admin; localStorage would have all of them sharing
  // a single session and break those tests. The trade-off is that
  // closing and reopening a browser window (a new tab) won't auto-
  // resume — the user clicks Join / Host again and the in-memory
  // anonymous Firebase uid handles the rest.
  //
  // The two records have intentionally distinct keys so a player's
  // session can't accidentally be read as an admin's, or vice versa.
  const SESSION_KEYS = {
    PLAYER: 'hat_player_session',
    ADMIN: 'hat_admin_active_game',
    ROLE: 'hat_current_role',
    LAST_RESTORE_ERROR: 'hat_last_restore_error',
    RESTORED: 'hat_last_restored',
  };

  // Player session: { gameCode, gameId, playerId, uid, nickname, joinedAt }
  function savePlayerSession(session) {
    if (!session || !session.gameCode || !session.gameId) return;
    const payload = Object.assign({
      role: 'player',
      joinedAt: session.joinedAt || nowIso(),
    }, session);
    sessionStorage.setItem(SESSION_KEYS.PLAYER, JSON.stringify(payload));
    sessionStorage.setItem(SESSION_KEYS.ROLE, 'player');
  }
  function loadPlayerSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEYS.PLAYER) || 'null'); }
    catch (e) { return null; }
  }
  function clearPlayerSession() {
    sessionStorage.removeItem(SESSION_KEYS.PLAYER);
    if (sessionStorage.getItem(SESSION_KEYS.ROLE) === 'player') {
      sessionStorage.removeItem(SESSION_KEYS.ROLE);
    }
  }

  // Admin session: { gameCode, gameId, createdAt }
  function saveAdminSession(session) {
    if (!session || !session.gameId) return;
    const payload = Object.assign({
      role: 'admin',
      createdAt: session.createdAt || nowIso(),
    }, session);
    sessionStorage.setItem(SESSION_KEYS.ADMIN, JSON.stringify(payload));
    sessionStorage.setItem(SESSION_KEYS.ROLE, 'admin');
  }
  function loadAdminSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEYS.ADMIN) || 'null'); }
    catch (e) { return null; }
  }
  function clearAdminSession() {
    sessionStorage.removeItem(SESSION_KEYS.ADMIN);
    if (sessionStorage.getItem(SESSION_KEYS.ROLE) === 'admin') {
      sessionStorage.removeItem(SESSION_KEYS.ROLE);
    }
  }

  function getCurrentRole() {
    return sessionStorage.getItem(SESSION_KEYS.ROLE) || null;
  }

  // Used by the debug overlay so testers can see why a restore
  // didn't fire on the last app boot.
  function setLastRestoreError(message) {
    if (message) sessionStorage.setItem(SESSION_KEYS.LAST_RESTORE_ERROR, message);
    else sessionStorage.removeItem(SESSION_KEYS.LAST_RESTORE_ERROR);
  }
  function getLastRestoreError() {
    return sessionStorage.getItem(SESSION_KEYS.LAST_RESTORE_ERROR) || null;
  }
  function setLastRestored(result) {
    sessionStorage.setItem(SESSION_KEYS.RESTORED,
      JSON.stringify({ result: !!result, at: nowIso() }));
  }
  function getLastRestored() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEYS.RESTORED) || 'null'); }
    catch (e) { return null; }
  }

  // Canonical team-membership view. Single source of truth so the
  // readiness oracle and any other consumer agree on who is on which
  // team. Ignores removed players; rejects players whose teamId points
  // to a deleted team.
  function buildTeamMembership(players, teams) {
    const safePlayers = (players || []).filter(p => !p.removed);
    const teamById = new Map((teams || []).map(t => [t.id, t]));
    const byTeam = new Map();
    const unassigned = [];
    const orphans = [];
    safePlayers.forEach(p => {
      if (!p.teamId) { unassigned.push(p); return; }
      if (!teamById.has(p.teamId)) { orphans.push(p); return; }
      if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
      byTeam.get(p.teamId).push(p);
    });
    return {
      players: safePlayers,
      teams: teams || [],
      byTeam: byTeam,
      unassigned: unassigned,
      orphans: orphans,
    };
  }

  // Single readiness oracle for Start Word Collection.
  // Intentionally ignores `connected` / `lastSeenAt` / presence —
  // browser refresh, tab throttling, phone sleep, and network blips
  // routinely flip players to "offline" without any actual problem.
  function getWordCollectionReadiness(game, players, teams) {
    const g = game || {};
    const teamList = teams || [];
    const m = buildTeamMembership(players, teamList);
    const teamCount = teamList.length;
    const wpp = g.wordsPerPlayer || 0;

    const hasEnoughTeams = teamCount >= MIN_TEAMS;
    const eachTeamHasAtLeastTwoPlayers = teamCount > 0 && teamList.every(
      t => (m.byTeam.get(t.id) || []).length >= MIN_PLAYERS_PER_TEAM
    );
    const allPlayersAssigned = m.players.length > 0 &&
      m.unassigned.length === 0 &&
      m.orphans.length === 0;
    const wordsPerPlayerValid = wpp >= 1;
    const registrationOpen = !g.registrationLocked;

    const checks = {
      hasEnoughTeams: hasEnoughTeams,
      eachTeamHasAtLeastTwoPlayers: eachTeamHasAtLeastTwoPlayers,
      allPlayersAssigned: allPlayersAssigned,
      wordsPerPlayerValid: wordsPerPlayerValid,
      registrationOpen: registrationOpen,
    };

    const invalidTeamNames = teamList
      .filter(t => (m.byTeam.get(t.id) || []).length < MIN_PLAYERS_PER_TEAM)
      .map(t => t.name);
    const unassignedPlayerNames = m.unassigned.map(p => p.name);

    const reasons = [];
    if (!hasEnoughTeams) reasons.push('At least 2 teams are required.');
    if (!eachTeamHasAtLeastTwoPlayers) reasons.push('Each team must have at least 2 players.');
    if (!allPlayersAssigned) {
      reasons.push(m.orphans.length > 0
        ? 'Some players are assigned to a missing team.'
        : 'Every player must be assigned to a team.');
    }
    if (!wordsPerPlayerValid) reasons.push('Words per player must be at least 1.');
    if (!registrationOpen) reasons.push('Registration is already locked.');

    return {
      canStart: reasons.length === 0,
      reasons: reasons,
      checks: checks,
      details: {
        teamCount: teamCount,
        playerCount: m.players.length,
        unassignedPlayerNames: unassignedPlayerNames,
        invalidTeamNames: invalidTeamNames,
      },
    };
  }

  // Single oracle for "everyone submitted enough words to review."
  // Counts actual word documents (grouped by ownerPlayerId / ownerUid)
  // — NOT player.wordCount — because the cached count can drift if
  // a submission/delete didn't atomically update both sides. The same
  // helper drives the admin hat progress, the per-player chips, the
  // Review words button, and the server-side `startWordReview` gate
  // so the UI and the gate cannot disagree.
  function getWordSubmissionReadiness(game, players, words) {
    const g = game || {};
    const wpp = g.wordsPerPlayer || 0;
    const safePlayers = (players || []).filter(p => !p.removed);
    const liveWords = (words || []).filter(w => w && w.status !== 'removed');

    // Index counts by both ownerPlayerId and ownerUid so we tolerate
    // either field. The Firebase provider stamps both at submitWord
    // time (ownerPlayerId === ownerUid on Firebase); the mock provider
    // sets ownerPlayerId distinctly.
    const byPlayerId = {};
    const byUid = {};
    liveWords.forEach(w => {
      if (w.ownerPlayerId) byPlayerId[w.ownerPlayerId] = (byPlayerId[w.ownerPlayerId] || 0) + 1;
      if (w.ownerUid)      byUid[w.ownerUid]           = (byUid[w.ownerUid] || 0) + 1;
    });

    const perPlayerCounts = {};
    const missingPlayers = [];
    let totalSubmitted = 0;
    safePlayers.forEach(p => {
      const pid = p.id || p.uid;
      const count = Math.max(byPlayerId[p.id] || 0, byUid[p.uid] || 0);
      perPlayerCounts[pid] = count;
      totalSubmitted += count;
      if (wpp >= 1 && count < wpp) {
        missingPlayers.push({
          playerId: pid,
          playerName: p.name || '(unnamed)',
          submittedCount: count,
          requiredCount: wpp,
        });
      }
    });

    const totalRequired = wpp * safePlayers.length;

    const reasons = [];
    if (safePlayers.length === 0) reasons.push('No players have joined yet.');
    if (wpp < 1) reasons.push('Words per player must be at least 1.');
    if (missingPlayers.length > 0) {
      reasons.push('Missing words: ' + missingPlayers
        .map(m => m.playerName + ' ' + m.submittedCount + '/' + m.requiredCount)
        .join(', ') + '.');
    }

    return {
      canReview: reasons.length === 0,
      totalRequired: totalRequired,
      totalSubmitted: totalSubmitted,
      missingPlayers: missingPlayers,
      perPlayerCounts: perPlayerCounts,
      reasons: reasons,
    };
  }

  // Connectivity thresholds for the admin's player status badge.
  // The player heartbeat updates lastSeenAt every ~25 seconds, so
  // the 45s "Online" window allows for one missed beat.
  const PRESENCE_ONLINE_MS = 45 * 1000;
  const PRESENCE_RECENT_MS = 2 * 60 * 1000;
  function classifyPresence(lastSeenAtIso) {
    if (!lastSeenAtIso) return 'offline';
    const age = Date.now() - new Date(lastSeenAtIso).getTime();
    if (age <= PRESENCE_ONLINE_MS) return 'online';
    if (age <= PRESENCE_RECENT_MS) return 'recent';
    return 'offline';
  }

  // ---- Public API --------------------------------------------------
  global.HatGame = global.HatGame || {};
  global.HatGame.Utils = {
    PHASE: PHASE,
    ALL_PHASES: ALL_PHASES,
    R_STATUS: R_STATUS,
    R1_STATUS: R1_STATUS, // alias for backwards compat
    ACTION: ACTION,
    ROUND_CONFIG: ROUND_CONFIG,
    roundNumberForPhase: roundNumberForPhase,
    phaseForRound: phaseForRound,
    roundLifecyclePhases: roundLifecyclePhases,
    defaultDurationForRound: defaultDurationForRound,
    MAX_WORD_LENGTH: MAX_WORD_LENGTH,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MIN_WORDS: MIN_WORDS,
    MAX_WORDS: MAX_WORDS,
    GameError: GameError,
    $: $, $$: $$, el: el, clear: clear,
    Log: Log,
    showToast: showToast,
    showScreen: showScreen,
    getQuery: getQuery,
    inviteLink: inviteLink,
    newId: newId,
    newGameCode: newGameCode,
    nowIso: nowIso,
    requireNonEmpty: requireNonEmpty,
    validateWordText: validateWordText,
    normalizeWordForCompare: normalizeWordForCompare,
    validateName: validateName,
    validateTeamName: validateTeamName,
    validateGameCode: validateGameCode,
    // Team randomization helpers.
    shuffleArray: shuffleArray,
    calculateTeamSizesByTeamCount: calculateTeamSizesByTeamCount,
    calculateTeamSizesByTargetSize: calculateTeamSizesByTargetSize,
    assignPlayersToBalancedTeams: assignPlayersToBalancedTeams,
    validateRandomizationOptions: validateRandomizationOptions,
    canEditTeams: canEditTeams,
    defaultTeamName: defaultTeamName,
    MIN_PLAYERS_PER_TEAM: MIN_PLAYERS_PER_TEAM,
    MIN_TEAMS: MIN_TEAMS,
    buildTeamMembership: buildTeamMembership,
    getWordCollectionReadiness: getWordCollectionReadiness,
    getWordSubmissionReadiness: getWordSubmissionReadiness,
    validateDurationSeconds: validateDurationSeconds,
    formatTime: formatTime,
    getPendingValidationWordIds: getPendingValidationWordIds,
    // Role + privacy helpers (see definitions above).
    isHost: isHost,
    isActiveExplainer: isActiveExplainer,
    isTeammateOfActiveExplainer: isTeammateOfActiveExplainer,
    getCurrentUserRole: getCurrentUserRole,
    canSeeActiveWord: canSeeActiveWord,
    canSeeHostHatContents: canSeeHostHatContents,
    canSeeValidationWords: canSeeValidationWords,
    canPerformHostAction: canPerformHostAction,
    canPerformExplainerAction: canPerformExplainerAction,
    // Round / Hat Contents helpers.
    getOriginalLockedWordIds: getOriginalLockedWordIds,
    getCurrentRoundState: getCurrentRoundState,
    getCurrentRoundRemainingWordIds: getCurrentRoundRemainingWordIds,
    getHostHatContents: getHostHatContents,
    isRoundComplete: isRoundComplete,
    normalizeRoundDecks: normalizeRoundDecks,
    selectNextActiveWord: selectNextActiveWord,
    selectRandomActiveWord: selectRandomActiveWord,
    getEligibleActiveWordIds: getEligibleActiveWordIds,
    normalizeCurrentRoundState: normalizeCurrentRoundState,
    getRoundStateWarnings: getRoundStateWarnings,
    MIN_DURATION_SECONDS: MIN_DURATION_SECONDS,
    MAX_DURATION_SECONDS: MAX_DURATION_SECONDS,
    DEFAULT_DURATION_SECONDS: DEFAULT_DURATION_SECONDS,
    // Session helpers — see the SESSION_KEYS comment above.
    SESSION_KEYS: SESSION_KEYS,
    savePlayerSession: savePlayerSession,
    loadPlayerSession: loadPlayerSession,
    clearPlayerSession: clearPlayerSession,
    saveAdminSession: saveAdminSession,
    loadAdminSession: loadAdminSession,
    clearAdminSession: clearAdminSession,
    getCurrentRole: getCurrentRole,
    setLastRestoreError: setLastRestoreError,
    getLastRestoreError: getLastRestoreError,
    setLastRestored: setLastRestored,
    getLastRestored: getLastRestored,
    classifyPresence: classifyPresence,
    PRESENCE_ONLINE_MS: PRESENCE_ONLINE_MS,
    PRESENCE_RECENT_MS: PRESENCE_RECENT_MS,
  };
  // Re-export common constants at the top level for convenience.
  global.HatGame.PHASE = PHASE;
  global.HatGame.GameError = GameError;
  global.HatGame.MAX_WORD_LENGTH = MAX_WORD_LENGTH;
})(window);
