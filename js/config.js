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
// per-person table, export). Change it before the meeting.
export const ADMIN_PASSCODE = "edleadership";

// Leadership identity for the (optional) Firebase-auth backend lockdown.
// The admin page signs in to Firebase as this email using the passcode above
// as the password. Create a matching Firebase Auth user (email + password =
// ADMIN_PASSCODE) and put this same email in firestore.rules. See README.
export const LEADER_EMAIL = "alvinyang@live.ca";

// ---- 3. Quorum ------------------------------------------------------------
// Minimum number of *eligible* voters (Group 1 + Group 2, i.e. weight > 0)
// who must cast any vote for a motion to be valid.
export const QUORUM_THRESHOLD = 24;

// ---- 4. Branding ----------------------------------------------------------
export const ORG_NAME = "MGH ED - Motion Voting";
