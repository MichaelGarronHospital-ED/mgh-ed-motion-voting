# Changes — Motion Voting

Running log of what changed and why, newest first.

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
