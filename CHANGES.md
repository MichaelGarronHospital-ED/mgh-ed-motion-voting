# Changes — Motion Voting

Running log of what changed and why, newest first.

---

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
