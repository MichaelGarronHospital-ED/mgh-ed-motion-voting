# Motion Voting

Live, mobile-friendly **weighted voting** for meeting motions. Static frontend +
Firebase Firestore for real-time vote storage. See `README.md` for full setup.

## This repo

- **Lives in the `MichaelGarronHospital-ED` org as `mgh-ed-motion-voting`**, served by GitHub
  Pages from `main` (root folder, no build step) at
  `https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting/`. The repo name is part of
  every shared link and QR code: renaming it breaks them all, because GitHub
  does not redirect Pages sites.
- **Split out of the old `DrAlvinYang/ED-motion-voting` repo in Oct 2026.**
  That repo now holds only redirect pages pointing here. Its history was
  filtered to this tool, so paths in old commits and in `CHANGES.md` may still
  say `tools/...`; that is history, not a bug.
- **Firebase project id `ed-motion-voting-99b96` is immutable.** It does not track the repo name;
  don't "fix" it to match.
- **Relative paths only.** Nothing in the code should hardcode the repo name.
- **Org rules:** public repo (free-plan Pages), GitHub-authored Actions only,
  feature branches merge to `main`, merged branches auto-delete.

## Commands, deploy and accounts

- **Local folder:** `MGH-ED-Tools/motion-voting` (short name; the repo name stays
  `mgh-ed-motion-voting`). `../README.md` maps every ED tool.
- **Run locally:** `python3 -m http.server 8000`, then open http://localhost:8000
  (it talks to the live Firebase project, so don't open or close real motions).
- **Tests:** `cd tests && python3 -m unittest -v` (needs Playwright; see `tests/README.md`).
  On Alvin's Mac the test tools live outside iCloud in `~/.venvs/mgh-ed-tools`:
  `~/.venvs/mgh-ed-tools/bin/python -m unittest discover -s tests -v`.
- **Database rules tests:** `cd tests/rules && npm install && npm test` (Firestore emulator;
  needs Java). 12 tests: only ed@ and leadership@ get in, voters vote only while a motion
  is open and add exactly one to its count, only leadership manages. Run after any change
  to `firestore.rules`.
- **Deploy the site:** push to `main`; GitHub Pages is live about a minute later.
- **Accounts:** repo owned by the `MichaelGarronHospital-ED` org (department login
  `MGH-ED-Admin`). Firebase project `ed-motion-voting-99b96` is owned by the Google
  account on MGHEmergencyDepartmentAdministration@tehn.ca (second Owner: dralvinyang@gmail.com,
  until another ED person is added). Free Spark plan. Publish rules with
  `npx firebase-tools deploy --only firestore:rules` (department login); live rules matched
  the repo on 2026-10-14. No other services or keys.

## Files

- `index.html` → voter view (loads `js/vote.js`).
- `admin-9f4k2x7q.html` → leadership view (loads `js/admin.js`). Leadership-password-gated (Firebase sign-in) +
  unguessable filename; keep the filename obscure if it's ever rotated.
- `js/config.js` → Firebase config, `LEADER_EMAIL` + `ED_EMAIL` (the two shared accounts;
  the passwords live only in Firebase Auth), `ORG_NAME`.
- `js/roster.js` → the roster and GROUP1 / GROUP2 / COURTESY weight assignments.
- `js/db.js` → Firestore + Auth wiring, tally/quorum logic.
- `js/vote.js` / `js/admin.js` → the two UIs. `js/util.js` → shared helpers.
- `js/xlsx.js` → dependency-free .xlsx writer behind the console's Export menu
  (identical copy in the hiring tool; keep the two the same).
- `firestore.rules` (locked-down, auth-gated) / `firestore.rules.open` (rollback).
- `tests/` → headless behaviour tests (dev-only, never shipped). See its README.
- `CHANGES.md` → what changed and why, newest first.

## Rules of the road

- **Weights:** GROUP1 = 1 pt, GROUP2 = ½ pt, COURTESY = 0. A motion passes when
  weighted *In favour* > weighted *Against*; abstentions count toward quorum only.
  Quorum = 50% of eligible voters, computed automatically.
- **All asset paths are relative** — never hardcode `/mgh-ed-motion-voting/`, so
  the app keeps working wherever it's served.
- **Firestore rules are the source of truth for access.** If you change data
  shape in `db.js`, re-check `firestore.rules`. Rollback path is
  `firestore.rules.open`.
- Duplicate votes are **flagged, not blocked** (a genuine vote change must still
  work); write-ins land at 0 weight with a *NEW* tag until leadership assigns one.
  The rules *cannot* enforce one-ballot-per-person — voters are anonymous, so any
  voter can write any name's ballot. That is the accepted trade-off; the limits
  are spelled out under **HONEST LIMITS** at the bottom of `firestore.rules`.
- **Never show a verdict before that motion's ballots have arrived.** An empty
  tally scores as "NO QUORUM", so painting it early announces a wrong outcome on
  a shared screen. Both results views and the CSV export gate on a `loaded` flag
  fed by the first snapshot; `tests/` pins this.
- **Leadership and voters must agree on what is open.** Voters only see motions
  that are neither archived nor deleted, so leadership's live-motion filter uses
  the *same* predicate and `openPoll` unarchives what it opens. A motion that is
  `open` but `archived` is invisible to voters — don't reintroduce that state.
- **`voteCount` is the distinct-voter counter**, not a ballot log: it drives the
  edit lock and the purge confirmation, so anything that removes a ballot must
  bring it down too (`clearVote` does this transactionally, floored at 0).
- **Names are keyed by `slugify(name)`**, so two people whose names slugify
  identically would share one ballot. Checked clean today across all 75 names —
  re-check when adding to the roster.
