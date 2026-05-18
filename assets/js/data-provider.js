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
   *   1. ?mode=mock or ?mode=local forces the mock provider (used by
   *      tests and the local single-browser demo).
   *   2. If Firebase config and the firebase SDK are both present,
   *      use the Firebase provider.
   *   3. On localhost/127.0.0.1 with no Firebase config, fall back to
   *      the mock provider but emit a visible console warning so the
   *      developer knows online mode is unavailable.
   *   4. Anywhere else (e.g. GitHub Pages without a real
   *      `firebase-config.js`), refuse to create a provider. The app
   *      shows a blocking message instead of silently turning into a
   *      single-browser localStorage demo that LOOKS like multiplayer.
   */
  function isLocalHostName() {
    const h = (global.location && global.location.hostname) || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '';
  }
  function hasValidFirebaseSdk() {
    return typeof global.firebase !== 'undefined' &&
      typeof global.firebase.initializeApp === 'function';
  }
  function hasValidFirebaseConfig() {
    const c = HG.firebaseConfig;
    return !!(c && typeof c === 'object' &&
      c.apiKey && c.apiKey !== 'YOUR_API_KEY');
  }

  // Surface a blocking banner so users on GitHub Pages can't be
  // tricked by an apparently-working local game. The banner is shown
  // once at boot and stays in the DOM.
  function showMissingConfigBanner(reason) {
    try {
      if (document.getElementById('firebase-missing-banner')) return;
      const banner = document.createElement('div');
      banner.id = 'firebase-missing-banner';
      banner.setAttribute('data-testid', 'firebase-missing-banner');
      banner.className = 'firebase-missing-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:#7a1c1c;color:#fff;padding:14px 16px;font-family:sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      banner.innerHTML =
        '<strong>Firebase is not configured.</strong> Online multiplayer is unavailable. ' +
        'Add a valid <code>firebase-config.js</code> to enable Host/Join, or open the app ' +
        'with <code>?mode=mock</code> for the single-browser demo.';
      if (document.body) document.body.appendChild(banner);
      else document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(banner);
      });
      // Disable the landing-page Host/Join buttons so the user can't
      // accidentally start a local-only "game".
      const disable = (id) => {
        const el = document.getElementById(id);
        if (el) { el.disabled = true; el.title = reason; }
      };
      ['landing-host-button', 'landing-join-button'].forEach(disable);
    } catch (e) { /* logging only */ }
  }

  function pickProvider() {
    const q = HG.Utils.getQuery();
    if (q.mode === 'mock' || q.mode === 'local') {
      Log.state('provider: mock (forced by ?mode=' + q.mode + ')');
      return new HG.MockProvider();
    }
    const hasSdk = hasValidFirebaseSdk();
    const hasConfig = hasValidFirebaseConfig();
    if (hasSdk && hasConfig) {
      Log.state('provider: firebase');
      return new HG.FirebaseProvider(HG.firebaseConfig);
    }
    if (isLocalHostName()) {
      Log.state(
        'provider: mock (local dev fallback — firebase ' +
        (hasSdk ? '' : 'sdk-missing ') +
        (hasConfig ? '' : 'no-config') + ')'
      );
      try {
        console.warn(
          '[HatGame] Falling back to MockProvider on localhost. ' +
          'Add a valid firebase-config.js to test the production wiring.'
        );
      } catch (e) { /* logging only */ }
      return new HG.MockProvider();
    }
    // Production / GitHub Pages without a valid config. Show the
    // banner, disable Host/Join, and surface a guard provider that
    // throws on every method so any accidental code path produces a
    // clear English error rather than localStorage data.
    const reason = 'Firebase is not configured. Online multiplayer is unavailable.';
    Log.state('provider: blocked (' + reason + ')');
    showMissingConfigBanner(reason);
    return new UnavailableProvider(reason);
  }

  // Last-resort provider used when Firebase is required but not
  // configured. Every contract method throws the same English error
  // so calling code reports the real reason rather than crashing.
  class UnavailableProvider {
    constructor(reason) {
      this.name = 'unavailable';
      this._reason = reason;
      this._uid = null;
    }
    get currentUid() { return null; }
    _block() {
      throw new HG.Utils.GameError(this._reason, 'Provider');
    }
  }
  // Stamp the contract methods onto the prototype so any call throws
  // immediately. Listener methods return a no-op unsubscribe so
  // accidental subscribe calls don't crash before the user sees the
  // banner.
  [
    'init', 'signInAnonymous',
    'createGame', 'joinGame', 'resumeIfAdmin', 'findMyPlayer',
    'touchPlayerPresence',
    'updateGameSettings', 'createTeam', 'deleteTeam', 'renameTeam',
    'randomizeTeams', 'assignPlayerToTeam', 'removePlayer',
    'startWordCollection', 'startWordReview', 'reopenWordCollection',
    'approveWord', 'approveAllWords', 'hostRemoveWord', 'hostEditWord',
    'requestWordRevision', 'resubmitRevisedWord', 'editWordAsHost',
    'submitWord', 'updateWord', 'deleteWord',
    'lockHat', 'startRound1Placeholder', 'startRound1', 'startNextRound',
    'startNextTurn', 'startTurnTimer', 'markGuessed', 'markWrong',
    'endTurn', 'confirmGuessedWord', 'rejectGuessedWord',
    'finishValidation', 'updateRoundDuration', 'updateRound1Duration',
    'finishGame', 'rematchGame', 'resetGame',
    'archiveGame', 'markGameAbandoned', 'deleteGameCompletely', 'fullNewGame',
    'exportState', 'importState', 'exportFinalResults',
  ].forEach(name => {
    UnavailableProvider.prototype[name] = function () { this._block(); };
  });
  [
    'listenToGame', 'listenToPlayers', 'listenToTeams',
    'listenToOwnWords', 'listenToHat', 'listenToRound1',
    'listenToCurrentRound', 'listenToHostHatContents',
    'listenToPublicGuessedWords',
  ].forEach(name => {
    UnavailableProvider.prototype[name] = function (gameId, cb) {
      try { cb && cb(null); } catch (e) { /* ignore */ }
      return function noopUnsub() {};
    };
  });

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
