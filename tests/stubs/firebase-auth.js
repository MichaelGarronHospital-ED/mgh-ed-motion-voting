// In-memory stand-in for firebase-auth.js (module-compatible subset).
// A test can start the page already signed in (as if another tab had signed in)
// by setting window.__authInitial in an init script.
let current = window.__authInitial || null;
const watchers = [];
function emit() { watchers.forEach((cb) => cb(current)); }

export function getAuth() { return { __auth: true }; }
export function onAuthStateChanged(auth, cb) {
  watchers.push(cb);
  // Like the real SDK, the first call comes after the caller's code has run
  // (Firebase first restores the saved sign-in), never during the subscribe.
  Promise.resolve().then(() => { if (watchers.includes(cb)) cb(current); });
  return () => { const i = watchers.indexOf(cb); if (i >= 0) watchers.splice(i, 1); };
}
export async function signInAnonymously() {
  current = { uid: "anon-" + Math.random().toString(36).slice(2, 8), isAnonymous: true, email: null };
  emit();
  return { user: current };
}
export async function signInWithEmailAndPassword(auth, email, password) {
  // The harness accepts whatever the page sends; rule enforcement is not modelled.
  // window.__authReject = true makes every sign-in fail like a wrong password,
  // the way Firebase answers once email-enumeration protection is on.
  window.__lastPassword = password;
  if (!password || window.__authReject) { const e = new Error("bad password"); e.code = "auth/invalid-credential"; throw e; }
  // The two accounts' real uids (the same as js/config.js and firestore.rules;
  // test_accounts.py checks). The page recognises them by uid, never by email.
  window.__lastEmail = email;
  current = { uid: email && email.startsWith("leadership") ? "3eigCLaK0RQ5PmVhxfDgI0qoYzQ2" : "CXyo7yciWpc78J1TQYRzrPpu77C3", isAnonymous: false, email };
  emit();
  return { user: current };
}
export async function signOut() { current = null; emit(); }

window.__auth = { current: () => current, force: (u) => { current = u; emit(); } };
