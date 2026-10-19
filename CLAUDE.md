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
  first, then the page. Every update: `python3 tests/set_version.py --snapshot` before
  changing `js/` (records what the live release imports), then
  `python3 tests/set_version.py voting-N` (writes `version.txt`, `js/version.js` and
  `?v=voting-N` on every module import and each page's script and stylesheet tags;
  `tests/test_versions.py` checks). Open consoles then say "A newer version is available.
  Reload." Never remove an export in the release that stops using it (a cached module of
  the live release may still import it). Pages are cached up to 10 minutes: check a
  deploy in a private window, or wait 10 minutes.
- **Accounts:** repo owned by the `MichaelGarronHospital-ED` org (department login
  `MGH-ED-Admin`). Firebase project `ed-motion-voting-99b96` is owned by the Google
  account on MGHEmergencyDepartmentAdministration@tehn.ca (second Owner: dralvinyang@gmail.com,
  until another ED person is added). Free Spark plan. Publish rules with
  `npx firebase-tools deploy --only firestore:rules` (department login); live rules matched
  the repo on 2026-10-14. No other services or keys.

## Files

- `index.html` → voter view (loads `js/vote.js`).
- `screen.html` → the meeting screen for the projector (loads `js/screen.js`). Display
  only: turnout, quorum, timer, the saved result, the QR code. It reuses the browser's
  existing sign-in and never signs in over it (one sign-in per browser for every tab);
  signed out, it asks for the ED password only. Controls are in the console's Meeting
  tab and live in `config/screen`.
- `admin-9f4k2x7q.html` → the Admin console (loads `js/admin.js`). Admin-password-gated (Firebase sign-in) +
  unguessable filename; keep the filename obscure if it's ever rotated.
- **"Admin" is the word people see** (since step 11, Oct 2026; it was "Leadership"): the
  Admin password, the Admin console, Admin only. Code and data keep the old names: the
  account `leadership@mgh-ed-voting.invalid`, `LEADER_UID`, `isLeader`, `by: "leadership"`
  on attendance, and the hidden password-manager name "Leadership password" (phones saved
  the password under it). Keep "ED leadership" where it means the people. Don't rename
  the code names: a stored value or a cached page may still use them.
- `js/config.js` → Firebase config, `LEADER_UID` + `ED_UID` (the two shared accounts, by
  uid, the same as `firestore.rules`), `LEADER_EMAIL_NEW` + `ED_EMAIL_NEW` (used only to sign in;
  the passwords live only in Firebase Auth), `ORG_NAME`.
- `js/roster.js` → the starting roster and GROUP1 / GROUP2 / COURTESY weight assignments.
  Changes made in the Admin console live in Firestore `config/roster` (`groups`, `added`, `removed`);
  `currentRoster()` in db.js is the list in use (roster.js + added − removed).
- `js/db.js` → Firestore + Auth wiring and who is in which category. `js/count.js` → the
  counting itself (pure, no Firebase; re-exported by db.js). `js/board.js` → builds the
  voters' board and past results from the motions, and the field-path patch between two
  boards (pure).
- `js/vote.js` → the voter page. The console is `js/admin.js` (sign-in, tabs, listeners)
  plus one module per tab. Tabs, in the order of the work (UX pass, voting-12):
  **Meeting** (`admin-meeting.js`: pick or add, Start/End, Edit details, QR and link,
  attendance, projector, meetings in Trash; it also fills Results' "Records of this
  meeting"), **Physicians** (`admin-roster.js`; `data-tab="roster"`), **Motions**
  (`admin-motions.js`: Add form, agenda rows with a per-row More menu), **Results**
  (`admin-results.js`: the count, then "Who voted", the old Voters tab, sharing the one
  motion picker; then the meeting's records). The gear opens Settings (`admin-settings.js`:
  voting rules, change history; its Done button, or the gear again, returns to the tab you
  came from; also the header's name chip, your name for the change history). `records.js` → Excel and print, all or one meeting. They share state and redraw
  each other only through `admin-state.js`, so no module imports another. `admin-state.js`
  also holds the console's small controls: `infoButton` (the (i) button; text on hover,
  focus and tap, Escape closes; one `wireInfo` for the page), `iconBtn` (icon-only buttons
  always get `aria-label` and `title`) and `wireMenus` (`<details class="menu">` drop-downs).
  In the page, `data-icon` and `<span data-info>` are filled in by `admin.js`.
  `js/util.js` → helpers shared by both pages (and the line icons).
- `js/xlsx.js` → dependency-free .xlsx writer behind the console's Export menu
  (identical copy in the hiring tool; keep the two the same).
- `firestore.rules` (locked-down, auth-gated). To roll back a bad publish, republish the
  previous version from Firebase console > Firestore > Rules (history), or `git revert`
  and deploy again. Never open the database to everyone.
- `tests/` → headless behaviour tests (dev-only, never shipped). See its README.
- `CHANGES.md` → what changed and why, newest first.

## Rules of the road

- **A role is known by uid, never by email.** Rules (`isAccount`) and pages (`isMember`,
  `isLeader` in `js/db.js`) compare `uid` with `LEADER_UID` / `ED_UID`; emails are only for
  `signInWithEmailAndPassword`. `tests/test_accounts.py` keeps config and rules equal and
  refuses any `.email ===` check in page code. `signInAs` signs in with the `.invalid`
  emails (`*_EMAIL_NEW`; step 9's old/new fallback is gone since step 10) and accepts only
  the pinned uid. The old emails are gone from the code since step 11. **Never delete a role
  account** (a new one has a new uid).
- **Weights:** GROUP1 = 1 pt, GROUP2 = ½ pt, COURTESY = 0. A motion passes when
  weighted *In favour* > weighted *Against*; abstentions count toward quorum only.
  Quorum = 50% of eligible voters, computed automatically. These are `LEGACY_RULE` in
  `count.js` and the defaults. The Admin console can change them in **Settings** (points per
  vote 0 to 1, quorum %, default pass rule "more in favour" or "two-thirds of points cast",
  tie wording, how long the change history is kept: at least 7 years); saved in
  `config/settings`, checked by the rules (R3). Each motion keeps a copy of the rules it
  opened with (`rule`), and any motion without one is counted with `LEGACY_RULE`, never
  with later settings. A draft follows today's settings with its own pass rule.
- **No proxy votes** (Alvin's decision, Oct 2026): nothing in the data, rules or screens.
- **Write-ins** are kept in `config/roster.writeins` (gathered at close and catch-up), so
  the Physicians tab's "Write-ins to review" card survives a reload. "Update the list by
  pasting" previews every change (`count.js parseRoster`) and removes nobody unless
  ticked. Every roster change writes a `roster`, `roster-bulk` or `writein` log entry.
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
  entry in the same batch or transaction. Admin only; never edited.
- **Phones read two small documents, never ballots.** `config/live` (the board: what
  is open and this meeting's results) and `config/roster`; past results are one read of
  `config/history` on a tap. "You voted" comes from the phone's own record
  (`ed_receipts`). Both documents are built from the motions alone (`board.js`), patched
  by field path inside every action that changes them (`boardPatch`), and written whole
  only by `healBoard` (on console load, "Save result now", and "Fix it"; never while
  writes are pending; at most every 30 s). A console never rewrites the board on its
  own: if it is out of date for 10 s it shows "Fix it". Never put a server time inside an
  array (Firestore refuses it): `results` is a map keyed by motion id. Phones have no
  fallback: until the console first creates `config/live`, nothing is open for them.
- **Re-vote** is the normal way to contest a saved result: a draft copy linked both
  ways (`revoteOf`, `supersededBy`), with a reason voters see. Re-open is for "closed by
  mistake".
- **Meetings** (`meetings/{id}`: title, date as local text YYYY-MM-DD, planned / open /
  closed, chair, notes). Motions carry `meetingId`; agenda numbers (1, 2, 2a, 2a.1) come
  from `order` and `amends` (`count.js agendaOrder`) and are saved as `number` when a
  motion opens. The board shows the open meeting, else the one that ended last (never a
  trashed or archived one). One meeting open at a time; End meeting closes the open
  motion with its result first. "Delete meeting permanently" works only from the Trash:
  motions first, the meeting last, so running it again finishes a half-done delete.
  Motions made before meetings stay under "Earlier motions" and can be moved in.
- **Questions and elections** (`kind: "choice"`, `style` question or election, `options`
  [{id, label}], `optionIds`, `seats`, `threshold` plurality or majority). A ballot has
  `choice` "pick" (with `picks`, in option order) or "abstain" (empty picks); a motion
  ballot never has picks (R6). Each pick adds the voter's points; winners are the top
  `seats` with points; a tie only when an option outside the winners equals the last
  winner; 0 points never wins; "more than half" (one pick) can end in a run-off of the
  top two (`runoffMotion`, logged as "runoff"). Options lock once voting starts.
- **Attendance, remote and receipts are claims, not proof** (everyone shares the ED
  password). A check-in (`meetings/{m}/attendance/{slug}`: in the room or remote) is one
  optional tap while the meeting is open (R7) and never needed to vote; the Admin console can
  add or remove someone. A vote receipt (`count.js receiptCode`: the motion, the name,
  what was recorded and how many times it changed) shows what was recorded under a
  name, not who tapped; the Admin console shows the same code from the stored ballot, so nothing
  extra is stored. There are no proxy votes. Say these limits plainly; HONEST LIMITS in
  `firestore.rules` lists them.
- **The projector never shows the for and against split** unless the Admin console ticks "Show
  the live count", and never a verdict before the result is saved (or counted once after
  30 s). Its timer never closes a vote.
- **The console waits for its data (the load gate).** Nothing that saves a result, and no
  Open or Close, runs until roster, settings and motions have each arrived from the
  server. Every wait has a plain message for refused, offline and timeout (no bare
  "Loading"). A page newer than the published rules says it "needs a database update".
- **Rules first, then the page.** Each upgrade step's rules are published before its page
  is merged, and are written so the previous page still works with them.
- **All asset paths are relative**: never hardcode `/mgh-ed-motion-voting/`, so
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
  work); write-ins land at 0 weight with a *NEW* tag until the Admin console assigns one.
  The rules *cannot* enforce one-ballot-per-person: every voter signs in as the
  same ED account, so anyone with the ED password can write any name's ballot.
  That is the accepted trade-off; the limits are spelled out under **HONEST
  LIMITS** at the bottom of `firestore.rules`. Voting is not secret: while a motion
  is open everyone with the ED password can read its names and choices, and Admin
  always can, so never call it anonymous. **Closed ballots are Admin only**
  (voting-14): the rules refuse ED reads of a motion that is not open, so phones and an
  ED projector never count a late result themselves (they wait for the saved one),
  "Check my recorded vote" is offered only while the motion is open (after close the
  voter shows the receipt code to Admin), and a refused ballot listener on the
  projector is not a sign-out (`ballotsFailed` in `screen.js`).
- **Never show a verdict before that motion's ballots have arrived.** An empty
  tally scores as "NO QUORUM", so painting it early announces a wrong outcome on
  a shared screen. Both results views and the CSV export gate on a `loaded` flag
  fed by the first snapshot; `tests/` pins this.
- **The Admin console and voters must agree on what is open.** Voters only see motions
  that are neither archived nor deleted, so the console's live-motion filter uses
  the *same* predicate and `openPoll` unarchives what it opens. A motion that is
  `open` but `archived` is invisible to voters; don't reintroduce that state.
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
