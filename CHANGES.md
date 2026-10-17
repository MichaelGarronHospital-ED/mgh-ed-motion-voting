# Changes — Motion Voting

Running log of what changed and why, newest first.

---

## Meetings and agendas (voting upgrade step 4, Oct 2026)

- **The Share tab is now Meeting.** Add a meeting (title and date), its chair and
  notes; **Start meeting** and **End meeting** (ending closes any open motion and saves
  its result first). Voters see the meeting's name, and its results under Results.
  **Download this meeting (Excel)** has five sheets: Meeting, Motions, Ballots,
  Attendance (who voted) and Changes; **Print this meeting** prints minutes without
  names. A meeting can go to the Trash and from there be deleted permanently (its
  motions and ballots too; the change history keeps a record of each result).
- **Agendas:** motions are numbered 1, 2, 2a, 2a.1; **Up** and **Down** reorder them
  (amendments move with their motion); **Add amendment** (two levels at most);
  **Paste an agenda** with a preview; **Details** for mover, seconder and notes, with the
  opening and closing times. Warnings before opening a motion whose amendment has not
  been voted, or an amendment whose motion already was. Voters see "Motion 2a" and, for
  an amendment, the wording of the motion it changes.
- Motions made before meetings are listed under "Earlier motions" and can be moved
  into a meeting (a result never changes when it moves).
- A re-vote of a motion from a meeting that has ended goes to the open meeting.
- **Settings → Delete history older than 7 years** (or the longer period set there):
  removes only entries past that period, and records that it did.

- Opening a motion in a meeting nobody has started starts that meeting (another open
  meeting is ended first, after asking), so phones and the projector always see it.

**Publish the rules before merging this page** (they add meetings, and let leadership
delete change-history entries only after the retention period, never under 7 years).
With the old rules this page says "needs a database update" and keeps Open and Close
off; voting itself is unaffected. **Once a meeting exists, never roll back to an earlier
page** (it would list motions out of order).

After the update: check in a private window, or wait 10 minutes. Close and reopen every
console tab (an open step-3 console does not keep the voters' board up to date with
meetings).

Tests: 172 browser tests (28 new), 94 rules tests (19 new, including the real meeting
code and calendar-year retention with Feb 29).

## Voting rules in Settings; paste the physician list; write-ins always shown (voting upgrade step 3, Oct 2026)

- **Settings → Voting rules:** points per vote for Full, Half and No vote (0 to 1), the
  quorum percent, the default pass rule for new motions (more points in favour, or at
  least two-thirds of the points cast with abstentions not counted), whether a tie reads
  "Tie" or "Tie: does not pass", and how long the change history is kept (at least 7
  years). Saved changes apply only to motions opened afterwards: closed motions keep
  their results, the open motion keeps the rules it opened with, and old motions keep
  the old rules. The screen refuses invalid values, and so do the database rules.
- **Add a motion** has a pass rule (default from Settings), changeable while it is a draft.
  The ballot says "Needs two-thirds of the points cast to pass." when that applies.
- **Physicians tab:** a "Write-ins to review" card (kept in the database, so it survives
  a reload; the tab shows how many): Add as Full, Half or No vote, Not a physician, or
  Restore if they were removed. **Update the list by pasting** from Excel, with a
  preview of new names, category changes, unchanged names, names not in the paste
  (removed only if you tick the box) and problems ("Looks like Meg Reynolds: same
  person?"). Every change to the list is in the change history.
- The records said "(uncategorized)" after a dash; they now say "Uncategorized".
- No proxy votes, as decided: there is no proxy setting.

**Publish the rules before merging this page** (they add the settings checks; the
step-2 page never writes settings).

After the update: check in a private window, or wait 10 minutes. Close and reopen every
console tab.

Tests: 144 browser tests (23 new), 75 rules tests (8 new).

## Phones read results from one small board; re-vote (voting upgrade step 2, Oct 2026)

**The big one: the free daily read limit.** Each phone used to read every ballot of
every closed motion again after each close. A meeting of 8 motions could pass the
50,000 free reads a day, and then voting would stop until the next day. Now phones
listen to two small documents only (the board and the name list) and never read
ballots. Our estimate for a 40-person, 8-motion meeting goes from about 150,000 reads
to about 6,700.

- **Voters:** the Results tab shows the latest results from the board; "Show earlier
  results" reads past results once. "You voted In favour" comes from what the phone sent.
  If a result is slow to save (a laptop went to sleep), the phone counts it once itself
  after 30 seconds and says so. Plain messages when the connection drops, when a vote is
  not sent, or when the ED sign-in has ended.
- **Leadership:** **Re-vote** on a saved result starts a clean copy (everyone votes
  again; the original stays on record, marked "Replaced by a re-vote"; voters see the
  reason). Each Results card has a **History** fold. **Settings** (top right) holds the
  change history and "Your name for the change history" (asked once per laptop).
- The board is updated inside each action. If it ever looks out of date, the console
  says "The voters' screen is out of date" with **Fix it**; it never rewrites it on its own.
- Closing now fails straight away when offline ("Not closed: no connection. Voting is
  still open. Try again") instead of waiting, so a late close can never land after a
  re-open.
- Archive, unarchive, trash and restore are now in the change history too.
- **Both password screens** (voters and the console) now say: "Not working on iPhone?
  Clear the box, type the password by hand, then tap Save when your phone offers."

**Publish the rules before merging this page** (they add the re-vote link only; the
step-1 page works the same with them). Until the first leadership sign-in creates the
board, phones fall back to reading the open motion directly.

After the update: check in a private window, or wait 10 minutes. Close and reopen every
console tab (an open step-1 console does not keep the voters' board up to date).
Voting with a keyboard keeps its place after each tap.

Tests: 121 browser tests (32 new), 67 rules tests (15 new, including the real close,
save, re-open, re-vote and history code writing the board in the emulator).

---

## Tests run on GitHub for every push (Oct 17 2026)

- `.github/workflows/tests.yml` runs the database rules tests and the browser tests on every
  push and pull request. No page, rule or test changed.

---

## Results are saved when a motion closes (voting upgrade step 1, Oct 2026)

Until now a result was worked out again from the ballots every time someone looked,
and leadership could remove a ballot from a closed motion, which quietly changed a
past result. Now:

- **Closing saves the result once.** A short "Saving the result..." box shows until it
  is saved (keep the page open; on an iPad or iPhone it cannot warn you). The Results tab
  then says "Result saved at 12:14. It can't be changed."
- **Old motions** are saved the first time leadership signs in, exactly as they show
  today ("Saved the results of N earlier motions. Nothing they show has changed.").
- **A bug is fixed:** a write-in who had been given a category but did not vote was
  left out when a motion closed, so the quorum needed could drop at close. Closing now
  keeps them. Old motions are checked: any motion where this could have changed whether
  quorum was met is listed under "Please check" and marked on its result; nothing is
  changed silently. Most likely none is listed.
- **Re-open needs a reason**, and keeps the earlier count. **Removing a ballot** of a
  closed motion is no longer possible, and a motion can be deleted only from the Trash.
- **Change history:** open, close, re-open and permanent delete are recorded with the
  reason (Results tab, "Change history").
- **No more silent waits:** if the connection drops, or the database rules are older
  than the page, the console says so in plain words and keeps Open and Close off.
- Each motion keeps a copy of the counting rules it opened with (today's rules), ready
  for the Settings screen in a later step.
- **No proxy votes** (Alvin's decision, Oct 16 2026): the voting upgrade has no proxies
  anywhere, in the data, the rules, the screens or the settings.

Voters see no change. **Publish the rules before merging this page**: the old page
keeps working with the new rules, except for removing a ballot of a closed motion and
"Re-open voting" (both now refused on purpose). Close any open motion before rolling
the page back.

After the update: check the live pages in a private window, or wait 10 minutes (files
are cached that long, and a page mixing old and new files shows "Starting... If this
message stays, reload the page."). Close and reopen every console tab; from this version
on, an open console says "A newer version is available. Reload." after each update.

Tests: 89 browser tests (34 new), 52 rules tests (31 new, including the real page code
run against the emulator: close, save, re-open, purge, catch-up).

## Console code split into parts; better test tools (voting upgrade step 0, Oct 2026)

Nothing changes for voters or leadership. This prepares the bigger voting upgrade
(saved results, meetings, projector screen and the rest), so each later change is
small and easy to check.

- The leadership console's code (one large file) is now one file per tab:
  `admin.js` (sign-in, tabs), `admin-motions.js`, `admin-results.js`, `admin-roster.js`,
  `records.js`, sharing state through `admin-state.js`. The counting moved to
  `count.js`; `board.js` is new and holds the helpers the voters' board will use.
- The test copy of Firebase now behaves more like the real one: server times appear
  only once a save is confirmed, saves can wait while offline, and a test can make a
  read or a save be refused, hold it back, or count how many documents a page read.
- The tests can run against the live site (with Firebase still replaced by the test
  copy, so no real data is touched): set `MV_BASE_URL`.
- **Security fix:** if Continue on the Leadership password screen was tapped before the
  page's code had loaded (slow network, or old and new cached files right after an
  update), the browser itself sent the form and the password showed in the address bar
  (and so in the history and server logs). The form now stays disabled until its code
  has taken over, and never sends itself.

Tests: the 42 existing browser tests and 21 rules tests pass unchanged; 13 new
(the test copy of Firebase, and a short live smoke set). Rules: unchanged.

## Leadership can add, remove and restore physicians (Oct 16 2026)

The Physicians tab now has **Add a physician** (name and category), **Remove** on each
row, and a **Removed** list with **Restore**. Changes are saved in Firebase
(`config/roster`) and reach every voter's name list straight away; no code change.

- **Past results never change.** Closed motions already froze everyone's category when
  they closed. Motions closed before that existed now get the same frozen copy just
  before any change to the list, so their results stay exactly as they are.
- **Removing hides, never deletes.** A removed physician leaves the name list and stops
  counting toward quorum. A vote they already cast on the open motion stops counting
  (the console warns first). Restore brings them back with the same category.
- Adding a name that is already listed changes nothing; adding a removed name restores it.

## Security fixes: safe console, stricter ballots, no open rollback (Oct 16 2026)

A security review found five things. All fixed; nothing changes for a voter except one
line of wording.

- **A crafted ballot could run code in the leadership console.** Voters' ballot fields
  (choice, submission count, ids, write-in names) were put into the page as HTML. They
  are now always shown as plain text. Both pages also carry a Content-Security-Policy,
  so even a slip in future code cannot run injected script: scripts only from this site,
  Firebase's SDK host and Google's sign-in helper (Safari loads it); connections only to
  Firestore and Firebase sign-in. Checked in Chrome and Safari engines at the real site
  address against real Firebase: no violations, and a wrong ED password still says
  "That's not the ED password."
- **Ballots could take any shape.** The rules only checked "signed in and motion open".
  Now a voter's ballot must sit under its own name (one name, one ballot), use one of
  the three real choices, have only the expected fields, keep every device id it already
  had, be flagged exactly when two or more devices used that name, use the server's
  clock, and arrive together with the +1 to the vote count. Changing your vote still
  works. Leadership can still do everything. The tally also counts each name only once,
  even if a second ballot for that name ever turns up.
- **The rollback opened the database to everyone.** `firestore.rules.open` is removed.
  To undo a bad rules publish: republish the previous version from Firebase console >
  Firestore > Rules (history), or `git revert` and deploy again.
- **"Live and anonymous to the group" was not true.** Names and choices are readable by
  anyone with the ED password. The line now says "Tap to cast your vote. Results update
  live."
- **Stale docs:** the rules header no longer describes anonymous voters; the test steps
  warn before touching the live database; "passcode" is now "Leadership password".

What the rules still cannot stop: everyone shares the ED account, so anyone with the ED
password can vote under any name (flagged for review, not blocked), and device ids are
made up by the browser. Written down under HONEST LIMITS in `firestore.rules`.

The rules must be published (`npx firebase-tools deploy --only firestore:rules`) for the
ballot checks to take effect. The old and new page code both work with both old and new
rules, so the order does not matter.

Tests: 36/36 (new: a name counts once; crafted ballot fields show as text). Rules tests
21/21 (new: duplicate ballot under another id, bad choice, extra or missing or wrongly
typed fields, flag not matching the device list, device list shrinking, faked counts and
times, a ballot without the count, and the real vote, change, re-tap and second device).

## iPhone Safari kept saying "wrong password" (Oct 16 2026)

Some physicians' iPhone Safari refused the right ED password while other browsers took
it. Every ED tool shares one web address, so Safari's saved passwords got mixed up and it
filled an old or other tool's password into the box. Both password screens now carry an
invisible username ("ED password" / "Leadership password"), so Safari keeps one saved
entry per password, and both ignore spaces before or after the password (the real ones
never have any). Nothing on screen changes; anyone signed in stays signed in.

## The shared ED tools look, for voters and leadership (Oct 15 2026)

Same look as every ED tool: `css/ed-ui.css` is an exact copy of the master in the
dashboard repo (`shared/ed-ui.css`) and loads before `css/styles.css`. Light and dark
follow the device; print stays light; every text colour reaches 7:1 (WCAG AAA).

- **One sign-in card** for both passwords (badge, title, a visible label, one button).
- **Voting:** three choice tiles with line icons; the chosen one gets the blue border and
  tint (no more heavy black ring). "Not you?" and "Switch voter" look like links.
- **Verdicts:** one size, with an icon, in sentence case ("Passed", "No quorum: cannot
  pass"), then one stacked result bar and a legend. Exports keep their old words.
- **No emoji** anywhere on screen: inline SVG icons instead.
- **Console:** all five tabs fit on a 375px phone (shorter names; a fade shows when a
  narrower screen has more to scroll). Archived and Trash headers are real buttons.
  Archived and trash pills are grey. The category picker is a segmented control. The
  quorum box is quiet grey with only its status in colour. On phones the Voters and
  Physicians tables become two-line rows, and the page scrolls instead of a 60vh box.
  The six-line Voters help is one hint line plus a "What the flags mean" fold. The
  voting link wraps in full, with a full-size "Copy link" button.
- Almost all inline styles moved into `css/styles.css` (the two left are result-bar widths).

Tests: 33/33 (verdict and flag strings updated to the new visible words). Rules tests
12/12. axe-core (WCAG A to AAA plus best practice) clean on every main screen, light and dark.

---

## Sign-in: the ED password to vote, the Leadership password for settings (Oct 14 2026)

The ED tools now share three passwords (Leadership, ED, Guest; MGH-ED-Tools/README.md).
For voting:

- **Voters enter the ED password once per device.** Firebase remembers the sign-in, so
  at later meetings they scan the QR code and go straight to the ballot. The password is
  the password of a shared Firebase account (`ED_EMAIL`), and `firestore.rules` now accept
  only that account and leadership's: an anonymous visitor with a forwarded link can no
  longer read or vote. Old anonymous sessions see the password screen.
- **Leadership enters the Leadership password**, checked by Firebase as the password of
  `LEADER_EMAIL`. The SHA-256 hash of the old passcode is gone from the public config,
  and the console no longer opens when the Firebase sign-in fails (it used to open with a
  warning, with writes then refused).
- A leadership session still counts on the voter page (a chair voting on the console
  laptop is not signed out of the console).

Tests: 33/33 (the anonymous-sign-in tests replaced: password screen, sign-in as ED,
password screen again after a sign-out elsewhere, an old anonymous session refused, a
wrong ED or Leadership password refused with a clear message). axe-core clean.

---

## Export: every motion, ballot and the roster in one Excel file; printable results (Oct 14 2026)

### Added: an Export menu in the leadership console header

- **Download Excel** saves `motion-voting-records-<date>.xlsx` with four sheets:
  Summary (counts, today's eligibility and quorum, the pass rule), Motions (every
  motion with its status, result, weighted and counted votes, quorum, write-ins and
  flags; motions in the trash are kept and marked), Ballots (every named ballot with
  category, weight, vote, submissions, flags), and Roster.
- **Print or save as PDF** prints each motion's result (verdict, quorum, points and
  votes) on a clean white page; the browser's print dialog saves it as a PDF. Named
  ballots stay out of the printout (voting is anonymous to the group) and are in
  the Excel file.
- Ballots are read fresh for every motion (`getVotesFor` in `js/db.js`), not only
  the motion on screen, so the file is complete. Results use the same `tally` and
  `quorumThreshold` as the console, so the file and the screen cannot disagree.
- `js/xlsx.js` writes the .xlsx with no library and no network; it is the same
  file as the hiring tool's. The per-motion and roster CSV buttons are unchanged.
- The menu is a native `<details>`: keyboard and screen-reader friendly, closes on
  Escape or a click outside. On phones the console subtitle hides so the header
  stays on one line of buttons.

Checked: 30/30 tests; axe-core clean on all 20 screens plus the open menu; Excel
opened with openpyxl (4 sheets; results, half-vote weights, trash all correct).

---

## Same look as the other ED tools; keyboard and screen-reader fixes (Oct 14 2026)

### Changed: the dark theme is gone; the tool now looks like the hiring tool and CPOE

One design language across the ED tools: light grey page, white cards, the
system font, one blue accent, soft shadows, the "ED" app badge, segmented tabs,
pill buttons, the dark toast. The token values are copied from the hiring tool
(`hiring-tool/css/styles.css`), so the two read as one family. Class names did
not change, so `js/` renders exactly as before; only `css/styles.css` was
rewritten, plus:

- Leadership sign-in is hiring's centred card (same ids: `#gate`, `#pass`,
  `#enter`, `#gate-err`).
- Header: "ED" badge + title on both pages.
- Repeated destructive actions (Delete, Remove) stay grey until hovered, and a
  selected vote category is simply filled blue instead of a heavy ring.
- On phones, the voters and physician tables drop columns the row already
  implies (weight, submissions; category, points), so nothing is cut off.

### Fixed: keyboard and screen-reader gaps (axe-core, WCAG 2 AA)

- The name list could only be clicked: names are now focusable and Enter or
  Space picks one (listbox/option roles).
- Tabs were `<div>`s; now real buttons, reachable by keyboard.
- The two "View motion" dropdowns and the voting-link box had no label.
- The voter page blocked pinch-zoom (`maximum-scale=1`); removed.
- Pages gained a `<main>` landmark; the toast is announced (`role="status"`).

Checked: 30/30 tests; axe-core clean on all 20 screens (voter picker, ballot,
results; gate and all five console tabs; 390 and 1280 px); keyboard voting
end to end.

---

## Voter page no longer signs leadership out (Oct 13 2026)

### Fixed — opening the voting page broke the leadership console in the same browser

Firebase keeps one sign-in per browser for the whole site, shared by every tab.
The voter page signed in anonymously on every load, which **replaced** a
leadership session: with the console open in another tab (or a chair voting on
the console laptop), the console's next close / delete / category change was
refused with "Missing or insufficient permissions". Found in the Oct 13
migration test: adding and opening a motion worked, closing it failed once the
voter tab had been opened.

The voter page now signs in anonymously only when nobody is signed in
(`ensureSignedIn` in `js/db.js`), and signs back in if the session is dropped
later (e.g. leadership clicks Lock in another tab). A leadership session can
vote — the rules already allow it. Three tests in `TestSignIn`; the
keep-the-session test fails against the old code. **30 tests, all passing.**

---

## Correctness pass + first test suite (Sept 21 2026)

This tool had shipped and been used without ever getting the adversarial review
the interviews tool had. This pass read every file, reproduced what it found in
a headless browser, fixed it, and left the reproductions behind as
[`tests/`](tests/) so they stay fixed. **27 tests, all passing.**

Verification note: everything below was reproduced and re-verified by driving
the real pages headlessly (Chromium) against an in-memory Firestore stub — see
[`tests/README.md`](tests/README.md). Each fix was then reverted one at a time to
confirm its own test failed, so the tests are known to be load-bearing rather
than merely green. **What is not covered here: `firestore.rules`.** Those need
the Firestore emulator (Java + `firebase-tools`), which this environment has
neither of; the rules were reviewed by reading only.

### Fixed — a closed motion could announce the wrong outcome
- **Why it mattered:** an empty tally scores as **"NO QUORUM — cannot pass"**.
  Firestore always delivers its first snapshot asynchronously, so both the voter
  Results tab and the leadership Live-results tab painted that verdict *before*
  the ballots arrived, then corrected themselves. On a projector in a meeting,
  the wrong answer appearing first is the answer people react to.
- Both views now show **"Counting votes…"** until that motion's ballots have
  actually arrived, and **Export CSV is refused** while they are still in flight
  (it would otherwise write a confident, empty, wrong result into a file someone
  circulates). The Voters table says "Loading ballots…" rather than "No votes yet."
- Reproduced at 26 in-favour ballots against a quorum of 24: first paint
  `NO QUORUM`, settled paint `PASSED ✅`.

### Fixed — re-opening an archived motion made it invisible to voters
- **Why it mattered:** voters only ever see motions that are **not archived**
  (`js/vote.js`), but leadership's live-motion filter ignored `archived`
  entirely. Re-opening an archived motion from the Results tab therefore left it
  `status: "open", archived: true` — leadership saw a live motion with a "Close
  voting" button and a quorum bar, while every voter saw "No motion open right
  now." Nothing in either UI explained the disagreement.
- `openPoll` now **unarchives** the motion it opens (an open motion must be
  visible to voters), and leadership's live-motion filter now excludes archived
  motions, matching the voter page exactly. Both sides agree by construction.

### Fixed — the distinct-voter count only ever went up
- **Why it mattered:** `voteCount` is the counter behind the "🔒 locked (voting
  started)" edit lock and behind the purge confirmation's "…and its N recorded
  vote(s)". `clearVote` deleted the ballot but never decremented it, so after
  leadership removed ballots the count drifted permanently high: a motion whose
  every ballot had been removed stayed locked against editing, and the permanent
  delete dialog over-reported how much it was about to destroy.
- `clearVote` is now a transaction that deletes the ballot and decrements
  `voteCount` together, floored at 0 so a double-removal cannot go negative.

### Smaller fixes
- A **draft** motion's button in Live results said "Re-open voting" for a motion
  that had never been open; it now says "Open voting".
- The voter page subscribed to roster category overrides with an empty callback,
  so a mid-meeting category fix did not reach a voter already looking at the
  results. It now re-renders.
- `js/roster.js` header said COURTESY was 26 people; it is 27. (GROUP1 = 34 and
  GROUP2 = 14 were correct, so eligible = 48 and quorum = 24 were never wrong.)

### Reviewed and deliberately left alone
- **Any anonymous voter can write any name's ballot while a motion is open.**
  The rules cannot prevent this — voters are anonymous, so there is no identity
  to check against. This is the documented trade-off in `CLAUDE.md` ("duplicate
  votes are flagged, not blocked"): the app *detects* it — same name from 2+
  devices, one device under 2+ names — and surfaces it to leadership for review,
  rather than blocking a legitimate vote change. Changing it would cost a voter
  who clears site data or switches phones the ability to fix their own vote.
  Now written down under **HONEST LIMITS** at the bottom of
  [`firestore.rules`](firestore.rules), with the recipe if it is ever wanted, so
  that it stays a decision rather than becoming an oversight.
- **Roster slugs were checked for collisions** — two people whose names slugify
  the same would silently share one ballot. There are none across all 75 names.
- `weightOverride` is guarded in the rules but written by no code. Kept: it
  stops a voter setting a future leadership-only weight field.

### Still needs a person
- **The admin passcode is stored as an unsalted single-round SHA-256**
  (`ADMIN_PASSCODE_SHA256` in `js/config.js`). The hash is public in this repo,
  so a short or guessable code falls to an offline brute-force in seconds — and
  because that same plaintext is the **Firebase leadership account password**
  (see `LEADER_EMAIL`), cracking it grants full write access to the database,
  not merely the admin screen. The interviews tool uses PBKDF2 for the same
  reason. Fixing this needs the plaintext code, which is deliberately not in the
  repo, so it is left for the operator: either move to PBKDF2 with a high
  iteration count, or ensure the code is long and random.
