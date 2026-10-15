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
// Two shared Firebase accounts, one per password. Nobody types these emails:
// they are fixed labels the app uses as the Firebase username, and they do not
// need to be real inboxes. The PASSWORDS are the shared secrets and live only in
// Firebase Authentication, never in this public file.
//   • LEADER_EMAIL — the Leadership password: the settings console.
//   • ED_EMAIL     — the ED password: voting (each phone remembers it).
// Keep both identical in firestore.rules.
export const LEADER_EMAIL = "leadership@ed-motion-voting.app";
export const ED_EMAIL = "ed@ed-motion-voting.app";

// ---- 3. Branding ----------------------------------------------------------
export const ORG_NAME = "MGH ED - Motion Voting";

// (Quorum is computed automatically as 50% of eligible voters — nothing to set.)
