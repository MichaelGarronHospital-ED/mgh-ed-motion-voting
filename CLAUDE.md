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
