// Stand-in for Firebase Auth when the rules tests load js/db.js. The sign-in
// the rules see comes from the test context the test picks (see helpers.mjs).
export function getAuth() { return {}; }
export function onAuthStateChanged() { return () => {}; }
export async function signInWithEmailAndPassword() { throw new Error("no sign-in in rules tests"); }
export async function signOut() {}
