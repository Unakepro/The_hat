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
### Configuring round durations

From the admin dashboard the host can change each round's timer
duration before that round begins:

- Round 1: 10–300 seconds (default 60)
- Round 2: 10–300 seconds (default 60)
- Round 3: 10–300 seconds (default 30)

Once a round has been started, its duration is frozen and the input
is disabled. Empty or invalid values fall back to the round's default.

---

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
