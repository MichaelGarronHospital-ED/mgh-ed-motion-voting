# ED Motion Voting

A free, mobile-friendly weighted-voting site for live meeting motions.
Static frontend on **GitHub Pages** + **Firebase Firestore** for real-time vote storage.

- **Voters:** `index.html` — pick your name, tap *In favour / Against / Abstain*.
- **Leadership:** `admin.html` — manage motions, see live weighted tally, quorum
  meter, per-person table + CSV export. Passcode-protected.

Weights: **Group 1 = 1 pt**, **Group 2 = ½ pt**, **Courtesy = 0**. A motion
passes when weighted *In favour* > weighted *Against*; abstentions count toward
quorum only. Quorum default = **24** eligible voters.

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
- Change `ADMIN_PASSCODE` to something only leadership knows.
- Confirm `QUORUM_THRESHOLD` (default 24).

Edit [`js/roster.js`](js/roster.js): move each name into **GROUP1 / GROUP2 / COURTESY**.
(Everyone starts in GROUP1 = 1 point. Provisional / <8 shifts / secondary-site → GROUP2. Courtesy → COURTESY.)

### 3. Publish on GitHub Pages
1. Create a new GitHub repo and upload this whole folder (or `git push`).
2. Repo **Settings → Pages → Source: Deploy from a branch → `main` / root → Save**.
3. After ~1 minute your site is live at `https://<user>.github.io/<repo>/`.
   - Voters: `…/index.html`
   - Leadership: `…/admin.html`

### 4. Test (30 seconds)
Open `admin.html`, enter the passcode → **Motions** → add a motion → **Open**.
Open `index.html` in another tab/phone, pick a name, vote. Confirm the tally
and quorum meter update live in the admin **Live results** tab.

---

## Running the meeting
1. **Add all of Friday's motions** in advance (Motions tab).
2. Share the voting link / **screen-share the QR code** (Share tab). Chat is not needed.
3. For each motion: **Open** → let people vote → watch the quorum meter hit 24 → **Close**.
4. The result appears to everyone the moment you close the motion; voters can also review all past results under their **Results** tab.
5. Move to the next motion. You can re-open any motion to re-vote. Motion wording can be edited until the first vote is cast, then it locks.
6. Afterward, **Export CSV** for the record.

## Notes
- **Duplicate detection:** one row per name. If the same name votes from two
  different devices it's **flagged for review** (highlighted in the Voters tab) —
  votes are not silently blocked, so a genuine vote change still works.
- **Write-ins:** new/unlisted members can add their name; they're recorded with
  **0 weight** and a *NEW* tag until leadership assigns a weight in the Voters tab.
- Identity is trust-based (anyone with the link can pick a name). Appropriate for
  a known group; the structure supports adding per-person PINs later if wanted.
