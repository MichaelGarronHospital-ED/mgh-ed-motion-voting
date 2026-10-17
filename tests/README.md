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
cd tests
pip install -r requirements.txt
python3 -m playwright install chromium     # ~120 MB, once
python3 -m unittest -v
```

GitHub Actions runs these and the rules tests on every push and pull request
(`../.github/workflows/tests.yml`), with the same commands as above.

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
| `test_voter_board.py` | Phones never read ballots of closed motions and listen to two documents only; a late result is counted once after 30 s of the phone's own time; the console patches the board in each action, never rewrites it by itself, offers "Fix it" when it is out of date, and keeps a closed time on the board; re-vote keeps the original and links both; every phone wait (offline, refused) has a plain message. |
| `test_settings_roster.py` | Settings change only motions opened afterwards (closed results, the open motion and old motions keep their rules); two-thirds and tie rules; invalid values refused on screen; paste preview (new, changed, unchanged, missing, problems), nobody removed unless ticked; write-ins survive a reload, can be added (counting for quorum) or dismissed (0 points). |
| `test_meetings.py` | A motion added with no meeting makes today's; start and end record times and End closes the open motion with its result; mover, seconder and notes stay editable; old motions sit under "Earlier motions"; the meeting export has five sheets from saved results; a trashed meeting is deleted permanently with a record; agenda paste, amendments (two levels), Up and Down with keyboard focus kept; the voter sees "Motion 2a" and the motion it amends. |
| `test_screen.py` | The projector screen reuses an existing sign-in and never signs in over it, asks for the ED password only when signed out, hides the for and against split by default, shows turnout and quorum progress, the saved result after close and never a verdict before it, a timer that says "Time is up" but never closes the vote, and "May be out of date" when offline. |
| `test_choice.py` | Questions and elections: weighted points per pick, two seats, level options inside the winners are not a tie, a tie for the last seat is reported, 0 points never wins, fewer scoring options than seats, more-than-half and run-off, options locked after the first vote, the same picks in another order are not a new submission. |
| `test_attendance.py` | Check-in is offered once per meeting on a phone and never needed to vote; skip and off work; refused and offline check-ins say so; leadership adds and removes (logged); "Remote" shows on the Voters tab; the projector counts check-ins; the phone's receipt equals the console's code from the stored ballot, and "Check my recorded vote" spots a changed ballot. |
| `test_accounts.py` | The two accounts are known by uid, never by email: the uids in `js/config.js` equal the rules' (and every test copy); no page code compares an email; a voter, the projector and the console signed in stay in when the account's email changes and after a reload, with the old or the new email; the right email with another uid gets nothing; the pages still sign in with the emails in `js/config.js`; during the email move each password screen (voter, projector, console) tries the email that last worked, else the old one, and the other once only on a refusal, works when left open across the move and after an undo, says a wrong password once, never tries again when offline, and never accepts another account under either email. |
| `test_versions.py` | Every module import and each page's script and stylesheet carry `?v=` the version in `js/version.js` (same as `version.txt`), and a page loads nothing unversioned; every name the live release's modules import (`previous-imports.json`, from `set_version.py --snapshot`) is still exported. |
| `test_saved_results.py` | Closing saves the result once and it matches the live count; old motions are saved on sign-in exactly as they show (and only after the roster arrives); the write-in quorum check flags only motions whose outcome could differ; re-open needs a reason and keeps the earlier count; closed ballots are locked; every wait (offline, refused, slow) shows a plain message. |

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

The stub keeps two copies, like the real SDK: the server's and the page's local
view (server plus writes not yet confirmed). A `serverTimestamp()` reads as null
until its write commits, and is refused inside an array, as in real Firestore.
Listeners get `metadata.fromCache` and `metadata.hasPendingWrites`; transactions
read from the server and fail at once when offline; batches wait for the
connection. `where`, `orderBy`, `limit`, `startAfter`, `writeBatch`,
`deleteField`, `FieldPath`, `getDocFromServer` and `getDocsFromServer` work.

`window.__store` is a test-only hook on the stub:

| Hook | What it does |
|---|---|
| `dump()`, `get(path)`, `local(path)` | read the server copy (or the page's local view) |
| `set(path, data)`, `del(path)` | write straight to the server, as another device would |
| `stall(prefix)`, `release(prefix)` | hold back snapshots AND one-time reads under a path, to pin the "no data yet" state |
| `order([prefixes])` | deliver first snapshots of those paths in that order |
| `fail(prefix, code, kinds)` | make listeners, reads and writes under a path fail (e.g. `permission-denied`) |
| `offline(true/false)` | cache-only snapshots; server reads and transactions fail; writes wait |
| `reads(prefix)`, `writes(prefix)`, `resetCounts()` | how many documents the page read or wrote |
| `ts(ms)` | a stored server time, for seeding |

`test_stub.py` pins these behaviours. `base.py` holds the shared test base.

Each browser page owns its own store, so leadership and voter state cannot be
driven from two pages at once — tests seed the store directly instead (see the
`seed_*` helpers in `harness.py`).

## Running against the live site

`MV_BASE_URL=https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting` makes the
harness load pages from that address instead of this folder. Firebase is still routed
to the stubs, so nothing real is read or written. `test_smoke.py` is the short set to
run after a deploy:

```bash
MV_BASE_URL=https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting \
  ~/.venvs/mgh-ed-tools/bin/python -m unittest discover -s tests -p "test_smoke.py" -v
```

## Scope — what these do NOT cover

- **`../firestore.rules`.** These tests stub Firestore, so they say nothing
  about the server-side rules. The rules have their own tests in `rules/`, run
  against the Firestore emulator (needs Java): `cd rules && npm install && npm test`.
  The limits the rules deliberately do *not* enforce are written down at the
  bottom of `../firestore.rules`.
- **The real password check.** `harness.open_admin` gets past the Leadership
  password screen through the auth watcher, and the stub accepts any ED password.
  The passwords are not in the repo at all: each is the password of a Firebase
  Auth account, checked by Firebase.
- **The Content-Security-Policy against real Firebase.** The stubs stand in for
  Firebase, so the hosts it really talks to are not exercised here.
- **Real-time behaviour between two live browsers.** The stub is per-page.

## Keeping them honest

The roster, quorum and slug helpers in `harness.py` are read out of
`../js/roster.js` at import time, so the tests cannot drift from the roster the
app ships.

If you change a fix these pin, the matching test should fail. That was checked
by reverting each fix and confirming exactly its own test broke — worth redoing
if you refactor `paintResults`, `clearVote`, or `openPoll`.
