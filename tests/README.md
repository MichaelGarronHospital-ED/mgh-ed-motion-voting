# Behaviour tests for Motion Voting

These drive the **real** pages in `../index.html` and `../admin-9f4k2x7q.html` in
a headless browser, with the Firebase CDN modules swapped for in-memory stubs.
No Firebase project, no credentials, no network, nothing to clean up.

**The tool itself still has no build step and no dependencies.** Everything here
is dev-only and never shipped — GitHub Pages serves the static files regardless
of what lives in this folder.

## Run it

Needs Python 3.11+ and one dependency (Playwright, for the headless browser).

```bash
cd tools/motion-voting/tests
pip install -r requirements.txt
python3 -m playwright install chromium     # ~120 MB, once
python3 -m unittest -v
```

On Linux the browser also needs system libraries:
`sudo python3 -m playwright install-deps chromium`.

## What it asserts

Each group maps to a promise the tool makes to someone in a meeting room.

| Group | Guarantee |
|---|---|
| `TestRosterAndQuorum` | Weights are 1 / ½ / 0, quorum is half the eligible roster, and the pass rule really is *weighted favour > weighted against*. A courtesy member's ballot never moves the result. |
| `TestCastingAVote` | A ballot lands under the right name with the right weight; changing your mind replaces your ballot instead of adding one; re-tapping the same choice is not a new submission; a write-in lands at zero weight for review; a device is bound to one person after voting. |
| `TestResultsAreNeverWrong` | No verdict is ever shown — to a voter, to leadership, or into a CSV — before that motion's ballots have arrived. |
| `TestLeadershipActions` | Only one motion is open at a time; opening one makes it visible to voters; removing a ballot brings the voter count down; closing freezes the weights so a later category change cannot rewrite a past result. |
| `TestVoterReview` | Duplicate signals surface for review: the same name from two devices, and one device used for two names. |

A console error in any test is a failure, even when the assertions pass.

## Why the stubs exist

`../js/db.js` imports Firestore straight from `gstatic.com`. `stubs/` provides
module-compatible stand-ins for the slice it uses, backed by a `Map`. Two
details are deliberate, because both are where bugs hide:

- **The first snapshot is asynchronous**, exactly as real Firestore's is. A page
  therefore renders once with no data before any arrives. That ordering is what
  made a closed motion briefly announce "NO QUORUM".
- **`setDoc(…, {merge:true})` deep-merges nested maps** while `updateDoc`
  replaces each top-level field. The roster overrides in `config/roster` rely on
  the difference.

`window.__store` is a test-only hook on the stub (`dump`, `get`, `set`, `del`,
`stall`, `release`). `stall(prefix)` holds a path's snapshots back so the
"subscribed but no data yet" state can be pinned instead of raced.

Each browser page owns its own store, so leadership and voter state cannot be
driven from two pages at once — tests seed the store directly instead (see the
`seed_*` helpers in `harness.py`).

## Scope — what these do NOT cover

- **`../firestore.rules`.** These tests stub Firestore, so they say nothing
  about the server-side rules. The rules are the real access boundary, and the
  limits they deliberately do *not* enforce are written down at the bottom of
  that file. Testing them needs the Firestore emulator (Java + `firebase-tools`),
  as in [`../../interviews/tests/`](../../interviews/tests/).
- **The passcode gate.** `harness.open_admin` bypasses it through the auth
  watcher, because the plaintext passcode is deliberately not in the repo —
  `js/config.js` holds only its hash.
- **Real-time behaviour between two live browsers.** The stub is per-page.

## Keeping them honest

The roster, quorum and slug helpers in `harness.py` are read out of
`../js/roster.js` at import time, so the tests cannot drift from the roster the
app ships.

If you change a fix these pin, the matching test should fail. That was checked
by reverting each fix and confirming exactly its own test broke — worth redoing
if you refactor `paintResults`, `clearVote`, or `openPoll`.
