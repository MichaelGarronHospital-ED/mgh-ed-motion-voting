# ED Motion Voting

A free, mobile-friendly weighted-voting site for live meeting motions.
Static frontend on **GitHub Pages** + **Firebase Firestore** for real-time vote storage.

- **Voters:** `index.html` — pick your name, tap *In favour / Against / Abstain*.
- **Leadership:** `admin-9f4k2x7q.html` — manage motions, see live weighted tally,
  quorum meter, per-person table + CSV export. Leadership-password-protected + unguessable URL.

Weights: **Group 1 = 1 pt**, **Group 2 = ½ pt**, **Courtesy = 0**. A motion
passes when weighted *In favour* > weighted *Against*; abstentions count toward
quorum only. Quorum is computed automatically as **50% of eligible voters**.

## Where it lives

| | |
|---|---|
| Voters | https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting/ |
| Leadership | https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting/admin-9f4k2x7q.html |
| Repo | https://github.com/MichaelGarronHospital-ED/mgh-ed-motion-voting |
| Owner | Alvin Yang |
| Firebase project | `ed-motion-voting-99b96` (config in [`js/config.js`](js/config.js), public by design) |

- **Deploys:** GitHub Pages, from `main`, root folder, no build step. A push to
  `main` is live about a minute later.
- **Passwords (since Oct 14 2026):** the ED tools' shared **ED password** (voters, once per
  device) and **Leadership password** (the settings console). Nothing about either is in
  the repo: each is the password of one Firebase Auth account (`ED_EMAIL`, `LEADER_EMAIL`
  in `js/config.js`), checked by Firebase, and the rules accept only those two accounts.
  To change them, edit `~/mgh-ed-passwords.txt` and run `python3 set-passwords.py --apply`
  in the `MGH-ED-Tools` folder.
- **Old address:** this tool used to live at
  `https://dralvinyang.github.io/ED-motion-voting/tools/motion-voting/`. That
  old repo is archived and only redirects: old `/tools/motion-voting/…` links
  land here with the path, query string and #hash kept, so printed QR codes
  still work. The old top-level address goes to the ED tools dashboard
  (https://michaelgarronhospital-ed.github.io/).
  The hiring tool that shared that repo is now `mgh-ed-hiring`.

---

## Setup (~15 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (any free Google account). Skip Google Analytics.
2. Left menu → **Build → Firestore Database → Create database** → **Start in *production* mode** → pick a location → Enable.
3. Firestore → **Rules** tab → paste the contents of [`firestore.rules`](firestore.rules) → **Publish**.
4. Project settings (gear icon) → scroll to **Your apps** → click the **`</>`** (Web) icon → register an app → copy the `firebaseConfig` object.

### 2. Configure the app
Edit [`js/config.js`](js/config.js):
- Paste your `firebaseConfig`.
- Passwords are not in this file: see "Sign-in" below.
- (Quorum is automatic — 50% of eligible voters — nothing to configure.)

The starting list of physicians is in [`js/roster.js`](js/roster.js) (**GROUP1 / GROUP2 / COURTESY**).
Day to day, leadership changes the list in the console instead, with no code change:
**Physicians** tab → **Add a physician** (name and category), **Remove** on a row, or
**Restore** under Removed. A category button changes someone's category. These changes
are saved in Firebase and reach every phone straight away. Removing never deletes
anything, and closed motions always keep their results.

### 3. Publish on GitHub Pages
Pages is already enabled (`main` / root), so a `git push` to `main` deploys it.
About a minute later:
   - Voters: https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting/
   - Leadership: `.../mgh-ed-motion-voting/admin-9f4k2x7q.html`

[`voter-qr.png`](voter-qr.png) encodes that voter URL. QR codes printed before
the move point at the old address, which redirects here. Renaming this repo
changes the URL and breaks the QR code, so don't, unless you leave a redirect.

### 4. Test (30 seconds)
**This uses the live database that real meetings use.** For most checks, run the
local tests instead (`tests/README.md`): they need no Firebase at all. To try the
real site, never during a meeting:

Open `admin-9f4k2x7q.html`, enter the Leadership password → **Motions** → add a motion
named clearly, e.g. "TEST, please ignore" → **Open**. Open `index.html` in another
tab/phone, enter the ED password, pick a name, vote. Confirm the tally and quorum
meter update live in the admin **Live results** tab. Then **Close** the test motion,
**Delete** it, and **Delete permanently** from the Trash, so no test ballot is left in
the record.

---

## Running the meeting
1. **Add all of Friday's motions** in advance (Motions tab).
2. Share the voting link / **screen-share the QR code** (Share tab). Chat is not needed.
3. For each motion: **Open** → let people vote → watch the quorum meter fill → **Close**.
   Closing shows "Saving the result..." for a moment: keep the page open until it says
   **Result saved** (on an iPad or iPhone especially).
4. The result appears to everyone the moment you close the motion; voters can also review all past results under their **Results** tab.
   A saved result never changes, even if someone's category is changed later.
5. Move to the next motion. If a motion was closed by mistake, **Re-open** it from the
   Results tab and type the reason (kept in the change history; no health or private
   details). The earlier count is kept. Motion wording can be edited until the first vote
   is cast, then it locks.
6. If the console shows a yellow line at the top, read it: "No connection" fixes itself
   when the connection is back; "needs a database update" means the matching rules have
   not been published yet (see below), and Open and Close stay off until they are.
7. Afterward, **Export** for the record.

## Notes
- **Duplicate detection:** one row per name. If the same name votes from two
  different devices it's **flagged for review** (highlighted in the Voters tab) —
  votes are not silently blocked, so a genuine vote change still works.
- **Write-ins:** new/unlisted members can add their name; they're recorded with
  **0 weight** and a *NEW* tag until leadership assigns a weight in the Voters tab.
- Identity is trust-based (anyone with the link can pick a name). Appropriate for
  a known group; the structure supports adding per-person PINs later if wanted.
- **Device lock:** once someone votes on a device, it's locked to that name (can't
  switch names and vote again). Voters **can still change their own choice** until
  the motion closes.

## Sign-in (Firebase Auth): the ED and Leadership passwords

Firestore only answers two shared accounts (see `firestore.rules`):

- `ED_EMAIL` (`ed@ed-motion-voting.app`), password = the **ED password**. Voters enter it
  once on the voting page; Firebase remembers the sign-in on that device.
- `LEADER_EMAIL` (`leadership@ed-motion-voting.app`), password = the **Leadership
  password**. Opens the settings console (`admin-9f4k2x7q.html`).

Both accounts live in Firebase → Authentication (Email/Password provider). Anonymous
sign-in is no longer accepted by the rules. `set-passwords.py` (in `MGH-ED-Tools`) creates
or updates both and verifies them.

**Rollback:** if newly published rules misbehave, put the previous version back:
Firebase console → Firestore Database → **Rules** lists every published version, so
pick the one before and publish it again. Or `git revert` the change here and deploy
again (below). Never open the database to everyone as a fix: the ballots carry names.
**Close any open motion before rolling the page back**, then roll back one step at a time:
the page first (`git revert -m 1 <merge>`), then its rules.

### Publishing the rules from the command line

`firebase.json` and `.firebaserc` point the Firebase CLI at this project
(`ed-motion-voting-99b96`) and at `firestore.rules`, so the console paste can be replaced by:

```bash
npx firebase-tools login                    # once, as the department Google account
npx firebase-tools deploy --only firestore:rules
```

`--only firestore:rules` publishes the rules and nothing else. Never publish during a
live meeting. Run `cd tests/rules && npm install && npm test` first (Firestore emulator).
The page code and the rules work in pairs: **publish the rules first**, then merge the
page change they belong to (see `CHANGES.md`). The previous page keeps working with
the new rules, so nothing breaks in between.

### After an update

- Close and reopen every console and projector tab after an update reaches the site.
  An open console also says "A newer version is available. Reload."
- Browsers keep the site's files for up to 10 minutes, so for a short time a page can
  mix old and new files and stay on "Starting...": reload it. To check a new
  version straight away, use a private window, or wait 10 minutes.
