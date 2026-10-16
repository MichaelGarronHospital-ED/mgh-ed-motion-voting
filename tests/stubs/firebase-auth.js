// In-memory stand-in for firebase-auth.js (module-compatible subset).
// A test can start the page already signed in (as if another tab had signed in)
// by setting window.__authInitial in an init script.
let current = window.__authInitial || null;
const watchers = [];
function emit() { watchers.forEach((cb) => cb(current)); }

export function getAuth() { return { __auth: true }; }
export function onAuthStateChanged(auth, cb) {
  watchers.push(cb);
  cb(current);
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
  current = { uid: email && email.startsWith("leadership") ? "leader-uid" : "ed-uid", isAnonymous: false, email };
  emit();
  return { user: current };
}
export async function signOut() { current = null; emit(); }

window.__auth = { current: () => current, force: (u) => { current = u; emit(); } };
