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

// ---- 2. Sign-in (the ED tools' shared passwords) ---------------------------
// Two shared Firebase accounts, one per password. The PASSWORDS are the shared
// secrets and live only in Firebase Authentication, never in this public file.
//   • Leadership password: the settings console.
//   • ED password: voting (each phone remembers it).
// Each account is RECOGNISED by its uid (the account's fixed id, public, never
// changes), here and in firestore.rules: keep the two uids identical in both
// (a test checks). The emails are used ONLY to sign in; nobody types them and
// they are not inboxes. Never delete either account: a new one gets a new uid,
// and the rules and this file would refuse it until both are updated.
export const LEADER_UID = "3eigCLaK0RQ5PmVhxfDgI0qoYzQ2";
export const ED_UID = "CXyo7yciWpc78J1TQYRzrPpu77C3";
// The accounts' emails since the move (addresses that can never be registered).
export const LEADER_EMAIL_NEW = "leadership@mgh-ed-voting.invalid";
export const ED_EMAIL_NEW = "ed@mgh-ed-voting.invalid";
// The emails before the move. Not used any more; kept for one release so a
// cached step-9 js/db.js that still imports them keeps loading. Remove next time.
export const LEADER_EMAIL = "leadership@ed-motion-voting.app";
export const ED_EMAIL = "ed@ed-motion-voting.app";

// ---- 3. Branding ----------------------------------------------------------
export const ORG_NAME = "MGH ED - Motion Voting";

// (Quorum is computed automatically as 50% of eligible voters — nothing to set.)
