// ============================================================================
//  CONFIG — edit these values, then redeploy.
// ============================================================================

// ---- 1. Firebase ----------------------------------------------------------
// Paste the config object from your Firebase project here.
// (Firebase console → Project settings → "Your apps" → SDK setup & config)
export const firebaseConfig = {
  apiKey: "AIzaSyD1IvlP16tceVfwMUHEvrMrxKf5BVZIok0",
  authDomain: "ed-motion-voting-99b96.firebaseapp.com",
  projectId: "ed-motion-voting-99b96",
  storageBucket: "ed-motion-voting-99b96.firebasestorage.app",
  messagingSenderId: "121642121257",
  appId: "1:121642121257:web:5ef04d3e13f0b84983c438"
};

// ---- 2. Admin / leadership passcode ---------------------------------------
// Anyone with this code can open the admin page (manage motions, see the
// per-person table, export). Shared "admin" code across the ED tools.
// Stored as a SHA-256 HASH so the shared code is NOT readable in this public
// source (it's also the interviews admin code). Admins type the plaintext code;
// the gate hashes it and compares. To change it, run:
//   python3 -c "import hashlib;print(hashlib.sha256(b'YOUR-CODE').hexdigest())"
// NOTE: if you use the locked Firebase backend, update the LEADER_EMAIL Auth
// user's password in the console to match the plaintext code (see README).
export const ADMIN_PASSCODE_SHA256 = "d9a577b3bdf03c3881e0947775924d007c5656ad2043398694626179c9a65b88";

// Leadership identity for the (optional) Firebase-auth backend lockdown.
// This is a SHARED account label — leadership only ever types the passcode;
// this email is used silently as the Firebase username (nobody sees/types it).
// It doesn't need to be a real inbox. Create a matching Firebase Auth user
// (this email + password = the plaintext admin code) and keep it identical in
// firestore.rules. See README.
export const LEADER_EMAIL = "leadership@ed-motion-voting.app";

// ---- 3. Branding ----------------------------------------------------------
export const ORG_NAME = "MGH ED - Motion Voting";

// (Quorum is computed automatically as 50% of eligible voters — nothing to set.)
