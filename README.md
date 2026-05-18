# The Hat Game

A cozy party word game inspired by **Alias / Hat Game**, designed to
deploy as a **static GitHub Pages site**. Online multiplayer is
optional via Firebase (Auth + Firestore); without it the app runs in
a single-browser mock mode.

This MVP covers:

- Game setup (teams, players, words-per-player)
- Word collection with privacy (players can't see each other's words)
- Hat locking
- **Three rounds of play** with the same locked hat words each time:
  - Round 1 — *Normal Explanation* (60s default, verbal clues allowed)
  - Round 2 — *Charades* (60s default, no speaking)
  - Round 3 — *One-Word Association* (30s default; explainer can press
    **Wrong** to end the turn immediately with no points)
- **Strict "no skip" rules**: only a *Guessed!* button (plus *Wrong* in
  Round 3), public reveal after each guess, then admin validation
  (Confirm / Reject → Return to hat)
- **Per-round + total scoreboards** and a **Final Results** screen
- **Safety rules**: registration lock, session persistence on refresh,
  readiness checklist before start, double-click guards
- Export / import game state JSON
- Optional debug overlay (`?debug=1`) — shows phase, uid, last error,
  and the recent audit-log tail
- Playwright automated test suite (40 specs)

---

## Quick start (local, no setup)

Open `index.html` directly in your browser:

```
open index.html?mode=mock
```

The `?mode=mock` flag forces the single-browser provider, which uses
`localStorage` for state. For multi-player testing, open another
**tab** of the **same browser window** — tabs share `localStorage` so
the mock provider syncs them.

For two phones / two devices, use the Firebase setup below.

---

## Admin login

```
username: admin
password: admin
```

**This login is cosmetic only.** The check happens in the browser;
anyone with devtools can bypass it. Authorization in online mode is
enforced by Firestore security rules (`firestore.rules`), not by this
prompt. Treat the credentials above as a placeholder until you wire up
real authentication.

---

## Deploy to GitHub Pages

1. Commit the repo to GitHub.
2. **Settings → Pages → Source**: deploy from branch (e.g. `main`,
   root `/`).
3. Visit the published URL (something like
   `https://<user>.github.io/<repo>/`).

The app works on Pages with no Firebase — players can play in mock
mode by opening the URL with `?mode=mock`. For real cross-device
play, see Firebase setup below.

---

## Optional: enable Firebase multiplayer

1. Create a Firebase project at <https://console.firebase.google.com>.
2. In **Authentication → Sign-in method**, enable **Anonymous**.
3. In **Firestore → Create database**, start in **production** mode.
4. **Project Settings → General**: register a Web App, copy the
   `firebaseConfig` object.
5. Copy `assets/js/firebase-config.example.js` to
   `assets/js/firebase-config.js` and paste your values into the
   `firebaseConfig` object. (This file is already in `.gitignore`.)
6. **Apply security rules**: paste the contents of `firestore.rules`
   into the Firestore **Rules** tab and publish, or use the CLI:
   ```
   firebase deploy --only firestore:rules
   ```
7. Push to GitHub Pages — the app will detect the config and switch
   to Firebase mode automatically.

If `firebase-config.js` is missing or empty, the app falls back to
mock mode and prints a banner explaining how to enable online mode.

---

## Modes & URL params

- `?mode=mock` — force the mock provider (single-browser, localStorage).
- `?game=ABC123` — deep-link to the player join screen with the code
  pre-filled. The same link is what **Copy invite link** in the admin
  topbar produces.
- `?debug=1` — show the debug overlay (state, uid, last error,
  last action, "Copy debug JSON" button).

Combine freely: `?mode=mock&debug=1&game=ABC123`.

---

## Game phases

```
LOBBY → TEAMS_SETUP → WORD_COLLECTION → WORD_REVIEW → HAT_LOCKED
      → ROUND_1_READY → ROUND_1_ACTIVE ↔ ROUND_1_TURN_VALIDATION → ROUND_1_FINISHED
      → ROUND_2_READY → ROUND_2_ACTIVE ↔ ROUND_2_TURN_VALIDATION → ROUND_2_FINISHED
      → ROUND_3_READY → ROUND_3_ACTIVE ↔ ROUND_3_TURN_VALIDATION → ROUND_3_FINISHED
      → GAME_FINISHED
```

**WORD_REVIEW.** Before locking the hat, the host runs a review pass:
every submitted word is shown with its owner, the host can edit text
inline, **Remove** inappropriate / out-of-scope words, and **Approve**
each one (or all at once). Only words with status=`approved` end up in
`originalLockedWordIds`. Duplicate words (case-insensitive, whitespace-
normalized comparison) surface a `Duplicate word` warning. The host
can press **Reopen word collection** to send players back to the
submission step. Players cannot edit during review and see the message
"The host is reviewing submitted words."

Between rounds the admin presses **Start Round 2** / **Start Round 3**,
which re-seeds the deck from the original locked words (shuffled) and
queues the first turn. After Round 3 finishes the admin presses
**Finish game** to reach `GAME_FINISHED` and reveal the final results.

### Common round rules (strict no-skip)

These apply to all three rounds:

- The active explainer sees exactly one hidden word.
- The team must guess it.
- **No Skip, no Violation, no Next Word** — the explainer can only
  advance via the round's allowed action button.
- Clicking **Guessed!**:
  - Reveals the word publicly to everyone (so the team can validate
    the call out loud).
  - Tentatively adds +1 to the active team's total + this round's
    subtotal.
  - Moves the hidden word out of the round's deck.
  - Immediately shows the next hidden word to the explainer.
- If the timer expires with a word still active and unguessed, the
  word stays hidden in the deck for a future turn.
- After the turn, the admin sees a **Validate guessed words** panel
  with each guessed word and Confirm / Reject controls:
  - **Confirm** keeps the point.
  - **Reject** subtracts the tentative +1 and returns the word to the
    deck for the **current** round only (other rounds are unaffected).
- The admin cannot start the next turn while any word is pending
  validation.
- A round finishes only when every word is confirmed guessed (the
  deck is empty and nothing is pending).

### Round-specific rules

| Round | Name | Default timer | Buttons |
| --- | --- | --- | --- |
| 1 | Normal Explanation | 60s | Guessed |
| 2 | Charades (no speaking) | 60s | Guessed |
| 3 | One-Word Association | 30s | Guessed + **Wrong** |

#### Round 3 — Wrong

Pressing **Wrong** during an active Round 3 turn:

- Ends the turn immediately.
- Does **not** reveal the active word publicly.
- Does **not** change any team's score.
- Keeps the active word in the Round 3 deck for the next explainer.
- Still routes through validation if any earlier guesses in the same
  turn are pending admin confirmation.

The Wrong button is only available in Round 3 — Rounds 1 and 2 do
not render it.

### Same words, all rounds

All three rounds replay the same hat. At the start of each round, the
deck is reset to the full set of original locked words and re-shuffled.
Per-round subtotals are tracked on each team alongside the running
total (see `team.roundScores`).

The immutable pool lives on the game doc as `originalLockedWordIds`,
captured once at `lockHat()`. Each round seeds its own
`remainingWordIds` from this list:

```
originalLockedWordIds     // set at lockHat, never mutated
round1.remainingWordIds   // = originalLockedWordIds − confirmed in R1
round2.remainingWordIds   // = originalLockedWordIds − confirmed in R2
round3.remainingWordIds   // = originalLockedWordIds − confirmed in R3
```

Confirmed guesses shrink that round's deck only. Rejected guesses
return to the same round's deck. Round 1's confirms never affect
Round 2 or Round 3.

### Role boundaries

The UI enforces strict privacy across four roles. Word texts are
emitted by the provider only to the role allowed to see them — the
client cannot render text it never received.

| Surface                  | Host | Active explainer | Teammate | Other player |
|--------------------------|:----:|:----------------:|:--------:|:------------:|
| Active word text         |  ⚪  |        ✅        |    ❌    |      ❌      |
| Hat Contents (remaining) |  ✅  |        ❌        |    ❌    |      ❌      |
| Validation panel words   |  ✅  |        ❌        |    ❌    |      ❌      |
| Round / team / explainer |  ✅  |        ✅        |    ✅    |      ✅      |
| Timer / status / scores  |  ✅  |        ✅        |    ✅    |      ✅      |

⚪ = the host sees the active word indirectly (as one chip among
many in Hat Contents) but never on a "now playing" surface; they
only see it singled out via the validation panel once the explainer
presses **Guessed**.

Action gates (mirror of the visibility rules):

- **Host/Admin** — create game, configure, lock hat, start rounds,
  confirm / reject guessed words, finish validation, start next
  turn, start next round.
- **Active explainer** — start their own turn timer, mark **Guessed**,
  click **Wrong** (Round 3 only).
- **Everyone else** — read-only.

Unauthorized mutations throw a `GameError` and log a
`[HatGame][Permission]` warning to the browser console.

### Host Hat Contents

The host-only **Hat Contents** card shows the remaining-deck view for
the current round:

```
Hat Contents
  Remaining words in the current round.
  Round 2 — Charades
  Remaining words: 6 / 10
  [river] [apple] [moon] [tundra] [paradox] [xylophone]
```

- The chip list is `currentRound.remainingWordIds` resolved to word
  objects (see `provider.listenToHostHatContents`).
- The count line format is load-bearing — `round-reset.spec.js`
  parses `"Remaining words: K / N"`.
- Between rounds (and after the hat is locked but before Round 1
  starts) the card shows the full original locked hat.
- When the explainer presses **Guessed**, the word is temporarily
  removed from Hat Contents and moved to the **validation panel**.
  Confirm leaves it removed; reject returns it.

Hat Contents and the Validation Panel are distinct surfaces:
**Hat Contents = remaining words**, **Validation Panel = guessed
words awaiting confirm/reject**.

### Word visibility before Start

During WAITING_TO_START — the moment after the host queues a turn but
before the explainer presses **Start** — the active word is not
selected on the doc at all. The explainer sees a pre-start screen:

> *Press Start to reveal your first word.*

Pressing **Start** atomically (a) selects a random word from the
current round's `remainingWordIds` (filtering out anything already
pending/confirmed for the round), (b) sets `turnStartedAt` /
`turnEndsAt`, and (c) flips the round status to ACTIVE. There is no
window in which the word exists in state without the timer running.

### Random word selection

`selectRandomActiveWord(round, currentTurn)` picks each new active
word with `Math.random()` from the eligible set (`remainingWordIds`
minus pending, confirmed, and this-turn-guessed). Deck order is no
longer predictable from a host who can see Hat Contents.

For deterministic tests, set `window.HatGame._randomFn` to a function
that returns a specific value (e.g. `() => 0.999` to always pick the
last eligible word).

### Mobile explainer screen

The explainer view (`#round1-explainer-view`) carries the
`mobile-explainer-screen` testid and the responsive CSS engages at
`max-width: 700px`. Key adjustments:

- Active word: `font-size: clamp(2rem, 10vw, 4rem)` for legibility at
  arm's length.
- Timer: `font-size: clamp(2rem, 8vw, 3.5rem)`.
- Action buttons (Start / Guessed / Wrong): `min-height: 64px`,
  full width, stacked vertically. The Guessed/Wrong block becomes
  `position: sticky; bottom: 0` so it stays in thumb reach as the
  player scrolls.
- Hidden during a turn: nothing extra is hidden — the player UI is
  already focused, but the round info row tightens its font to keep
  the active word + buttons above the fold.

### Final results

When `GAME_FINISHED` is reached, both the admin and every player see a
**Final results** card with every team's total score and per-round
breakdown, sorted highest first. Ties are surfaced explicitly
("It's a tie between …").

### Configuring round durations

From the admin dashboard the host can change each round's timer
duration before that round begins:

- Round 1: 10–300 seconds (default 60)
- Round 2: 10–300 seconds (default 60)
- Round 3: 10–300 seconds (default 30)

Once a round has been started, its duration is frozen and the input
is disabled. Empty or invalid values fall back to the round's default.

---

## Safety rules

These rules are enforced both client-side (in the provider, so the mock
provider used by tests behaves the same) and — where possible — by
`firestore.rules` for the Firebase provider.

### Registration lock

- The host clicks **Start word collection** → `registrationLocked = true`.
- After that point, **no new player can join** with a fresh nickname.
  Trying to do so surfaces:
  *"Game has already started. New players cannot join now."*
- Existing players (matched by their anonymous Firebase uid /
  sessionStorage uid in mock mode) can still reconnect after a refresh.

### Minimum start requirements

The host can't start word collection until the readiness checklist
is all green:

- ✓ At least **2 teams**
- ✓ Each team has at least **2 players**
- ✓ Every player is assigned to a team
- ✓ Words per player is set (≥ 1)

The **Start word collection** button stays disabled until all four
items pass.

### No team changes after registration lock

Once collection starts:

- Admin cannot create / delete / rename teams or move players between
  teams.
- Players cannot change their nickname.

The team-assign dropdowns disappear from the admin UI in this state,
and a lock warning is shown.

### Double-click safety

Every "phase-advancing" button (Create game, Join, Start word
collection, Lock hat, Start Round 1, Start turn, Guessed!, End turn,
Confirm / Reject, Finish validation, Submit word) disables itself
while the click's async write is in flight. This prevents a fast
double-click from producing a stale-phase error toast.

The Playwright suite has a dedicated test for this
(`safety-rules.spec.js` → "J. double-click on Start does not double-fire").

## Session persistence

### Helpers

The session storage layer lives in `utils.js` and is exposed via
`HatGame.Utils.*`:

| Helper | Purpose |
| --- | --- |
| `savePlayerSession({ gameCode, gameId, playerId, uid, nickname })` | Write a player session record |
| `loadPlayerSession()` | Read it back (or `null`) |
| `clearPlayerSession()` | Delete it |
| `saveAdminSession({ gameId, gameCode })` | Write an admin session record |
| `loadAdminSession()` | Read it back (or `null`) |
| `clearAdminSession()` | Delete it |
| `getCurrentRole()` | `'player'` / `'admin'` / `null` |
| `setLastRestoreError(msg)` / `getLastRestoreError()` | Surface restore failures in the debug overlay |
| `classifyPresence(lastSeenAtIso)` | Returns `'online'` / `'recent'` / `'offline'` based on the player's last heartbeat |

Sessions are stored in `sessionStorage` (per-tab) so multi-tab
testing (Playwright) and multi-tab demo (one browser, multiple
identities) both work — see the comment block in `utils.js`.

### Player

- On first join, the player's anonymous uid is stored in
  `sessionStorage` (Firebase Auth handles this in online mode; mock
  mode uses a manually managed key).
- A session record (`{ gameCode, gameId, playerId, uid, nickname,
  joinedAt }`) is also written.
- A **heartbeat** runs every 25 seconds while the player is mounted,
  updating their `lastSeenAt` on the game doc. The admin's player
  list shows an **Online / Recently active / Offline** badge based
  on that timestamp (45 s / 2 min / >2 min thresholds).
- On refresh, the app looks up the player slot by uid in the joined
  game. If found, it re-mounts the player view silently — **no second
  nickname prompt**.
- If the player's slot no longer exists (e.g. admin reset the game),
  the stashed session is cleared, a toast says *"Your previous
  session could not be restored. Please join again."*, and the
  landing screen is shown.

### Admin

- A successful admin login + game creation stashes the admin
  session in `sessionStorage`.
- On refresh, the admin lands directly on the dashboard for the same
  game. No second game is created accidentally.
- If the previously active game is gone (storage cleared, code
  collision after reset, etc.), the admin sees *"Your previous game
  is no longer available."* and lands on the landing screen.
- **Logout** wipes both the admin auth flag and the active-game pointer.

### Final results actions

When the game reaches `GAME_FINISHED`, the admin has three controls
on the final-results card:

- **New game** — confirms, then resets the current game (same code,
  fresh state).
- **Export final results JSON** — downloads a structured file with
  per-team standings, ranks (ties surfaced), and the winner.
- **Leave game** — logs the admin out and returns to the landing
  screen. Players have an equivalent leave button on their side.

### Reconnect routing

After a refresh, both roles route to the correct screen based on
the game's current phase. For players:

- LOBBY / TEAMS_SETUP: waiting room
- WORD_COLLECTION: private word entry
- HAT_LOCKED / ROUND_X_READY: waiting screen
- ROUND_X_ACTIVE: explainer view (active word) or watcher view
- ROUND_X_TURN_VALIDATION: "the host is validating words" + public
  guessed list
- ROUND_X_FINISHED: between-round message
- GAME_FINISHED: final results screen

For admins the dashboard is always rendered and the right panel
(setup / collection / round / validation / final results) is
displayed automatically based on phase.

### Resetting your local session during testing

If you want to start from a clean slate (e.g. re-test the join flow):

- Use the browser devtools: **Application → Storage → Clear site data**.
- Or in console: `sessionStorage.clear(); localStorage.clear(); location.reload();`
- The debug overlay (`?debug=1`) surfaces session role / playerId /
  gameCode / uid / `session.restored` true|false / `session.lastErr`,
  which makes it easy to verify state.

## Privacy guarantees

- **Other players never see your words.** The `listenToOwnWords`
  filter in both the mock and Firebase providers restricts results
  to `ownerUid == currentUid`.
- **The admin never sees word texts during WORD_COLLECTION.** The
  admin's only word listener (`listenToHat`) returns an empty list
  until the hat is locked.
- **Non-explainers never see the active hidden word.** The
  `listenToRound1` callback strips `activeWordId` / `activeWordText`
  for anyone who isn't the active explainer.
- **Server-side enforcement (online mode):** `firestore.rules` adds a
  second layer — see that file for the deployable rules.

---

## Run the automated tests

The tests use Playwright in mock mode, so they don't need Firebase
or network access.

```sh
npm install
npx playwright install --with-deps  # one-time browser install
npm test                            # all specs, headless
npm run test:headed                 # see the browser
npm run test:debug                  # step through interactively
```

`npm run serve` boots a local static server at <http://localhost:8080>
in case you want to QA manually instead.

### What the suite covers

| File | Scenarios |
| --- | --- |
| `tests/admin-flow.spec.js` | login, create game, set wpp, add teams, admin progress hides word text |
| `tests/player-flow.spec.js` | deep-link join, real-time visibility on admin, full word submission cycle |
| `tests/privacy.spec.js` | two players never see each other's words; admin sees hat only after lock |
| `tests/validation.spec.js` | empty/duplicate/over-cap word, lock-only-when-complete, frozen after lock, **full Round 1 turn + admin validation flow** |
| `tests/validation-state-consistency.spec.js` | pending validation invariant: mixed confirm+reject, re-guess after reject, stale-id auto-repair, deck invariants |
| `tests/safety-rules.spec.js` | registration lock, duplicate nicknames, single identity per browser, double-click guards |
| `tests/start-requirements.spec.js` | min-teams / min-players-per-team / all-assigned readiness gating |
| `tests/round-timer.spec.js` | timer doesn't auto-start, only explainer can start, countdown ticks on every client, auto-end on expiration, custom duration |
| `tests/three-rounds.spec.js` | per-round timer defaults + customization, deck reuse across rounds, Wrong button gating (R3 only), Wrong ends turn with no score, final game finish |
| `tests/final-results.spec.js` | winner shown, tie game surfaced, New Game resets state |
| `tests/reconnect-routing.spec.js` | registration-locked reconnect, mid-turn refresh keeps explainer state, validation reconnect, stale-session detection, session helper API |
| `tests/session-persistence.spec.js` | player + admin refresh round-trip |

**Known limitations:**
- The mock provider only syncs across pages in the same Playwright
  **context**, so all multi-player tests use a single context with
  multiple pages.
- The Firebase provider implements setup / word collection / lock and
  most listeners, but **Round 1 mutations and a few admin-only writes
  are marked `// TODO(firebase)`** and throw clear `GameError`s in
  the meantime. The mock provider is the reference implementation for
  Round 1 behavior; once you exercise it against a real Firestore
  project, port the same logic into `firebase-provider.js`.
- **No real-time heartbeat** — `lastSeenAt` is updated on (re)join only.
  Admin's "Online / Recently / Offline" badge is out of scope for MVP.
- **Audit log is recorded but only surfaced in the debug overlay**
  (`?debug=1`). A user-visible event history is a future enhancement.
- The **admin password is a dev-only cosmetic gate** — anyone can flip
  the `sessionStorage` flag in devtools. Treat it as UX scaffolding,
  not security.
- **Firestore rules**: the `players.create` rule blocks new joiners
  after `registrationLocked` is true, but doesn't yet enforce
  duplicate nicknames or readiness — those checks live in the client
  and provider. Hardening is in `TODO(firestore)` comments.

---

## Debug overlay

Append `?debug=1` to any URL. A floating panel in the bottom-right
shows the current role / provider / phase / uid / counts / last
action / last error. The **Copy debug JSON** button puts the panel's
data on your clipboard for filing bug reports.

---

## Export / import state

In the admin topbar, **Export JSON** downloads a complete snapshot of
the game (players, teams, words, round 1 state). **Import JSON** lets
you replace the current game with a prior snapshot — handy for
reproducing bugs from a tester's session.

In mock mode this works fully. In Firebase mode, export works; import
is currently a stub and throws a "not implemented" error.

---

## Project structure

```
alias-hat-game/
  index.html                       # all screens in one document
  firestore.rules                  # proposed Firestore security rules
  README.md
  QA_CHECKLIST.md                  # manual test scenarios
  package.json                     # dev-only: Playwright + http-server
  playwright.config.js
  .gitignore
  tests/
    helpers.js
    admin-flow.spec.js
    player-flow.spec.js
    privacy.spec.js
    validation.spec.js              # includes the full Round 1 scenario
  assets/
    css/style.css
    js/
      utils.js                     # constants, validators, toast, routing
      firebase-config.example.js   # template
      data-provider.js             # provider factory (firebase vs mock)
      mock-provider.js             # localStorage-backed provider + Round 1
      firebase-provider.js         # Firebase implementation (stub for Round 1)
      ui.js                        # idempotent renderers
      admin.js                     # admin controller
      player.js                    # player controller
      debug-panel.js               # ?debug=1 overlay
      app.js                       # boot + screen routing
```

---

## What's intentionally left for the next milestone

- Undo of admin actions (Confirm/Reject can be re-validated, but a
  proper Undo history is not implemented yet).
- Full Firebase parity for Round 1/2/3 mutations (the mock provider is
  the reference; Firebase methods throw a clear "not implemented"
  error until ported).
- Hardening of `firestore.rules` — the MVP rules are documented but
  should be exercised in the Firebase emulator before production use.

---

## Production / security caveats

- `admin / admin` is **not** secure. Replace before any meaningful
  deployment.
- Firebase API keys are not secret on their own, but **the database
  is only as safe as `firestore.rules`** — review them carefully.
- The mock provider holds everything in `localStorage`. Wiping
  browser storage wipes the game.
