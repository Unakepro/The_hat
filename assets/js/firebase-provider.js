/* eslint-disable */
/**
 * FirebaseProvider — production implementation of the DataProvider
 * contract on top of Firebase Auth (anonymous) + Firestore.
 *
 * STATUS: feature-complete across setup, word collection, word
 * review, gameplay (rounds 1-3, turn flow, validation, scoring),
 * final results, rematch, and reset. All paths use Firestore
 * transactions or batched writes where consistency matters and
 * write append-only audit events under games/{gameId}/events.
 *
 * Reference behavior lives in `mock-provider.js` (used by the
 * Playwright suite); keep the two in sync when changing semantics.
 *
 * SECURITY: the client-side admin password gate is a UX
 * convenience. The real authority on "who can write what" is
 * Firestore security rules (see firestore.rules at the repo root).
 * Admin = game.adminUid; active explainer = game.activeExplainerUid
 * mirror (kept fresh by startNextTurn / endTurn).
 *
 * FIRESTORE LAYOUT:
 *
 *   games/{gameId}                       (room doc: gameCode, phase, ...)
 *     players/{playerId}                 (player doc keyed by uid)
 *     teams/{teamId}                     (team doc with playerIds[])
 *     words/{wordId}                     (privacy enforced by rules)
 *     rounds/round1                      (round subdoc; turns inline)
 *     rounds/round2
 *     rounds/round3
 *     events/{eventId}                   (append-only audit log)
 *
 * Notes:
 *   - We use the Firebase v9 compat SDK loaded via CDN <script> tags,
 *     which exposes `firebase` on window. This avoids needing a
 *     bundler and keeps the GitHub Pages story simple.
 *   - Anonymous sign-in must be enabled in the Firebase console:
 *       Authentication → Sign-in method → Anonymous → Enable.
 *   - Run the Full Online QA section in QA_CHECKLIST.md before
 *     signing off on any rule / schema change.
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const PHASE = U.PHASE;
  const GameError = U.GameError;
  const Log = U.Log;
  const R_STATUS = U.R_STATUS;

  // Round key used for the rounds subcollection doc id.
  function roundKey(n) { return 'round' + n; }

  // Build a fresh round subdoc. Same shape as MockProvider.emptyRound
  // so the listener stitching code can stay in lockstep — the only
  // difference is that turns live inline (Firestore doc fields) here,
  // exactly as in mock mode.
  function emptyRound(roundNumber, allWordIds, durationSeconds) {
    return {
      roundNumber: roundNumber,
      status: R_STATUS.READY,
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
      _teamCursor: 0,
      _explainerCursorByTeam: {},
      turns: [],
    };
  }

  // Same normalization logic as MockProvider._normalizeRound1State,
  // but pure: given a round object + the known word ids, mutate the
  // round in place and return a `wordStatusUpdates` map for the
  // caller to flush into `games/{id}/words/{wordId}`. Mirrors the
  // mock so listener consumers see the same derived fields.
  function normalizeRoundInPlace(round, knownWordIds, activeWordIdHint) {
    if (!round) return {};
    const knownSet = new Set(knownWordIds);
    const dedupExisting = (arr) => {
      if (!Array.isArray(arr)) return [];
      const seen = new Set();
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i];
        if (!knownSet.has(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    };
    round.remainingWordIds = dedupExisting(round.remainingWordIds);
    round.publicRevealedWordIds = dedupExisting(round.publicRevealedWordIds);
    round.confirmedGuessedWordIds = dedupExisting(round.confirmedGuessedWordIds);
    round.rejectedWordIds = dedupExisting(round.rejectedWordIds);
    round.pendingValidationWordIds = dedupExisting(round.pendingValidationWordIds);

    (round.turns || []).forEach(t => {
      t.guessedWordIds = dedupExisting(t.guessedWordIds);
      t.confirmedWordIds = dedupExisting(t.confirmedWordIds);
      t.rejectedWordIds = dedupExisting(t.rejectedWordIds);
      const confirmedInTurn = new Set(t.confirmedWordIds);
      t.rejectedWordIds = t.rejectedWordIds.filter(id => !confirmedInTurn.has(id));
    });

    const confirmedSet = new Set(round.confirmedGuessedWordIds);
    round.rejectedWordIds = round.rejectedWordIds.filter(id => !confirmedSet.has(id));

    const currentTurn = round.turns && round.turns[round.turns.length - 1];
    round.pendingValidationWordIds = currentTurn
      ? U.getPendingValidationWordIds(round, currentTurn)
      : [];

    round.remainingWordIds = round.remainingWordIds.filter(id => !confirmedSet.has(id));
    const pendingSet = new Set(round.pendingValidationWordIds);
    const liveActive = activeWordIdHint != null ? activeWordIdHint : round.activeWordId;
    for (let i = 0; i < round.rejectedWordIds.length; i++) {
      const id = round.rejectedWordIds[i];
      if (id === liveActive) continue;
      if (pendingSet.has(id)) continue;
      if (round.remainingWordIds.indexOf(id) === -1) round.remainingWordIds.push(id);
    }

    // Compute the word.status updates the caller should flush.
    const rejectedSet = new Set(round.rejectedWordIds);
    const updates = {};
    knownWordIds.forEach(id => {
      if (confirmedSet.has(id)) updates[id] = 'confirmed';
      else if (pendingSet.has(id)) updates[id] = 'pending_validation';
      else if (rejectedSet.has(id)) updates[id] = 'returned_to_pool';
      else if (id === liveActive) updates[id] = 'active';
    });
    return updates;
  }

  // Shared "end the current turn" mutation. Mirrors MockProvider's
  // _endActiveTurnInPlace. Mutates the round in place and returns the
  // next game.phase the caller should write.
  function endActiveTurnInPlace(round, knownWordIds) {
    const turn = round.turns && round.turns[round.turns.length - 1];
    if (turn) {
      turn.endedAt = U.nowIso();
      (turn.actions = turn.actions || []).push({
        type: U.ACTION.TURN_ENDED, timestamp: turn.endedAt,
      });
    }
    round.activeWordId = null;
    round.activeExplainerUid = null;
    round.activeExplainerPlayerId = null;
    round.activeTeamId = null;
    round.turnEndsAt = null;
    const pendingIds = turn
      ? U.getPendingValidationWordIds(round, turn)
      : [];
    let nextPhase;
    if (pendingIds.length > 0) {
      round.status = R_STATUS.TURN_VALIDATION;
      nextPhase = U.phaseForRound(round.roundNumber, 'TURN_VALIDATION');
      if (turn) turn.status = 'validation';
    } else if (round.remainingWordIds.length === 0) {
      round.status = R_STATUS.FINISHED;
      nextPhase = U.phaseForRound(round.roundNumber, 'FINISHED');
      if (turn) turn.status = 'completed';
    } else {
      round.status = R_STATUS.READY;
      nextPhase = U.phaseForRound(round.roundNumber, 'ACTIVE');
      if (turn) turn.status = 'completed';
    }
    normalizeRoundInPlace(round, knownWordIds);
    return nextPhase;
  }

  class FirebaseProvider {
    constructor(config) {
      this.name = 'firebase';
      this._config = config;
      this._app = null;
      this._auth = null;
      this._db = null;
      this._uid = null;
      this._initialized = false;
    }

    async init() {
      if (this._initialized) return;
      if (typeof global.firebase === 'undefined') {
        throw new GameError('Firebase SDK not loaded.', 'Firebase');
      }
      try {
        this._app = global.firebase.initializeApp(this._config);
        this._auth = global.firebase.auth();
        this._db = global.firebase.firestore();
        this._initialized = true;
        Log.firebase('initialized; project =', this._config.projectId);
      } catch (e) {
        Log.firebaseError('init failed', e);
        throw new GameError('Failed to initialize Firebase: ' + e.message, 'Firebase');
      }
    }

    get currentUid() { return this._uid; }

    async signInAnonymous() {
      await this.init();
      try {
        const result = await this._auth.signInAnonymously();
        this._uid = result.user.uid;
        Log.firebase('signed in; uid =', this._uid);
        return { uid: this._uid };
      } catch (e) {
        Log.firebaseError('anonymous sign-in failed', e);
        throw new GameError(
          'Anonymous sign-in failed — make sure it is enabled in the Firebase console.',
          'Firebase'
        );
      }
    }

    // -- Doc helpers ----------------------------------------------
    _gameRef(gameId) { return this._db.collection('games').doc(gameId); }
    _playersRef(gameId) { return this._gameRef(gameId).collection('players'); }
    _teamsRef(gameId) { return this._gameRef(gameId).collection('teams'); }
    _wordsRef(gameId) { return this._gameRef(gameId).collection('words'); }
    _eventsRef(gameId) { return this._gameRef(gameId).collection('events'); }
    _roundsRef(gameId) { return this._gameRef(gameId).collection('rounds'); }
    _roundRef(gameId, roundNumber) {
      return this._roundsRef(gameId).doc(roundKey(roundNumber || 1));
    }

    // -- Admin / phase guard helpers ------------------------------
    async _requireSignedIn() {
      await this.init();
      if (!this._uid) await this.signInAnonymous();
      if (!this._uid) {
        throw new GameError('You must be signed in to do that.', 'Firebase');
      }
    }
    async _loadGameOrThrow(gameId) {
      const snap = await this._gameRef(gameId).get();
      if (!snap.exists) throw new GameError('Game not found.');
      return Object.assign({ id: snap.id }, snap.data());
    }
    // Mirrors the mock provider's setup-edit gate: must be host, must
    // still be pre-collection (LOBBY or TEAMS_SETUP), registration not
    // locked.
    _assertAdminCanEditSetup(game) {
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (game.registrationLocked === true) {
        throw new GameError('This action is not allowed after the game starts.');
      }
      if (game.phase !== PHASE.LOBBY && game.phase !== PHASE.TEAMS_SETUP) {
        throw new GameError('Not allowed in phase ' + game.phase + '.');
      }
    }
    // Generic admin + phase guard for review / lock flows.
    _assertAdminInPhase(game, allowedPhases) {
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (allowedPhases.indexOf(game.phase) === -1) {
        throw new GameError('Not allowed in phase ' + game.phase + '.');
      }
    }
    _serverTimestamp() {
      return global.firebase.firestore.FieldValue.serverTimestamp();
    }
    _arrayRemove(value) {
      return global.firebase.firestore.FieldValue.arrayRemove(value);
    }

    // -- Game creation / join -------------------------------------
    async createGame({ wordsPerPlayer } = {}) {
      await this.signInAnonymous();
      // Try a few times in case of code collision. The doc id IS the
      // game code so a `set({ merge: false })` after a `get` is the
      // closest we can get to an atomic create. For production strength,
      // wrap this in a Firestore transaction.
      let code, ref, attempts = 0;
      while (attempts < 8) {
        code = U.newGameCode();
        ref = this._gameRef(code);
        const snap = await ref.get();
        if (!snap.exists) break;
        attempts++;
      }
      if (!ref) throw new GameError('Could not allocate a game code.', 'Firebase');
      const now = U.nowIso();
      await ref.set({
        gameCode: code,
        adminUid: this._uid,
        phase: PHASE.LOBBY,
        wordsPerPlayer: parseInt(wordsPerPlayer, 10) || 5,
        currentRound: 0,
        locked: false,
        // Registration lock mirrors the mock provider: false until the
        // host triggers word collection. Firestore security rules read
        // this field, so it must exist on the doc at creation time.
        registrationLocked: false,
        // Lifecycle tag: 'active' | 'archived' | 'abandoned' |
        // 'deleting'. archived/abandoned/deleting rooms refuse joins.
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return { gameId: code, gameCode: code };
    }

    async joinGame({ gameCode, nickname }) {
      await this.signInAnonymous();
      const code = U.validateGameCode(gameCode);
      const name = U.validateName(nickname, 'Nickname');
      const ref = this._gameRef(code);
      const snap = await ref.get();
      if (!snap.exists) throw new GameError('Game not found. Check the code.');
      const game = snap.data();
      // Lifecycle gate: archived / abandoned / deleting rooms are
      // closed regardless of phase.
      if (game.status && game.status !== 'active') {
        throw new GameError('This game is closed.');
      }
      if (game.phase === PHASE.HAT_LOCKED ||
          game.phase === PHASE.ROUND_1_READY ||
          game.phase === PHASE.ROUND_1_ACTIVE ||
          game.phase === PHASE.ROUND_1_TURN_VALIDATION ||
          game.phase === PHASE.ROUND_1_FINISHED) {
        throw new GameError('That game is no longer accepting new players.');
      }
      const playersRef = this._playersRef(code);
      // Use the uid as the player doc id so security rules can match
      // request.auth.uid to the document path.
      const playerRef = playersRef.doc(this._uid);
      await playerRef.set({
        uid: this._uid,
        name: name,
        teamId: null,
        joinedAt: U.nowIso(),
        connected: true,
        wordCount: 0,
      }, { merge: true });
      return { gameId: code, gameCode: code, playerId: this._uid };
    }

    async resumeIfAdmin(gameCode) {
      await this.signInAnonymous();
      const snap = await this._gameRef(gameCode).get();
      return snap.exists && snap.data().adminUid === this._uid;
    }

    async findMyPlayer(gameCode) {
      await this.signInAnonymous();
      const snap = await this._gameRef(gameCode).get();
      if (!snap.exists) return null;
      const psnap = await this._playersRef(gameCode).doc(this._uid).get();
      if (!psnap.exists) return null;
      return {
        gameId: gameCode, gameCode: gameCode,
        playerId: this._uid,
      };
    }

    // -- Listeners ------------------------------------------------
    listenToGame(gameId, cb) {
      return this._gameRef(gameId).onSnapshot(
        snap => cb(snap.exists ? Object.assign({ gameId: snap.id }, snap.data()) : null),
        err => Log.firebaseError('listenToGame', err)
      );
    }
    listenToPlayers(gameId, cb) {
      return this._playersRef(gameId).onSnapshot(
        snap => cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data()))),
        err => Log.firebaseError('listenToPlayers', err)
      );
    }
    listenToTeams(gameId, cb) {
      return this._teamsRef(gameId).onSnapshot(
        snap => cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data()))),
        err => Log.firebaseError('listenToTeams', err)
      );
    }
    listenToOwnWords(gameId, ownerUid, cb) {
      return this._wordsRef(gameId)
        .where('ownerUid', '==', ownerUid)
        .onSnapshot(
          snap => cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data()))),
          err => Log.firebaseError('listenToOwnWords', err)
        );
    }
    listenToHat(gameId, cb) {
      // The Firestore rule for `words` only opens admin-wide reads
      // once we hit a phase where the host needs the full hat: review
      // and post-lock. The mock provider follows the same gate (see
      // mock-provider.listenToHat) and the renderer expects words to
      // appear during WORD_REVIEW so the host can approve / edit /
      // remove them.
      let wordsUnsub = null;
      const gameUnsub = this._gameRef(gameId).onSnapshot(snap => {
        if (!snap.exists) { cb([]); return; }
        const phase = snap.data().phase;
        const open = phase === PHASE.WORD_REVIEW ||
          phase === PHASE.HAT_LOCKED ||
          phase === PHASE.ROUND_1_READY ||
          phase === PHASE.ROUND_1_ACTIVE ||
          phase === PHASE.ROUND_1_TURN_VALIDATION ||
          phase === PHASE.ROUND_1_FINISHED;
        if (open && !wordsUnsub) {
          wordsUnsub = this._wordsRef(gameId).onSnapshot(
            ws => cb(ws.docs.map(d => Object.assign({ id: d.id }, d.data()))),
            err => Log.firebaseError('listenToHat words', err)
          );
        } else if (!open) {
          if (wordsUnsub) { wordsUnsub(); wordsUnsub = null; }
          cb([]);
        }
      });
      return function unsub() {
        if (wordsUnsub) wordsUnsub();
        gameUnsub();
      };
    }
    // Composite "current round" listener. Subscribes to the game doc
    // (for currentRound + adminUid + phase), the round subdoc for the
    // current round, and the words collection (for resolving active /
    // pending word text). Re-emits a role-filtered view whenever any
    // source changes — identical payload shape to MockProvider so the
    // UI code stays provider-agnostic.
    listenToCurrentRound(gameId, cb) {
      const self = this;
      let game = null;
      let rounds = { 1: null, 2: null, 3: null };
      let wordsById = {};
      let roundUnsubs = {};
      let activeRoundNum = 0;
      function emit() {
        if (!game) return cb(null);
        const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
        if (roundNum === 0) return cb(null);
        const r = rounds[roundNum];
        if (!r) return cb(null);
        const cfg = U.ROUND_CONFIG[roundNum] || {};
        const isAdmin = game.adminUid === self._uid;
        const isExplainer = r.activeExplainerUid && r.activeExplainerUid === self._uid;
        const currentTurn = (r.turns && r.turns[r.turns.length - 1]) || null;
        const pendingIds = U.getPendingValidationWordIds(r, currentTurn);
        const pendingWords = pendingIds
          .map(id => wordsById[id])
          .filter(Boolean)
          .map(w => Object.assign({}, w));
        const view = {
          roundNumber: roundNum,
          roundName: cfg.name || ('Round ' + roundNum),
          roundRule: cfg.rule || '',
          hasWrong: !!cfg.hasWrong,
          status: r.status,
          phase: game.phase,
          activeTeamId: r.activeTeamId,
          activeExplainerPlayerId: r.activeExplainerPlayerId,
          activeExplainerUid: r.activeExplainerUid,
          activeWordId: isExplainer ? r.activeWordId : null,
          activeWordText: null,
          remainingCount: (r.remainingWordIds || []).length,
          turnNumber: r.turnNumber,
          turnStartedAt: r.turnStartedAt,
          turnEndsAt: r.turnEndsAt,
          durationSeconds: r.durationSeconds,
          timerRunning: r.status === R_STATUS.ACTIVE,
        };
        if (isExplainer && r.activeWordId) {
          const w = wordsById[r.activeWordId];
          view.activeWordText = w ? w.text : null;
        }
        if (isAdmin) {
          view.remainingWordIds = (r.remainingWordIds || []).slice();
          view.pendingValidationWordIds = pendingIds;
          view.pendingValidationCount = pendingIds.length;
          view.pendingValidationWords = pendingWords;
          view.publicRevealedWordIds = (r.publicRevealedWordIds || []).slice();
          view.confirmedGuessedWordIds = (r.confirmedGuessedWordIds || []).slice();
          view.rejectedWordIds = (r.rejectedWordIds || []).slice();
          view.turns = (r.turns || []).slice(-10);
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
      }
      function ensureRoundSub(n) {
        if (roundUnsubs[n]) return;
        roundUnsubs[n] = self._roundRef(gameId, n).onSnapshot(
          snap => {
            rounds[n] = snap.exists ? Object.assign({}, snap.data()) : null;
            emit();
          },
          err => Log.firebaseError('listenToCurrentRound round' + n, err)
        );
      }
      const gameUnsub = self._gameRef(gameId).onSnapshot(snap => {
        if (!snap.exists) { game = null; cb(null); return; }
        game = Object.assign({ gameId: snap.id }, snap.data());
        const newRoundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
        if (newRoundNum !== activeRoundNum) {
          activeRoundNum = newRoundNum;
          if (newRoundNum > 0) ensureRoundSub(newRoundNum);
        }
        emit();
      }, err => Log.firebaseError('listenToCurrentRound game', err));
      const wordsUnsub = self._wordsRef(gameId).onSnapshot(snap => {
        const next = {};
        snap.docs.forEach(d => { next[d.id] = Object.assign({ id: d.id }, d.data()); });
        wordsById = next;
        emit();
      }, err => Log.firebaseError('listenToCurrentRound words', err));
      return function unsub() {
        gameUnsub();
        wordsUnsub();
        Object.keys(roundUnsubs).forEach(k => roundUnsubs[k] && roundUnsubs[k]());
      };
    }
    // Backwards-compat alias.
    listenToRound1(gameId, cb) {
      return this.listenToCurrentRound(gameId, cb);
    }
    listenToPublicGuessedWords(gameId, cb) {
      // DEPRECATED: under the strict privacy rule the public guessed
      // surface no longer exists on the player UI, and on the host UI
      // it has been replaced by `listenToHostHatContents`. Kept as a
      // no-op so legacy admin/player controllers don't crash if they
      // still subscribe; emits [] regardless of caller identity.
      cb([]);
      return function () {};
    }

    // Host-only listener for the Hat Contents panel. Emits the
    // remaining deck for the current round, resolved to word objects.
    // Between rounds (or pre-round) emits the full locked-hat snapshot
    // — matches MockProvider behavior so the host UI is identical.
    // Non-admin subscribers always receive the empty payload.
    listenToHostHatContents(gameId, cb) {
      const self = this;
      const empty = { remaining: [], roundNumber: 0, roundName: '', originalCount: 0 };
      let game = null;
      let rounds = { 1: null, 2: null, 3: null };
      let wordsById = {};
      let roundUnsubs = {};
      let activeRoundNum = 0;
      function emit() {
        if (!game) return cb(empty);
        const isAdmin = game.adminUid === self._uid;
        if (!isAdmin) return cb(empty);
        const origIds = (game.originalLockedWordIds || []).slice();
        const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
        const r = roundNum > 0 ? rounds[roundNum] : null;
        if (!r || roundNum === 0) {
          const remaining = origIds
            .map(id => wordsById[id])
            .filter(Boolean)
            .map(w => Object.assign({}, w));
          return cb({
            remaining: remaining,
            roundNumber: 0, roundName: '',
            originalCount: origIds.length,
          });
        }
        const remaining = (r.remainingWordIds || [])
          .map(id => wordsById[id])
          .filter(Boolean)
          .map(w => Object.assign({}, w));
        const cfg = U.ROUND_CONFIG[roundNum] || {};
        cb({
          remaining: remaining,
          roundNumber: roundNum,
          roundName: cfg.name || ('Round ' + roundNum),
          originalCount: origIds.length,
        });
      }
      function ensureRoundSub(n) {
        if (roundUnsubs[n]) return;
        roundUnsubs[n] = self._roundRef(gameId, n).onSnapshot(
          snap => {
            rounds[n] = snap.exists ? Object.assign({}, snap.data()) : null;
            emit();
          },
          err => Log.firebaseError('listenToHostHatContents round' + n, err)
        );
      }
      const gameUnsub = self._gameRef(gameId).onSnapshot(snap => {
        if (!snap.exists) { game = null; cb(empty); return; }
        game = Object.assign({ gameId: snap.id }, snap.data());
        const newRoundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
        if (newRoundNum !== activeRoundNum) {
          activeRoundNum = newRoundNum;
          if (newRoundNum > 0) ensureRoundSub(newRoundNum);
        }
        emit();
      }, err => Log.firebaseError('listenToHostHatContents game', err));
      const wordsUnsub = self._wordsRef(gameId).onSnapshot(snap => {
        const next = {};
        snap.docs.forEach(d => { next[d.id] = Object.assign({ id: d.id }, d.data()); });
        wordsById = next;
        emit();
      }, err => Log.firebaseError('listenToHostHatContents words', err));
      return function unsub() {
        gameUnsub();
        wordsUnsub();
        Object.keys(roundUnsubs).forEach(k => roundUnsubs[k] && roundUnsubs[k]());
      };
    }

    // -- Mutations: admin -----------------------------------------
    async updateGameSettings(gameId, { wordsPerPlayer }) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);
      const n = parseInt(wordsPerPlayer, 10);
      if (!Number.isFinite(n) || n < U.MIN_WORDS || n > U.MAX_WORDS) {
        throw new GameError(
          'Words per player must be between ' + U.MIN_WORDS + ' and ' + U.MAX_WORDS + '.'
        );
      }
      await this._gameRef(gameId).update({
        wordsPerPlayer: n, updatedAt: U.nowIso(),
      });
    }
    async createTeam(gameId, name) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);
      // Surface duplicate names with the same English error players
      // get during rename — the mock provider doesn't enforce this on
      // create, but it's the right behavior on Firebase too.
      const teamsSnap = await this._teamsRef(gameId).get();
      const existing = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const clean = U.validateTeamName(name, existing, null);
      const now = U.nowIso();
      const teamRef = this._teamsRef(gameId).doc();
      const batch = this._db.batch();
      batch.set(teamRef, {
        name: clean, playerIds: [], score: 0,
        roundScores: { 1: 0, 2: 0, 3: 0 },
        createdAt: now, updatedAt: now,
      });
      const gameUpdates = { updatedAt: now };
      if (game.phase === PHASE.LOBBY) gameUpdates.phase = PHASE.TEAMS_SETUP;
      batch.update(this._gameRef(gameId), gameUpdates);
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'team_created',
        actorUid: this._uid,
        teamId: teamRef.id,
        name: clean,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async deleteTeam(gameId, teamId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);
      const teamRef = this._teamsRef(gameId).doc(teamId);
      const teamSnap = await teamRef.get();
      if (!teamSnap.exists) throw new GameError('Team not found.');
      const teamName = (teamSnap.data() && teamSnap.data().name) || '';
      // Clear teamId on every player who was on this team — without
      // this they keep a dangling reference and readiness checks read
      // stale state. Query by index so we only touch affected rows.
      const orphansSnap = await this._playersRef(gameId)
        .where('teamId', '==', teamId).get();
      const now = U.nowIso();
      const batch = this._db.batch();
      orphansSnap.docs.forEach(d => {
        batch.update(d.ref, { teamId: null, updatedAt: now });
      });
      batch.delete(teamRef);
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'team_deleted',
        actorUid: this._uid,
        teamId: teamId,
        teamName: teamName,
        clearedPlayerCount: orphansSnap.size,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async renameTeam(gameId, teamId, newName) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);

      const teamRef = this._teamsRef(gameId).doc(teamId);
      const teamSnap = await teamRef.get();
      if (!teamSnap.exists) throw new GameError('Team not found.');
      const oldName = teamSnap.data().name || '';

      const teamsSnap = await this._teamsRef(gameId).get();
      const allTeams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const clean = U.validateTeamName(newName, allTeams, teamId);

      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(teamRef, { name: clean, updatedAt: now });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'team_renamed',
        actorUid: this._uid,
        teamId: teamId,
        oldName: oldName,
        newName: clean,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async randomizeTeams(gameId, options) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);

      const playersSnap = await this._playersRef(gameId).get();
      const players = playersSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      // Throws "At least 4 players are required..." when applicable.
      const { sizes, mode } = U.validateRandomizationOptions(players.length, options || {});

      const teamsSnap = await this._teamsRef(gameId).get();
      const existingTeams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));

      // The shared helper preserves existing team identities + names
      // for the first `sizes.length` teams, then assigns each shuffled
      // player to exactly one team. Newly-created teams get default
      // names ("Team A", "Team B", ...). Extra existing teams are
      // returned with empty playerIds — we never auto-delete.
      const shuffled = U.shuffleArray(players);
      const result = U.assignPlayersToBalancedTeams(
        shuffled, existingTeams, sizes, () => 'team_' + U.newId()
      );

      const playerToTeam = {};
      Object.keys(result.assignments).forEach(teamId => {
        result.assignments[teamId].forEach(pid => {
          playerToTeam[pid] = teamId;
        });
      });

      const now = U.nowIso();
      const batch = this._db.batch();

      // Reassign every player. Reset to null first via the same write
      // so a player who is no longer placed lands in a clean state.
      playersSnap.docs.forEach(d => {
        const newTeamId = playerToTeam[d.id] || null;
        batch.update(d.ref, { teamId: newTeamId });
      });

      const existingById = {};
      existingTeams.forEach(t => { existingById[t.id] = t; });
      result.teams.forEach(t => {
        const ref = this._teamsRef(gameId).doc(t.id);
        if (existingById[t.id]) {
          batch.update(ref, {
            name: t.name,
            playerIds: t.playerIds.slice(),
            updatedAt: now,
          });
        } else {
          batch.set(ref, {
            name: t.name,
            playerIds: t.playerIds.slice(),
            score: 0,
            roundScores: { 1: 0, 2: 0, 3: 0 },
            createdAt: now,
            updatedAt: now,
          });
        }
      });
      // Extra existing teams beyond `sizes.length`: keep the doc, drop
      // its roster. The mock provider also leaves them in place.
      result.emptyTeams.forEach(t => {
        const ref = this._teamsRef(gameId).doc(t.id);
        batch.update(ref, { playerIds: [], updatedAt: now });
      });

      const gameUpdates = { updatedAt: now };
      if (game.phase === PHASE.LOBBY) gameUpdates.phase = PHASE.TEAMS_SETUP;
      batch.update(this._gameRef(gameId), gameUpdates);

      batch.set(this._eventsRef(gameId).doc(), {
        type: 'teams_randomized',
        actorUid: this._uid,
        mode: mode,
        playerCount: players.length,
        teamCount: sizes.length,
        teamSizes: sizes.slice(),
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async assignPlayerToTeam(gameId, playerId, teamId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);
      const playerRef = this._playersRef(gameId).doc(playerId);
      const playerSnap = await playerRef.get();
      if (!playerSnap.exists) throw new GameError('Player not found.');
      const teamsSnap = await this._teamsRef(gameId).get();
      let targetTeam = null;
      if (teamId) {
        targetTeam = teamsSnap.docs.find(d => d.id === teamId);
        if (!targetTeam) throw new GameError('Team not found.');
      }
      const now = U.nowIso();
      const batch = this._db.batch();
      // Strip playerId from every team's roster, then add it back to
      // the target team. arrayRemove is a no-op when the value is
      // absent, so the strip is safe to apply unconditionally.
      teamsSnap.docs.forEach(d => {
        if (d.id === teamId) return;
        batch.update(d.ref, {
          playerIds: this._arrayRemove(playerId),
          updatedAt: now,
        });
      });
      if (targetTeam) {
        batch.update(targetTeam.ref, {
          playerIds: global.firebase.firestore.FieldValue.arrayUnion(playerId),
          updatedAt: now,
        });
      }
      batch.update(playerRef, { teamId: teamId || null, updatedAt: now });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'player_assigned',
        actorUid: this._uid,
        playerId: playerId,
        teamId: teamId || null,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async removePlayer(gameId, playerId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);

      const playerRef = this._playersRef(gameId).doc(playerId);
      const playerSnap = await playerRef.get();
      if (!playerSnap.exists) throw new GameError('Player not found.');
      const playerData = playerSnap.data() || {};

      // List teams so we can strip the playerId from every roster.
      // arrayRemove is a no-op for teams that don't carry the id, so
      // applying it unconditionally is safe and keeps the batch flat.
      const teamsSnap = await this._teamsRef(gameId).get();

      const now = U.nowIso();
      const batch = this._db.batch();
      teamsSnap.docs.forEach(d => {
        batch.update(d.ref, {
          playerIds: this._arrayRemove(playerId),
          updatedAt: now,
        });
      });
      batch.delete(playerRef);
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'player_removed',
        actorUid: this._uid,
        targetPlayerId: playerId,
        targetPlayerName: playerData.name || null,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async startWordCollection(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminCanEditSetup(game);
      // Mirror the admin UI's readiness gate so a stale UI can't
      // bypass the requirement client-side. Single canonical helper.
      const [playersSnap, teamsSnap] = await Promise.all([
        this._playersRef(gameId).get(),
        this._teamsRef(gameId).get(),
      ]);
      const players = playersSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const teams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const r = U.getWordCollectionReadiness(
        { wordsPerPlayer: game.wordsPerPlayer, registrationLocked: !!game.registrationLocked },
        players, teams
      );
      if (!r.canStart) {
        throw new GameError(r.reasons[0]);
      }
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(this._gameRef(gameId), {
        phase: PHASE.WORD_COLLECTION,
        registrationLocked: true,
        updatedAt: now,
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_collection_started',
        actorUid: this._uid,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    // WORD_COLLECTION → WORD_REVIEW. Mirrors mock-provider.
    // startWordReview: requires every player to have submitted their
    // cap. Flips every still-'active' word to 'submitted' so the
    // review UI can drive approve / remove / request-revision badges.
    async startWordReview(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminInPhase(game, [PHASE.WORD_COLLECTION]);

      const [playersSnap, wordsSnap] = await Promise.all([
        this._playersRef(gameId).get(),
        this._wordsRef(gameId).get(),
      ]);
      const players = playersSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const words = wordsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));

      // Count owned words directly from the words collection — Firebase
      // submitWord doesn't currently maintain player.wordCount, so the
      // word collection is the source of truth here.
      const wpp = game.wordsPerPlayer | 0;
      const ownedCount = {};
      words.forEach(w => {
        const uid = w.ownerUid;
        if (!uid) return;
        ownedCount[uid] = (ownedCount[uid] || 0) + 1;
      });
      const allDone = players.length > 0 &&
        players.every(p => (ownedCount[p.uid] || 0) === wpp);
      if (!allDone) {
        throw new GameError('Cannot start review yet. Some players are missing words.');
      }

      const now = U.nowIso();
      const batch = this._db.batch();
      wordsSnap.docs.forEach(d => {
        const w = d.data() || {};
        if (!w.status || w.status === 'active') {
          batch.update(d.ref, { status: 'submitted', updatedAt: now });
        }
      });
      batch.update(this._gameRef(gameId), {
        phase: PHASE.WORD_REVIEW, updatedAt: now,
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_review_started',
        actorUid: this._uid,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // WORD_REVIEW → WORD_COLLECTION. Mirrors mock: every word goes
    // back to 'active', removedByHost is cleared, and each player's
    // wordCount is recomputed so the player UI shows the right
    // "X / N" progress when the host reopens collection.
    async reopenWordCollection(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminInPhase(game, [PHASE.WORD_REVIEW]);
      if (game.locked === true) {
        throw new GameError('Cannot reopen collection after the hat is locked.');
      }

      const [playersSnap, wordsSnap] = await Promise.all([
        this._playersRef(gameId).get(),
        this._wordsRef(gameId).get(),
      ]);

      const now = U.nowIso();
      const batch = this._db.batch();
      wordsSnap.docs.forEach(d => {
        batch.update(d.ref, {
          status: 'active',
          removedByHost: false,
          approved: false,
          revisionReason: '',
          updatedAt: now,
        });
      });
      // Recompute wordCount per player from the (now all-active) word
      // set. Match mock semantics — un-removing everything brings the
      // counts back up to the owner's full submission total.
      const ownedCount = {};
      wordsSnap.docs.forEach(d => {
        const w = d.data() || {};
        if (!w.ownerUid) return;
        ownedCount[w.ownerUid] = (ownedCount[w.ownerUid] || 0) + 1;
      });
      playersSnap.docs.forEach(d => {
        batch.update(d.ref, { wordCount: ownedCount[d.id] || 0 });
      });
      batch.update(this._gameRef(gameId), {
        phase: PHASE.WORD_COLLECTION, updatedAt: now,
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_collection_reopened',
        actorUid: this._uid,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // WORD_REVIEW → HAT_LOCKED. Only approved words enter the locked
    // pool. submitted/needs_revision words block the lock. Mirrors
    // mock-provider.lockHat.
    async lockHat(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminInPhase(game, [PHASE.WORD_REVIEW]);

      const wordsSnap = await this._wordsRef(gameId).get();
      const words = wordsSnap.docs.map(d => Object.assign({ id: d.id, _ref: d.ref }, d.data()));
      const needsRevision = words.filter(w => w.status === 'needs_revision');
      const stillPending = words.filter(w => w.status === 'submitted');
      const approved = words.filter(w => w.status === 'approved');
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

      const now = U.nowIso();
      const batch = this._db.batch();
      approved.forEach(w => {
        batch.update(w._ref, { status: 'locked', updatedAt: now });
      });
      const removedCount = words.filter(w => w.status === 'removed').length;
      batch.update(this._gameRef(gameId), {
        phase: PHASE.HAT_LOCKED,
        locked: true,
        // Snapshot the immutable locked pool. Removed words are
        // excluded; this is the source for every round's deck.
        originalLockedWordIds: approved.map(w => w.id),
        lockedAt: now,
        updatedAt: now,
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'hat_locked',
        actorUid: this._uid,
        approvedCount: approved.length,
        removedCount: removedCount,
        wordCount: approved.length,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }
    async startRound1Placeholder(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminInPhase(game, [PHASE.HAT_LOCKED]);
      await this._gameRef(gameId).update({
        phase: PHASE.ROUND_1_READY,
        currentRound: 1,
        updatedAt: U.nowIso(),
      });
    }
    // Delete every doc in a subcollection. Firestore doesn't cascade,
    // and the client SDK has no native bulk-delete, so we batch up to
    // 450 deletes at a time (just under the 500-op limit).
    async _deleteAllInRef(collRef) {
      const snap = await collRef.get();
      if (snap.empty) return 0;
      const docs = snap.docs;
      let cursor = 0;
      while (cursor < docs.length) {
        const batch = this._db.batch();
        const slice = docs.slice(cursor, cursor + 450);
        slice.forEach(d => batch.delete(d.ref));
        await batch.commit();
        cursor += slice.length;
      }
      return docs.length;
    }

    // Hard reset: tears the game back to the LOBBY shape and wipes
    // every subcollection (players, teams, words, rounds, events).
    // Matches MockProvider.resetGame (which replaces the doc with a
    // fresh emptyGame). Triggered by the admin's "New Game" button.
    async resetGame(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const now = U.nowIso();
      // Wipe subcollections first so listeners on the (now stale) doc
      // don't briefly see orphaned players/teams.
      await Promise.all([
        this._deleteAllInRef(this._playersRef(gameId)),
        this._deleteAllInRef(this._teamsRef(gameId)),
        this._deleteAllInRef(this._wordsRef(gameId)),
        this._deleteAllInRef(this._roundsRef(gameId)),
      ]);
      // Reset the game doc to a fresh LOBBY shape. Keep gameCode +
      // adminUid so the existing subscribers (admin tab, any open
      // player tabs) stay attached to the same doc id.
      await this._gameRef(gameId).set({
        gameCode: game.gameCode || gameId,
        adminUid: this._uid,
        phase: PHASE.LOBBY,
        wordsPerPlayer: game.wordsPerPlayer || 5,
        currentRound: 0,
        locked: false,
        registrationLocked: false,
        originalLockedWordIds: [],
        finalStandings: null,
        finishedAt: null,
        activeExplainerUid: null,
        activeTeamId: null,
        createdAt: game.createdAt || now,
        updatedAt: now,
      });
      await this._eventsRef(gameId).add({
        type: 'game_reset',
        actorUid: this._uid,
        createdAt: this._serverTimestamp(),
      });
    }

    // Soft reset that preserves players + teams. Mirrors
    // MockProvider.rematchGame. Allowed only from GAME_FINISHED.
    async rematchGame(gameId, options) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (game.phase !== PHASE.GAME_FINISHED) {
        throw new GameError(
          'Rematch is only available after the game is finished.'
        );
      }
      const opts = options || {};
      const [playersSnap, teamsSnap] = await Promise.all([
        this._playersRef(gameId).get(),
        this._teamsRef(gameId).get(),
      ]);
      const players = playersSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const teams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const playerCount = players.length;
      const teamCount = teams.length;

      const now = U.nowIso();

      // Optional reshuffle into existing teams (preserve team identity).
      let assignmentByPlayer = null;
      let reshuffleSizes = null;
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
        reshuffleSizes = U.calculateTeamSizesByTeamCount(playerCount, teamCount);
        const shuffled = U.shuffleArray(players);
        const result = U.assignPlayersToBalancedTeams(
          shuffled, teams, reshuffleSizes, U.newId
        );
        assignmentByPlayer = {};
        Object.keys(result.assignments).forEach(teamId => {
          result.assignments[teamId].forEach(pid => {
            assignmentByPlayer[pid] = teamId;
          });
        });
        // Also rewrite team rosters to match the shuffle.
        const byId = {};
        teams.forEach(t => { byId[t.id] = t; });
        result.teams.forEach(updated => {
          const target = byId[updated.id];
          if (target) target.playerIds = updated.playerIds.slice();
        });
      }

      // Wipe words + rounds; keep players + teams.
      await Promise.all([
        this._deleteAllInRef(this._wordsRef(gameId)),
        this._deleteAllInRef(this._roundsRef(gameId)),
      ]);

      const batch = this._db.batch();
      // Reset team scores + (optionally) playerIds.
      teamsSnap.docs.forEach(d => {
        const updates = {
          score: 0,
          roundScores: { 1: 0, 2: 0, 3: 0 },
          updatedAt: now,
        };
        if (opts.reshufflePlayers) {
          const updated = teams.find(t => t.id === d.id);
          if (updated) updates.playerIds = (updated.playerIds || []).slice();
        }
        batch.update(d.ref, updates);
      });
      // Reset player progress + reassignment.
      playersSnap.docs.forEach(d => {
        const updates = { wordCount: 0, updatedAt: now };
        if (assignmentByPlayer) {
          updates.teamId = assignmentByPlayer[d.id] || null;
        }
        batch.update(d.ref, updates);
      });
      batch.update(this._gameRef(gameId), {
        phase: PHASE.TEAMS_SETUP,
        currentRound: 0,
        locked: false,
        registrationLocked: false,
        originalLockedWordIds: [],
        finalStandings: null,
        finishedAt: null,
        activeExplainerUid: null,
        activeTeamId: null,
        updatedAt: now,
      });
      if (opts.reshufflePlayers) {
        batch.set(this._eventsRef(gameId).doc(), {
          type: 'players_reshuffled',
          actorUid: this._uid,
          teamCount: teamCount,
          teamSizes: reshuffleSizes,
          createdAt: this._serverTimestamp(),
        });
      } else {
        batch.set(this._eventsRef(gameId).doc(), {
          type: 'teams_preserved',
          actorUid: this._uid,
          teamCount: teamCount,
          createdAt: this._serverTimestamp(),
        });
      }
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'game_state_reset',
        actorUid: this._uid,
        playerCount: playerCount,
        teamCount: teamCount,
        createdAt: this._serverTimestamp(),
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'rematch_started',
        actorUid: this._uid,
        playerCount: playerCount,
        teamCount: teamCount,
        options: { reshufflePlayers: !!opts.reshufflePlayers },
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // -- Game lifecycle: archive / delete / abandon / fullNewGame ---
    //
    // The `game.status` field is the lifecycle tag:
    //   'active'      — normal play (default; missing field counts as
    //                   active so existing games keep working).
    //   'archived'    — host has finished + chosen to keep the room
    //                   visible-but-frozen. New joins blocked.
    //   'abandoned'   — host left before start and didn't return; the
    //                   room is marked stale by markGameAbandoned.
    //   'deleting'    — transient state during deleteGameCompletely.
    //
    // joinGame consults this field; archived/abandoned/deleting rooms
    // refuse new players regardless of phase.

    // Lifecycle phases where it is safe to perform a destructive
    // delete: pre-start (LOBBY / TEAMS_SETUP), GAME_FINISHED, or any
    // already-non-active state.
    _canDeleteGame(game) {
      if (!game) return false;
      if (game.status && game.status !== 'active') return true;
      return game.phase === PHASE.LOBBY ||
        game.phase === PHASE.TEAMS_SETUP ||
        game.phase === PHASE.GAME_FINISHED;
    }

    // Archive a game without destroying its data. The host can still
    // view results; nobody else can rejoin.
    async archiveGame(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (game.status === 'archived') return; // idempotent
      if (game.status === 'deleting') {
        throw new GameError('This game is being deleted.');
      }
      const batch = this._db.batch();
      batch.update(this._gameRef(gameId), {
        status: 'archived',
        archivedAt: U.nowIso(),
        updatedAt: U.nowIso(),
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'game_archived',
        actorUid: this._uid,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // Mark a stale pre-start game as abandoned. Allowed when the host
    // is the caller OR a timeout has elapsed since the last activity
    // (the rules permit a window for ops cleanup; we hard-check on the
    // client for the timeout-only path).
    async markGameAbandoned(gameId, opts) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      // Only valid while still pre-start. Once the game has begun the
      // host disconnecting must NOT trigger an abandoned tag — the
      // room is in play.
      const preStart = game.phase === PHASE.LOBBY || game.phase === PHASE.TEAMS_SETUP;
      if (!preStart) {
        throw new GameError(
          'A game that has already started cannot be marked abandoned.'
        );
      }
      const isAdmin = game.adminUid === this._uid;
      const minIdleMs = (opts && opts.minIdleMs) || 6 * 60 * 60 * 1000; // 6h
      let allowedByTimeout = false;
      if (game.updatedAt) {
        const last = new Date(game.updatedAt).getTime();
        if (Number.isFinite(last) && Date.now() - last >= minIdleMs) {
          allowedByTimeout = true;
        }
      }
      if (!isAdmin && !allowedByTimeout) {
        throw new GameError('Only the host can mark a game abandoned.');
      }
      const batch = this._db.batch();
      batch.update(this._gameRef(gameId), {
        status: 'abandoned',
        abandonedAt: U.nowIso(),
        updatedAt: U.nowIso(),
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'game_abandoned',
        actorUid: this._uid,
        reason: isAdmin ? 'host_marked' : 'idle_timeout',
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // Permanently delete a game and every subcollection under it.
    // Firestore does not cascade; we batch-delete each subcollection
    // (players, teams, words, rounds, events) and then the game doc
    // itself. Allowed only pre-start, after GAME_FINISHED, or for
    // already-non-active rooms (archived / abandoned).
    async deleteGameCompletely(gameId, options) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (!this._canDeleteGame(game)) {
        throw new GameError(
          'A game in progress cannot be deleted. Finish or abandon it first.'
        );
      }
      const expectedCode = (game.gameCode || gameId || '').toString().toUpperCase();
      const supplied = ((options && options.confirmCode) || '').toString().trim().toUpperCase();
      if (supplied !== expectedCode) {
        throw new GameError(
          'Type the game code (' + expectedCode + ') to confirm deletion.'
        );
      }
      // Tag the game as deleting first so live listeners can react.
      // We accept that this is a best-effort signal: if the page is
      // closed mid-delete, the doc + subcollections may stay (the
      // status tag stops joins). Run again from the host's tab to
      // complete.
      await this._gameRef(gameId).update({
        status: 'deleting',
        updatedAt: U.nowIso(),
      });
      // Wipe every subcollection. _deleteAllInRef chunks at 450 ops
      // so large rooms still complete.
      await Promise.all([
        this._deleteAllInRef(this._playersRef(gameId)),
        this._deleteAllInRef(this._teamsRef(gameId)),
        this._deleteAllInRef(this._wordsRef(gameId)),
        this._deleteAllInRef(this._roundsRef(gameId)),
        this._deleteAllInRef(this._eventsRef(gameId)),
      ]);
      // Finally the game doc itself.
      await this._gameRef(gameId).delete();
      return { gameId: gameId, gameCode: expectedCode };
    }

    // "Full New Game" — create a brand-new game with a brand-new
    // code. Does not carry over players or teams; callers should
    // close any stale sessions client-side. Returns the new
    // { gameId, gameCode } so the UI can route the host into it.
    async fullNewGame(opts) {
      await this._requireSignedIn();
      // Reuse createGame so the new room follows the same setup path
      // (LOBBY, registrationLocked=false, adminUid=this uid).
      return this.createGame(opts || {});
    }

    // Returns a final-results payload computed from team scores +
    // game-doc metadata. Admin-only.
    async exportFinalResults(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (game.phase !== PHASE.GAME_FINISHED) {
        throw new GameError('Final results are only available after the game is finished.');
      }
      const teamsSnap = await this._teamsRef(gameId).get();
      const teams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const standings = teams
        .map(t => ({
          teamId: t.id,
          name: t.name || '',
          score: t.score || 0,
          roundScores: Object.assign({ 1: 0, 2: 0, 3: 0 }, t.roundScores || {}),
        }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      const top = standings[0] ? standings[0].score : 0;
      const winners = standings.filter(s => s.score === top && top > 0);
      return {
        gameId: gameId,
        gameCode: game.gameCode,
        finishedAt: game.finishedAt || game.updatedAt,
        standings: standings,
        winner: winners.length === 1 ? winners[0] : null,
        tie: winners.length > 1,
      };
    }

    // -- Mutations: player ---------------------------------------
    async submitWord(gameId, text) {
      await this._requireSignedIn();
      const clean = U.validateWordText(text);
      const gameRef = this._gameRef(gameId);
      const playerRef = this._playersRef(gameId).doc(this._uid);
      const newWordRef = this._wordsRef(gameId).doc();
      // Transaction: enforce phase, owner, cap, duplicates, and
      // wordCount atomically so a fast double-click cannot exceed
      // wordsPerPlayer. We have to read all the same-owner words to
      // check duplicates, which means we collect their ids in advance
      // and read them inside the transaction.
      const ownerSnap = await this._wordsRef(gameId)
        .where('ownerUid', '==', this._uid).get();
      const ownerWordRefs = ownerSnap.docs.map(d => d.ref);
      const self = this;
      await this._db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw new GameError('Game not found.');
        const game = gameSnap.data();
        if (game.phase !== PHASE.WORD_COLLECTION) {
          throw new GameError('Not allowed in phase ' + game.phase + '.');
        }
        const playerSnap = await tx.get(playerRef);
        if (!playerSnap.exists) throw new GameError('You are not part of this game.');
        const player = playerSnap.data();
        const cap = parseInt(game.wordsPerPlayer, 10) || 0;
        const ownerDocs = await Promise.all(ownerWordRefs.map(r => tx.get(r)));
        const myWords = ownerDocs
          .filter(s => s.exists)
          .map(s => Object.assign({ id: s.id }, s.data()))
          // Exclude soft-removed/locked words from the cap so a host
          // can drop one and the owner can submit a replacement (the
          // mock provider counts owned words inclusive; we mirror).
          .filter(w => w.status !== 'removed');
        if (myWords.length >= cap) {
          throw new GameError(
            'You cannot submit more than ' + cap + ' words.'
          );
        }
        const normalized = clean.toLowerCase();
        if (myWords.some(w => (w.text || '').toLowerCase() === normalized)) {
          throw new GameError('You already submitted that word.');
        }
        const now = U.nowIso();
        tx.set(newWordRef, {
          text: clean,
          ownerUid: self._uid,
          ownerPlayerId: self._uid,
          ownerName: player.name || '',
          createdAt: now,
          updatedAt: now,
          status: 'active',
        });
        tx.update(playerRef, {
          wordCount: myWords.length + 1,
          updatedAt: now,
        });
        tx.update(gameRef, { updatedAt: now });
      });
      // Audit event written outside the transaction (events are
      // append-only; a transaction can't include create-with-auto-id
      // for a subcollection cleanly).
      await this._eventsRef(gameId).add({
        type: 'word_submitted',
        actorUid: this._uid,
        wordId: newWordRef.id,
        createdAt: this._serverTimestamp(),
      });
    }

    async updateWord(gameId, wordId, text) {
      await this._requireSignedIn();
      const clean = U.validateWordText(text);
      const gameRef = this._gameRef(gameId);
      const wordRef = this._wordsRef(gameId).doc(wordId);
      // Pre-query owner's other words for duplicate detection.
      const ownerSnap = await this._wordsRef(gameId)
        .where('ownerUid', '==', this._uid).get();
      const ownerOtherRefs = ownerSnap.docs
        .filter(d => d.id !== wordId)
        .map(d => d.ref);
      const self = this;
      await this._db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw new GameError('Game not found.');
        const game = gameSnap.data();
        const wordSnap = await tx.get(wordRef);
        if (!wordSnap.exists) throw new GameError('Word not found.');
        const word = wordSnap.data();
        if (word.ownerUid !== self._uid) {
          throw new GameError('You can only edit your own words.');
        }
        // Allowed paths:
        //  - WORD_COLLECTION: free edit of any of the owner's words.
        //  - WORD_REVIEW: owner can only edit their needs_revision
        //    word, and the edit promotes it back to 'submitted'
        //    so the host can re-review.
        const inCollection = game.phase === PHASE.WORD_COLLECTION;
        const isResubmit = game.phase === PHASE.WORD_REVIEW &&
          word.status === 'needs_revision';
        if (!inCollection && !isResubmit) {
          throw new GameError('Not allowed in phase ' + game.phase + '.');
        }
        const normalized = clean.toLowerCase();
        const otherSnaps = await Promise.all(ownerOtherRefs.map(r => tx.get(r)));
        const dupe = otherSnaps.some(s => {
          if (!s.exists) return false;
          const other = s.data() || {};
          if (other.status === 'removed') return false;
          return (other.text || '').toLowerCase() === normalized;
        });
        if (dupe) {
          throw new GameError('You already have a word with that text.');
        }
        const now = U.nowIso();
        const updates = { text: clean, updatedAt: now };
        if (isResubmit) {
          updates.status = 'submitted';
          updates.revisionReason = '';
          updates.approved = false;
          updates.approvedByHost = false;
          updates.revisedAt = now;
        }
        tx.update(wordRef, updates);
        tx.update(gameRef, { updatedAt: now });
      });
    }

    async deleteWord(gameId, wordId) {
      await this._requireSignedIn();
      const gameRef = this._gameRef(gameId);
      const wordRef = this._wordsRef(gameId).doc(wordId);
      const playerRef = this._playersRef(gameId).doc(this._uid);
      const self = this;
      await this._db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw new GameError('Game not found.');
        const game = gameSnap.data();
        if (game.phase !== PHASE.WORD_COLLECTION) {
          throw new GameError('Not allowed in phase ' + game.phase + '.');
        }
        const wordSnap = await tx.get(wordRef);
        if (!wordSnap.exists) throw new GameError('Word not found.');
        const word = wordSnap.data();
        if (word.ownerUid !== self._uid) {
          throw new GameError('You can only delete your own words.');
        }
        const playerSnap = await tx.get(playerRef);
        const currentCount = (playerSnap.exists &&
          (playerSnap.data().wordCount | 0)) || 0;
        const nextCount = Math.max(0, currentCount - 1);
        const now = U.nowIso();
        tx.delete(wordRef);
        if (playerSnap.exists) {
          tx.update(playerRef, { wordCount: nextCount, updatedAt: now });
        }
        tx.update(gameRef, { updatedAt: now });
      });
      await this._eventsRef(gameId).add({
        type: 'word_deleted',
        actorUid: this._uid,
        wordId: wordId,
        createdAt: this._serverTimestamp(),
      });
    }

    // -- Host word-review actions --------------------------------
    async _loadWordForHost(gameId, wordId, allowedPhases) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminInPhase(game, allowedPhases);
      const ref = this._wordsRef(gameId).doc(wordId);
      const snap = await ref.get();
      if (!snap.exists) throw new GameError('Word not found.');
      return { game, ref, word: Object.assign({ id: snap.id }, snap.data()) };
    }

    async approveWord(gameId, wordId) {
      const { ref, word } = await this._loadWordForHost(
        gameId, wordId, [PHASE.WORD_REVIEW]
      );
      if (word.status === 'removed') {
        throw new GameError('Removed words cannot be approved.');
      }
      if (word.status === 'needs_revision') {
        throw new GameError('Wait for the player to resubmit this word.');
      }
      if (!word.text || !word.text.trim()) {
        throw new GameError('Cannot approve an empty word.');
      }
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(ref, {
        status: 'approved',
        approved: true,
        approvedByHost: true,
        reviewedAt: this._serverTimestamp(),
        reviewedByHostAt: now,
        updatedAt: now,
      });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_approved',
        actorUid: this._uid,
        wordId: wordId,
        ownerPlayerId: word.ownerPlayerId || word.ownerUid || null,
        ownerName: word.ownerName || null,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async approveAllWords(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      this._assertAdminInPhase(game, [PHASE.WORD_REVIEW]);

      const wordsSnap = await this._wordsRef(gameId).get();
      const now = U.nowIso();
      const batch = this._db.batch();
      let approvedCount = 0;
      let skippedCount = 0;
      let needsRevisionCount = 0;
      let invalidCount = 0;
      wordsSnap.docs.forEach(d => {
        const w = d.data() || {};
        if (w.status === 'removed' || w.status === 'locked' || w.status === 'approved') {
          skippedCount++;
          return;
        }
        if (w.status === 'needs_revision') {
          needsRevisionCount++;
          return;
        }
        if (!w.text || !w.text.trim()) {
          invalidCount++;
          return;
        }
        approvedCount++;
        batch.update(d.ref, {
          status: 'approved',
          approved: true,
          approvedByHost: true,
          reviewedAt: this._serverTimestamp(),
          reviewedByHostAt: now,
          updatedAt: now,
        });
      });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'approve_all_words',
        actorUid: this._uid,
        approvedCount: approvedCount,
        skippedCount: skippedCount,
        needsRevisionCount: needsRevisionCount,
        invalidCount: invalidCount,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
      return {
        approvedCount: approvedCount,
        skippedCount: skippedCount,
        needsRevisionCount: needsRevisionCount,
        invalidCount: invalidCount,
      };
    }

    async hostRemoveWord(gameId, wordId) {
      const { ref, word } = await this._loadWordForHost(
        gameId, wordId, [PHASE.WORD_REVIEW]
      );
      if (word.status === 'locked') {
        throw new GameError('Locked words cannot be removed.');
      }
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(ref, {
        status: 'removed',
        removedByHost: true,
        approved: false,
        approvedByHost: false,
        reviewedAt: this._serverTimestamp(),
        updatedAt: now,
      });
      // Recompute the owner's wordCount excluding the just-removed
      // word + any previously-removed words, so a reopen shows the
      // correct "X / N" progress. Matches mock semantics.
      if (word.ownerUid) {
        const ownerWordsSnap = await this._wordsRef(gameId)
          .where('ownerUid', '==', word.ownerUid).get();
        const remaining = ownerWordsSnap.docs.filter(d => {
          if (d.id === wordId) return false;
          const x = d.data() || {};
          return x.status !== 'removed';
        }).length;
        batch.update(this._playersRef(gameId).doc(word.ownerUid), {
          wordCount: remaining,
        });
      }
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_removed_by_host',
        actorUid: this._uid,
        wordId: wordId,
        ownerPlayerId: word.ownerPlayerId || word.ownerUid || null,
        ownerName: word.ownerName || null,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async hostEditWord(gameId, wordId, newText) {
      const { ref, word } = await this._loadWordForHost(
        gameId, wordId, [PHASE.WORD_REVIEW]
      );
      if (word.status === 'removed') {
        throw new GameError('Removed words cannot be edited.');
      }
      if (word.status === 'locked') {
        throw new GameError('Locked words cannot be edited.');
      }
      const clean = U.validateWordText(newText);
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(ref, {
        text: clean,
        editedByHost: true,
        // Match mock: a host edit drops the word back to 'submitted'
        // so the host must re-approve before lock.
        status: 'submitted',
        approved: false,
        approvedByHost: false,
        updatedAt: now,
      });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_edited_by_host',
        actorUid: this._uid,
        wordId: wordId,
        text: clean,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async requestWordRevision(gameId, wordId, reason) {
      const { ref, word } = await this._loadWordForHost(
        gameId, wordId, [PHASE.WORD_REVIEW]
      );
      if (word.status === 'removed') {
        throw new GameError('Removed words cannot be revised.');
      }
      if (word.status === 'locked') {
        throw new GameError('Locked words cannot be revised.');
      }
      const cleanReason = typeof reason === 'string'
        ? reason.trim().slice(0, 200)
        : '';
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(ref, {
        status: 'needs_revision',
        revisionReason: cleanReason,
        approved: false,
        approvedByHost: false,
        reviewedAt: this._serverTimestamp(),
        reviewedByHostAt: now,
        updatedAt: now,
      });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_revision_requested',
        actorUid: this._uid,
        wordId: wordId,
        ownerPlayerId: word.ownerPlayerId || word.ownerUid || null,
        ownerName: word.ownerName || null,
        reason: cleanReason,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // Alias kept for renderers / tests that call the spec-name variant.
    async editWordAsHost(gameId, wordId, newText) {
      return this.hostEditWord(gameId, wordId, newText);
    }

    // -- Player revision action ----------------------------------
    async resubmitRevisedWord(gameId, wordId, newText) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.phase !== PHASE.WORD_REVIEW) {
        throw new GameError('Not allowed in phase ' + game.phase + '.');
      }
      const ref = this._wordsRef(gameId).doc(wordId);
      const snap = await ref.get();
      if (!snap.exists) throw new GameError('Word not found.');
      const word = snap.data() || {};
      if (word.ownerUid !== this._uid) {
        throw new GameError('You can only revise your own words.');
      }
      if (word.status !== 'needs_revision') {
        throw new GameError('Only words marked for revision can be resubmitted.');
      }
      const clean = U.validateWordText(newText);
      // Duplicate check against the owner's other non-removed words.
      const ownerWordsSnap = await this._wordsRef(gameId)
        .where('ownerUid', '==', this._uid).get();
      const dupe = ownerWordsSnap.docs.some(d => {
        if (d.id === wordId) return false;
        const x = d.data() || {};
        if (x.status === 'removed') return false;
        return (x.text || '').toLowerCase() === clean.toLowerCase();
      });
      if (dupe) {
        throw new GameError('You already have a word with that text.');
      }
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.update(ref, {
        text: clean,
        status: 'submitted',
        revisionReason: '',
        approved: false,
        approvedByHost: false,
        revisedAt: this._serverTimestamp(),
        updatedAt: now,
      });
      batch.update(this._gameRef(gameId), { updatedAt: now });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_revision_resubmitted',
        actorUid: this._uid,
        wordId: wordId,
        ownerPlayerId: word.ownerPlayerId || word.ownerUid || null,
        ownerName: word.ownerName || null,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // -- Round / turn / validation -------------------------------
    async _readKnownWordIds(gameId) {
      const snap = await this._wordsRef(gameId).get();
      return snap.docs.map(d => d.id);
    }
    // Seed a round subdoc, set game phase to ROUND_X_ACTIVE, optionally
    // queue the first turn. Shared between startRound1 + startNextRound.
    async _seedRound(gameId, roundNumber, opts) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const allowedPhases = opts && opts.allowedPhases;
      if (allowedPhases && allowedPhases.indexOf(game.phase) === -1) {
        throw new GameError('Not allowed in phase ' + game.phase + '.');
      }
      const allIds = U.shuffleArray(game.originalLockedWordIds || []);
      if (allIds.length === 0) {
        throw new GameError('No words in the hat.');
      }
      const teamsSnap = await this._teamsRef(gameId).get();
      const teams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const teamsWithPlayers = teams.filter(t => (t.playerIds || []).length > 0);
      if (teamsWithPlayers.length === 0) {
        throw new GameError('No teams have players assigned.');
      }
      const settings = (game.roundSettings && game.roundSettings[roundKey(roundNumber)]) || {};
      const requested = (opts && opts.durationSeconds);
      const duration = requested ||
        settings.durationSeconds ||
        U.defaultDurationForRound(roundNumber);
      const round = emptyRound(roundNumber, allIds, duration);
      const now = U.nowIso();
      const batch = this._db.batch();
      batch.set(this._roundRef(gameId, roundNumber), round);
      batch.update(this._gameRef(gameId), {
        phase: U.phaseForRound(roundNumber, 'ACTIVE'),
        currentRound: roundNumber,
        activeExplainerUid: null,
        activeTeamId: null,
        updatedAt: now,
      });
      // For rounds 2 and 3 the mock resets word.status back to active
      // so the host's hat view doesn't leak prior-round derived
      // statuses (confirmed / returned_to_pool).
      if (roundNumber > 1) {
        const wordsSnap = await this._wordsRef(gameId).get();
        wordsSnap.docs.forEach(d => {
          batch.update(d.ref, { status: 'active', updatedAt: now });
        });
      }
      batch.set(this._eventsRef(gameId).doc(), {
        type: roundNumber === 1 ? 'round1_started' : 'round_started',
        actorUid: this._uid,
        round: roundNumber,
        durationSeconds: duration,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
      return { round, teams };
    }

    async startRound1(gameId, opts) {
      await this._seedRound(gameId, 1, Object.assign(
        { allowedPhases: [PHASE.ROUND_1_READY] },
        opts || {}
      ));
    }

    async startNextRound(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      let nextRound;
      if (game.phase === PHASE.ROUND_1_FINISHED) nextRound = 2;
      else if (game.phase === PHASE.ROUND_2_FINISHED) nextRound = 3;
      else throw new GameError('No next round to start from phase ' + game.phase + '.');
      await this._seedRound(gameId, nextRound, {});
      // Mirror mock: queue the first turn immediately so the explainer
      // can press Start without waiting for the host to click another
      // button.
      await this.startNextTurn(gameId);
    }

    async startNextTurn(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (game.phase !== activePhase) {
        throw new GameError('Cannot start a turn outside of an active round.');
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const [roundSnap, playersSnap, teamsSnap] = await Promise.all([
        roundRef.get(), this._playersRef(gameId).get(), this._teamsRef(gameId).get(),
      ]);
      if (!roundSnap.exists) throw new GameError('No active round.');
      const r = Object.assign({}, roundSnap.data());
      if (r.status === R_STATUS.WAITING_TO_START) {
        throw new GameError('A turn is already queued — waiting for explainer to start.');
      }
      if (r.status === R_STATUS.ACTIVE) {
        throw new GameError('A turn is already in progress.');
      }
      if (r.status === R_STATUS.TURN_VALIDATION) {
        throw new GameError('Validate the previous turn before starting the next one.');
      }
      if ((r.remainingWordIds || []).length === 0) {
        throw new GameError('No words left in the deck.');
      }
      const teams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const teamsWithPlayers = teams.filter(t => (t.playerIds || []).length > 0);
      if (teamsWithPlayers.length === 0) {
        throw new GameError('No teams have players assigned.');
      }
      const players = playersSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const teamCursor = r._teamCursor | 0;
      const team = teamsWithPlayers[teamCursor % teamsWithPlayers.length];
      const explainerCursors = Object.assign({}, r._explainerCursorByTeam || {});
      const eCursor = explainerCursors[team.id] || 0;
      const explainerId = team.playerIds[eCursor % team.playerIds.length];
      explainerCursors[team.id] = (eCursor + 1) % team.playerIds.length;
      const explainer = players.find(p => p.id === explainerId);
      const explainerUid = explainer ? (explainer.uid || explainerId) : null;

      const turnNumber = (r.turnNumber | 0) + 1;
      r._teamCursor = (teamCursor + 1) % teamsWithPlayers.length;
      r._explainerCursorByTeam = explainerCursors;
      r.turnNumber = turnNumber;
      r.activeTeamId = team.id;
      r.activeExplainerPlayerId = explainerId;
      r.activeExplainerUid = explainerUid;
      r.activeWordId = null;
      r.status = R_STATUS.WAITING_TO_START;
      r.turnStartedAt = null;
      r.turnEndsAt = null;
      const turns = (r.turns || []).slice();
      turns.push({
        turnNumber: turnNumber,
        teamId: team.id,
        explainerPlayerId: explainerId,
        explainerUid: explainerUid,
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
      r.turns = turns;

      const now = U.nowIso();
      const batch = this._db.batch();
      batch.set(roundRef, r);
      batch.update(this._gameRef(gameId), {
        activeExplainerUid: explainerUid,
        activeTeamId: team.id,
        updatedAt: now,
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'turn_created',
        actorUid: this._uid,
        round: roundNum,
        turnNumber: turnNumber,
        teamId: team.id,
        explainerPlayerId: explainerId,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async startTurnTimer(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (game.phase !== activePhase) {
        throw new GameError('Cannot start a timer outside of an active round.');
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) throw new GameError('No active round.');
      const r = Object.assign({}, roundSnap.data());
      if (r.status === R_STATUS.ACTIVE) return; // idempotent double-click
      if (r.status !== R_STATUS.WAITING_TO_START) {
        throw new GameError('Timer can only be started when a turn is queued.');
      }
      if (r.activeExplainerUid !== this._uid) {
        throw new GameError('Only the active explainer can do that.');
      }
      const turns = (r.turns || []).slice();
      const turn = turns[turns.length - 1];
      if (!r.activeWordId) {
        r.activeWordId = U.selectRandomActiveWord(r, turn);
      }
      if (!r.activeWordId) {
        throw new GameError('No active word to play.');
      }
      const duration = r.durationSeconds || U.defaultDurationForRound(roundNum);
      const now = Date.now();
      r.status = R_STATUS.ACTIVE;
      r.turnStartedAt = new Date(now).toISOString();
      r.turnEndsAt = new Date(now + duration * 1000).toISOString();
      if (turn) {
        turn.startedAt = r.turnStartedAt;
        turn.status = 'active';
      }
      r.turns = turns;
      const batch = this._db.batch();
      batch.set(roundRef, r);
      batch.update(this._gameRef(gameId), { updatedAt: U.nowIso() });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'turn_started',
        actorUid: this._uid,
        round: roundNum,
        turnNumber: r.turnNumber,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async updateRoundDuration(gameId, roundNumber, seconds) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const rn = parseInt(roundNumber, 10);
      if (rn !== 1 && rn !== 2 && rn !== 3) {
        throw new GameError('Invalid round number.');
      }
      const roundRef = this._roundRef(gameId, rn);
      const sub = await roundRef.get();
      if (sub.exists) {
        throw new GameError(
          'Round ' + rn + ' duration cannot be changed once the round has started.'
        );
      }
      const n = U.validateDurationSeconds(seconds);
      const key = roundKey(rn);
      const existingSettings = game.roundSettings || {};
      const existing = existingSettings[key] || {};
      const merged = Object.assign({}, existingSettings, {
        [key]: Object.assign({}, existing, {
          durationSeconds: n,
          name: existing.name || (U.ROUND_CONFIG[rn] && U.ROUND_CONFIG[rn].name) || ('Round ' + rn),
        }),
      });
      const updates = { roundSettings: merged, updatedAt: U.nowIso() };
      if (rn === 1) updates.round1DurationSeconds = n;
      await this._gameRef(gameId).update(updates);
    }

    async updateRound1Duration(gameId, seconds) {
      return this.updateRoundDuration(gameId, 1, seconds);
    }

    async finishGame(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      if (game.phase !== PHASE.ROUND_3_FINISHED) {
        throw new GameError('Game can only be finished after Round 3 is complete.');
      }
      const teamsSnap = await this._teamsRef(gameId).get();
      const teams = teamsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      const finalStandings = teams
        .map(t => ({
          teamId: t.id,
          name: t.name || '',
          score: t.score || 0,
          roundScores: Object.assign({ 1: 0, 2: 0, 3: 0 }, t.roundScores || {}),
        }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      const finishedAt = U.nowIso();
      const batch = this._db.batch();
      batch.update(this._gameRef(gameId), {
        phase: PHASE.GAME_FINISHED,
        finishedAt: finishedAt,
        finalStandings: finalStandings,
        updatedAt: finishedAt,
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'game_finished',
        actorUid: this._uid,
        finalStandings: finalStandings,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    _guessedGuardWarn(reason, gameId, r) {
      try {
        console.warn(
          '[HatGame][GuessedGuard] stale or duplicate guessed action ignored:',
          reason,
          'gameId=', gameId,
          'roundNumber=', r && r.roundNumber,
          'activeWordId=', r && r.activeWordId
        );
      } catch (e) { /* logging only */ }
    }

    async markGuessed(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (game.phase !== activePhase) {
        this._guessedGuardWarn('phase ' + game.phase + ' not active', gameId, null);
        return;
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) {
        this._guessedGuardWarn('no round subdoc', gameId, null);
        return;
      }
      const r = Object.assign({}, roundSnap.data());
      if (r.status === R_STATUS.WAITING_TO_START) {
        throw new GameError('Start the timer before marking a word as guessed.');
      }
      if (r.status !== R_STATUS.ACTIVE) {
        this._guessedGuardWarn('round status ' + r.status, gameId, r);
        return;
      }
      if (r.activeExplainerUid !== this._uid) {
        throw new GameError('Only the active explainer can do that.');
      }
      if (r.turnEndsAt && new Date(r.turnEndsAt).getTime() <= Date.now()) {
        throw new GameError('Time is up — no more guesses.');
      }
      const wordId = r.activeWordId;
      if (!wordId) {
        this._guessedGuardWarn('no activeWordId', gameId, r);
        return;
      }
      const turns = (r.turns || []).slice();
      const turn = turns[turns.length - 1];
      const inRemaining = (r.remainingWordIds || []).indexOf(wordId) !== -1;
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
          gameId, r
        );
        return;
      }
      // All guards passed — apply.
      r.remainingWordIds = (r.remainingWordIds || []).filter(id => id !== wordId);
      r.publicRevealedWordIds = (r.publicRevealedWordIds || []).slice();
      if (r.publicRevealedWordIds.indexOf(wordId) === -1) {
        r.publicRevealedWordIds.push(wordId);
      }
      const teamRef = r.activeTeamId
        ? this._teamsRef(gameId).doc(r.activeTeamId)
        : null;
      const teamSnap = teamRef ? await teamRef.get() : null;
      let teamUpdate = null;
      if (teamSnap && teamSnap.exists) {
        const team = teamSnap.data() || {};
        const score = (team.score || 0) + 1;
        const roundScores = Object.assign({ 1: 0, 2: 0, 3: 0 }, team.roundScores || {});
        roundScores[roundNum] = (roundScores[roundNum] || 0) + 1;
        teamUpdate = { score: score, roundScores: roundScores };
      }
      if (turn) {
        turn.guessedWordIds = (turn.guessedWordIds || []).slice();
        turn.guessedWordIds.push(wordId);
        turn.temporaryScore = (turn.temporaryScore || 0) + 1;
        turn.actions = (turn.actions || []).slice();
        turn.actions.push({
          type: U.ACTION.GUESSED,
          wordId: wordId,
          timestamp: U.nowIso(),
          teamId: r.activeTeamId,
          explainerPlayerId: r.activeExplainerPlayerId,
        });
      }
      r.turns = turns;
      r.activeWordId = U.selectRandomActiveWord(r, turn);
      const knownIds = await this._readKnownWordIds(gameId);
      const wordStatusUpdates = normalizeRoundInPlace(r, knownIds);
      // Deck exhaustion ends the turn in the same write.
      let nextPhase = null;
      if (!r.activeWordId) {
        nextPhase = endActiveTurnInPlace(r, knownIds);
        Object.assign(wordStatusUpdates, normalizeRoundInPlace(r, knownIds));
      }

      const batch = this._db.batch();
      batch.set(roundRef, r);
      if (teamRef && teamUpdate) batch.update(teamRef, teamUpdate);
      const gameUpdates = { updatedAt: U.nowIso() };
      if (nextPhase) {
        gameUpdates.phase = nextPhase;
        gameUpdates.activeExplainerUid = null;
        gameUpdates.activeTeamId = null;
      }
      batch.update(this._gameRef(gameId), gameUpdates);
      Object.keys(wordStatusUpdates).forEach(wid => {
        batch.update(this._wordsRef(gameId).doc(wid), {
          status: wordStatusUpdates[wid], updatedAt: U.nowIso(),
        });
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_marked_guessed',
        actorUid: this._uid,
        wordId: wordId,
        teamId: r.activeTeamId,
        explainerPlayerId: r.activeExplainerPlayerId,
        round: roundNum,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async markWrong(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      if (roundNum !== 3) {
        throw new GameError('Wrong is only available in Round 3.');
      }
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (game.phase !== activePhase) {
        throw new GameError('No active Round 3 turn.');
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) throw new GameError('No active Round 3.');
      const r = Object.assign({}, roundSnap.data());
      if (r.status !== R_STATUS.ACTIVE) {
        throw new GameError('No active turn.');
      }
      if (r.activeExplainerUid !== this._uid) {
        throw new GameError('Only the active explainer can do that.');
      }
      const turns = (r.turns || []).slice();
      const turn = turns[turns.length - 1];
      if (turn) {
        turn.actions = (turn.actions || []).slice();
        turn.actions.push({
          type: 'wrong', timestamp: U.nowIso(), wordId: r.activeWordId,
        });
      }
      r.turns = turns;
      await roundRef.set(r);
      await this._eventsRef(gameId).add({
        type: 'word_wrong',
        actorUid: this._uid,
        wordId: r.activeWordId,
        round: roundNum,
        createdAt: this._serverTimestamp(),
      });
      // Now end the turn — endTurn handles status transitions.
      await this.endTurn(gameId);
    }

    async endTurn(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const activePhase = U.phaseForRound(roundNum, 'ACTIVE');
      if (game.phase !== activePhase) return; // idempotent
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) return;
      const r = Object.assign({}, roundSnap.data());
      if (r.status !== R_STATUS.ACTIVE && r.status !== R_STATUS.WAITING_TO_START) {
        return; // idempotent
      }
      const isAdmin = game.adminUid === this._uid;
      const isExplainer = r.activeExplainerUid && r.activeExplainerUid === this._uid;
      if (!isAdmin && !isExplainer) {
        throw new GameError('Only the admin or the active explainer can end the turn.');
      }
      const knownIds = await this._readKnownWordIds(gameId);
      const nextPhase = endActiveTurnInPlace(r, knownIds);
      const wordStatusUpdates = normalizeRoundInPlace(r, knownIds);
      const batch = this._db.batch();
      batch.set(roundRef, r);
      batch.update(this._gameRef(gameId), {
        phase: nextPhase,
        activeExplainerUid: null,
        activeTeamId: null,
        updatedAt: U.nowIso(),
      });
      Object.keys(wordStatusUpdates).forEach(wid => {
        batch.update(this._wordsRef(gameId).doc(wid), {
          status: wordStatusUpdates[wid], updatedAt: U.nowIso(),
        });
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'turn_ended',
        actorUid: this._uid,
        round: roundNum,
        turnNumber: r.turnNumber,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async confirmGuessedWord(gameId, wordId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const validationPhase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
      if (game.phase !== validationPhase) {
        throw new GameError('Not in turn validation phase.');
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) throw new GameError('No active round.');
      const r = Object.assign({}, roundSnap.data());
      const turns = (r.turns || []).slice();
      const currentTurn = turns[turns.length - 1];
      const pending = U.getPendingValidationWordIds(r, currentTurn);
      if (pending.indexOf(wordId) === -1) {
        throw new GameError('Word is not pending validation.');
      }
      if ((r.confirmedGuessedWordIds || []).indexOf(wordId) === -1) {
        r.confirmedGuessedWordIds = (r.confirmedGuessedWordIds || []).slice();
        r.confirmedGuessedWordIds.push(wordId);
      }
      r.rejectedWordIds = (r.rejectedWordIds || []).filter(id => id !== wordId);
      r.pendingValidationWordIds = (r.pendingValidationWordIds || []).filter(id => id !== wordId);
      if (currentTurn) {
        currentTurn.confirmedWordIds = (currentTurn.confirmedWordIds || []).slice();
        if (currentTurn.confirmedWordIds.indexOf(wordId) === -1) {
          currentTurn.confirmedWordIds.push(wordId);
        }
        currentTurn.rejectedWordIds = (currentTurn.rejectedWordIds || []).filter(id => id !== wordId);
        currentTurn.finalScore = (currentTurn.finalScore || 0) + 1;
        currentTurn.actions = (currentTurn.actions || []).slice();
        currentTurn.actions.push({
          type: U.ACTION.ADMIN_CONFIRMED, wordId: wordId, timestamp: U.nowIso(),
        });
      }
      r.turns = turns;
      const knownIds = await this._readKnownWordIds(gameId);
      const wordStatusUpdates = normalizeRoundInPlace(r, knownIds);
      const batch = this._db.batch();
      batch.set(roundRef, r);
      batch.update(this._gameRef(gameId), { updatedAt: U.nowIso() });
      Object.keys(wordStatusUpdates).forEach(wid => {
        batch.update(this._wordsRef(gameId).doc(wid), {
          status: wordStatusUpdates[wid], updatedAt: U.nowIso(),
        });
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_confirmed',
        actorUid: this._uid,
        wordId: wordId,
        round: roundNum,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async rejectGuessedWord(gameId, wordId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const validationPhase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
      if (game.phase !== validationPhase) {
        throw new GameError('Not in turn validation phase.');
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) throw new GameError('No active round.');
      const r = Object.assign({}, roundSnap.data());
      const turns = (r.turns || []).slice();
      const currentTurn = turns[turns.length - 1];
      const pending = U.getPendingValidationWordIds(r, currentTurn);
      if (pending.indexOf(wordId) === -1) {
        throw new GameError('Word is not pending validation.');
      }
      if ((r.rejectedWordIds || []).indexOf(wordId) === -1) {
        r.rejectedWordIds = (r.rejectedWordIds || []).slice();
        r.rejectedWordIds.push(wordId);
      }
      r.confirmedGuessedWordIds = (r.confirmedGuessedWordIds || []).filter(id => id !== wordId);
      r.pendingValidationWordIds = (r.pendingValidationWordIds || []).filter(id => id !== wordId);
      r.publicRevealedWordIds = (r.publicRevealedWordIds || []).filter(id => id !== wordId);
      if ((r.remainingWordIds || []).indexOf(wordId) === -1) {
        r.remainingWordIds = (r.remainingWordIds || []).slice();
        r.remainingWordIds.push(wordId);
      }
      let teamUpdate = null;
      let teamRef = null;
      if (currentTurn) {
        currentTurn.rejectedWordIds = (currentTurn.rejectedWordIds || []).slice();
        if (currentTurn.rejectedWordIds.indexOf(wordId) === -1) {
          currentTurn.rejectedWordIds.push(wordId);
        }
        currentTurn.confirmedWordIds = (currentTurn.confirmedWordIds || []).filter(id => id !== wordId);
        currentTurn.finalScore = (currentTurn.finalScore || 0) - 1;
        currentTurn.actions = (currentTurn.actions || []).slice();
        currentTurn.actions.push({
          type: U.ACTION.ADMIN_REJECTED, wordId: wordId, timestamp: U.nowIso(),
        });
        if (currentTurn.teamId) {
          teamRef = this._teamsRef(gameId).doc(currentTurn.teamId);
          const teamSnap = await teamRef.get();
          if (teamSnap.exists) {
            const team = teamSnap.data() || {};
            const score = Math.max(0, (team.score || 0) - 1);
            const roundScores = Object.assign({ 1: 0, 2: 0, 3: 0 }, team.roundScores || {});
            roundScores[roundNum] = Math.max(0, (roundScores[roundNum] || 0) - 1);
            teamUpdate = { score: score, roundScores: roundScores };
          }
        }
      }
      r.turns = turns;
      const knownIds = await this._readKnownWordIds(gameId);
      const wordStatusUpdates = normalizeRoundInPlace(r, knownIds);
      const batch = this._db.batch();
      batch.set(roundRef, r);
      if (teamRef && teamUpdate) batch.update(teamRef, teamUpdate);
      batch.update(this._gameRef(gameId), { updatedAt: U.nowIso() });
      Object.keys(wordStatusUpdates).forEach(wid => {
        batch.update(this._wordsRef(gameId).doc(wid), {
          status: wordStatusUpdates[wid], updatedAt: U.nowIso(),
        });
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'word_rejected',
        actorUid: this._uid,
        wordId: wordId,
        round: roundNum,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    async finishValidation(gameId) {
      await this._requireSignedIn();
      const game = await this._loadGameOrThrow(gameId);
      if (game.adminUid !== this._uid) {
        throw new GameError('Only the host can do that.');
      }
      const roundNum = U.roundNumberForPhase(game.phase) || game.currentRound || 0;
      const validationPhase = U.phaseForRound(roundNum, 'TURN_VALIDATION');
      if (game.phase !== validationPhase) {
        throw new GameError('Not in validation phase.');
      }
      const roundRef = this._roundRef(gameId, roundNum);
      const roundSnap = await roundRef.get();
      if (!roundSnap.exists) throw new GameError('No active round.');
      const r = Object.assign({}, roundSnap.data());
      const knownIds = await this._readKnownWordIds(gameId);
      const wordStatusUpdates = normalizeRoundInPlace(r, knownIds);
      const turns = (r.turns || []).slice();
      const currentTurn = turns[turns.length - 1] || null;
      const pending = U.getPendingValidationWordIds(r, currentTurn);
      if (pending.length > 0) {
        throw new GameError(
          'Validate all guessed words before continuing (' +
          pending.length + ' pending).'
        );
      }
      if (currentTurn) currentTurn.status = 'completed';
      r.turns = turns;
      let nextPhase;
      if ((r.remainingWordIds || []).length === 0) {
        r.status = R_STATUS.FINISHED;
        nextPhase = U.phaseForRound(roundNum, 'FINISHED');
      } else {
        r.status = R_STATUS.READY;
        nextPhase = U.phaseForRound(roundNum, 'ACTIVE');
      }
      const batch = this._db.batch();
      batch.set(roundRef, r);
      batch.update(this._gameRef(gameId), {
        phase: nextPhase,
        updatedAt: U.nowIso(),
      });
      Object.keys(wordStatusUpdates).forEach(wid => {
        batch.update(this._wordsRef(gameId).doc(wid), {
          status: wordStatusUpdates[wid], updatedAt: U.nowIso(),
        });
      });
      batch.set(this._eventsRef(gameId).doc(), {
        type: 'validation_finished',
        actorUid: this._uid,
        round: roundNum,
        createdAt: this._serverTimestamp(),
      });
      await batch.commit();
    }

    // -- Export / import -----------------------------------------
    async exportState(gameId) {
      // Pull everything in parallel and stitch.
      const [game, players, teams, words] = await Promise.all([
        this._gameRef(gameId).get(),
        this._playersRef(gameId).get(),
        this._teamsRef(gameId).get(),
        this._wordsRef(gameId).get(),
      ]);
      return {
        gameId: game.id,
        gameCode: game.exists ? game.data().gameCode : null,
        game: game.exists ? game.data() : null,
        players: players.docs.map(d => Object.assign({ id: d.id }, d.data())),
        teams: teams.docs.map(d => Object.assign({ id: d.id }, d.data())),
        words: words.docs.map(d => Object.assign({ id: d.id }, d.data())),
      };
    }
    async importState(gameId, snapshot) {
      // Importing a hand-edited or exported state into a live multi-
      // tenant Firestore is a foot-gun (it would silently overwrite
      // every player + word doc and the security rules can't validate
      // shape). Restoring from a backup is supported only via the
      // debug/mock path. Use Export → start a new mock game → Import
      // there if you need to inspect a snapshot.
      throw new GameError(
        'Import is disabled in Firebase production mode. Switch to ?mode=mock to inspect a snapshot.',
        'Firebase'
      );
    }
  }

  global.HatGame.FirebaseProvider = FirebaseProvider;
})(window);
