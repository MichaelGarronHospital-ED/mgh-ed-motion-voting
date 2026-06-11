// ============================================================================
//  CONFIG — edit these values, then redeploy.
// ============================================================================

// ---- 1. Firebase ----------------------------------------------------------
// Paste the config object from your Firebase project here.
// (Firebase console → Project settings → "Your apps" → SDK setup & config)
export const firebaseConfig = {
  apiKey: "PASTE_HERE",
  authDomain: "PASTE_HERE",
  projectId: "PASTE_HERE",
  storageBucket: "PASTE_HERE",
  messagingSenderId: "PASTE_HERE",
  appId: "PASTE_HERE",
};

// ---- 2. Admin / leadership passcode ---------------------------------------
// Anyone with this code can open the admin page (manage motions, see the
// per-person table, export). Change it before the meeting.
export const ADMIN_PASSCODE = "ed-motion-2026";

// ---- 3. Quorum ------------------------------------------------------------
// Minimum number of *eligible* voters (Group 1 + Group 2, i.e. weight > 0)
// who must cast any vote for a motion to be valid.
export const QUORUM_THRESHOLD = 24;

// ---- 4. Branding ----------------------------------------------------------
export const ORG_NAME = "Emergency Medicine — Motion Voting";
