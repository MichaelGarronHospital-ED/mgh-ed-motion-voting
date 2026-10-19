// In-memory stand-in for firebase-firestore.js (module-compatible subset).
// Only the surface the app uses, but with the behaviour that matters for it:
//
//  - Two copies of the data, like the real SDK: the SERVER (what is committed)
//    and the LOCAL view (server plus this page's writes still waiting to be
//    confirmed). Listeners see the local view, with
//    metadata.hasPendingWrites while a write of theirs is waiting.
//  - serverTimestamp() is a placeholder in the app's hands. In the local view
//    it reads as null; it becomes a real time only when the write commits, as
//    in real Firestore. A server time inside an array is refused, as real
//    Firestore refuses it.
//  - The FIRST snapshot of every listener is asynchronous, so a page renders
//    once with no data before any arrives (where "empty shown as a real
//    result" bugs live).
//  - setDoc(..., {merge:true}) deep-merges maps; updateDoc sets each field path
//    (a dotted string or a FieldPath) and replaces the value there.
//
// Test hooks live on window.__store (see the bottom of this file).

const SERVER = new Map();   // path -> data, as committed
let LOCAL = new Map();      // SERVER plus pending writes (server times as null)
const VERS = new Map();     // path -> version number, bumped on every server change
let PENDING = [];           // [{ ops, resolve, reject }], in commit order
const LISTENERS = [];       // { ref, cb, err, meta, live, ... }
const READS = [];           // document paths delivered by reads and snapshots (not from cache)
const WRITES = [];          // document paths written to the server
let autoId = 0;
let lastMs = 0;
let OFFLINE = false;
const FAILS = [];           // { prefix, code, kinds }
const STALLED = new Set();
let STALL_WAITERS = [];     // reads waiting on a stall
let ORDER = [];             // path prefixes whose first snapshots arrive in this order
const LATENCY = 2;          // ms before a write is confirmed by the "server"

const INC = Symbol("inc");
const TS = Symbol("ts");
const DEL = Symbol("del");

export function increment(n) { return { __k: INC, n }; }
export function serverTimestamp() { return { __k: TS }; }
export function deleteField() { return { __k: DEL }; }
export class FieldPath { constructor(...segs) { this.__fp = segs; } }
export function documentId() { return "__name__"; }

function isSentinel(v) { return !!v && typeof v === "object" && (v.__k === INC || v.__k === TS || v.__k === DEL); }
function isDel(v) { return isSentinel(v) && v.__k === DEL; }
function plainObj(v) { return !!v && typeof v === "object" && !Array.isArray(v) && !isSentinel(v) && !(v instanceof FieldPath); }
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function makeTs() {
  const ms = Math.max(Date.now(), lastMs + 1);
  lastMs = ms;
  return { __ts: ms, seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}
function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function hasSentinel(v) {
  if (isSentinel(v)) return true;
  if (Array.isArray(v)) return v.some(hasSentinel);
  if (plainObj(v)) return Object.values(v).some(hasSentinel);
  return false;
}

// Resolve increment()/serverTimestamp() against the value already there.
// mode "server": a real time; mode "local": null, as the SDK shows it pending.
function resolve(value, prev, mode) {
  if (isSentinel(value)) {
    if (value.__k === INC) return (typeof prev === "number" ? prev : 0) + value.n;
    if (value.__k === TS) return mode === "server" ? makeTs() : null;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.some(hasSentinel)) throw err("invalid-argument", "serverTimestamp() and other special values are not supported inside arrays");
    return clone(value);
  }
  if (plainObj(value)) {
    const out = {};
    for (const k of Object.keys(value)) {
      if (isDel(value[k]) || value[k] === undefined) continue;
      out[k] = resolve(value[k], prev && prev[k], mode);
    }
    return out;
  }
  return value;
}
function deepMerge(base, patch, mode) {
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isDel(v)) { delete out[k]; continue; }
    if (v === undefined) continue;
    out[k] = plainObj(v) && plainObj(out[k]) ? deepMerge(out[k], v, mode) : resolve(v, out[k], mode);
  }
  return out;
}
function setIn(obj, segs, value, mode) {
  let o = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!plainObj(o[segs[i]])) o[segs[i]] = {};
    o = o[segs[i]];
  }
  const last = segs[segs.length - 1];
  if (isDel(value)) delete o[last];
  else o[last] = resolve(value, o[last], mode);
}

// Update arguments: an object (dotted keys are field paths) or field/value
// pairs (strings, which may be dotted, or FieldPath).
function fieldPairs(args) {
  if (args.length === 1 && plainObj(args[0])) {
    return Object.keys(args[0]).map((k) => [k.split("."), args[0][k]]);
  }
  const out = [];
  for (let i = 0; i < args.length; i += 2) {
    const f = args[i];
    out.push([f instanceof FieldPath ? f.__fp : String(f).split("."), args[i + 1]]);
  }
  return out;
}

function applyOp(map, op, mode) {
  const prev = map.get(op.path);
  if (op.type === "set") {
    map.set(op.path, op.merge && prev ? deepMerge(prev, op.data, mode) : resolve(op.data, prev, mode));
  } else if (op.type === "update") {
    if (!prev) throw err("not-found", "No document to update: " + op.path);
    const next = clone(prev);
    for (const [segs, v] of op.fields) setIn(next, segs, v, mode);
    map.set(op.path, next);
  } else if (op.type === "delete") {
    map.delete(op.path);
  }
}
function cloneMap(m) { const out = new Map(); for (const [k, v] of m) out.set(k, clone(v)); return out; }
function checkOps(ops) {
  for (const op of ops) {
    if (op.type === "set") resolve(op.data, undefined, "local");
    if (op.type === "update") op.fields.forEach(([, v]) => resolve(v, undefined, "local"));
  }
}

function under(path, prefix) { return path === prefix || path.startsWith(prefix + "/"); }
function failFor(path, kind) {
  for (const f of FAILS) if (f.kinds.includes(kind) && under(path, f.prefix)) return f.code;
  return closedBallots(path, kind);
}
// The one read rule the pages must respect (firestore.rules, voting-14): a
// motion's ballots are readable by the ED account only while it is open; the
// Admin account (leadership@, by uid) reads them always.
function closedBallots(path, kind) {
  if (kind !== "r") return null;
  const m = /^polls\/([^/]+)\/votes(\/|$)/.exec(path);
  if (!m) return null;
  const who = window.__auth && window.__auth.current ? window.__auth.current() : null;
  if (who && who.uid === "3eigCLaK0RQ5PmVhxfDgI0qoYzQ2") return null;
  const poll = SERVER.get(`polls/${m[1]}`);
  return poll && poll.status === "open" ? null : "permission-denied";
}
function isStalled(path) {
  for (const p of STALLED) if (path === p || path.startsWith(p)) return true;
  return false;
}
function waitStall(path) {
  if (!isStalled(path)) return Promise.resolve();
  return new Promise((res) => STALL_WAITERS.push({ path, res }));
}

function recomputeLocal() {
  LOCAL = cloneMap(SERVER);
  for (const p of PENDING) for (const op of p.ops) { try { applyOp(LOCAL, op, "local"); } catch (e) { /* refused when it commits */ } }
}
function pendingPaths() {
  const s = new Set();
  for (const p of PENDING) for (const op of p.ops) s.add(op.path);
  return s;
}

// Commit ops to the server atomically; throws without changing anything.
function commitToServer(ops) {
  for (const op of ops) {
    const code = failFor(op.path, "w");
    if (code) throw err(code, `${code}: ${op.path}`);
  }
  const next = cloneMap(SERVER);
  for (const op of ops) applyOp(next, op, "server");
  for (const op of ops) {
    if (next.has(op.path)) SERVER.set(op.path, next.get(op.path)); else SERVER.delete(op.path);
    VERS.set(op.path, (VERS.get(op.path) || 0) + 1);
    WRITES.push(op.path);
  }
}

let flushT = null;
function scheduleFlush() {
  if (OFFLINE || flushT) return;
  flushT = setTimeout(flush, LATENCY);
}
function flush() {
  flushT = null;
  if (OFFLINE) return;
  const batch = PENDING;
  PENDING = [];
  const done = [];
  for (const p of batch) {
    try { commitToServer(p.ops); done.push(() => p.resolve()); }
    catch (e) { done.push(() => p.reject(e)); }
  }
  recomputeLocal();
  notify();
  done.forEach((f) => f());
}
function enqueue(ops) {
  try { checkOps(ops); } catch (e) { return Promise.reject(e); }
  return new Promise((resolveP, rejectP) => {
    PENDING.push({ ops, resolve: resolveP, reject: rejectP });
    recomputeLocal();
    notify();
    scheduleFlush();
  });
}

export function initializeApp(cfg) { return { cfg }; }
export function getFirestore() { return { __db: true }; }

export function collection(dbOrRef, ...segs) {
  const base = dbOrRef && dbOrRef.__path ? dbOrRef.__path.split("/") : [];
  return { __col: true, __path: [...base, ...segs].join("/"), __mods: [] };
}
export function doc(dbOrRef, ...segs) {
  let path;
  if (dbOrRef && dbOrRef.__col && segs.length === 0) path = `${dbOrRef.__path}/auto-${++autoId}`;
  else {
    const base = dbOrRef && dbOrRef.__path ? dbOrRef.__path.split("/") : [];
    path = [...base, ...segs].join("/");
  }
  return { __doc: true, __path: path, id: path.split("/").pop() };
}
export function query(ref, ...mods) {
  return { __col: true, __path: ref.__path, __mods: [...(ref.__mods || []), ...mods.filter(Boolean)] };
}
export function orderBy(field, dir = "asc") { return { __order: field, dir }; }
export function where(field, op, value) { return { __where: field, op, value }; }
export function limit(n) { return { __limit: n }; }
export function startAfter(v) { return { __startAfter: v }; }

function tsMs(v) {
  if (v instanceof Date) return v.getTime();
  return v && typeof v === "object" && ("__ts" in v || "seconds" in v) ? (v.__ts ?? v.seconds * 1000) : v;
}
function cmp(x, y) {
  x = tsMs(x); y = tsMs(y);
  if (x === undefined && typeof y === "number") x = 0;
  if (y === undefined && typeof x === "number") y = 0;
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x).localeCompare(String(y));
}
function getField(d, f) { return f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d); }
function matches(d, w) {
  const v = getField(d, w.__where);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (w.op === "==") return v !== undefined && same(v, w.value);
  if (w.op === "!=") return v !== undefined && !same(v, w.value);
  if (w.op === "in") return v !== undefined && w.value.some((x) => same(x, v));
  if (v === undefined) return false;
  if (w.op === "<") return cmp(v, w.value) < 0;
  if (w.op === "<=") return cmp(v, w.value) <= 0;
  if (w.op === ">") return cmp(v, w.value) > 0;
  if (w.op === ">=") return cmp(v, w.value) >= 0;
  return false;
}

function docSnap(map, path, meta) {
  const data = map.get(path);
  return {
    id: path.split("/").pop(),
    ref: { __doc: true, __path: path, id: path.split("/").pop() },
    exists: () => map.has(path),
    data: () => (data ? clone(data) : undefined),
    get: (f) => (data ? clone(getField(data, f)) : undefined),
    metadata: meta,
  };
}
// Direct children of a collection path (not grandchildren), filtered and sorted.
function childPaths(map, ref) {
  const colPath = ref.__path;
  const depth = colPath.split("/").length + 1;
  let paths = [...map.keys()].filter((p) => p.startsWith(colPath + "/") && p.split("/").length === depth);
  const mods = ref.__mods || [];
  for (const w of mods.filter((m) => m.__where)) paths = paths.filter((p) => matches(map.get(p), w));
  const orders = mods.filter((m) => m.__order);
  if (orders.length) {
    paths.sort((a, b) => {
      for (const o of orders) {
        const c = o.__order === "__name__" ? a.localeCompare(b) : cmp(getField(map.get(a), o.__order), getField(map.get(b), o.__order));
        if (c) return o.dir === "desc" ? -c : c;
      }
      return 0;
    });
  }
  const sa = mods.find((m) => m.__startAfter);
  if (sa) {
    const after = sa.__startAfter && sa.__startAfter.ref ? sa.__startAfter.ref.__path : null;
    const i = after ? paths.indexOf(after) : -1;
    if (i >= 0) paths = paths.slice(i + 1);
  }
  const lim = mods.find((m) => m.__limit);
  if (lim) paths = paths.slice(0, lim.__limit);
  return paths;
}
function colSnap(map, ref, meta, pend) {
  const docs = childPaths(map, ref).map((p) => docSnap(map, p, { fromCache: meta.fromCache, hasPendingWrites: pend ? pend.has(p) : false }));
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (f) => docs.forEach(f), metadata: meta, query: ref };
}
function noteReads(paths, colPath) {
  if (!paths.length && colPath) READS.push(colPath + "/(empty)");
  paths.forEach((p) => READS.push(p));
}

// ---- listeners ---------------------------------------------------------------
function deliver(l, force) {
  if (!l.live || l.waitingFirst || isStalled(l.ref.__path)) return;
  const code = failFor(l.ref.__path, "r");
  if (code) {
    l.live = false;
    if (l.err) l.err(err(code, `${code}: ${l.ref.__path}`));
    return;
  }
  const pend = pendingPaths();
  const ref = l.ref;
  let snap, paths;
  if (ref.__col) {
    paths = childPaths(LOCAL, ref);
    snap = colSnap(LOCAL, ref, { fromCache: OFFLINE, hasPendingWrites: paths.some((p) => pend.has(p)) }, pend);
  } else {
    paths = [ref.__path];
    snap = docSnap(LOCAL, ref.__path, { fromCache: OFFLINE, hasPendingWrites: pend.has(ref.__path) });
  }
  const docs = {};
  paths.forEach((p) => { docs[p] = JSON.stringify(LOCAL.has(p) ? LOCAL.get(p) : null); });
  const dataSig = JSON.stringify(docs);
  const metaSig = JSON.stringify([snap.metadata, paths.map((p) => pend.has(p))]);
  const dataChanged = dataSig !== l.lastDataSig;
  const metaChanged = metaSig !== l.lastMetaSig;
  if (!force && !dataChanged && !(l.meta && metaChanged)) return;
  if (!OFFLINE) {
    if (!l.lastDocs) noteReads(paths, ref.__col ? ref.__path : null);
    else paths.filter((p) => l.lastDocs[p] !== docs[p]).forEach((p) => READS.push(p));
    l.lastDocs = docs;
  }
  l.lastDataSig = dataSig;
  l.lastMetaSig = metaSig;
  try { l.cb(snap); } catch (e) { setTimeout(() => { throw e; }, 0); }
}
function notify() { [...LISTENERS].forEach((l) => deliver(l, false)); }

// onSnapshot(ref, cb) | (ref, options, cb) | (ref, cb, errCb) | (ref, options, cb, errCb)
// | (ref, observer) | (ref, options, observer)
export function onSnapshot(ref, ...args) {
  let options = {};
  const isObserver = (o) => !!o && typeof o === "object" && (typeof o.next === "function" || typeof o.error === "function");
  if (args[0] && typeof args[0] === "object" && !isObserver(args[0])) options = args.shift();
  let next, error;
  if (isObserver(args[0])) { next = args[0].next; error = args[0].error; }
  else { next = args[0]; error = args[1]; }
  const l = { ref, cb: next || (() => {}), err: error, meta: !!options.includeMetadataChanges, live: true, waitingFirst: true };
  LISTENERS.push(l);
  const idx = ORDER.findIndex((p) => under(ref.__path, p));
  setTimeout(() => { l.waitingFirst = false; deliver(l, true); }, idx >= 0 ? (idx + 1) * 40 : 0);
  return () => { l.live = false; const i = LISTENERS.indexOf(l); if (i >= 0) LISTENERS.splice(i, 1); };
}

// ---- one-time reads ----------------------------------------------------------
async function readCheck(path) {
  await waitStall(path);
  const code = failFor(path, "r");
  if (code) throw err(code, `${code}: ${path}`);
}
export async function getDoc(ref) {
  await readCheck(ref.__path);
  const meta = { fromCache: OFFLINE, hasPendingWrites: pendingPaths().has(ref.__path) };
  if (OFFLINE && !LOCAL.has(ref.__path)) throw err("unavailable", "Failed to get document because the client is offline.");
  if (!OFFLINE) READS.push(ref.__path);
  return docSnap(LOCAL, ref.__path, meta);
}
export async function getDocs(ref) {
  await readCheck(ref.__path);
  const snap = colSnap(LOCAL, ref, { fromCache: OFFLINE, hasPendingWrites: false }, pendingPaths());
  if (!OFFLINE) noteReads(snap.docs.map((d) => d.ref.__path), ref.__path);
  return snap;
}
export async function getDocFromServer(ref) {
  await readCheck(ref.__path);
  if (OFFLINE) throw err("unavailable", "Failed to get document from server.");
  READS.push(ref.__path);
  return docSnap(SERVER, ref.__path, { fromCache: false, hasPendingWrites: false });
}
export async function getDocsFromServer(ref) {
  await readCheck(ref.__path);
  if (OFFLINE) throw err("unavailable", "Failed to get documents from server.");
  const snap = colSnap(SERVER, ref, { fromCache: false, hasPendingWrites: false }, null);
  noteReads(snap.docs.map((d) => d.ref.__path), ref.__path);
  return snap;
}

// ---- writes ------------------------------------------------------------------
function setOp(ref, data, opts) { return { type: "set", path: ref.__path, data, merge: !!(opts && opts.merge) }; }
function updOp(ref, args) { return { type: "update", path: ref.__path, fields: fieldPairs(args) }; }
export function setDoc(ref, data, opts) { return enqueue([setOp(ref, data, opts)]); }
export function updateDoc(ref, ...args) { return enqueue([updOp(ref, args)]); }
export function deleteDoc(ref) { return enqueue([{ type: "delete", path: ref.__path }]); }
export async function addDoc(colRef, data) { const ref = doc(colRef); await setDoc(ref, data); return ref; }

export function writeBatch() {
  const ops = [];
  const b = {
    set: (ref, data, opts) => { ops.push(setOp(ref, data, opts)); return b; },
    update: (ref, ...args) => { ops.push(updOp(ref, args)); return b; },
    delete: (ref) => { ops.push({ type: "delete", path: ref.__path }); return b; },
    commit: () => enqueue(ops),
  };
  return b;
}

// Transactions read from the server and commit straight to it. Like the real
// SDK they fail at once when offline (never queued), and are re-run if a
// document they read changed before they committed.
export async function runTransaction(db, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (OFFLINE) throw err("unavailable", "Transaction failed: the client is offline.");
    const seen = new Map();
    const ops = [];
    const tx = {
      get: async (ref) => {
        await readCheck(ref.__path);
        if (OFFLINE) throw err("unavailable", "Transaction failed: the client is offline.");
        seen.set(ref.__path, VERS.get(ref.__path) || 0);
        READS.push(ref.__path);
        return docSnap(SERVER, ref.__path, { fromCache: false, hasPendingWrites: false });
      },
      set: (ref, data, opts) => { ops.push(setOp(ref, data, opts)); return tx; },
      update: (ref, ...args) => { ops.push(updOp(ref, args)); return tx; },
      delete: (ref) => { ops.push({ type: "delete", path: ref.__path }); return tx; },
    };
    const r = await fn(tx);
    if (OFFLINE) throw err("unavailable", "Transaction failed: the client is offline.");
    let stale = false;
    for (const [p, v] of seen) if ((VERS.get(p) || 0) !== v) stale = true;
    if (stale) continue;
    checkOps(ops);
    if (ops.length) {
      commitToServer(ops);
      recomputeLocal();
      notify();
    }
    return r;
  }
  throw err("aborted", "Transaction failed after too many attempts.");
}

// ---- test hooks (not part of the real SDK) --------------------------------
function serverSet(p, v) {
  if (v === null || v === undefined) SERVER.delete(p); else SERVER.set(p, clone(v));
  VERS.set(p, (VERS.get(p) || 0) + 1);
  recomputeLocal();
  notify();
}
window.__store = {
  dump: () => Object.fromEntries([...SERVER.entries()].map(([k, v]) => [k, clone(v)])),
  get: (p) => (SERVER.has(p) ? clone(SERVER.get(p)) : null),
  local: (p) => (LOCAL.has(p) ? clone(LOCAL.get(p)) : null),
  // Write straight to the server, as another device would.
  set: (p, v) => serverSet(p, v),
  del: (p) => serverSet(p, null),
  reset: () => { SERVER.clear(); recomputeLocal(); notify(); },
  listeners: () => ({ docs: LISTENERS.filter((l) => l.ref.__doc).length, cols: LISTENERS.filter((l) => l.ref.__col).length }),
  listenerPaths: () => LISTENERS.map((l) => l.ref.__path),
  // Hold back snapshots and one-time reads for a path prefix; deliver them on release.
  stall: (prefix) => { STALLED.add(prefix); },
  release: (prefix) => {
    STALLED.delete(prefix);
    const still = [];
    STALL_WAITERS.forEach((w) => (isStalled(w.path) ? still.push(w) : w.res()));
    STALL_WAITERS = still;
    notify();
  },
  // Deliver the first snapshots of these path prefixes in this order (40 ms apart).
  order: (paths) => { ORDER = paths.slice(); },
  // Make listeners, reads and writes under a path fail with this code
  // ("permission-denied", "unavailable", ...). kinds: "rw" (default), "r" or "w".
  fail: (prefix, code, kinds = "rw") => { FAILS.push({ prefix, code, kinds }); notify(); },
  unfail: (prefix) => { for (let i = FAILS.length - 1; i >= 0; i--) if (FAILS[i].prefix === prefix) FAILS.splice(i, 1); },
  // Offline: snapshots come from the cache, server reads and transactions fail
  // with "unavailable", and writes wait until the connection is back.
  offline: (on) => { OFFLINE = !!on; notify(); if (!OFFLINE) scheduleFlush(); },
  isOffline: () => OFFLINE,
  pending: () => PENDING.length,
  // Documents delivered to the page by reads and snapshots (not from the cache).
  reads: (prefix = "") => READS.filter((p) => p.startsWith(prefix)).length,
  readPaths: (prefix = "") => READS.filter((p) => p.startsWith(prefix)),
  writes: (prefix = "") => WRITES.filter((p) => p.startsWith(prefix)).length,
  writePaths: (prefix = "") => WRITES.filter((p) => p.startsWith(prefix)),
  resetCounts: () => { READS.length = 0; WRITES.length = 0; },
  // A server time like the ones the stub makes, for seeding.
  ts: (ms) => ({ __ts: ms, seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 }),
};
