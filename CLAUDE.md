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
  `MV_BASE_URL=<site address>` runs them against another copy of the site (for example
  the live one after a deploy, `-p "test_smoke.py"`), still with Firebase stubbed.
  On Alvin's Mac the test tools live outside iCloud in `~/.venvs/mgh-ed-tools`:
  `~/.venvs/mgh-ed-tools/bin/python -m unittest discover -s tests -v`.
- **Database rules tests:** `cd tests/rules && npm install && npm test` (Firestore emulator;
  needs Java). One file per topic (`rules.core`, `rules.results`, `rules.listeners`, ...),
  run one after another. `app-loader.mjs` lets them run the REAL page code (`js/db.js`)
  against the emulator, with Firebase swapped for the npm SDK (never the live project).
  `rules.listeners` checks every source each page reads is readable under these rules.
  Run after any change to `firestore.rules`.
- **GitHub Actions:** `.github/workflows/tests.yml` runs both sets (rules on the emulator,
  browser tests in Chromium) on every push to any branch and every pull request. Free on a
  public repo. Actions are pinned by commit hash; runner image `ubuntu-24.04`.
- **Deploy the site:** push to `main`; GitHub Pages is live about a minute later. Rules
  first, then the page. Bump `version.txt` and `js/version.js` together with every
  update (open consoles then say "A newer version is available. Reload."). Pages are
  cached up to 10 minutes: check a deploy in a private window, or wait 10 minutes.
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
- `js/roster.js` → the starting roster and GROUP1 / GROUP2 / COURTESY weight assignments.
  Leadership's changes live in Firestore `config/roster` (`groups`, `added`, `removed`);
  `currentRoster()` in db.js is the list in use (roster.js + added − removed).
- `js/db.js` → Firestore + Auth wiring and who is in which category. `js/count.js` → the
  counting itself (pure, no Firebase; re-exported by db.js). `js/board.js` → the voters'
  board helpers (pure).
- `js/vote.js` → the voter page. The console is `js/admin.js` (sign-in, tabs, listeners)
  plus one module per tab: `admin-motions.js`, `admin-results.js` (Results and Voters),
  `admin-roster.js` (Physicians), `records.js` (Excel and print). They share state and
  redraw each other only through `admin-state.js`, so no module imports another.
  `js/util.js` → helpers shared by both pages.
- `js/xlsx.js` → dependency-free .xlsx writer behind the console's Export menu
  (identical copy in the hiring tool; keep the two the same).
- `firestore.rules` (locked-down, auth-gated). To roll back a bad publish, republish the
  previous version from Firebase console > Firestore > Rules (history), or `git revert`
  and deploy again. Never open the database to everyone.
- `tests/` → headless behaviour tests (dev-only, never shipped). See its README.
- `CHANGES.md` → what changed and why, newest first.

## Rules of the road

- **Weights:** GROUP1 = 1 pt, GROUP2 = ½ pt, COURTESY = 0. A motion passes when
  weighted *In favour* > weighted *Against*; abstentions count toward quorum only.
  Quorum = 50% of eligible voters, computed automatically. These are `LEGACY_RULE` in
  `count.js`. Each motion keeps a copy of the rules it opened with (`rule`), and any
  motion without one is counted with `LEGACY_RULE`, never with later settings.
- **Results are saved once, at close, and never change** (`polls/{id}.result`). Close
  has two steps: `closeMotion` freezes the motion (the rules then refuse every ballot
  write), then `saveResult` counts the ballots read from the server and saves inside a
  transaction. Screens and records show the saved result for closed motions. Motions
  closed before this existed are saved by the console's catch-up on sign-in, exactly as
  they showed, and checked for the write-in quorum bug (flagged with `quorumNote`).
- **Re-open needs a reason** and a saved result first: the result moves to
  `priorResults`, the frozen categories go into the change log. Ballots of a closed
  motion are locked (no Remove), and a motion is deleted only from the Trash.
- **Change log (`log/`)**: open, close, catch-up, re-open and permanent delete write an
  entry in the same batch or transaction. Leadership only; never edited.
- **The console waits for its data (the load gate).** Nothing that saves a result, and no
  Open or Close, runs until roster, settings and motions have each arrived from the
  server. Every wait has a plain message for refused, offline and timeout (no bare
  "Loading"). A page newer than the published rules says it "needs a database update".
- **Rules first, then the page.** Each upgrade step's rules are published before its page
  is merged, and are written so the previous page still works with them.
- **All asset paths are relative** — never hardcode `/mgh-ed-motion-voting/`, so
  the app keeps working wherever it's served.
- **Firestore rules are the source of truth for access.** If you change data
  shape in `db.js`, change `firestore.rules` and its tests with it: the rules
  accept only the exact ballot shape `castVote` writes, so a new ballot field is
  refused until the rules allow it. Roll back by republishing the previous rules
  version (Firebase console history) or `git revert`, never by opening the database.
- **Everything stored is shown as text.** Ballot fields are typed by voters, so any
  value put into `innerHTML` goes through `escapeHtml` (js/util.js). Both pages
  also carry a Content-Security-Policy `<meta>`: a new script host or Firebase
  service has to be added there, and inline scripts and `onclick=` handlers are blocked.
- Duplicate votes are **flagged, not blocked** (a genuine vote change must still
  work); write-ins land at 0 weight with a *NEW* tag until leadership assigns one.
  The rules *cannot* enforce one-ballot-per-person: every voter signs in as the
  same ED account, so anyone with the ED password can write any name's ballot.
  That is the accepted trade-off; the limits are spelled out under **HONEST
  LIMITS** at the bottom of `firestore.rules`. Voting is not secret: everyone with
  the ED password can read names and choices, so never call it anonymous.
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
  identically would share one ballot. Checked clean today across all 75 names;
  the console's Add refuses a name whose slug is already listed.
- **Closed results never move.** Closing freezes every category into the motion
  (`lockedGroups`), including write-ins who were given a category (they count toward
  quorum while it is open), and saves the result. Removing hides a physician (no vote on
  open or future motions); it never deletes.
