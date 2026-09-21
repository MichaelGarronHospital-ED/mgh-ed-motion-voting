// In-memory stand-in for firebase-firestore.js (module-compatible subset).
// Only the surface tools/motion-voting/js/db.js actually uses.
const STORE = new Map();          // "polls/ID" | "polls/ID/votes/SLUG" | "config/roster" -> data
const DOC_LISTENERS = [];         // {path, cb}
const COL_LISTENERS = [];         // {path, cb, order}
let autoId = 0;

const INC = Symbol("inc");
const TS = Symbol("ts");

export function increment(n) { return { __k: INC, n }; }
export function serverTimestamp() { return { __k: TS }; }

function isSentinel(v) { return v && typeof v === "object" && (v.__k === INC || v.__k === TS); }
function plainObj(v) { return v && typeof v === "object" && !Array.isArray(v) && !isSentinel(v); }

// Resolve increment()/serverTimestamp() against the value already stored.
function resolve(value, prev) {
  if (isSentinel(value)) {
    if (value.__k === INC) return (typeof prev === "number" ? prev : 0) + value.n;
    return { __ts: ++autoId };                       // monotonic fake timestamp
  }
  if (plainObj(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolve(value[k], prev && prev[k]);
    return out;
  }
  return value;
}

// Firestore's setDoc(..., {merge:true}) DEEP-merges nested maps; updateDoc does
// a field-path (shallow per top-level key) write. Both are reproduced here
// because the difference is load-bearing in this codebase.
function deepMerge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    out[k] = plainObj(v) && plainObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function initializeApp(cfg) { return { cfg }; }
export function getFirestore() { return { __db: true }; }

export function collection(dbOrRef, ...segs) {
  const base = dbOrRef && dbOrRef.__path ? dbOrRef.__path.split("/") : [];
  return { __col: true, __path: [...base, ...segs].join("/") };
}
export function doc(dbOrRef, ...segs) {
  if (dbOrRef && dbOrRef.__col && segs.length === 0) {
    return { __doc: true, __path: `${dbOrRef.__path}/auto-${++autoId}` };
  }
  const base = dbOrRef && dbOrRef.__path ? dbOrRef.__path.split("/") : [];
  return { __doc: true, __path: [...base, ...segs].join("/") };
}
export function query(ref, ...mods) {
  return { __col: true, __path: ref.__path, __order: mods.find((m) => m && m.__order)?.__order };
}
export function orderBy(field) { return { __order: field }; }

function docSnap(path) {
  const data = STORE.get(path);
  return {
    id: path.split("/").pop(),
    ref: { __doc: true, __path: path },
    exists: () => STORE.has(path),
    data: () => (data ? clone(data) : undefined),
  };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Direct children of a collection path (not grandchildren).
function childDocs(colPath, order) {
  const depth = colPath.split("/").length + 1;
  let paths = [...STORE.keys()].filter(
    (p) => p.startsWith(colPath + "/") && p.split("/").length === depth
  );
  if (order) {
    paths = paths.sort((a, b) => {
      const x = STORE.get(a)[order], y = STORE.get(b)[order];
      return (x === undefined ? 0 : x) - (y === undefined ? 0 : y);
    });
  }
  return paths.map(docSnap);
}
function colSnap(colPath, order) {
  const docs = childDocs(colPath, order);
  return { docs, size: docs.length, forEach: (f) => docs.forEach(f), empty: docs.length === 0 };
}

// Paths whose snapshots are held back until released, so a test can pin the
// app in its "subscribed but no data yet" state instead of racing timers.
const STALLED = new Set();
function isStalled(path) {
  for (const p of STALLED) if (path === p || path.startsWith(p)) return true;
  return false;
}

function notify() {
  for (const l of DOC_LISTENERS) if (!isStalled(l.path)) l.cb(docSnap(l.path));
  for (const l of COL_LISTENERS) if (!isStalled(l.path)) l.cb(colSnap(l.path, l.order));
}

// Real Firestore always delivers the FIRST snapshot asynchronously, so a page
// renders once with no data before any arrives. That ordering is reproduced
// here deliberately — it is where "empty state shown as a real result" bugs live.
export function onSnapshot(ref, cb) {
  let live = true;
  const l = ref.__col
    ? { path: ref.__path, cb, order: ref.__order }
    : { path: ref.__path, cb };
  const list = ref.__col ? COL_LISTENERS : DOC_LISTENERS;
  const snap = () => (ref.__col ? colSnap(l.path, l.order) : docSnap(l.path));
  list.push(l);
  setTimeout(() => { if (live && !isStalled(l.path)) cb(snap()); }, 0);
  return () => { live = false; const i = list.indexOf(l); if (i >= 0) list.splice(i, 1); };
}

export async function getDocs(ref) { return colSnap(ref.__path, ref.__order); }
export async function getDoc(ref) { return docSnap(ref.__path); }

export async function setDoc(ref, data, opts) {
  const prev = STORE.get(ref.__path);
  const resolved = resolve(data, prev);
  STORE.set(ref.__path, opts && opts.merge && prev ? deepMerge(prev, resolved) : resolved);
  notify();
}
export async function updateDoc(ref, patch) {
  const prev = STORE.get(ref.__path);
  if (!prev) throw new Error("No document to update: " + ref.__path);
  STORE.set(ref.__path, { ...prev, ...resolve(patch, prev) });
  notify();
}
export async function deleteDoc(ref) { STORE.delete(ref.__path); notify(); }

export async function runTransaction(db, fn) {
  // Single-threaded harness: run the body against the live store, then notify once.
  const tx = {
    get: async (ref) => docSnap(ref.__path),
    set: (ref, data) => { STORE.set(ref.__path, resolve(data, STORE.get(ref.__path))); },
    update: (ref, patch) => {
      const prev = STORE.get(ref.__path);
      if (!prev) throw new Error("No document to update: " + ref.__path);
      STORE.set(ref.__path, { ...prev, ...resolve(patch, prev) });
    },
    delete: (ref) => { STORE.delete(ref.__path); },
  };
  const r = await fn(tx);
  notify();
  return r;
}

// ---- test hooks (not part of the real SDK) --------------------------------
window.__store = {
  dump: () => Object.fromEntries([...STORE.entries()].map(([k, v]) => [k, clone(v)])),
  get: (p) => (STORE.has(p) ? clone(STORE.get(p)) : null),
  set: (p, v) => { STORE.set(p, v); notify(); },
  del: (p) => { STORE.delete(p); notify(); },
  reset: () => { STORE.clear(); notify(); },
  listeners: () => ({ docs: DOC_LISTENERS.length, cols: COL_LISTENERS.length }),
  // Hold back snapshots for a path prefix, then deliver them on release.
  stall: (prefix) => { STALLED.add(prefix); },
  release: (prefix) => { STALLED.delete(prefix); notify(); },
};
