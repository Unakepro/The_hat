/* eslint-disable */
/**
 * DataProvider interface + factory.
 *
 * The rest of the app talks to a `provider` that exposes a uniform
 * API. In production we wire up `FirebaseProvider`; in tests, local
 * demo, or whenever Firebase isn't configured, we wire up
 * `MockProvider` (localStorage + cross-tab `storage` events).
 *
 * Either way the contract is identical, which is what makes the
 * Playwright suite useful: it tests real UI flows against a real
 * provider, just without the network.
 *
 *   Contract (all methods async unless noted):
 *
 *     init()                                  -> void
 *     signInAnonymous()                       -> { uid }
 *     createGame({ wordsPerPlayer })          -> { gameId, gameCode }
 *     joinGame({ gameCode, nickname })        -> { gameId, gameCode, playerId }
 *     resumeIfAdmin(gameCode)                 -> boolean   (am I its admin?)
 *
 *     listenToGame(gameId, cb)                -> unsubscribe
 *     listenToPlayers(gameId, cb)             -> unsubscribe
 *     listenToTeams(gameId, cb)               -> unsubscribe
 *     listenToOwnWords(gameId, ownerUid, cb)  -> unsubscribe
 *     listenToHat(gameId, cb)                 -> unsubscribe
 *          // Hat listener: ONLY emits texts after HAT_LOCKED.
 *          // Before that, callback gets [] (privacy).
 *
 *     updateGameSettings(gameId, { wordsPerPlayer })
 *     createTeam(gameId, name)
 *     deleteTeam(gameId, teamId)
 *     assignPlayerToTeam(gameId, playerId, teamId)
 *     startWordCollection(gameId)
 *     submitWord(gameId, text)
 *     updateWord(gameId, wordId, text)
 *     deleteWord(gameId, wordId)
 *     lockHat(gameId)
 *     startRound1Placeholder(gameId)
 *     resetGame(gameId)
 *
 *     exportState(gameId)                     -> JSON snapshot
 *     importState(gameId, snapshot)           -> void
 *
 *     name                                    -> 'firebase' | 'mock'
 *     currentUid                              -> string
 */
(function (global) {
  'use strict';

  const HG = global.HatGame;
  const Log = HG.Utils.Log;

  /**
   * Choose which provider to instantiate.
   *
   * Order of preference:
   *   1. ?mode=mock in the URL forces the mock provider (used by tests
   *      and the local demo).
   *   2. If Firebase config and the firebase SDK are both present,
   *      use the Firebase provider.
   *   3. Otherwise fall back to the mock provider with a console
   *      hint so the developer knows online mode is unavailable.
   */
  function pickProvider() {
    const q = HG.Utils.getQuery();
    if (q.mode === 'mock' || q.mode === 'local') {
      Log.state('provider: mock (forced by ?mode=' + q.mode + ')');
      return new HG.MockProvider();
    }
    const hasFirebaseSdk = typeof global.firebase !== 'undefined' &&
      typeof global.firebase.initializeApp === 'function';
    const hasConfig = HG.firebaseConfig &&
      typeof HG.firebaseConfig === 'object' &&
      HG.firebaseConfig.apiKey &&
      HG.firebaseConfig.apiKey !== 'YOUR_API_KEY';
    if (hasFirebaseSdk && hasConfig) {
      Log.state('provider: firebase');
      return new HG.FirebaseProvider(HG.firebaseConfig);
    }
    Log.state(
      'provider: mock (firebase ' +
      (hasFirebaseSdk ? '' : 'sdk-missing ') +
      (hasConfig ? '' : 'no-config') + ')'
    );
    return new HG.MockProvider();
  }

  // Singleton — the rest of the app reads this. We set it lazily on
  // first call so module load order doesn't matter.
  let _instance = null;
  function getProvider() {
    if (!_instance) _instance = pickProvider();
    return _instance;
  }

  global.HatGame.getProvider = getProvider;
  // For tests / debug — lets us reset the singleton between sessions.
  global.HatGame._resetProvider = function () { _instance = null; };
})(window);
