/* eslint-disable */
/**
 * MockProvider — in-browser DataProvider backed by localStorage.
 *
 * Used in three situations:
 *   - Playwright tests (`?mode=mock`)
 *   - Local single-browser demo
 *   - Fallback when Firebase isn't configured
 *
 * Cross-tab sync: localStorage is shared between tabs/pages of the
 * same origin and same browser context. The `storage` event fires
 * when *another* tab writes. We use that to notify listeners, plus
 * an in-memory event bus for same-tab updates (storage events don't
 * fire in the tab that wrote).
 *
 * Privacy:
 *   - `listenToOwnWords(gameId, ownerUid)` filters to that owner.
 *   - `listenToHat` only emits texts when the game phase is
 *     HAT_LOCKED or later; before that it emits an empty list.
 *   - The admin's `listenToPlayers` exposes word *counts*, not text.
 *
 * Validation lives in this module too so the same rules apply
 * regardless of whether the call came from admin or player. Anything
 * that throws is propagated up as a rejected Promise carrying a
 * GameError.
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const PHASE = U.PHASE;
  const GameError = U.GameError;
  const Log = U.Log;

  const STORAGE_PREFIX = 'hat_mock_game_';
  const UID_KEY = 'hat_mock_uid';
  const ADMIN_GAMES_KEY = 'hat_mock_admin_games'; // {gameId: true}

  function storageKey(gameId) { return STORAGE_PREFIX + gameId; }

  function loadGame(gameId) {
    const raw = localStorage.getItem(storageKey(gameId));
    if (!raw) return null;
    try {
      const doc = JSON.parse(raw);
      // Idempotent migration: derive originalLockedWordIds if missing,
      // strip drift from round decks. Cheap; runs on every load.
      U.normalizeRoundDecks(doc);
      return doc;
    }
    catch (e) {
      Log.error('mock: corrupt game doc, dropping', e);
      localStorage.removeItem(storageKey(gameId));
      return null;
    }
  }

  function saveGame(gameId, doc) {
    doc.updatedAt = U.nowIso();
    localStorage.setItem(storageKey(gameId), JSON.stringify(doc));
    // Same-tab listeners don't get a `storage` event, so we fire an
    // explicit custom event on window for them.
    global.dispatchEvent(new CustomEvent('hatmock:change', {
      detail: { gameId: gameId, key: storageKey(gameId) },
    }));
  }

  // Minimum requirements before the admin can start word collection.
  const MIN_TEAMS = 2;
  const MIN_PLAYERS_PER_TEAM = 2;

  function emptyGame(gameId, gameCode, adminUid) {
    const now = U.nowIso();
    return {
      gameId: gameId,
      gameCode: gameCode,
      adminUid: adminUid,
      phase: PHASE.LOBBY,
      wordsPerPlayer: 5,
      currentRound: 0,
      locked: false,
      // Registration is "locked" once word collection starts. From
      // that moment new players cannot join with a new nickname, and
      // existing players cannot have their team/nickname changed.
      // Existing players (matched by uid) can still reconnect.
      registrationLocked: false,
      // Lifecycle tag: 'active' | 'archived' | 'abandoned' | 'deleting'.
      status: 'active',
      // Per-round turn durations in seconds. Live settings before
      // each round begins; once a round subdoc is created the value
      // is also mirrored to `round{N}.durationSeconds` for runtime use.
      // Keys are 'round1' / 'round2' / 'round3' to match the spec.
      roundSettings: {
        round1: {
          durationSeconds: U.defaultDurationForRound(1),
          name: U.ROUND_CONFIG[1].name,
        },
        round2: {
          durationSeconds: U.defaultDurationForRound(2),
          name: U.ROUND_CONFIG[2].name,
        },
        round3: {
          durationSeconds: U.defaultDurationForRound(3),
          name: U.ROUND_CONFIG[3].name,
        },
      },
      // Legacy alias kept for tests and any code that still reads it.
      round1DurationSeconds: U.defaultDurationForRound(1),
      createdAt: now,
      updatedAt: now,
      players: [],   // {id, uid, name, teamId, joinedAt, connected, lastSeenAt, wordCount}
      // Teams: {id, name, playerIds[], score, roundScores: {1, 2, 3}}
      // `score` is the running total across rounds; per-round
      // subtotals live in roundScores so the UI can show the
      // breakdown when the game finishes.
      teams: [],
      words: [],     // {id, text, ownerUid, ownerPlayerId, ownerName, createdAt, updatedAt, status}
      // Immutable snapshot of every word's id, taken at lockHat. Every
      // round draws its deck from THIS list — round 1's guesses do not
      // shrink round 2's deck. The field is set once and is never
      // mutated thereafter; `normalizeRoundDecks` backfills it for
      // games created before this field existed.
      originalLockedWordIds: [],
      round1: null,
      round2: null,
      round3: null,
      events: [],    // lightweight audit log; bounded to last 200 entries
    };
  }

  function logEvent(doc, type, actorUid, details) {
    doc.events.push({
      id: U.newId(),
      type: type,
      actorUid: actorUid || null,
      timestamp: U.nowIso(),
      details: details || null,
    });
    // Bound the log so localStorage stays small.
    if (doc.events.length > 200) doc.events.splice(0, doc.events.length - 200);
  }

  // Thin wrapper around the canonical readiness oracle in utils.js.
  // Used only to gate `startWordCollection` server-side (the admin UI
  // computes readiness directly from state and no longer reads this
  // off the listener payload).
  function readinessReport(doc) {
    return U.getWordCollectionReadiness(
      { wordsPerPlayer: doc.wordsPerPlayer, registrationLocked: !!doc.registrationLocked },
      doc.players || [],
      doc.teams || []
    );
  }

  // Generic per-round subdoc factory. Same shape applies to Round 1,
  // 2, and 3 — the state machine and validation rules are identical
  // between rounds; only the UI rules text + default duration +
  // whether the "Wrong" button is available differ (those live in
  // U.ROUND_CONFIG).
  function emptyRound(roundNumber, allWordIds, durationSeconds) {
    return {
      roundNumber: roundNumber,
      status: U.R_STATUS.READY,
      activeTeamId: null,
      activeExplainerPlayerId: null,
      activeExplainerUid: null,
      activeWordId: null,
      remainingWordIds: allWordIds.slice(),
      pendingValidationWordIds: [],
      confirmedGuessedWordIds: [],
      rejectedWordIds: [],
      publicRevealedWordIds: [],
      turnNumber: 0,
      turnStartedAt: null,
      turnEndsAt: null,
      durationSeconds: durationSeconds || U.defaultDurationForRound(roundNumber),
      // Rotation bookkeeping: index of next team and per-team next
      // explainer index. Simple round-robin among assigned players.
      // Each round starts a fresh rotation.
      _teamCursor: 0,
      _explainerCursorByTeam: {},
      turns: [],  // {turnNumber, teamId, explainerPlayerId, ..., actions[]}
    };
  }
  // Backwards-compat alias.
  function emptyRound1(allWordIds, durationSeconds) {
    return emptyRound(1, allWordIds, durationSeconds);
  }

  // Fisher-Yates shuffle (in place is fine since we're shuffling a
  // copy). Used at the start of every round so the deck order is
  // randomized but every round draws from the same source.
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  // The "original" word pool for a round = every locked-hat word as
  // captured at lockHat time. We never permanently consume words;
  // each round seeds its own deck from this same pool. Falls back to
  // `doc.words` for back-compat with games that pre-date the
  // `originalLockedWordIds` field (normalizeRoundDecks would have
  // backfilled it during load, so this branch is mostly defensive).
  function shuffledOriginalWordIds(doc) {
    let ids = (doc.originalLockedWordIds || []).slice();
    if (ids.length === 0) ids = (doc.words || []).map(w => w.id);
    return shuffle(ids);
  }

  // Round number → key in the game doc. Round subdocs live as
  // top-level fields on the game doc for backwards compat with the
  // original Round-1-only shape.
  function roundKey(n) { return 'round' + n; }
  function getRoundDoc(doc, n) {
    if (!doc) return null;
    return doc[roundKey(n)] || null;
  }
  function setRoundDoc(doc, n, sub) {
    doc[roundKey(n)] = sub;
  }
  // Current round number, from the phase. 0 if we're not in any round.
  function currentRoundNumber(doc) {
    if (!doc || !doc.phase) return 0;
    return U.roundNumberForPhase(doc.phase) || 0;
  }
  function currentRoundDoc(doc) {
    const n = currentRoundNumber(doc);
    return n > 0 ? getRoundDoc(doc, n) : null;
  }

  // -----------------------------------------------------------------
  class MockProvider {
    constructor() {
      this.name = 'mock';
      this._initialized = false;
      this._uid = null;
      this._listeners = []; // {gameId, fn} kept so we can route storage events
      this._adminGames = this._loadAdminGames();
    }

    async init() {
      if (this._initialized) return;
      // Anonymous UID is *per-tab* — we use sessionStorage so two
      // pages in the same browser context (e.g. admin + player in
      // Playwright) get different identities. localStorage would be
      // shared between them, which is wrong for our two-tab tests.
      this._uid = sessionStorage.getItem(UID_KEY);
      if (!this._uid) {
        this._uid = 'u_' + U.newId();
        sessionStorage.setItem(UID_KEY, this._uid);
      }
      // Route storage events to per-game listeners.
      global.addEventListener('storage', this._onStorage.bind(this));
      // And in-tab change events.
      global.addEventListener('hatmock:change', this._onSelfChange.bind(this));
      this._initialized = true;
      Log.state('mock provider initialized; uid =', this._uid);
    }

    get currentUid() { return this._uid; }

    async signInAnonymous() {
      await this.init();
      return { uid: this._uid };
    }

    _onStorage(ev) {
      if (!ev.key || !ev.key.indexOf) return;
      if (ev.key.indexOf(STORAGE_PREFIX) !== 0) return;
      const gameId = ev.key.substring(STORAGE_PREFIX.length);
      this._fanout(gameId);
    }
    _onSelfChange(ev) {
      const { gameId } = (ev.detail || {});
      if (gameId) this._fanout(gameId);
    }
    _fanout(gameId) {
      this._listeners
        .filter(function (l) { return l.gameId === gameId; })
        .forEach(function (l) { try { l.fn(); } catch (e) { Log.error('listener', e); } });
    }
    _subscribe(gameId, fn) {
      const entry = { gameId: gameId, fn: fn };
      this._listeners.push(entry);
      // Fire once immediately so callers always get the current state.
      try { fn(); } catch (e) { Log.error('listener (initial)', e); }
      const self = this;
      return function unsubscribe() {
        const i = self._listeners.indexOf(entry);
        if (i >= 0) self._listeners.splice(i, 1);
      };
    }

    _loadAdminGames() {
      // sessionStorage (not localStorage): admin status is per-tab.
      // Otherwise both admin and player tabs in the same context would
      // share the "I am admin" map and the player would pass admin
      // checks.
      try { return JSON.parse(sessionStorage.getItem(ADMIN_GAMES_KEY) || '{}'); }
      catch (e) { return {}; }
    }
    _saveAdminGames() {
      sessionStorage.setItem(ADMIN_GAMES_KEY, JSON.stringify(this._adminGames));
    }

    // -- Mutations: lookup helpers ---------------------------------
    _findGameByCode(code) {
      // localStorage keys are not searchable directly; iterate.
      const upper = code.toUpperCase();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(STORAGE_PREFIX) !== 0) continue;
        const doc = loadGame(k.substring(STORAGE_PREFIX.length));
        if (doc && doc.gameCode === upper) return doc;
      }
      return null;
    }

    // -- Creation ---------------------------------------------------
    async createGame({ wordsPerPlayer } = {}) {
      await this.init();
      // Generate a unique game code; retry on collision.
      let code = U.newGameCode();
      let attempts = 0;
      while (this._findGameByCode(code) && attempts < 8) {
        code = U.newGameCode();
        attempts++;
      }
      const gameId = code; // gameId == gameCode for the mock provider
      const doc = emptyGame(gameId, code, this._uid);
      if (wordsPerPlayer) doc.wordsPerPlayer = parseInt(wordsPerPlayer, 10) || 5;
      saveGame(gameId, doc);
      this._adminGames[gameId] = true;
      this._saveAdminGames();
      Log.state('mock: created game', code);
      return { gameId: gameId, gameCode: code };
    }

    async joinGame({ gameCode, nickname }) {
      await this.init();
      // Normalize the code (uppercase, trimmed).
      const code = U.validateGameCode(gameCode);
      const name = U.validateName(nickname, 'Nickname');
      const doc = this._findGameByCode(code);
      if (!doc) throw new GameError('Game not found.');
      // Lifecycle gate: archived / abandoned / deleting rooms are
      // closed regardless of phase.
      if (doc.status && doc.status !== 'active') {
        throw new GameError('This game is closed.');
      }

      // Reconnect path: if this uid already has a player slot, we
      // allow the rejoin in *any* phase. The nickname is fixed at
      // first join; we don't let it change on reconnect.
      const existing = doc.players.find(p => p.uid === this._uid);
      if (existing) {
        existing.connected = true;
        existing.lastSeenAt = U.nowIso();
        saveGame(doc.gameId, doc);
        return { gameId: doc.gameId, gameCode: doc.gameCode, playerId: existing.id };
      }

      // New-joiner path: only allowed before registration is locked.
      if (doc.registrationLocked ||
          doc.phase !== PHASE.LOBBY && doc.phase !== PHASE.TEAMS_SETUP) {
        throw new GameError('Game has already started. New players cannot join now.');
      }
      // Duplicate nicknames (case-insensitive) are rejected so the
      // host doesn't end up with two "Alex"es.
      if (doc.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        throw new GameError('A player with that nickname is already in the game.');
      }
      const player = {
        id: U.newId(),
        uid: this._uid,
        name: name,
        teamId: null,
        joinedAt: U.nowIso(),
        connected: true,
        lastSeenAt: U.nowIso(),
        wordCount: 0,
      };
      doc.players.push(player);
      logEvent(doc, 'player_joined', this._uid, { name: player.name });
      saveGame(doc.gameId, doc);
      return { gameId: doc.gameId, gameCode: doc.gameCode, playerId: player.id };
    }

    async resumeIfAdmin(gameCode) {
      await this.init();
      const doc = this._findGameByCode(gameCode);
      if (!doc) return false;
      // In mock mode, the adminUid is whichever uid created the game.
      // sessionStorage keeps the uid stable across reloads of the
      // same tab, so the same tab can resume after refresh.
      return doc.adminUid === this._uid || !!this._adminGames[doc.gameId];
    }

    // Used by the player controller on app boot: do we already have
    // a player slot in this game? If yes, we resume silently without
    // re-asking for a nickname.
    async findMyPlayer(gameCode) {
      await this.init();
      const doc = this._findGameByCode(gameCode);
      if (!doc) return null;
      const me = doc.players.find(p => p.uid === this._uid);
      if (!me) return null;
      // Heartbeat: update lastSeenAt so the admin sees us as fresh.
      me.connected = true;
      me.lastSeenAt = U.nowIso();
      saveGame(doc.gameId, doc);
      return {
        gameId: doc.gameId, gameCode: doc.gameCode, playerId: me.id,
        nickname: me.name,
      };
    }

    // Periodic heartbeat from the player controller — refreshes the
    // player's `lastSeenAt` so the admin's online-status badge stays
    // accurate. Safe to call frequently; only updates the field when
    // it would change (no spurious writes from sub-second beats).
    async touchPlayerPresence(gameId) {
      const doc = loadGame(gameId);
      if (!doc) return;
      const me = doc.players && doc.players.find(p => p.uid === this._uid);
      if (!me) return;
      me.connected = true;
      me.lastSeenAt = U.nowIso();
      saveGame(gameId, doc);
    }

    // -- Listeners --------------------------------------------------
    listenToGame(gameId, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb(null);
        // Normalize the per-round settings so the consumer always sees
        // a complete object regardless of whether old docs (pre-3-round)
        // are loaded from localStorage.
        const settings = doc.roundSettings || {};
        const roundSettings = {
          round1: {
            durationSeconds:
              (settings.round1 && settings.round1.durationSeconds) ||
              doc.round1DurationSeconds ||
              U.defaultDurationForRound(1),
            name: (settings.round1 && settings.round1.name) || U.ROUND_CONFIG[1].name,
          },
          round2: {
            durationSeconds:
              (settings.round2 && settings.round2.durationSeconds) ||
              U.defaultDurationForRound(2),
            name: (settings.round2 && settings.round2.name) || U.ROUND_CONFIG[2].name,
          },
          round3: {
            durationSeconds:
              (settings.round3 && settings.round3.durationSeconds) ||
              U.defaultDurationForRound(3),
            name: (settings.round3 && settings.round3.name) || U.ROUND_CONFIG[3].name,
          },
        };
        cb({
          gameId: doc.gameId,
          gameCode: doc.gameCode,
          phase: doc.phase,
          wordsPerPlayer: doc.wordsPerPlayer,
          adminUid: doc.adminUid,
          currentRound: doc.currentRound,
          locked: doc.locked,
          registrationLocked: !!doc.registrationLocked,
          // Legacy alias — round 1 duration on the game doc.
          round1DurationSeconds: roundSettings.round1.durationSeconds,
          roundSettings: roundSettings,
          readiness: readinessReport(doc),
          // Tail of the audit log — surfaced in the debug panel.
          // Capped here so we don't bloat the listener payload.
          recentEvents: (doc.events || []).slice(-10),
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        });
      });
    }

    listenToPlayers(gameId, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb([]);
        // Strip nothing here — wordCount is the only count exposed and
        // is safe to share. (We never expose word texts via this method.)
        cb(doc.players.map(p => Object.assign({}, p)));
      });
    }

    listenToTeams(gameId, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb([]);
        cb(doc.teams.map(t => Object.assign({}, t, { playerIds: t.playerIds.slice() })));
      });
    }

    listenToOwnWords(gameId, ownerUid, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb([]);
        cb(doc.words
          .filter(w => w.ownerUid === ownerUid)
          .map(w => Object.assign({}, w)));
      });
    }

    listenToHat(gameId, cb) {
      // Emits word texts ONLY to the admin, and ONLY during phases
      // where the host needs the full hat (or the under-review set):
      //   - WORD_REVIEW      — host's review / approve / remove pass
      //   - HAT_LOCKED       — review after lock, before round 1
      //   - ROUND_X_READY    — pre-round review between turns/rounds
      //   - ROUND_X_FINISHED — post-round review
      //   - GAME_FINISHED    — final review
      // During ACTIVE / TURN_VALIDATION phases the list is empty so
      // the admin's "Hat contents" panel doesn't show the active
      // word (which would defeat the explainer-only privacy rule).
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb([]);
        const isAdmin = doc.adminUid === this._uid ||
          !!this._adminGames[doc.gameId];
        if (!isAdmin) return cb([]);
        const p = doc.phase;
        const open = p === PHASE.WORD_REVIEW ||
          p === PHASE.HAT_LOCKED ||
          p === PHASE.ROUND_1_READY ||
          p === PHASE.ROUND_2_READY ||
          p === PHASE.ROUND_3_READY ||
          p === PHASE.ROUND_1_FINISHED ||
          p === PHASE.ROUND_2_FINISHED ||
          p === PHASE.ROUND_3_FINISHED ||
          p === PHASE.GAME_FINISHED;
        if (!open) return cb([]);
        cb(doc.words.map(w => Object.assign({}, w)));
      });
    }

    // -- Mutations: admin -----------------------------------------
    _requireAdmin(doc) {
      const isAdmin = doc.adminUid === this._uid || !!this._adminGames[doc.gameId];
      if (!isAdmin) {
        this._permissionDenied('admin', doc, null);
        throw new GameError('Only the host can do that.');
      }
    }
    _requireExplainer(doc, round) {
      if (!round || round.activeExplainerUid !== this._uid) {
        this._permissionDenied('explainer', doc, round);
        throw new GameError('Only the active explainer can do that.');
      }
    }
    _permissionDenied(kind, doc, round) {
      try {
        // Single prefix so QA can `grep '[HatGame][Permission]'`.
        const expected = kind === 'admin'
          ? (doc && doc.adminUid)
          : (round && round.activeExplainerUid);
        console.warn(
          '[HatGame][Permission]', kind + ' required',
          'callerUid=', this._uid, 'expectedUid=', expected,
          'gameId=', doc && doc.gameId, 'phase=', doc && doc.phase
        );
      } catch (e) { /* logging only */ }
    }
    _requireGame(gameId) {
      const doc = loadGame(gameId);
      if (!doc) throw new GameError('Game not found.');
      return doc;
    }
    _requirePhase(doc, allowed) {
      if (allowed.indexOf(doc.phase) === -1) {
        throw new GameError('Not allowed in phase ' + doc.phase + '.');
      }
    }

    async updateGameSettings(gameId, { wordsPerPlayer }) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      const n = parseInt(wordsPerPlayer, 10);
      if (!Number.isFinite(n) || n < U.MIN_WORDS || n > U.MAX_WORDS) {
        throw new GameError('Words per player must be between ' + U.MIN_WORDS + ' and ' + U.MAX_WORDS + '.');
      }
      doc.wordsPerPlayer = n;
      saveGame(gameId, doc);
    }

    async createTeam(gameId, name) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      const clean = U.validateName(name, 'Team name');
      if (doc.teams.some(t => t.name.toLowerCase() === clean.toLowerCase())) {
        throw new GameError('A team with that name already exists.');
      }
      doc.teams.push({
        id: U.newId(), name: clean, playerIds: [], score: 0,
        roundScores: { 1: 0, 2: 0, 3: 0 },
      });
      if (doc.phase === PHASE.LOBBY) doc.phase = PHASE.TEAMS_SETUP;
      saveGame(gameId, doc);
    }

    async deleteTeam(gameId, teamId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      doc.teams = doc.teams.filter(t => t.id !== teamId);
      doc.players.forEach(p => { if (p.teamId === teamId) p.teamId = null; });
      saveGame(gameId, doc);
    }

    // Host renames a team. Allowed only before word collection starts;
    // duplicates are rejected case-insensitively.
    async renameTeam(gameId, teamId, newName) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (doc.registrationLocked) {
        throw new GameError('Team names cannot be changed after the game starts.');
      }
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      const team = (doc.teams || []).find(t => t.id === teamId);
      if (!team) throw new GameError('Unknown team.');
      const clean = U.validateTeamName(newName, doc.teams || [], teamId);
      const before = team.name;
      team.name = clean;
      logEvent(doc, 'team_renamed', this._uid, {
        teamId: teamId, before: before, after: clean,
      });
      saveGame(gameId, doc);
    }

    // Host randomizes player→team distribution. Existing team names
    // and IDs are preserved where possible; missing teams are created
    // automatically with default names ("Team A", "Team B", …).
    // Extra existing teams beyond the computed count keep their name
    // but get emptied (we never auto-delete).
    async randomizeTeams(gameId, options) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (doc.registrationLocked) {
        throw new GameError('Teams cannot be randomized after the game starts.');
      }
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      const players = doc.players || [];
      const { sizes, mode } = U.validateRandomizationOptions(players.length, options || {});
      const shuffled = U.shuffleArray(players);
      const result = U.assignPlayersToBalancedTeams(
        shuffled, doc.teams || [], sizes, U.newId
      );
      // Merge `result.teams` and `result.emptyTeams` back into the
      // game doc. The "used" teams keep their roundScores/score if
      // they already existed (we preserve identity by id).
      const allTeams = result.teams.concat(result.emptyTeams);
      const byId = {};
      (doc.teams || []).forEach(t => { byId[t.id] = t; });
      doc.teams = allTeams.map(t => {
        const existing = byId[t.id];
        if (existing) {
          return Object.assign(existing, {
            name: t.name,
            playerIds: t.playerIds.slice(),
          });
        }
        return {
          id: t.id, name: t.name, playerIds: t.playerIds.slice(),
          score: 0, roundScores: { 1: 0, 2: 0, 3: 0 },
        };
      });
      // Reset every player's teamId, then write the new assignment.
      doc.players.forEach(p => { p.teamId = null; });
      Object.keys(result.assignments).forEach(teamId => {
        result.assignments[teamId].forEach(pid => {
          const p = doc.players.find(x => (x.id === pid || x.uid === pid));
          if (p) p.teamId = teamId;
        });
      });
      // Auto-advance phase if we were still in LOBBY (mirrors
      // createTeam's behavior).
      if (doc.phase === PHASE.LOBBY) doc.phase = PHASE.TEAMS_SETUP;
      logEvent(doc, 'teams_randomized', this._uid, {
        mode: mode,
        teamSizes: sizes,
        emptyTeamIds: result.emptyTeams.map(t => t.id),
      });
      saveGame(gameId, doc);
    }

    // Admin removes a player from the game. Only allowed before
    // word collection has started (phase ∈ {LOBBY, TEAMS_SETUP} and
    // registration is not locked). Strips the playerId from every
    // team's playerIds array so the team rosters stay consistent.
    //
    // The player's tab, if still connected, will see itself
    // disappear from the players listener and the player controller
    // surfaces a "You were removed by the host" message + clears
    // its session.
    async removePlayer(gameId, playerId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (doc.registrationLocked) {
        throw new GameError('Players cannot be removed after the game starts.');
      }
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      const idx = (doc.players || []).findIndex(p => p.id === playerId);
      if (idx === -1) throw new GameError('Unknown player.');
      const removed = doc.players[idx];
      doc.players.splice(idx, 1);
      // Pull the playerId out of every team's roster.
      (doc.teams || []).forEach(t => {
        t.playerIds = (t.playerIds || []).filter(pid => pid !== playerId);
      });
      logEvent(doc, 'player_removed', this._uid, {
        playerId: playerId, name: removed.name, removedUid: removed.uid,
      });
      saveGame(gameId, doc);
    }

    async assignPlayerToTeam(gameId, playerId, teamId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      const player = doc.players.find(p => p.id === playerId);
      if (!player) throw new GameError('Unknown player.');
      doc.teams.forEach(t => { t.playerIds = t.playerIds.filter(pid => pid !== playerId); });
      if (teamId) {
        const team = doc.teams.find(t => t.id === teamId);
        if (!team) throw new GameError('Unknown team.');
        team.playerIds.push(playerId);
        player.teamId = teamId;
      } else {
        player.teamId = null;
      }
      saveGame(gameId, doc);
    }

    async startWordCollection(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.LOBBY, PHASE.TEAMS_SETUP]);
      // Readiness check: the admin UI gates the button on these,
      // but we validate here too so a stale UI / direct API call
      // can't bypass it.
      const r = readinessReport(doc);
      if (!r.canStart) {
        // Surface the first failing requirement so the toast is
        // specific.
        throw new GameError(r.reasons[0]);
      }
      doc.phase = PHASE.WORD_COLLECTION;
      doc.registrationLocked = true;
      logEvent(doc, 'word_collection_started', this._uid);
      saveGame(gameId, doc);
    }

    // WORD_COLLECTION → WORD_REVIEW. Triggered by the host clicking
    // the "Review Words" button. Requires every player to have hit
    // their submission cap so the host isn't reviewing a half-formed
    // hat. Initializes every existing word's status to 'submitted'
    // (so the review UI can show approve/remove badges).
    async startWordReview(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_COLLECTION]);
      const allDone = doc.players.length > 0 &&
        doc.players.every(p => p.wordCount === doc.wordsPerPlayer);
      if (!allDone) {
        throw new GameError('Cannot start review yet. Some players are missing words.');
      }
      doc.words.forEach(w => {
        if (!w.status || w.status === 'active') w.status = 'submitted';
      });
      doc.phase = PHASE.WORD_REVIEW;
      logEvent(doc, 'word_review_started', this._uid);
      saveGame(gameId, doc);
    }

    // WORD_REVIEW → WORD_COLLECTION. Host may decide a player needs
    // to resubmit a removed/edited word, so we drop back. Clears the
    // approve/remove flags so the next round of review starts fresh.
    async reopenWordCollection(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      doc.words.forEach(w => {
        w.status = 'active';
        w.removedByHost = false;
        // Keep editedByHost so the host can see what they already
        // edited, even if they reopen and revisit.
      });
      doc.phase = PHASE.WORD_COLLECTION;
      // wordCount on each player reflects "non-removed words"; since
      // we just un-removed everything, recompute.
      (doc.players || []).forEach(p => {
        p.wordCount = doc.words.filter(w => w.ownerUid === p.uid).length;
      });
      logEvent(doc, 'word_collection_reopened', this._uid);
      saveGame(gameId, doc);
    }

    // Host edits a word during WORD_REVIEW. Trims/validates the text,
    // marks editedByHost=true. Status falls back to 'submitted' (re-
    // requires explicit approval) so the host can't unintentionally
    // ship an edited word without confirming it.
    async hostEditWord(gameId, wordId, text) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      const w = (doc.words || []).find(w => w.id === wordId);
      if (!w) throw new GameError('Unknown word.');
      const clean = U.validateWordText(text);
      w.text = clean;
      w.editedByHost = true;
      w.status = 'submitted';
      w.approved = false;
      w.updatedAt = U.nowIso();
      logEvent(doc, 'word_edited_by_host', this._uid, { wordId, text: clean });
      saveGame(gameId, doc);
    }

    // Alias kept for spec alignment — the renderer / tests can call
    // either `hostEditWord` or `editWordAsHost`.
    async editWordAsHost(gameId, wordId, newText) {
      return this.hostEditWord(gameId, wordId, newText);
    }

    // Host marks a submitted word as needing revision. The owner sees
    // it in their own list with the optional reason and can resubmit
    // a corrected version. The word stays in `doc.words` and is NOT
    // removed — it just blocks `lockHat` until it's resubmitted and
    // re-approved (or removed by the host).
    async requestWordRevision(gameId, wordId, reason) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      const w = (doc.words || []).find(w => w.id === wordId);
      if (!w) throw new GameError('Unknown word.');
      if (w.status === 'removed') {
        throw new GameError('Removed words cannot be revised.');
      }
      const clean = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
      w.status = 'needs_revision';
      w.revisionReason = clean;
      w.approved = false;
      w.reviewedByHostAt = U.nowIso();
      w.updatedAt = U.nowIso();
      logEvent(doc, 'word_revision_requested', this._uid, {
        wordId: wordId, reason: clean,
      });
      saveGame(gameId, doc);
    }

    // Player resubmits a word that was marked needs_revision. The
    // revised text replaces the old text, status flips back to
    // 'submitted', and the host can re-review.
    async resubmitRevisedWord(gameId, wordId, newText) {
      const doc = this._requireGame(gameId);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      const me = this._requireMyPlayer(doc);
      const w = (doc.words || []).find(w => w.id === wordId);
      if (!w) throw new GameError('Word not found.');
      if (w.ownerUid !== this._uid) {
        throw new GameError('You can only revise your own words.');
      }
      if (w.status !== 'needs_revision') {
        throw new GameError('Only words marked for revision can be resubmitted.');
      }
      const clean = U.validateWordText(newText);
      // Re-check duplicates within the owner's own list (matches
      // submitWord / updateWord behavior).
      const dupe = (doc.words || []).some(other =>
        other.id !== wordId &&
        other.ownerUid === this._uid &&
        other.status !== 'removed' &&
        other.text.toLowerCase() === clean.toLowerCase()
      );
      if (dupe) {
        throw new GameError('You already have a word with that text.');
      }
      w.text = clean;
      w.status = 'submitted';
      w.revisionReason = '';
      w.approved = false;
      w.revisedAt = U.nowIso();
      w.updatedAt = U.nowIso();
      logEvent(doc, 'word_revision_resubmitted', this._uid, { wordId });
      saveGame(gameId, doc);
    }

    // Host removes a word during WORD_REVIEW. Soft delete: the doc
    // stays in `doc.words` so the audit trail is preserved, but its
    // status flips to 'removed' and it is excluded from
    // originalLockedWordIds at lockHat time.
    async hostRemoveWord(gameId, wordId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      const w = (doc.words || []).find(w => w.id === wordId);
      if (!w) throw new GameError('Unknown word.');
      w.status = 'removed';
      w.removedByHost = true;
      w.approved = false;
      w.updatedAt = U.nowIso();
      // Re-derive the owner's wordCount excluding removed words, so
      // if the host reopens word collection the player sees the
      // correct "X / N" progress.
      const owner = (doc.players || []).find(p => p.uid === w.ownerUid);
      if (owner) {
        owner.wordCount = doc.words.filter(x =>
          x.ownerUid === w.ownerUid && x.status !== 'removed'
        ).length;
      }
      logEvent(doc, 'word_removed_by_host', this._uid, { wordId });
      saveGame(gameId, doc);
    }

    // Host approves a single word. Must be in 'submitted' status —
    // already-removed words have to be un-removed first (re-edit) to
    // be approvable. Words pending revision can't be approved until
    // they've been resubmitted by the owner.
    async approveWord(gameId, wordId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      const w = (doc.words || []).find(w => w.id === wordId);
      if (!w) throw new GameError('Unknown word.');
      if (w.status === 'removed') {
        throw new GameError('Removed words cannot be approved.');
      }
      if (w.status === 'needs_revision') {
        throw new GameError('Wait for the player to resubmit this word.');
      }
      if (!w.text || !w.text.trim()) {
        throw new GameError('Cannot approve an empty word.');
      }
      w.status = 'approved';
      w.approved = true;
      w.reviewedByHostAt = U.nowIso();
      w.updatedAt = U.nowIso();
      saveGame(gameId, doc);
    }

    // Bulk approve every non-removed word that isn't pending revision.
    // Convenience action so the host doesn't have to click 20 times
    // when the submitted list looks clean. needs_revision words are
    // skipped — the host must wait for the player to resubmit.
    async approveAllWords(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      (doc.words || []).forEach(w => {
        if (w.status === 'removed') return;
        if (w.status === 'needs_revision') return;
        if (!w.text || !w.text.trim()) return;
        w.status = 'approved';
        w.approved = true;
        w.reviewedByHostAt = U.nowIso();
        w.updatedAt = U.nowIso();
      });
      logEvent(doc, 'approve_all_words', this._uid);
      saveGame(gameId, doc);
    }

    // WORD_REVIEW → HAT_LOCKED. Only approved words enter the locked
    // pool; removed words are excluded; 'submitted' (un-acted-on)
    // words block the lock so the host can't accidentally ship
    // words they haven't seen.
    async lockHat(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.WORD_REVIEW]);
      const approved = (doc.words || []).filter(w => w.status === 'approved');
      const stillPending = (doc.words || []).filter(w =>
        w.status === 'submitted'
      );
      const needsRevision = (doc.words || []).filter(w =>
        w.status === 'needs_revision'
      );
      if (needsRevision.length > 0) {
        throw new GameError(
          'Some words need revision before the hat can be locked.'
        );
      }
      if (stillPending.length > 0) {
        throw new GameError(
          'Approve or remove the remaining ' + stillPending.length +
          ' word(s) before locking the hat.'
        );
      }
      if (approved.length === 0) {
        throw new GameError('At least one approved word is required to lock the hat.');
      }
      approved.forEach(w => { w.status = 'locked'; });
      doc.phase = PHASE.HAT_LOCKED;
      doc.locked = true;
      // Snapshot the immutable word pool exactly once. This is what
      // every round's `remainingWordIds` is seeded from — words
      // guessed in round 1 do not disappear from rounds 2/3. Only
      // approved words enter; removed/un-acted-on words are excluded
      // (the throw above ensures there are no 'submitted' words at
      // this point).
      doc.originalLockedWordIds = approved.map(w => w.id);
      logEvent(doc, 'hat_locked', this._uid, {
        approvedCount: approved.length,
        removedCount: (doc.words || []).filter(w => w.status === 'removed').length,
      });
      saveGame(gameId, doc);
    }

    async startRound1Placeholder(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.HAT_LOCKED]);
      doc.phase = PHASE.ROUND_1_READY;
      doc.currentRound = 1;
      saveGame(gameId, doc);
    }

    async resetGame(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      const reset = emptyGame(doc.gameId, doc.gameCode, this._uid);
      saveGame(gameId, reset);
    }

    // Rematch: start a new game session while preserving players and
    // teams. Clears every piece of gameplay state (words, rounds,
    // scores, validation, etc.) but keeps the player and team
    // documents intact so connected clients don't have to rejoin.
    //
    // Options:
    //   reshufflePlayers: boolean
    //     If true, redistribute the current player roster evenly
    //     across the EXISTING teams (preserving team ids + names).
    //     If false (default), keep current team membership.
    async rematchGame(gameId, options) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.GAME_FINISHED]);
      const opts = options || {};
      const previousFinishedAt = doc.updatedAt || U.nowIso();
      const playerCount = (doc.players || []).length;
      const teamCount = (doc.teams || []).length;

      // Reshuffle into the existing teams if requested. Done BEFORE
      // wiping team rosters so we can use the existing team objects
      // as the seed.
      if (opts.reshufflePlayers) {
        if (teamCount < 1) {
          throw new GameError('Cannot reshuffle: no teams exist.');
        }
        const minRequired = teamCount * U.MIN_PLAYERS_PER_TEAM;
        if (playerCount < minRequired) {
          throw new GameError(
            'Cannot reshuffle: each team must have at least ' +
            U.MIN_PLAYERS_PER_TEAM + ' players.'
          );
        }
        const sizes = U.calculateTeamSizesByTeamCount(playerCount, teamCount);
        const shuffled = U.shuffleArray(doc.players || []);
        const result = U.assignPlayersToBalancedTeams(
          shuffled, doc.teams || [], sizes, U.newId
        );
        // Apply the reshuffle into existing team objects (preserving
        // identity).
        const byId = {};
        (doc.teams || []).forEach(t => { byId[t.id] = t; });
        result.teams.forEach(updated => {
          const target = byId[updated.id];
          if (target) {
            target.playerIds = updated.playerIds.slice();
            target.name = updated.name; // unchanged in this path
          }
        });
        (doc.players || []).forEach(p => { p.teamId = null; });
        Object.keys(result.assignments).forEach(teamId => {
          result.assignments[teamId].forEach(pid => {
            const p = (doc.players || []).find(x => (x.id === pid || x.uid === pid));
            if (p) p.teamId = teamId;
          });
        });
        logEvent(doc, 'players_reshuffled', this._uid, {
          teamSizes: sizes, teamCount: teamCount,
        });
      } else {
        logEvent(doc, 'teams_preserved', this._uid, { teamCount: teamCount });
      }

      // Reset gameplay state. Player and team documents are kept,
      // but every score / word / round / validation state is wiped.
      doc.phase = PHASE.TEAMS_SETUP;
      doc.currentRound = 0;
      doc.locked = false;
      doc.registrationLocked = false;
      doc.words = [];
      doc.originalLockedWordIds = [];
      doc.round1 = null;
      doc.round2 = null;
      doc.round3 = null;
      // Scores: per-team total + per-round subtotals.
      (doc.teams || []).forEach(t => {
        t.score = 0;
        t.roundScores = { 1: 0, 2: 0, 3: 0 };
      });
      // Player progress: zero submitted-word counters; preserve
      // identity (id/uid/name/teamId/lastSeenAt).
      (doc.players || []).forEach(p => {
        p.wordCount = 0;
      });
      logEvent(doc, 'game_state_reset', this._uid, {
        previousFinishedAt: previousFinishedAt,
        playerCount: playerCount,
        teamCount: teamCount,
      });
      logEvent(doc, 'rematch_started', this._uid, {
        previousFinishedAt: previousFinishedAt,
        options: { reshufflePlayers: !!opts.reshufflePlayers },
        playerCount: playerCount,
        teamCount: teamCount,
      });
      saveGame(gameId, doc);
    }

    // -- Mutations: player ----------------------------------------
    _requireMyPlayer(doc) {
      const me = doc.players.find(p => p.uid === this._uid);
      if (!me) throw new GameError('You are not part of this game.');
      return me;
    }

    async submitWord(gameId, text) {
      const doc = this._requireGame(gameId);
      this._requirePhase(doc, [PHASE.WORD_COLLECTION]);
      const me = this._requireMyPlayer(doc);
      const clean = U.validateWordText(text);
      const myWords = doc.words.filter(w => w.ownerUid === this._uid);
      if (myWords.length >= doc.wordsPerPlayer) {
        throw new GameError('You cannot submit more than ' + doc.wordsPerPlayer + ' words.');
      }
      if (myWords.some(w => w.text.toLowerCase() === clean.toLowerCase())) {
        throw new GameError('You already submitted that word.');
      }
      const word = {
        id: U.newId(),
        text: clean,
        ownerUid: this._uid,
        ownerPlayerId: me.id,
        ownerName: me.name,
        createdAt: U.nowIso(),
        updatedAt: U.nowIso(),
        status: 'active',
      };
      doc.words.push(word);
      me.wordCount = doc.words.filter(w => w.ownerUid === this._uid).length;
      saveGame(gameId, doc);
    }

    async updateWord(gameId, wordId, text) {
      const doc = this._requireGame(gameId);
      this._requirePhase(doc, [PHASE.WORD_COLLECTION]);
      const me = this._requireMyPlayer(doc);
      const word = doc.words.find(w => w.id === wordId);
      if (!word) throw new GameError('Word not found.');
      if (word.ownerUid !== this._uid) {
        throw new GameError('You can only edit your own words.');
      }
      const clean = U.validateWordText(text);
      if (doc.words.some(w =>
        w.ownerUid === this._uid && w.id !== wordId &&
        w.text.toLowerCase() === clean.toLowerCase()
      )) {
        throw new GameError('You already have a word with that text.');
      }
      word.text = clean;
      word.updatedAt = U.nowIso();
      saveGame(gameId, doc);
    }

    async deleteWord(gameId, wordId) {
      const doc = this._requireGame(gameId);
      this._requirePhase(doc, [PHASE.WORD_COLLECTION]);
      const me = this._requireMyPlayer(doc);
      const idx = doc.words.findIndex(w => w.id === wordId);
      if (idx === -1) throw new GameError('Word not found.');
      if (doc.words[idx].ownerUid !== this._uid) {
        throw new GameError('You can only delete your own words.');
      }
      doc.words.splice(idx, 1);
      me.wordCount = doc.words.filter(w => w.ownerUid === this._uid).length;
      saveGame(gameId, doc);
    }

    // -- Round subdoc listener -------------------------------------
    // The round subdocument lives inline on the game doc in mock mode
    // (Firestore version would split it into a subcollection — see
    // firestore.rules and firebase-provider.js for the recommended
    // shape). The listener below strips `activeWordId` for non-
    // explainers so they never see the hidden word.
    //
    // Generalized to all 3 rounds — emits whichever round is current
    // based on the game phase. The legacy `listenToRound1` is now an
    // alias that forwards to this method (consumers should migrate to
    // `listenToCurrentRound`).
    listenToCurrentRound(gameId, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb(null);
        const roundNum = currentRoundNumber(doc);
        if (roundNum === 0) return cb(null);
        const r = getRoundDoc(doc, roundNum);
        if (!r) return cb(null);
        const cfg = U.ROUND_CONFIG[roundNum] || {};
        const isAdmin = doc.adminUid === this._uid ||
          !!this._adminGames[doc.gameId];
        const isExplainer = r.activeExplainerUid &&
          r.activeExplainerUid === this._uid;
        // Canonical pending list — single source for badge + cards.
        const currentTurn = (r.turns && r.turns[r.turns.length - 1]) || null;
        const pendingIds = U.getPendingValidationWordIds(r, currentTurn);
        const pendingWords = pendingIds
          .map(id => doc.words.find(w => w.id === id))
          .filter(Boolean)
          .map(w => Object.assign({}, w));
        // Always-public fields. These describe *who is up* and *where
        // we are*, but never expose word text or remaining-deck ids.
        const view = {
          roundNumber: roundNum,
          roundName: cfg.name || ('Round ' + roundNum),
          roundRule: cfg.rule || '',
          hasWrong: !!cfg.hasWrong,
          status: r.status,
          phase: doc.phase,
          activeTeamId: r.activeTeamId,
          activeExplainerPlayerId: r.activeExplainerPlayerId,
          activeExplainerUid: r.activeExplainerUid,
          activeWordId: isExplainer ? r.activeWordId : null,
          activeWordText: null,
          remainingCount: r.remainingWordIds.length,
          turnNumber: r.turnNumber,
          turnStartedAt: r.turnStartedAt,
          turnEndsAt: r.turnEndsAt,
          durationSeconds: r.durationSeconds,
          timerRunning: r.status === U.R_STATUS.ACTIVE,
        };
        // Explainer-only: the active word text. Stripped for everyone
        // else, including the host — the host sees the word via the
        // validation panel after Guessed is pressed, never live.
        if (isExplainer && r.activeWordId) {
          const w = doc.words.find(w => w.id === r.activeWordId);
          view.activeWordText = w ? w.text : null;
        }
        // Host-only: the id arrays, the pending-validation list, the
        // current turn breakdown, and the recent turn log. None of
        // these fields are emitted to non-admin subscribers so a
        // teammate / other player has nothing to render even if a
        // future UI bug forgets to gate.
        if (isAdmin) {
          view.remainingWordIds = r.remainingWordIds.slice();
          view.pendingValidationWordIds = pendingIds;
          view.pendingValidationCount = pendingIds.length;
          view.pendingValidationWords = pendingWords;
          view.publicRevealedWordIds = r.publicRevealedWordIds.slice();
          view.confirmedGuessedWordIds = r.confirmedGuessedWordIds.slice();
          view.rejectedWordIds = r.rejectedWordIds.slice();
          view.turns = r.turns.slice(-10);
          view.currentTurn = currentTurn ? {
            turnNumber: currentTurn.turnNumber,
            teamId: currentTurn.teamId,
            explainerPlayerId: currentTurn.explainerPlayerId,
            status: currentTurn.status,
            guessedWordIds: (currentTurn.guessedWordIds || []).slice(),
            confirmedWordIds: (currentTurn.confirmedWordIds || []).slice(),
            rejectedWordIds: (currentTurn.rejectedWordIds || []).slice(),
            temporaryScore: currentTurn.temporaryScore || 0,
            finalScore: currentTurn.finalScore || 0,
          } : null;
        }
        cb(view);
      });
    }

    // Host-only listener: emits the chips for the Hat Contents
    // panel — i.e. `currentRound.remainingWordIds` resolved to word
    // objects. For non-admin subscribers this always emits the empty
    // payload, regardless of phase, so a non-host UI can't leak text
    // even if it accidentally subscribes.
    //
    // Payload shape:
    //   { remaining: [{id, text, ...}], roundNumber, roundName,
    //     originalCount }
    //
    // Between rounds (no active round subdoc) the payload contains
    // the full locked hat — that matches the host's expectation that
    // "Hat Contents" pre-round shows everything in the hat.
    listenToHostHatContents(gameId, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        const empty = {
          remaining: [], roundNumber: 0, roundName: '', originalCount: 0,
        };
        if (!doc) return cb(empty);
        const isAdmin = doc.adminUid === this._uid ||
          !!this._adminGames[doc.gameId];
        if (!isAdmin) return cb(empty);
        const origIds = (doc.originalLockedWordIds || []).slice();
        const lookup = {};
        (doc.words || []).forEach(w => { lookup[w.id] = w; });
        const roundNum = currentRoundNumber(doc);
        const r = currentRoundDoc(doc);
        // Pre-round and post-game: show the full locked hat. The
        // admin already used the same surface during HAT_LOCKED /
        // ROUND_N_READY before this change.
        if (!r || roundNum === 0) {
          const remaining = origIds
            .map(id => lookup[id])
            .filter(Boolean)
            .map(w => Object.assign({}, w));
          return cb({
            remaining: remaining,
            roundNumber: 0,
            roundName: '',
            originalCount: origIds.length,
          });
        }
        const remaining = (r.remainingWordIds || [])
          .map(id => lookup[id])
          .filter(Boolean)
          .map(w => Object.assign({}, w));
        const cfg = U.ROUND_CONFIG[roundNum] || {};
        cb({
          remaining: remaining,
          roundNumber: roundNum,
          roundName: cfg.name || ('Round ' + roundNum),
          originalCount: origIds.length,
        });
      });
    }
    // Backwards-compat alias.
    listenToRound1(gameId, cb) { return this.listenToCurrentRound(gameId, cb); }

    // DEPRECATED: pre-privacy this emitted "publicly revealed" words to
    // every subscriber so players could see the running list of
    // guessed words. Under the strict privacy rule (only the host and
    // the active explainer ever see word text) that surface is gone.
    //
    // The method is kept so old callers don't crash, but it now emits
    // [] unconditionally for non-admins, and for the admin it returns
    // the same union (publicRevealedWordIds ∪ confirmedGuessedWordIds)
    // — which is what the validation panel surfaces anyway. New code
    // should use `listenToHostHatContents` (remaining deck) or
    // `listenToCurrentRound` (pendingValidationWords, host-only).
    listenToPublicGuessedWords(gameId, cb) {
      return this._subscribe(gameId, () => {
        const doc = loadGame(gameId);
        if (!doc) return cb([]);
        const isAdmin = doc.adminUid === this._uid ||
          !!this._adminGames[doc.gameId];
        if (!isAdmin) return cb([]);
        const r = currentRoundDoc(doc);
        if (!r) return cb([]);
        const idSet = {};
        r.publicRevealedWordIds.concat(r.confirmedGuessedWordIds)
          .forEach(id => { idSet[id] = true; });
        const out = doc.words
          .filter(w => idSet[w.id])
          .map(w => Object.assign({}, w));
        cb(out);
      });
    }

    // Round 1 placeholder is a separate transition (HAT_LOCKED →
    // ROUND_1_READY) wired up in startRound1Placeholder above. The
    // method below activates the round (READY → ACTIVE) and seeds
    // its state from the original locked hat. Rounds 2 and 3 use
    // `startNextRound` which combines READY-seed + activation in one
    // call so the admin only has to press one button between rounds.
    async startRound1(gameId, opts) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      this._requirePhase(doc, [PHASE.ROUND_1_READY]);
      if (doc.teams.length < 1) {
        throw new GameError('At least one team is needed to start the round.');
      }
      if (doc.words.length === 0) {
        throw new GameError('No words in the hat.');
      }
      const allIds = shuffledOriginalWordIds(doc);
      // Take the pre-round duration setting; fall back to the
      // requester-supplied opts (used by Firebase port / tests).
      const settings = (doc.roundSettings && doc.roundSettings.round1) || {};
      const duration = (opts && opts.durationSeconds) ||
        settings.durationSeconds ||
        doc.round1DurationSeconds ||
        U.defaultDurationForRound(1);
      doc.round1 = emptyRound(1, allIds, duration);
      doc.phase = PHASE.ROUND_1_ACTIVE;
      doc.currentRound = 1;
      logEvent(doc, 'round1_started', this._uid, { durationSeconds: duration });
      saveGame(gameId, doc);
    }

    // Generic "start the next round" — moves from ROUND_X_FINISHED to
    // ROUND_(X+1)_ACTIVE, seeding the new round's deck from the
    // ORIGINAL locked words (re-shuffled). Score is preserved; only
    // the per-round score for the new round resets to 0 implicitly
    // (it accumulates from this round's confirmations).
    //
    // Convenience entrypoint used from the admin UI's "Start Round 2"
    // and "Start Round 3" buttons. After the round is activated the
    // first turn is queued automatically so the explainer can press
    // Start (mirrors how the admin "Start first turn" button works
    // for Round 1).
    async startNextRound(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      let nextRound;
      if (doc.phase === PHASE.ROUND_1_FINISHED) nextRound = 2;
      else if (doc.phase === PHASE.ROUND_2_FINISHED) nextRound = 3;
      else throw new GameError('No next round to start from phase ' + doc.phase + '.');
      if (doc.words.length === 0) {
        throw new GameError('No words in the hat.');
      }
      const teamsWithPlayers = doc.teams.filter(t => (t.playerIds || []).length > 0);
      if (teamsWithPlayers.length === 0) {
        throw new GameError('No teams have players assigned.');
      }
      const allIds = shuffledOriginalWordIds(doc);
      const settings =
        (doc.roundSettings && doc.roundSettings['round' + nextRound]) || {};
      const duration = settings.durationSeconds ||
        U.defaultDurationForRound(nextRound);
      setRoundDoc(doc, nextRound, emptyRound(nextRound, allIds, duration));
      doc.phase = U.phaseForRound(nextRound, 'ACTIVE');
      doc.currentRound = nextRound;
      // Reset all word statuses for the new round so the admin's hat
      // view shows "active" instead of leftover confirmed/rejected
      // from the previous round.
      (doc.words || []).forEach(w => { w.status = 'active'; });
      logEvent(doc, 'round_started', this._uid,
        { round: nextRound, durationSeconds: duration });
      saveGame(gameId, doc);
      // Queue the first turn of the new round — same pattern as
      // admin clicks Start Round 1 + Start first turn for Round 1.
      this._queueNextTurn(doc);
      saveGame(gameId, doc);
    }

    // Begin the next turn: pick the next team/explainer in rotation
    // and the first hidden word. The timer DOES NOT start here — the
    // active explainer must click their Start button (which calls
    // `startTurnTimer`) to begin the countdown.
    //
    // Generalized over all 3 rounds: reads + writes the current
    // round's subdoc based on the game phase.
    async startNextTurn(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      const roundNum = currentRoundNumber(doc);
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (doc.phase !== activePhase) {
        throw new GameError('Cannot start a turn outside of an active round.');
      }
      this._queueNextTurn(doc);
      saveGame(gameId, doc);
    }

    // Internal helper — queues the next turn on whichever round is
    // currently active. Used by `startNextTurn` and `startNextRound`.
    _queueNextTurn(doc) {
      const r = currentRoundDoc(doc);
      if (!r) throw new GameError('No active round to queue a turn for.');
      if (r.status === U.R_STATUS.WAITING_TO_START) {
        throw new GameError('A turn is already queued — waiting for explainer to start.');
      }
      if (r.status === U.R_STATUS.ACTIVE) {
        throw new GameError('A turn is already in progress.');
      }
      if (r.status === U.R_STATUS.TURN_VALIDATION) {
        throw new GameError('Validate the previous turn before starting the next one.');
      }
      if (r.remainingWordIds.length === 0) {
        throw new GameError('No words left in the deck.');
      }
      const teamsWithPlayers = doc.teams.filter(t => t.playerIds.length > 0);
      if (teamsWithPlayers.length === 0) {
        throw new GameError('No teams have players assigned.');
      }
      const team = teamsWithPlayers[r._teamCursor % teamsWithPlayers.length];
      r._teamCursor = (r._teamCursor + 1) % teamsWithPlayers.length;

      const eCursor = r._explainerCursorByTeam[team.id] || 0;
      const explainerId = team.playerIds[eCursor % team.playerIds.length];
      r._explainerCursorByTeam[team.id] = (eCursor + 1) % team.playerIds.length;
      const explainer = doc.players.find(p => p.id === explainerId);

      r.turnNumber++;
      r.activeTeamId = team.id;
      r.activeExplainerPlayerId = explainerId;
      r.activeExplainerUid = explainer ? explainer.uid : null;
      r.turns.push({
        turnNumber: r.turnNumber,
        teamId: team.id,
        explainerPlayerId: explainerId,
        explainerUid: explainer ? explainer.uid : null,
        startedAt: null,
        endedAt: null,
        status: 'waiting_to_start',
        guessedWordIds: [],
        confirmedWordIds: [],
        rejectedWordIds: [],
        temporaryScore: 0,
        finalScore: 0,
        actions: [],
      });
      // Word selection is deferred until the explainer presses Start.
      // That way nobody — not even the active explainer — can see the
      // word during WAITING_TO_START.
      r.activeWordId = null;
      // Timer is COLD: status flips to WAITING_TO_START; no
      // startedAt/endsAt until the explainer hits their Start button.
      r.status = U.R_STATUS.WAITING_TO_START;
      r.turnStartedAt = null;
      r.turnEndsAt = null;
    }

    // Start the per-turn countdown. ONLY callable by the active
    // explainer of the currently queued turn. This is what flips the
    // round from WAITING_TO_START → ACTIVE.
    //
    // Idempotent against the "click Start twice quickly" case — if
    // the turn is already ACTIVE this is a no-op rather than an
    // error. Works for all 3 rounds.
    async startTurnTimer(gameId) {
      const doc = this._requireGame(gameId);
      const roundNum = currentRoundNumber(doc);
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (doc.phase !== activePhase) {
        throw new GameError('Cannot start a timer outside of an active round.');
      }
      const r = getRoundDoc(doc, roundNum);
      if (!r) throw new GameError('No active round.');
      if (r.status === U.R_STATUS.ACTIVE) {
        // Already started — make this a no-op for double-click safety.
        return;
      }
      if (r.status !== U.R_STATUS.WAITING_TO_START) {
        throw new GameError('Timer can only be started when a turn is queued.');
      }
      this._requireExplainer(doc, r);
      // Pick the first word now, at Start time — not when the turn
      // was queued. This is the privacy guarantee: even the active
      // explainer cannot peek at the word during WAITING_TO_START
      // (their UI has nothing to render until this save lands).
      const turn = r.turns[r.turns.length - 1];
      if (!r.activeWordId) {
        r.activeWordId = U.selectRandomActiveWord(r, turn);
      }
      if (!r.activeWordId) {
        // Deck must have words to start a turn — _queueNextTurn
        // already enforced this, but double-check defensively.
        throw new GameError('No active word to play.');
      }
      const duration = r.durationSeconds || U.defaultDurationForRound(roundNum);
      const now = Date.now();
      r.status = U.R_STATUS.ACTIVE;
      r.turnStartedAt = new Date(now).toISOString();
      r.turnEndsAt = new Date(now + duration * 1000).toISOString();
      if (turn) {
        turn.startedAt = r.turnStartedAt;
        turn.status = 'active';
      }
      logEvent(doc, 'turn_started', this._uid, {
        round: roundNum, turnNumber: r.turnNumber,
      });
      saveGame(gameId, doc);
    }

    // Admin: set the per-turn duration in seconds for a specific
    // round. The roundNumber argument is 1/2/3. Allowed only before
    // that round has begun (i.e. while phase is HAT_LOCKED or an
    // earlier round's lifecycle phases). Once round N is in progress
    // or has finished, its duration is frozen at its stored value.
    async updateRoundDuration(gameId, roundNumber, seconds) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      const rn = parseInt(roundNumber, 10);
      if (rn !== 1 && rn !== 2 && rn !== 3) {
        throw new GameError('Invalid round number.');
      }
      // Disallow editing a round's duration once it has been started.
      // We compare against the round subdoc — if the subdoc exists,
      // the round has been at least queued (READY/ACTIVE/etc).
      const sub = getRoundDoc(doc, rn);
      if (sub) {
        throw new GameError(
          'Round ' + rn + ' duration cannot be changed once the round has started.'
        );
      }
      const n = U.validateDurationSeconds(seconds);
      if (!doc.roundSettings) doc.roundSettings = {};
      const key = 'round' + rn;
      doc.roundSettings[key] = Object.assign({}, doc.roundSettings[key] || {}, {
        durationSeconds: n,
        name: (doc.roundSettings[key] && doc.roundSettings[key].name) ||
              U.ROUND_CONFIG[rn].name,
      });
      // Keep the legacy alias in sync for Round 1.
      if (rn === 1) doc.round1DurationSeconds = n;
      saveGame(gameId, doc);
    }
    // Backwards-compat alias used by the existing Round 1 save
    // button + tests.
    async updateRound1Duration(gameId, seconds) {
      return this.updateRoundDuration(gameId, 1, seconds);
    }

    // Player action: only the active explainer may call this. The
    // current active word is marked guessed, tentative +1 to the
    // active team (and +1 to that team's per-round score), and the
    // next word from remainingWordIds becomes active. Works for all
    // 3 rounds.
    //
    // Idempotency contract — exactly one +1 per word per round:
    //   - activeWordId MUST be in remainingWordIds.
    //   - activeWordId MUST NOT be in pendingValidationWordIds.
    //   - activeWordId MUST NOT be in confirmedGuessedWordIds.
    //   - activeWordId MUST NOT already be in currentTurn.guessedWordIds.
    // A failed guard logs `[HatGame][GuessedGuard]` and returns
    // silently (not throw) — this is the right behavior for a stale
    // double-click that races past the UI's button-disable.
    //
    // Deck exhaustion: if there is no valid next word after this
    // guess, we end the turn here in the same write — moving to
    // TURN_VALIDATION if there are pending words, or directly to
    // FINISHED if every word in the round was confirmed. Without
    // this, the round would stay in ACTIVE status with no active
    // word and the only way out would be the timer expiring.
    async markGuessed(gameId) {
      const doc = this._requireGame(gameId);
      const roundNum = currentRoundNumber(doc);
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (doc.phase !== activePhase) {
        this._guessedGuardWarn('phase ' + doc.phase + ' not active', doc, null);
        return;
      }
      const r = getRoundDoc(doc, roundNum);
      if (!r) {
        this._guessedGuardWarn('no round subdoc', doc, null);
        return;
      }
      if (r.status === U.R_STATUS.WAITING_TO_START) {
        throw new GameError('Start the timer before marking a word as guessed.');
      }
      if (r.status !== U.R_STATUS.ACTIVE) {
        // No active turn — treat as a stale click rather than throwing
        // so a button race between auto-end + click doesn't surface
        // a confusing error toast.
        this._guessedGuardWarn('round status ' + r.status, doc, r);
        return;
      }
      this._requireExplainer(doc, r);
      // Reject any guess that arrives after the deadline.
      if (r.turnEndsAt && new Date(r.turnEndsAt).getTime() <= Date.now()) {
        throw new GameError('Time is up — no more guesses.');
      }
      const wordId = r.activeWordId;
      if (!wordId) {
        this._guessedGuardWarn('no activeWordId', doc, r);
        return;
      }
      const turn = r.turns && r.turns[r.turns.length - 1];
      // Idempotency guards — if any one fails this is a stale click
      // or a state drift. Either way: do nothing.
      const inRemaining = r.remainingWordIds.indexOf(wordId) !== -1;
      const inPending = (r.pendingValidationWordIds || []).indexOf(wordId) !== -1;
      const inConfirmed = (r.confirmedGuessedWordIds || []).indexOf(wordId) !== -1;
      const alreadyGuessedThisTurn = !!(turn &&
        (turn.guessedWordIds || []).indexOf(wordId) !== -1);
      if (!inRemaining || inPending || inConfirmed || alreadyGuessedThisTurn) {
        this._guessedGuardWarn(
          'duplicate/stale: wordId=' + wordId +
          ' inRemaining=' + inRemaining +
          ' inPending=' + inPending +
          ' inConfirmed=' + inConfirmed +
          ' alreadyThisTurn=' + alreadyGuessedThisTurn,
          doc, r
        );
        return;
      }
      // All guards passed — apply state changes exactly once.
      r.remainingWordIds = r.remainingWordIds.filter(id => id !== wordId);
      if (r.publicRevealedWordIds.indexOf(wordId) === -1) {
        r.publicRevealedWordIds.push(wordId);
      }
      const team = doc.teams.find(t => t.id === r.activeTeamId);
      if (team) {
        team.score = (team.score || 0) + 1;
        if (!team.roundScores) team.roundScores = { 1: 0, 2: 0, 3: 0 };
        team.roundScores[roundNum] = (team.roundScores[roundNum] || 0) + 1;
      }
      if (turn) {
        turn.guessedWordIds.push(wordId);
        turn.temporaryScore = (turn.temporaryScore || 0) + 1;
        turn.actions.push({
          type: U.ACTION.GUESSED,
          wordId: wordId,
          timestamp: U.nowIso(),
          teamId: r.activeTeamId,
          explainerPlayerId: r.activeExplainerPlayerId,
        });
      }
      // Pick the next word at random — within the eligibility set
      // (remaining minus pending/confirmed/this-turn-guessed) so we
      // cannot re-issue a word the host hasn't ruled on, and so the
      // deck order itself isn't predictable to players who might have
      // peeked at the host's hat-contents pane.
      r.activeWordId = U.selectRandomActiveWord(r, turn);
      // Normalize before the exhaustion check so the derived
      // pendingValidationWordIds is fresh.
      this._normalizeRound1State(doc);
      // Deck exhaustion: no valid next word means the turn ends
      // right here. We DON'T leave the round in ACTIVE with a null
      // activeWordId — that's the "infinite scoring" trap the bug
      // report described, since a fast double-click could otherwise
      // re-arm the button against a stale activeWordId.
      if (!r.activeWordId) {
        this._endActiveTurnInPlace(doc, r, roundNum);
      }
      saveGame(gameId, doc);
    }

    // Single guarded console warning so QA can grep for the prefix.
    _guessedGuardWarn(reason, doc, r) {
      try {
        console.warn(
          '[HatGame][GuessedGuard] stale or duplicate guessed action ignored:',
          reason,
          'gameId=', doc && doc.gameId,
          'phase=', doc && doc.phase,
          'roundNumber=', r && r.roundNumber,
          'activeWordId=', r && r.activeWordId
        );
      } catch (e) { /* logging only */ }
    }

    // Shared mutation used by `endTurn` and the deck-exhaustion path
    // of `markGuessed`. Mutates the doc in place — caller is
    // responsible for saving. Does NOT auth-check: callers do that
    // before deciding to end the turn.
    _endActiveTurnInPlace(doc, r, roundNum) {
      const turn = r.turns[r.turns.length - 1];
      if (turn) {
        turn.endedAt = U.nowIso();
        turn.actions.push({ type: U.ACTION.TURN_ENDED, timestamp: turn.endedAt });
      }
      r.activeWordId = null;
      r.activeExplainerUid = null;
      r.activeExplainerPlayerId = null;
      r.activeTeamId = null;
      r.turnEndsAt = null;
      const pendingIds = U.getPendingValidationWordIds(r, turn);
      if (pendingIds.length > 0) {
        r.status = U.R_STATUS.TURN_VALIDATION;
        doc.phase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
        if (turn) turn.status = 'validation';
      } else if (r.remainingWordIds.length === 0) {
        // Nothing pending, nothing left in the deck — round is done.
        r.status = U.R_STATUS.FINISHED;
        doc.phase = U.phaseForRound(roundNum, 'FINISHED');
        if (turn) turn.status = 'completed';
      } else {
        // Deck still has words but nothing pending (e.g. timer
        // expired with no guesses). Back to READY, ready for next
        // turn.
        r.status = U.R_STATUS.READY;
        if (turn) turn.status = 'completed';
      }
      this._normalizeRound1State(doc);
    }

    // Round 3 only: the explainer signals that their team made a
    // mistake / the association can't be guessed. The turn ends
    // immediately, no score change, the active word stays in the
    // deck for the next explainer. Earlier guesses in the same turn
    // still go through validation (admin can still
    // confirm/reject them).
    //
    // This is essentially "end the turn with no penalty and don't
    // advance the active word". We implement it by calling endTurn
    // (which is idempotent and accepts the explainer).
    async markWrong(gameId) {
      const doc = this._requireGame(gameId);
      const roundNum = currentRoundNumber(doc);
      if (roundNum !== 3) {
        throw new GameError('Wrong is only available in Round 3.');
      }
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (doc.phase !== activePhase) {
        throw new GameError('No active Round 3 turn.');
      }
      const r = getRoundDoc(doc, roundNum);
      if (!r) throw new GameError('No active Round 3.');
      if (r.status !== U.R_STATUS.ACTIVE) {
        throw new GameError('No active turn.');
      }
      this._requireExplainer(doc, r);
      // Wrong = end the turn. The active word stays in
      // remainingWordIds (we never popped it — markGuessed is the
      // only thing that does that), is not revealed (it isn't in
      // publicRevealedWordIds), no score change. The shared endTurn
      // does the right thing.
      const turn = r.turns[r.turns.length - 1];
      if (turn) {
        turn.actions.push({
          type: 'wrong', timestamp: U.nowIso(),
          wordId: r.activeWordId,
        });
      }
      logEvent(doc, 'word_wrong', this._uid, { wordId: r.activeWordId });
      saveGame(gameId, doc);
      // Reuse endTurn for the actual transition — it picks the right
      // next status (TURN_VALIDATION if anything pending, else READY
      // or FINISHED if the deck ran out).
      await this.endTurn(gameId);
    }

    // Admin (or timer expiry) ends the current turn. If any words are
    // pending validation, status moves to TURN_VALIDATION.
    //
    // Idempotent: if there's nothing active to end (e.g. another tab
    // already triggered the auto-end on timer expiration), silently
    // return. Multiple tabs may race the expiration check; only the
    // first transition takes effect, the rest are no-ops.
    //
    // Authorization: admin OR the active explainer (so an
    // explainer-side client can drive auto-end too if the admin's
    // tab isn't open). Works for all 3 rounds.
    async endTurn(gameId) {
      const doc = this._requireGame(gameId);
      const roundNum = currentRoundNumber(doc);
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (doc.phase !== activePhase) {
        return; // idempotent
      }
      const r = getRoundDoc(doc, roundNum);
      if (!r) return; // idempotent
      if (r.status !== U.R_STATUS.ACTIVE &&
          r.status !== U.R_STATUS.WAITING_TO_START) {
        return; // idempotent
      }
      const isAdmin = doc.adminUid === this._uid || !!this._adminGames[doc.gameId];
      const isExplainer = r.activeExplainerUid && r.activeExplainerUid === this._uid;
      if (!isAdmin && !isExplainer) {
        throw new GameError('Only the admin or the active explainer can end the turn.');
      }
      // All the state mutation lives in _endActiveTurnInPlace so
      // markGuessed's deck-exhaustion path goes through the exact
      // same transitions.
      this._endActiveTurnInPlace(doc, r, roundNum);
      saveGame(gameId, doc);
    }

    async confirmGuessedWord(gameId, wordId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      const roundNum = currentRoundNumber(doc);
      const validationPhase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
      if (doc.phase !== validationPhase) {
        throw new GameError('Not in turn validation phase.');
      }
      const r = getRoundDoc(doc, roundNum);
      const currentTurn = r.turns[r.turns.length - 1];
      // Gate via the canonical helper, NOT the stored array. The
      // stored array is a derived field; a stale stored array would
      // let us mis-validate.
      const pending = U.getPendingValidationWordIds(r, currentTurn);
      if (pending.indexOf(wordId) === -1) {
        throw new GameError('Word is not pending validation.');
      }
      // Game-level: confirmed wins. Defensive dedup-add + cross-strip.
      if (r.confirmedGuessedWordIds.indexOf(wordId) === -1) {
        r.confirmedGuessedWordIds.push(wordId);
      }
      r.rejectedWordIds = r.rejectedWordIds.filter(id => id !== wordId);
      r.pendingValidationWordIds = r.pendingValidationWordIds.filter(id => id !== wordId);
      // Current turn arrays — same dedup-add + cross-strip.
      if (currentTurn) {
        if (currentTurn.confirmedWordIds.indexOf(wordId) === -1) {
          currentTurn.confirmedWordIds.push(wordId);
        }
        currentTurn.rejectedWordIds = currentTurn.rejectedWordIds.filter(id => id !== wordId);
        currentTurn.finalScore = (currentTurn.finalScore || 0) + 1;
        currentTurn.actions.push({
          type: U.ACTION.ADMIN_CONFIRMED, wordId, timestamp: U.nowIso(),
        });
      }
      const w = doc.words.find(w => w.id === wordId);
      if (w) w.status = 'confirmed';
      logEvent(doc, 'word_confirmed', this._uid, { wordId, round: roundNum });
      // Score unchanged: temp +1 from markGuessed stays.
      this._normalizeRound1State(doc);
      saveGame(gameId, doc);
    }

    async rejectGuessedWord(gameId, wordId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      const roundNum = currentRoundNumber(doc);
      const validationPhase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
      if (doc.phase !== validationPhase) {
        throw new GameError('Not in turn validation phase.');
      }
      const r = getRoundDoc(doc, roundNum);
      const currentTurn = r.turns[r.turns.length - 1];
      const pending = U.getPendingValidationWordIds(r, currentTurn);
      if (pending.indexOf(wordId) === -1) {
        throw new GameError('Word is not pending validation.');
      }
      // Game-level: dedup-add to rejected; strip from confirmed,
      // pending, and the public-revealed list (returned to the
      // hidden pool).
      if (r.rejectedWordIds.indexOf(wordId) === -1) r.rejectedWordIds.push(wordId);
      r.confirmedGuessedWordIds = r.confirmedGuessedWordIds.filter(id => id !== wordId);
      r.pendingValidationWordIds = r.pendingValidationWordIds.filter(id => id !== wordId);
      r.publicRevealedWordIds = r.publicRevealedWordIds.filter(id => id !== wordId);
      // Return word to the deck (no dup).
      if (r.remainingWordIds.indexOf(wordId) === -1) r.remainingWordIds.push(wordId);
      // Current turn arrays
      if (currentTurn) {
        if (currentTurn.rejectedWordIds.indexOf(wordId) === -1) {
          currentTurn.rejectedWordIds.push(wordId);
        }
        currentTurn.confirmedWordIds = currentTurn.confirmedWordIds.filter(id => id !== wordId);
        currentTurn.finalScore = (currentTurn.finalScore || 0) - 1;
        currentTurn.actions.push({
          type: U.ACTION.ADMIN_REJECTED, wordId, timestamp: U.nowIso(),
        });
        // Subtract the tentative +1 from the team that guessed it
        // (both the running total and the per-round subtotal).
        const team = doc.teams.find(t => t.id === currentTurn.teamId);
        if (team) {
          team.score = Math.max(0, (team.score || 0) - 1);
          if (!team.roundScores) team.roundScores = { 1: 0, 2: 0, 3: 0 };
          team.roundScores[roundNum] = Math.max(0, (team.roundScores[roundNum] || 0) - 1);
        }
      }
      const w = doc.words.find(w => w.id === wordId);
      if (w) w.status = 'returned_to_pool';
      logEvent(doc, 'word_rejected', this._uid, { wordId, round: roundNum });
      this._normalizeRound1State(doc);
      saveGame(gameId, doc);
    }

    async finishValidation(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      const roundNum = currentRoundNumber(doc);
      const validationPhase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
      if (doc.phase !== validationPhase) {
        throw new GameError('Not in validation phase.');
      }
      // Always normalize first — this is the key fix for the
      // "2 pending but 0 cards" stuck state. After normalize the
      // stored array equals the canonical computation by construction.
      this._normalizeRound1State(doc);
      const r = getRoundDoc(doc, roundNum);
      const currentTurn = r.turns[r.turns.length - 1] || null;
      const pending = U.getPendingValidationWordIds(r, currentTurn);
      if (pending.length > 0) {
        throw new GameError(
          'Validate all guessed words before continuing (' +
          pending.length + ' pending).'
        );
      }
      if (currentTurn) currentTurn.status = 'completed';
      r.status = U.R_STATUS.READY;
      // Finish condition: no words left in the deck and nothing pending.
      if (r.remainingWordIds.length === 0) {
        doc.phase = U.phaseForRound(roundNum, 'FINISHED');
        r.status = U.R_STATUS.FINISHED;
      } else {
        doc.phase = U.phaseForRound(roundNum, 'ACTIVE');
      }
      saveGame(gameId, doc);
    }

    // Final transition: ROUND_3_FINISHED → GAME_FINISHED. Admin-only.
    // No state mutation beyond the phase change — the final results
    // screen reads team.score and team.roundScores directly.
    async finishGame(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (doc.phase !== PHASE.ROUND_3_FINISHED) {
        throw new GameError(
          'Game can only be finished after Round 3 is complete.'
        );
      }
      doc.phase = PHASE.GAME_FINISHED;
      logEvent(doc, 'game_finished', this._uid);
      saveGame(gameId, doc);
    }

    /**
     * Re-establish all invariants on the current round's state.
     *
     * Called after every mutation that can alter validation-related
     * arrays (markGuessed, endTurn, confirmGuessedWord,
     * rejectGuessedWord, finishValidation). Idempotent — running it
     * on an already-consistent state is a no-op.
     *
     * Invariants enforced:
     *   - All ID arrays are deduped and contain only IDs that exist
     *     in `doc.words`.
     *   - Game-level `confirmedGuessedWordIds` and `rejectedWordIds`
     *     are disjoint. Confirmed wins (admin's positive decision).
     *   - Per-turn `confirmedWordIds` and `rejectedWordIds` disjoint
     *     within each turn (confirmed wins, same reasoning).
     *   - `pendingValidationWordIds` equals
     *     `getPendingValidationWordIds(r, currentTurn)` exactly.
     *   - Confirmed words are NOT in `remainingWordIds`.
     *   - Rejected words ARE in `remainingWordIds` (unless they're
     *     the current active word or are once again pending in the
     *     current turn — they get back into the deck when the active
     *     turn ends).
     *   - `word.status` reflects the current state.
     *
     * Name kept (`_normalizeRound1State`) for diff readability, but
     * it operates on whichever round is current.
     */
    _normalizeRound1State(doc) {
      if (!doc) return;
      const r = currentRoundDoc(doc);
      if (!r) return;
      const knownIds = new Set((doc.words || []).map(w => w.id));

      const dedupExisting = (arr) => {
        if (!Array.isArray(arr)) return [];
        const seen = new Set();
        const out = [];
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i];
          if (!knownIds.has(id)) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
        return out;
      };

      r.remainingWordIds = dedupExisting(r.remainingWordIds);
      r.publicRevealedWordIds = dedupExisting(r.publicRevealedWordIds);
      r.confirmedGuessedWordIds = dedupExisting(r.confirmedGuessedWordIds);
      r.rejectedWordIds = dedupExisting(r.rejectedWordIds);
      r.pendingValidationWordIds = dedupExisting(r.pendingValidationWordIds);

      // Per-turn dedup + disjoint (confirmed wins).
      (r.turns || []).forEach(t => {
        t.guessedWordIds = dedupExisting(t.guessedWordIds);
        t.confirmedWordIds = dedupExisting(t.confirmedWordIds);
        t.rejectedWordIds = dedupExisting(t.rejectedWordIds);
        const confirmedInTurn = new Set(t.confirmedWordIds);
        t.rejectedWordIds = t.rejectedWordIds.filter(id => !confirmedInTurn.has(id));
      });

      // Game-level disjoint: confirmed wins.
      const confirmedSet = new Set(r.confirmedGuessedWordIds);
      r.rejectedWordIds = r.rejectedWordIds.filter(id => !confirmedSet.has(id));

      // Sync pendingValidationWordIds to the canonical computation
      // from the current turn.
      const currentTurn = r.turns && r.turns[r.turns.length - 1];
      r.pendingValidationWordIds = currentTurn
        ? U.getPendingValidationWordIds(r, currentTurn)
        : [];

      // Deck invariants.
      // 1. Confirmed words must NOT be in the deck.
      r.remainingWordIds = r.remainingWordIds.filter(id => !confirmedSet.has(id));
      // 2. Rejected words MUST be in the deck — unless they're the
      //    currently active word (mid-explanation) or are pending
      //    re-validation in the current turn (which shouldn't happen
      //    naturally, but guard against it).
      const pendingSet = new Set(r.pendingValidationWordIds);
      for (let i = 0; i < r.rejectedWordIds.length; i++) {
        const id = r.rejectedWordIds[i];
        if (id === r.activeWordId) continue;
        if (pendingSet.has(id)) continue;
        if (r.remainingWordIds.indexOf(id) === -1) r.remainingWordIds.push(id);
      }

      // Word.status sync — pure derived field.
      const rejectedSet = new Set(r.rejectedWordIds);
      (doc.words || []).forEach(w => {
        if (confirmedSet.has(w.id)) w.status = 'confirmed';
        else if (pendingSet.has(w.id)) w.status = 'pending_validation';
        else if (rejectedSet.has(w.id)) w.status = 'returned_to_pool';
        else if (w.id === r.activeWordId) w.status = 'active';
        // Otherwise we leave the previous status alone (e.g. "locked"
        // from before Round 1 started).
      });
    }

    // -- Game lifecycle: archive / delete / abandon / fullNewGame ---
    // Mirrors FirebaseProvider semantics. `doc.status` defaults to
    // 'active'; archived/abandoned/deleting rooms refuse new joins.
    _canDeleteGame(doc) {
      if (!doc) return false;
      if (doc.status && doc.status !== 'active') return true;
      return doc.phase === PHASE.LOBBY ||
        doc.phase === PHASE.TEAMS_SETUP ||
        doc.phase === PHASE.GAME_FINISHED;
    }
    async archiveGame(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (doc.status === 'archived') return;
      if (doc.status === 'deleting') {
        throw new GameError('This game is being deleted.');
      }
      doc.status = 'archived';
      doc.archivedAt = U.nowIso();
      logEvent(doc, 'game_archived', this._uid);
      saveGame(gameId, doc);
    }
    async markGameAbandoned(gameId, opts) {
      const doc = this._requireGame(gameId);
      const preStart = doc.phase === PHASE.LOBBY || doc.phase === PHASE.TEAMS_SETUP;
      if (!preStart) {
        throw new GameError(
          'A game that has already started cannot be marked abandoned.'
        );
      }
      const isAdmin = doc.adminUid === this._uid ||
        !!this._adminGames[doc.gameId];
      const minIdleMs = (opts && opts.minIdleMs) || 6 * 60 * 60 * 1000;
      let allowedByTimeout = false;
      if (doc.updatedAt) {
        const last = new Date(doc.updatedAt).getTime();
        if (Number.isFinite(last) && Date.now() - last >= minIdleMs) {
          allowedByTimeout = true;
        }
      }
      if (!isAdmin && !allowedByTimeout) {
        throw new GameError('Only the host can mark a game abandoned.');
      }
      doc.status = 'abandoned';
      doc.abandonedAt = U.nowIso();
      logEvent(doc, 'game_abandoned', this._uid, {
        reason: isAdmin ? 'host_marked' : 'idle_timeout',
      });
      saveGame(gameId, doc);
    }
    async deleteGameCompletely(gameId, options) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (!this._canDeleteGame(doc)) {
        throw new GameError(
          'A game in progress cannot be deleted. Finish or abandon it first.'
        );
      }
      const expectedCode = (doc.gameCode || gameId || '').toString().toUpperCase();
      const supplied = ((options && options.confirmCode) || '').toString().trim().toUpperCase();
      if (supplied !== expectedCode) {
        throw new GameError(
          'Type the game code (' + expectedCode + ') to confirm deletion.'
        );
      }
      // Hard-wipe: remove storage entry and admin-games map.
      localStorage.removeItem(storageKey(gameId));
      if (this._adminGames[gameId]) {
        delete this._adminGames[gameId];
        this._saveAdminGames();
      }
      // Fire a change event so any listener can see the deletion.
      global.dispatchEvent(new CustomEvent('hatmock:change', {
        detail: { gameId: gameId, key: storageKey(gameId) },
      }));
      return { gameId: gameId, gameCode: expectedCode };
    }
    async fullNewGame(opts) {
      return this.createGame(opts || {});
    }

    // -- Export / import (admin) ----------------------------------
    async exportState(gameId) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      return JSON.parse(JSON.stringify(doc));
    }

    async importState(gameId, snapshot) {
      const doc = this._requireGame(gameId);
      this._requireAdmin(doc);
      if (!snapshot || typeof snapshot !== 'object') {
        throw new GameError('Invalid snapshot.');
      }
      // Preserve gameId/code/adminUid so we don't break the listener
      // subscriptions for this tab.
      const next = Object.assign({}, snapshot, {
        gameId: doc.gameId,
        gameCode: doc.gameCode,
        adminUid: doc.adminUid,
      });
      // Defensive shape coercion.
      next.players = Array.isArray(next.players) ? next.players : [];
      next.teams = Array.isArray(next.teams) ? next.teams : [];
      next.words = Array.isArray(next.words) ? next.words : [];
      next.phase = U.ALL_PHASES.indexOf(next.phase) !== -1 ? next.phase : PHASE.LOBBY;
      saveGame(gameId, next);
    }
  }

  global.HatGame.MockProvider = MockProvider;
})(window);
