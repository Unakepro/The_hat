/* eslint-disable */
/**
 * Firebase configuration template.
 *
 * HOW TO USE:
 *   1. Create a Firebase project at https://console.firebase.google.com/
 *   2. In Project Settings → General, register a Web App and copy its
 *      config object.
 *   3. Copy this file to `assets/js/firebase-config.js` and replace the
 *      placeholder values below.
 *   4. Add `firebase-config.js` to `.gitignore` so your keys never get
 *      pushed (they already are — see .gitignore at repo root).
 *
 * If `firebase-config.js` is missing or `firebaseConfig` is null, the
 * app falls back to mock/local mode automatically. This means anyone
 * who clones the repo can still test the UI on GitHub Pages without
 * setting up Firebase first.
 *
 * Note: Firebase web API keys are *not* secret on their own — security
 * is enforced by Firestore rules (see firestore.rules at the repo root).
 * Still, keep this file out of version control as a hygiene practice.
 */
(function (global) {
  'use strict';
  global.HatGame = global.HatGame || {};
  // Set to null to disable Firebase mode entirely.
  global.HatGame.firebaseConfig = {
    apiKey: 'YOUR_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT.appspot.com',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
  };
  // OPTIONAL: per-deployment admin password.
  //
  // Set this to the SHA-256 hex digest of the password you want to
  // require on the "Host a game" sign-in screen. When set, the
  // hardcoded admin/admin dev fallback is rejected and only the
  // matching password passes the local gate. When unset, the local
  // gate is skipped entirely in Firebase mode — admin authority comes
  // exclusively from the Firestore `adminUid` field on the game doc
  // (the host who creates the game is that game's admin).
  //
  // Generate a hash with:
  //   echo -n "YourPasswordHere" | shasum -a 256
  // and paste the hex digest below.
  global.HatGame.adminPasswordHash = null;
  // Until the user fills in the values above, treat as missing so that
  // the bundled example file doesn't accidentally try to hit Firebase.
  if (global.HatGame.firebaseConfig.apiKey === 'YOUR_API_KEY') {
    global.HatGame.firebaseConfig = null;
  }
})(window);
