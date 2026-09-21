# Motion Voting

Live, mobile-friendly **weighted voting** for meeting motions. Static frontend +
Firebase Firestore for real-time vote storage. See `README.md` for full setup.

## Files

- `index.html` → voter view (loads `js/vote.js`).
- `admin-9f4k2x7q.html` → leadership view (loads `js/admin.js`). Passcode-gated +
  unguessable filename; keep the filename obscure if it's ever rotated.
- `js/config.js` → Firebase config, `ADMIN_PASSCODE`, `LEADER_EMAIL`, `ORG_NAME`.
- `js/roster.js` → the roster and GROUP1 / GROUP2 / COURTESY weight assignments.
- `js/db.js` → Firestore + Auth wiring, tally/quorum logic.
- `js/vote.js` / `js/admin.js` → the two UIs. `js/util.js` → shared helpers.
- `firestore.rules` (locked-down, auth-gated) / `firestore.rules.open` (rollback).
- `tests/` → headless behaviour tests (dev-only, never shipped). See its README.
- `CHANGES.md` → what changed and why, newest first.

## Rules of the road

- **Weights:** GROUP1 = 1 pt, GROUP2 = ½ pt, COURTESY = 0. A motion passes when
  weighted *In favour* > weighted *Against*; abstentions count toward quorum only.
  Quorum = 50% of eligible voters, computed automatically.
- **All asset paths are relative** — never hardcode `/tools/motion-voting/`, so
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
