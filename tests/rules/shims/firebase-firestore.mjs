// The real Firestore SDK (from node_modules), except getFirestore: js/db.js
// gets an object that points at whichever emulator test context the test set
// in globalThis.__appDb (so the same page code runs as leadership or as ED).
// It never reaches the live project: there is no live config here at all.
export * from "firebase/firestore";
export function getFirestore() {
  return {
    get _delegate() {
      const d = globalThis.__appDb;
      if (!d) throw new Error("rules test: set globalThis.__appDb first");
      return d._delegate || d;
    },
  };
}
