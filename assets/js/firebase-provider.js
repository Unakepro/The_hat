/* eslint-disable */
/**
 * FirebaseProvider — implementation of the DataProvider contract on
 * top of Firebase Auth (anonymous) + Firestore.
 *
 * STATUS: scaffold + read paths implemented. The mutation paths and
 * Round 1 are wired up where they map cleanly, but several places
 * are marked with `// TODO(firebase)` — these need to be exercised
 * against a live Firestore project before being trusted in prod.
 * The mock provider is the reference implementation for behavior.
 *
 * SECURITY NOTE: the client-side admin password gate is purely a UX
 * convenience — the real authority on "who can write what" is
 * Firestore security rules. See firestore.rules at the repo root.
 *
 * RECOMMENDED FIRESTORE LAYOUT (this matches the spec in the task):
 *
 *   games/{gameId}                       (doc: gameCode, phase, ...)
 *     players/{playerId}
 *     teams/{teamId}
 *     words/{wordId}                     (only owner can read text)
 *     rounds/round1                      (round subdoc)
 *       turns/{turnId}                   (turn history)
 *
 * Notes:
 *   - We use the Firebase v9 compat SDK loaded via CDN <script> tags,
 *     which exposes `firebase` on window. This avoids needing a
 *     bundler and keeps the GitHub Pages story simple.
 *   - Anonymous sign-in must be enabled in the Firebase console:
 *       Authentication → Sign-in method → Anonymous → Enable.
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const U = HG.Utils;
  const PHASE = U.PHASE;
  const GameError = U.GameError;
  const Log = U.Log;

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
    _roundRef(gameId) { return this._gameRef(gameId).collection('rounds').doc('round1'); }

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
      // The Firestore rule for `words` will reject a read of texts
      // before the hat is locked unless ownerUid matches. We therefore
      // gate the listener on the game phase ourselves: only attach
      // the words listener once the game is HAT_LOCKED+.
      let wordsUnsub = null;
      const gameUnsub = this._gameRef(gameId).onSnapshot(snap => {
        if (!snap.exists) { cb([]); return; }
        const phase = snap.data().phase;
        const open = phase === PHASE.HAT_LOCKED ||
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
    listenToRound1(gameId, cb) {
      // TODO(firebase): combine round doc + active word fetch (only
      // for the explainer) — for now we just expose the round doc.
      return this._roundRef(gameId).onSnapshot(
        snap => cb(snap.exists ? snap.data() : null),
        err => Log.firebaseError('listenToRound1', err)
      );
    }
    // Generic listener: returns whichever round is currently active.
    // TODO(firebase): pick the round subdoc based on the game's
    // current phase. For MVP this is identical to listenToRound1.
    // When implementing, follow the mock provider's contract — the
    // canonical helper `U.getPendingValidationWordIds` MUST be used
    // for the pending count and the listener payload, so the gating
    // logic is identical on both providers.
    listenToCurrentRound(gameId, cb) {
      return this.listenToRound1(gameId, cb);
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

    // Host-only listener: emits the remaining-deck chips for the
    // Hat Contents panel. The Firestore implementation should read
    // `/games/{gameId}/rounds/{currentRound}` (or the inline round
    // subdoc), pull `remainingWordIds`, resolve to /games/{gameId}/words
    // entries, and emit them only if the requesting uid is the
    // admin. For now this stub keeps the admin UI from breaking by
    // emitting an empty payload — the equivalent of "no words yet".
    //
    // TODO(firebase):
    //   1. Add a Firestore rule that limits reads of
    //      /games/{gameId}/rounds/{n}.remainingWordIds to the admin.
    //   2. Resolve word texts via /games/{gameId}/words/{wordId}.
    //   3. Mirror the mock provider's payload shape exactly:
    //        { remaining: [{id, text, ...}],
    //          roundNumber, roundName, originalCount }
    listenToHostHatContents(gameId, cb) {
      cb({ remaining: [], roundNumber: 0, roundName: '', originalCount: 0 });
      return function () {};
    }

    // -- Mutations: admin -----------------------------------------
    async updateGameSettings(gameId, { wordsPerPlayer }) {
      await this._gameRef(gameId).update({
        wordsPerPlayer: parseInt(wordsPerPlayer, 10),
        updatedAt: U.nowIso(),
      });
    }
    async createTeam(gameId, name) {
      const clean = U.validateName(name, 'Team name');
      await this._teamsRef(gameId).add({
        name: clean, playerIds: [], score: 0,
      });
      // Auto-advance phase if still in LOBBY.
      const gameSnap = await this._gameRef(gameId).get();
      if (gameSnap.exists && gameSnap.data().phase === PHASE.LOBBY) {
        await this._gameRef(gameId).update({ phase: PHASE.TEAMS_SETUP });
      }
    }
    async deleteTeam(gameId, teamId) {
      // TODO(firebase): also unassign all players in that team.
      await this._teamsRef(gameId).doc(teamId).delete();
    }
    async renameTeam(gameId, teamId, newName) {
      // TODO(firebase): admin-only, gated on registrationLocked === false.
      // Validate the name against existing team names (case-insensitive).
      throw new GameError(
        'Team renaming is not yet implemented on the Firebase provider.',
        'Firebase'
      );
    }
    async randomizeTeams(gameId, options) {
      // TODO(firebase): admin-only, registrationLocked === false, phase ∈
      // {LOBBY, TEAMS_SETUP}. Use a Firestore transaction to:
      //   1. read all /games/{gameId}/players
      //   2. read existing /games/{gameId}/teams
      //   3. compute sizes via U.validateRandomizationOptions
      //   4. shuffle + assignPlayersToBalancedTeams
      //   5. batch-write team upserts + player.teamId updates
      // See mock-provider.randomizeTeams for the reference behavior.
      throw new GameError(
        'Team randomization is not yet implemented on the Firebase provider.',
        'Firebase'
      );
    }
    async assignPlayerToTeam(gameId, playerId, teamId) {
      // TODO(firebase): use a transaction to update player.teamId and
      // the teams' playerIds arrays atomically.
      await this._playersRef(gameId).doc(playerId).update({ teamId: teamId || null });
    }
    async removePlayer(gameId, playerId) {
      // TODO(firebase): wrap in a transaction that
      //   - reads /games/{gameId} to verify phase ∈ {LOBBY,
      //     TEAMS_SETUP} and registrationLocked === false
      //   - deletes /games/{gameId}/players/{playerId}
      //   - strips playerId from each team.playerIds in
      //     /games/{gameId}/teams/* (use arrayRemove)
      //   - logs a `player_removed` audit event
      // Also harden firestore.rules so only the admin uid can perform
      // the delete, and only while registrationLocked === false.
      // See mock-provider.removePlayer for the reference behavior.
      throw new GameError(
        'Removing players is not yet implemented on the Firebase provider.',
        'Firebase'
      );
    }
    async startWordCollection(gameId) {
      await this._gameRef(gameId).update({
        phase: PHASE.WORD_COLLECTION,
        updatedAt: U.nowIso(),
      });
    }
    async lockHat(gameId) {
      // TODO(firebase): server-side check that all players have
      // wordCount === wordsPerPlayer. For MVP this is enforced on
      // the client.
      await this._gameRef(gameId).update({
        phase: PHASE.HAT_LOCKED,
        locked: true,
        updatedAt: U.nowIso(),
      });
    }
    async startRound1Placeholder(gameId) {
      await this._gameRef(gameId).update({
        phase: PHASE.ROUND_1_READY,
        currentRound: 1,
        updatedAt: U.nowIso(),
      });
    }
    async resetGame(gameId) {
      // TODO(firebase): delete subcollections too — Firestore doesn't
      // cascade. For MVP we recommend using a Cloud Function.
      throw new GameError('Reset is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async rematchGame(gameId, options) {
      // TODO(firebase): preserve players/teams, clear words/rounds/
      // scores. See mock-provider.rematchGame for reference behavior.
      throw new GameError(
        'Rematch is not yet implemented on the Firebase provider.',
        'Firebase'
      );
    }

    // -- Mutations: player ---------------------------------------
    async submitWord(gameId, text) {
      const clean = U.validateWordText(text);
      // TODO(firebase): use a transaction to enforce duplicates and
      // the per-player cap. For MVP the mock provider is the source
      // of truth for validation tests.
      await this._wordsRef(gameId).add({
        text: clean,
        ownerUid: this._uid,
        ownerPlayerId: this._uid,
        ownerName: '',
        createdAt: U.nowIso(),
        updatedAt: U.nowIso(),
        status: 'active',
      });
    }
    async updateWord(gameId, wordId, text) {
      const clean = U.validateWordText(text);
      await this._wordsRef(gameId).doc(wordId).update({
        text: clean, updatedAt: U.nowIso(),
      });
    }
    async deleteWord(gameId, wordId) {
      await this._wordsRef(gameId).doc(wordId).delete();
    }

    // -- Revision flow (TODO(firebase)) ---------------------------
    // See mock-provider.{requestWordRevision, resubmitRevisedWord}
    // for the reference behavior + audit-event names.
    async requestWordRevision(gameId, wordId, reason) {
      throw new GameError(
        'Revision flow is not yet implemented on the Firebase provider.',
        'Firebase'
      );
    }
    async resubmitRevisedWord(gameId, wordId, newText) {
      throw new GameError(
        'Revision flow is not yet implemented on the Firebase provider.',
        'Firebase'
      );
    }
    async editWordAsHost(gameId, wordId, newText) {
      return this.updateWord(gameId, wordId, newText);
    }

    // -- Round 1 mutations (TODO(firebase)) -----------------------
    async startRound1(gameId, opts) {
      throw new GameError('Round 1 not implemented on the Firebase provider yet.', 'Firebase');
    }
    async startNextTurn(gameId) {
      throw new GameError('Round 1 not implemented on the Firebase provider yet.', 'Firebase');
    }
    async startTurnTimer(gameId) {
      // TODO(firebase): write `status=active`, `turnStartedAt`,
      // `turnEndsAt` on /games/{gameId}/rounds/round1 in a single
      // transaction. Authorize: request.auth.uid must match the
      // round's activeExplainerUid (security rule + client check).
      throw new GameError('Round 1 not implemented on the Firebase provider yet.', 'Firebase');
    }
    async updateRound1Duration(gameId, seconds) {
      // TODO(firebase): admin-only update of the duration field on
      // /games/{gameId}. Gate via the same phase rules as the mock
      // provider (HAT_LOCKED / pre-round-1 only).
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async updateRoundDuration(gameId, roundNumber, seconds) {
      // TODO(firebase): same as updateRound1Duration but writes to
      // roundSettings.round{N}.durationSeconds. Gate via the same
      // phase rules as the mock provider — durations are frozen
      // once the round subdoc exists.
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async startNextRound(gameId) {
      // TODO(firebase): transition ROUND_(N)_FINISHED → ROUND_(N+1)_ACTIVE,
      // seed the new round subdoc from doc.words (re-shuffled). Preserve
      // team.score and team.roundScores. See mock-provider's
      // `startNextRound` for the reference implementation.
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async finishGame(gameId) {
      // TODO(firebase): transition ROUND_3_FINISHED → GAME_FINISHED.
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async markGuessed(gameId) {
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async markWrong(gameId) {
      // TODO(firebase): Round 3 only. End the current turn without
      // changing score and without revealing/removing the active
      // word. See mock-provider's `markWrong` for the contract.
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async endTurn(gameId) {
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async confirmGuessedWord(gameId, wordId) {
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async rejectGuessedWord(gameId, wordId) {
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
    }
    async finishValidation(gameId) {
      throw new GameError('Round play is not yet implemented on the Firebase provider.', 'Firebase');
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
      // TODO(firebase): batch write the snapshot into Firestore. For
      // MVP, recommend importing into a fresh game and discarding the
      // old one.
      throw new GameError('Import is not yet implemented on the Firebase provider.', 'Firebase');
    }
  }

  global.HatGame.FirebaseProvider = FirebaseProvider;
})(window);
