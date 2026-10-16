// ============================================================================
//  DATA LAYER: Firebase Firestore (real-time). Counting lives in count.js.
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, runTransaction, serverTimestamp, getDocs, increment,
  writeBatch, deleteField, getDocFromServer, getDocsFromServer, FieldPath, where, getDoc, startAfter,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, LEADER_EMAIL, ED_EMAIL } from "./config.js";
import { ROSTER, ROSTER_BY_SLUG, WEIGHTS, slugify } from "./roster.js";
import {
  tallyVotes, computeResult, ruleFor, ruleFromSettings, copyRule, weightIn, quorumNeededFor, sameTime, tsMillis, localDate,
} from "./count.js";
import { buildBoard, buildHistory, boardPatch, sameBoard } from "./board.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---- auth ------------------------------------------------------------------
// Two shared accounts, one per password (config.js): ED_EMAIL for voters (the ED
// password) and LEADER_EMAIL for leadership (the Leadership password). The rules
// accept only these two, so the password is enforced by the server, not just by
// the screen. Firebase keeps the sign-in on the device, so a phone that has
// entered the ED password once goes straight to the ballot afterwards.
//
// Firebase keeps ONE sign-in per browser for the whole site, shared by every tab.
// A leadership session therefore also counts as a member on the voter page (a
// chair voting on the console laptop must not be signed out of the console).
export function watchAuth(cb) { return onAuthStateChanged(auth, cb); }
export const isMember = (u) => !!u && !u.isAnonymous && (u.email === ED_EMAIL || u.email === LEADER_EMAIL);
// Calls cb(user) whenever the member state changes: the user when signed in as
// ED or leadership, null otherwise (signed out, or an old anonymous session).
export function watchMember(cb) { return onAuthStateChanged(auth, (u) => cb(isMember(u) ? u : null)); }
export function voterSignIn(password) { return signInWithEmailAndPassword(auth, ED_EMAIL, password); }
export function leaderSignIn(password) { return signInWithEmailAndPassword(auth, LEADER_EMAIL, password); }
export function leaderSignOut() { return signOut(auth); }
// Was this a wrong password (as opposed to no connection, or throttling)?
export function isWrongPassword(e) {
  const c = (e && e.code) || "";
  return c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("user-not-found") || c.includes("invalid-login");
}
export { LEADER_EMAIL, ED_EMAIL };

// References are made when used (not once at load), so the rules tests can
// run this file against the emulator with a different sign-in per test.
const pollsCol = () => collection(db, "polls");
const pollRef = (id) => doc(db, "polls", id);
const votesCol = (id) => collection(db, "polls", id, "votes");
const logCol = () => collection(db, "log");
const rosterRef = () => doc(db, "config", "roster");
const liveRef = () => doc(db, "config", "live");
const historyRef = () => doc(db, "config", "history");

// ---- errors ------------------------------------------------------------------
// Every Firestore error is one of: "refused" (the rules said no, or the sign-in
// is gone), "offline" (no connection, or no answer in time), or "other".
export function classify(e) {
  const c = String((e && e.code) || "").replace(/^firestore\//, "");
  if (c === "permission-denied" || c === "unauthenticated") return "refused";
  if (c === "unavailable" || c === "deadline-exceeded" || c === "timeout") return "offline";
  return "other";
}
// Reject with code "timeout" if p takes longer than ms.
export function withTimeout(p, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error("timeout"); e.code = "timeout"; rej(e); }, ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}
export const DB_UPDATE_MSG = "This page needs a database update that has not been published yet. Voting still works; Open and Close do not.";
const notFound = (what) => Object.assign(new Error(what + " not found"), { code: "not-found" });
// After a refusal: are the live rules older than this page? The change log is
// readable by leadership from the step-1 rules on, so a refused read of it
// means the rules this page needs are not published yet. One read.
export async function rulesNeedUpdate() {
  try { await getDocs(query(logCol(), limit(1))); return false; }
  catch (e) { return classify(e) === "refused"; }
}

// ---- session id (per browser): used to flag the same name voting from two
//      different devices, which is the strongest "duplicate person" signal. ---
export function getSessionId() {
  let id = localStorage.getItem("ed_session_id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      "s-" + Math.abs(Array.from(localStorage.length + ":" + navigator.userAgent)
        .reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
    localStorage.setItem("ed_session_id", id);
  }
  return id;
}

// ---- the console's load gate ---------------------------------------------------
// Nothing that writes a permanent value (a saved result, catch-up) runs until
// the console has real server data for everything a count depends on. Each
// source is marked ready by its first snapshot that came from the server (not
// the local cache); a missing document counts once the server says it is missing.
const gate = { need: new Set(), ready: new Set(), waiters: [] };
export function gateNeed(name) { gate.need.add(name); }
function markReady(name) {
  if (gate.ready.has(name)) return;
  gate.ready.add(name);
  if (gateIsOpen()) { const w = gate.waiters; gate.waiters = []; w.forEach((f) => f()); }
}
export function gateIsOpen() { return gate.need.size > 0 && [...gate.need].every((n) => gate.ready.has(n)); }
export function gateMissing() { return [...gate.need].filter((n) => !gate.ready.has(n)); }
export function whenReady() { return gateIsOpen() ? Promise.resolve() : new Promise((r) => gate.waiters.push(r)); }
function gated(name, snap) { if (snap && snap.metadata && !snap.metadata.fromCache) markReady(name); }

// ---- live subscriptions ----------------------------------------------------
// opts: { gate: "name" (counts toward the load gate), onError(e) }.
// cb(list, snap) gets the snapshot too (metadata: fromCache, hasPendingWrites).
export function onPolls(cb, opts = {}) {
  const meta = !!opts.gate;
  return onSnapshot(query(pollsCol(), orderBy("order")), { includeMetadataChanges: meta }, (snap) => {
    if (opts.gate) gated(opts.gate, snap);
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), _pending: !!(d.metadata && d.metadata.hasPendingWrites) })), snap);
  }, (e) => { if (opts.onError) opts.onError(e); else console.error(e); });
}

// One-off read of a motion's ballots (the leadership export reads every motion).
export async function getVotesFor(pollId) {
  const snap = await getDocs(votesCol(pollId));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
// The same, always from the server (never the local cache): what a saved
// result is counted from.
export async function getVotesFromServer(pollId) {
  const snap = await getDocsFromServer(votesCol(pollId));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function onVotesFor(pollId, cb, onError) {
  return onSnapshot(votesCol(pollId), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (e) => { if (onError) onError(e); else console.error(e); });
}

// ---- settings (config/settings) ------------------------------------------------
// Saved from the console's Settings screen (from the next step of the upgrade).
// Until then the doc does not exist and DEFAULT_RULE (today's rules) applies.
let settings = null;
export function currentSettings() { return settings; }
export function onSettings(cb, opts = {}) {
  return onSnapshot(doc(db, "config", "settings"), { includeMetadataChanges: !!opts.gate }, (snap) => {
    if (opts.gate) gated(opts.gate, snap);
    settings = snap.exists() ? snap.data() : null;
    if (cb) cb(settings, snap);
  }, (e) => { if (opts.onError) opts.onError(e); else console.error(e); });
}

// ---- roster changes made by leadership --------------------------------------
// Editable from the leadership console and saved in Firestore (config/roster)
// so changes persist and sync to everyone. roster.js holds the defaults.
//   groups:  slug -> category ("1" | "2" | "courtesy"), overriding roster.js
//   added:   slug -> { name }   physicians added in the console
//   removed: slug -> true       taken off the list (false = restored)
//   writeins: slug -> { name, firstPollId, status: "new" | "dismissed" }
// Nothing is ever deleted: a removed physician keeps their category, so
// restoring them puts them back exactly as they were.
let overrideGroups = {}, addedPeople = {}, removedSlugs = {}, writeinsSeen = {};
export function onRosterOverrides(cb, opts = {}) {
  return onSnapshot(rosterRef(), { includeMetadataChanges: !!opts.gate }, (snap) => {
    if (opts.gate) gated(opts.gate, snap);
    const d = (snap.exists() && snap.data()) || {};
    overrideGroups = d.groups || {};
    addedPeople = d.added || {};
    removedSlugs = d.removed || {};
    writeinsSeen = d.writeins || {};
    if (cb) cb(overrideGroups, snap);
  }, (e) => { if (opts.onError) opts.onError(e); else console.error(e); });
}
export const isRemoved = (slug) => removedSlugs[slug] === true;
const isAdded = (slug) => !ROSTER_BY_SLUG[slug] && !!addedPeople[slug] && !!addedPeople[slug].name;
export function rosterWriteins() { return writeinsSeen; }

// Everyone on the list today: roster.js plus added, minus removed. This is
// what voters pick from and what quorum counts.
export function currentRoster() {
  const base = ROSTER.map((p) => ({ name: p.name, slug: p.slug, group: overrideGroups[p.slug] || p.group }));
  const added = Object.keys(addedPeople).filter(isAdded)
    .map((slug) => ({ name: addedPeople[slug].name, slug, group: overrideGroups[slug] || "courtesy", added: true }));
  return base.concat(added)
    .filter((p) => !isRemoved(p.slug))
    .map((p) => ({ ...p, weight: WEIGHTS[p.group] !== undefined ? WEIGHTS[p.group] : 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function rosterPerson(slug) { return currentRoster().find((p) => p.slug === slug) || null; }
// Removed physicians, for the console's Restore list.
export function removedRoster() {
  return Object.keys(removedSlugs).filter(isRemoved).map((slug) => {
    const name = ROSTER_BY_SLUG[slug] ? ROSTER_BY_SLUG[slug].name : (addedPeople[slug] && addedPeople[slug].name) || slug;
    return { name, slug };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
// Write-ins who were given a category: not in roster.js, not added through
// the form, not removed, with a category in config/roster.groups. They count
// toward quorum on open motions (eligibleCount) and so must be frozen at close.
function grantedWriteins() {
  return Object.keys(overrideGroups).filter((slug) => !ROSTER_BY_SLUG[slug] && !isAdded(slug) && !isRemoved(slug));
}

// Before any change to who is listed or their category, give every closed
// motion its own frozen copy of the categories, if it doesn't have one yet
// (motions closed before freezing existed). Closed results then never move.
// polls: the console's in-memory list (no re-read of the collection).
let knownPolls = [];
export function setKnownPolls(list) { knownPolls = list; }

// ---- the voters' board (config/live) and past results (config/history) ------
// Every leadership action that changes what voters see patches the board in
// its own batch or transaction, by field path, touching only what changed
// (see board.js boardPatch). Only healBoard writes a whole board.
let live;          // undefined: not known yet; null: confirmed missing; else the board
let history;       // the same for config/history
export function currentLive() { return live; }
// Forget what this laptop remembers of the board and history (tests, and after a reset).
export function forgetBoard() { live = undefined; history = undefined; }
export function currentHistory() { return history; }
export function onLive(cb, opts = {}) {
  return onSnapshot(liveRef(), { includeMetadataChanges: !!opts.meta }, (snap) => {
    if (!(snap.metadata && snap.metadata.fromCache && !snap.exists())) live = snap.exists() ? snap.data() : null;
    if (cb) cb(snap.exists() ? snap.data() : null, snap);
  }, (e) => { if (opts.onError) opts.onError(e); else console.error(e); });
}
export function onHistoryDoc(cb, opts = {}) {
  return onSnapshot(historyRef(), { includeMetadataChanges: !!opts.meta }, (snap) => {
    if (!(snap.metadata && snap.metadata.fromCache && !snap.exists())) history = snap.exists() ? snap.data() : null;
    if (cb) cb(history, snap);
  }, (e) => { if (opts.onError) opts.onError(e); else console.error(e); });
}
// The motions as they will be once these changes land ({ id: fields }).
function simulate(changes) {
  return knownPolls.map((p) => (changes[p.id] ? { ...p, ...changes[p.id] } : p)).filter((p) => !(changes[p.id] && changes[p.id]._gone));
}
// The board built from the motions (no meetings yet).
export function builtBoard(polls, opts) { return buildBoard(polls || knownPolls, [], opts); }
// The board built from these motions (and meetings, from step 4).
function boardFrom(polls, opts) { return buildBoard(polls, [], opts); }
// Write field-path changes ([path, value], undefined = delete) to the board.
function writeOps(target, ops) {
  if (!ops.length) return false;
  const args = [];
  ops.forEach(([path, v]) => { args.push(new FieldPath(...path), v === undefined ? deleteField() : v); });
  args.push("changedAt", serverTimestamp());
  target.update(liveRef(), ...args);
  return true;
}
// Add the board patch for these changes to a batch. cur: the board as this
// laptop last saw it. Missing, or not known yet: build it first, then the
// action is tried once more (withBoard).
function patchBoard(target, cur, next, timeFor) {
  if (cur === null || cur === undefined) throw notFound("board");
  return writeOps(target, boardPatch(cur, next, timeFor));
}
// Is the board missing (so a field-path patch would fail with not-found)?
// Then build it first, and run the action once more.
async function withBoard(fn) {
  try { return await fn(); }
  catch (e) {
    if (String(e && e.code).replace(/^firestore\//, "") !== "not-found" || e.notBoard) throw e;
    live = null;          // what this laptop remembered is gone
    await healBoard({ force: true });
    return fn();
  }
}
let lastHeal = 0;
// Rebuild the board and history from the motions and write them, only if they
// differ from what is stored, never while this laptop has writes pending, and
// at most once every 30 seconds (unless forced: the board is missing).
// Returns "wrote", "same", "pending" or "wait".
export async function healBoard(opts = {}) {
  if (opts.pending) return "pending";
  if (!opts.force && Date.now() - lastHeal < 30000) return "wait";
  lastHeal = Date.now();
  const board = buildBoard(knownPolls, []);
  let wrote = false;
  if (!live || !sameBoard(board, live)) {
    await setDoc(liveRef(), { ...board, changedAt: serverTimestamp() });
    live = board;
    wrote = true;
  }
  if (await writeHistory(board)) wrote = true;
  return wrote ? "wrote" : "same";
}
// Write past results if they differ from what is stored. Called only once the
// motions snapshot has no pending writes, so every copied time is real.
export async function writeHistory(board) {
  const h = buildHistory(knownPolls, [], board || buildBoard(knownPolls, []));
  if (history && sameBoard(h, history)) return false;
  await setDoc(historyRef(), { ...h, changedAt: serverTimestamp() });
  history = h;
  return true;
}
// Does the stored board (or history) match what the motions say?
export function boardIsCurrent() { return live !== undefined && sameBoard(buildBoard(knownPolls, []), live); }
export function historyIsCurrent() {
  if (history === undefined) return true;
  return sameBoard(buildHistory(knownPolls, [], buildBoard(knownPolls, [])), history);
}
// Make sure the board exists before Open and Close are offered (every later
// change to it is a field-path patch, which needs the document), and repair it
// once if it is out of date. This is the console-load heal.
export async function ensureBoard() {
  const s = await getDocFromServer(liveRef());
  live = s.exists() ? s.data() : null;
  const h = await getDocFromServer(historyRef());
  history = h.exists() ? h.data() : null;
  // Missing: build it now. Present: repair it once if it differs (on load only).
  await healBoard({ force: !live });
}
async function freezeClosedMotions() {
  const ops = knownPolls.filter((p) => p.status === "closed" && !p.lockedGroups && !p.result)
    .map(async (p) => updateDoc(pollRef(p.id), { lockedGroups: snapshotGroupsFor(await getVotesFor(p.id)) }));
  await Promise.all(ops);
}
export async function setPersonGroup(slug, group) {
  await freezeClosedMotions();
  await setDoc(rosterRef(), { groups: { [slug]: group } }, { merge: true });
}
// Add a physician (or restore a removed one with the same name). Returns
// "added", "restored" or "exists".
export async function addPhysician(name, group) {
  const clean = name.trim().replace(/\s+/g, " ");
  const slug = slugify(clean);
  if (!slug) throw new Error("empty name");
  if (rosterPerson(slug)) return "exists";
  const restoring = isRemoved(slug);
  await freezeClosedMotions();
  const patch = { groups: { [slug]: group }, removed: { [slug]: false } };
  if (!ROSTER_BY_SLUG[slug] && !(restoring && addedPeople[slug])) patch.added = { [slug]: { name: clean } };
  await setDoc(rosterRef(), patch, { merge: true });
  return restoring ? "restored" : "added";
}
export async function removePhysician(slug) {
  await freezeClosedMotions();
  await setDoc(rosterRef(), { removed: { [slug]: true } }, { merge: true });
}
export async function restorePhysician(slug) {
  await freezeClosedMotions();
  await setDoc(rosterRef(), { removed: { [slug]: false } }, { merge: true });
}

// A removed physician has no vote from then on (open and future motions);
// closed motions keep the category they were frozen with.
export function effectiveGroup(slug) {
  if (isRemoved(slug)) return "removed";
  if (overrideGroups[slug]) return overrideGroups[slug];
  const base = ROSTER_BY_SLUG[slug];
  if (base) return base.group;
  return isAdded(slug) ? "courtesy" : "writein";
}
export function resolvedPerson(slug) {
  const g = effectiveGroup(slug);
  return { group: g, weight: WEIGHTS[g] !== undefined ? WEIGHTS[g] : 0 };
}
// Full roster with categories applied (for the leadership Physicians tab).
export function resolvedRoster() { return currentRoster(); }

// Eligible to vote today under a rule (points above 0): the list plus write-ins
// who were given a category.
export function liveEligible(rule) {
  return currentRoster().filter((p) => weightIn(rule, p.group) > 0).length
    + grantedWriteins().filter((slug) => weightIn(rule, overrideGroups[slug]) > 0).length;
}
// Eligible-to-vote count (weight > 0). Frozen for closed motions, live otherwise.
// Includes write-ins who have been granted a category (they live in overrides).
export function eligibleCount(poll) {
  if (poll && poll.status === "closed" && poll.lockedGroups) {
    return Object.values(poll.lockedGroups).filter((g) => WEIGHTS[g] > 0).length;
  }
  let n = currentRoster().filter((p) => p.weight > 0).length;
  grantedWriteins().forEach((slug) => { if (WEIGHTS[overrideGroups[slug]] > 0) n += 1; });
  return n;
}
// Quorum = 50% of eligible, rounded up.
export function quorumThreshold(poll) {
  return Math.ceil(eligibleCount(poll) / 2);
}
// What computeResult needs to know about today's list.
export function countCtx() {
  return { groupOf: effectiveGroup, liveEligible, settings };
}
// The result of a motion from its ballots, counted the way it will be saved.
export function resultOf(poll, votes) { return computeResult(poll, votes, countCtx()); }

// ---- the voter page's reads ------------------------------------------------------
// Fallback while config/live does not exist yet (before the first leadership
// sign-in after the upgrade): the open motion only (0 or 1 document).
export function onOpenPolls(cb, onError) {
  return onSnapshot(query(pollsCol(), where("status", "==", "open")), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.archived && !p.deleted));
  }, (e) => { if (onError) onError(e); else console.error(e); });
}
// "Show earlier results": one read of config/history (null if it does not exist yet).
export async function getHistoryOnce() {
  const s = await getDoc(historyRef());
  return s.exists() ? s.data() : null;
}
// Fallback for earlier results while config/history does not exist: the closed
// motions, read once.
export async function getClosedPollsOnce() {
  const snap = await getDocs(query(pollsCol(), where("status", "==", "closed")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.archived && !p.deleted);
}
// Count a closed motion once from its ballots (a result that is late, or an
// old motion without one): the motion (its rule and frozen categories) and its
// ballots from the server, counted exactly as the console saves it.
export async function countOnce(pollId, pollData) {
  const p = pollData || (await getDoc(pollRef(pollId))).data();
  if (!p) return null;
  if (p.status === "closed" && p.result) return p.result;
  const votes = await getVotesFromServer(pollId);
  return computeResult({ id: pollId, ...p }, votes, countCtx());
}

// ---- voter action ----------------------------------------------------------
// Stores ONE row per name per poll (clean tally), but tracks every submission
// so leadership can flag duplicates. Re-voting from the SAME device = changing
// your mind. The same name from a DIFFERENT device = flagged for review.
export async function castVote({ pollId, name, slug, group, weight, isWriteIn, choice, sessionId }) {
  const ref = doc(db, "polls", pollId, "votes", slug);
  const pRef = pollRef(pollId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      tx.set(ref, {
        name, slug, group, weight, isWriteIn: !!isWriteIn, choice,
        sessionIds: [sessionId], submissionCount: 1, flagged: false,
        firstAt: serverTimestamp(), lastAt: serverTimestamp(),
      });
      tx.update(pRef, { voteCount: increment(1) });   // distinct-voter count: edit lock
    } else {
      const d = snap.data();
      const sessions = d.sessionIds || [];
      const sessionIds = sessions.includes(sessionId) ? sessions : [...sessions, sessionId];
      const changed = d.choice !== choice;   // re-tapping the SAME choice is a no-op for the count
      tx.update(ref, {
        choice,
        submissionCount: (d.submissionCount || 1) + (changed ? 1 : 0),
        sessionIds,
        flagged: sessionIds.length > 1,   // same name, 2+ devices: review
        lastAt: serverTimestamp(),
      });
    }
  });
}

// ---- change log (log/{id}) -----------------------------------------------------
// Every leadership action that changes a result, or what is open, writes one
// entry in the same batch or transaction. Entries cannot be edited. "by" is the
// name typed on this laptop (not checked). Reasons are kept with the record.
let byName = "";
export function setLogName(n) { byName = String(n || "").trim().slice(0, 80); }
export function writeLog(batchOrTx, entry) {
  const ref = doc(logCol());
  const e = { at: serverTimestamp(), ...entry };
  if (e.text) e.text = String(e.text).slice(0, 200);
  if (e.reason) e.reason = String(e.reason).slice(0, 1000);
  if (byName && !e.by) e.by = byName;
  Object.keys(e).forEach((k) => { if (e[k] === undefined) delete e[k]; });
  batchOrTx.set(ref, e);
  return ref.id;
}
export async function getRecentLog(n = 50) {
  const snap = await getDocs(query(logCol(), orderBy("at", "desc"), limit(n)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
// What a log entry keeps of a saved result (numbers only).
function resultSummary(r) {
  if (!r) return null;
  return { outcome: r.outcome, weight: r.weight, count: r.count, quorumCount: r.quorumCount,
    quorumNeeded: r.quorumNeeded, eligible: r.eligible, rule: r.rule };
}

// ---- admin actions ---------------------------------------------------------
export async function addPoll(text) {
  const order = knownPolls.reduce((m, p) => Math.max(m, Number(p.order) || 0), -1) + 1;
  const ref = doc(pollsCol());
  await setDoc(ref, {
    text: text.trim(), order, status: "draft", voteCount: 0, archived: false, deleted: false,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// A change to a motion's own fields, with the board patch it needs (for
// example new wording of the open motion) and, if given, a log entry.
async function updateWithBoard(pollId, patch, log) {
  return withBoard(async () => {
    const b = writeBatch(db);
    b.update(pollRef(pollId), patch);
    if (log) writeLog(b, log);
    patchBoard(b, live, buildBoard(simulate({ [pollId]: patch }), []));
    await b.commit();
  });
}
export async function updatePoll(pollId, patch) {
  await updateWithBoard(pollId, patch, null);
}
const textOf = (id) => (knownPolls.find((x) => x.id === id) || {}).text;

// Archive = keep the motion + its votes for reference, but remove it from the
// active list and from voters' view. Reversible via unarchive.
export async function setArchived(pollId, archived) {
  await updateWithBoard(pollId, { archived }, { action: archived ? "archive" : "unarchive", pollId, text: textOf(pollId) });
}

// Soft delete: moves a motion to the Trash (recoverable). Restore undoes it.
export async function trashPoll(pollId) {
  await updateWithBoard(pollId, { deleted: true }, { action: "trash", pollId, text: textOf(pollId) });
}
export async function restorePoll(pollId) {
  await updateWithBoard(pollId, { deleted: false }, { action: "restore", pollId, text: textOf(pollId) });
}
// Permanent delete (from the Trash). One batch writes a "purge" log entry that
// keeps the saved result, and deletes the motion; its ballots go after it (the
// rules allow that only once the motion is gone). If the ballots step stops
// halfway, the next console load finishes it.
const PURGE_KEY = "mv_purge_pending";
function purgeList() { try { return JSON.parse(localStorage.getItem(PURGE_KEY) || "[]"); } catch (e) { return []; } }
function setPurgeList(l) { try { localStorage.setItem(PURGE_KEY, JSON.stringify(l)); } catch (e) { /* private mode */ } }
export async function purgePoll(pollId) {
  const p = knownPolls.find((x) => x.id === pollId) || {};
  const b = writeBatch(db);
  writeLog(b, { action: "purge", pollId, text: p.text, before: resultSummary(p.result) });
  b.delete(pollRef(pollId));
  await b.commit();
  setPurgeList([...new Set([...purgeList(), pollId])]);
  await purgeBallots(pollId);
}
async function purgeBallots(pollId) {
  const vs = await getDocs(votesCol(pollId));
  await Promise.all(vs.docs.map((d) => deleteDoc(d.ref)));
  setPurgeList(purgeList().filter((x) => x !== pollId));
}
// Finish permanent deletes that stopped halfway (ballots left behind).
export async function finishPurges() {
  for (const id of purgeList()) {
    if (knownPolls.some((p) => p.id === id)) { setPurgeList(purgeList().filter((x) => x !== id)); continue; }
    try { await purgeBallots(id); } catch (e) { /* tried again next load */ }
  }
}

// Every physician's CURRENT category for a motion: the list today, write-ins
// who were given a category (they count toward quorum on an open motion, so
// they must be frozen too), and anyone else who has a ballot on it. This is
// what gets frozen on close, so "eligible" is the same just before and just
// after a close.
export function snapshotGroupsFor(votes) {
  const lockedGroups = {};
  currentRoster().forEach((p) => { lockedGroups[p.slug] = p.group; });
  grantedWriteins().forEach((slug) => { lockedGroups[slug] = overrideGroups[slug]; });
  (votes || []).forEach((v) => {
    const s = v.slug;
    if (s && !(s in lockedGroups)) lockedGroups[s] = effectiveGroup(s);  // write-ins too
  });
  return lockedGroups;
}

// Write-ins seen on these ballots that config/roster.writeins does not know yet.
function newWriteins(votes, pollId) {
  const out = {};
  (votes || []).forEach((v) => {
    if (v.isWriteIn && v.slug && !ROSTER_BY_SLUG[v.slug] && !isAdded(v.slug) && !writeinsSeen[v.slug] && !out[v.slug]) {
      out[v.slug] = { name: String(v.name || v.slug).slice(0, 200), firstPollId: pollId, status: "new" };
    }
  });
  return out;
}

// Open one motion. Only one is open at a time: the console closes any other
// open motion first, with both steps of a normal close. Opening also
// UNARCHIVES: voters never see archived motions, so an archived motion left
// "open" would be invisible to them while leadership saw it as live.
// The first time a motion opens it keeps a copy of the counting rules
// (`rule`), so a later settings change never changes how it is counted.
// A closed motion is re-opened with reopenMotion (it needs a reason).
export async function openPoll(pollId) {
  const p = knownPolls.find((x) => x.id === pollId) || {};
  const patch = { status: "open", archived: false, openedAt: serverTimestamp() };
  if (!p.rule) patch.rule = ruleFromSettings(settings, p.threshold);
  await withBoard(async () => {
    const b = writeBatch(db);
    b.update(pollRef(pollId), patch);
    writeLog(b, { action: "open", pollId, text: p.text });
    patchBoard(b, live, buildBoard(simulate({ [pollId]: { ...patch, openedAt: null } }), []));
    await b.commit();
  });
}

// Close, step 1: freeze the motion. From this moment the rules refuse every
// voter write, so the ballots cannot change. `closeOfOpenedAt` names the
// opening this close is for, so a close that waited offline can never land on
// a motion that was re-opened since. lockedGroups: today's categories plus
// every slug in the open motion's live ballot list.
// A transaction that reads only the board (voters never write it, so no
// contention with their votes): it clears `open` only if the open motion is
// this one, and leaves the board alone if it already shows this motion closed
// by another laptop. A transaction fails at once offline instead of queuing.
export async function closeMotion(pollId, seen) {
  const p = knownPolls.find((x) => x.id === pollId) || {};
  // Already closed (by another laptop): stop here. The rules refuse a second
  // close too, so a close that waited offline cannot land on a closed motion.
  if (p.status === "closed") throw Object.assign(new Error("already closed"), { code: "failed-precondition", why: "closed" });
  const lockedGroups = snapshotGroupsFor(seen && seen.votes);
  return withBoard(() => runTransaction(db, async (tx) => {
    const ls = await tx.get(liveRef());
    if (!ls.exists()) throw notFound("board");
    const cur = ls.data();
    tx.update(pollRef(pollId), {
      status: "closed", closedAt: serverTimestamp(),
      closeOfOpenedAt: seen && seen.openedAt !== undefined ? seen.openedAt : (p.openedAt === undefined ? null : p.openedAt),
      lockedGroups,
    });
    writeLog(tx, { action: "close", pollId, text: p.text });
    const isOpenHere = cur.open && cur.open.id === pollId;
    // The board (read in this transaction) already shows it closed: another
    // laptop closed it. Stop: nothing is written.
    if (cur.results && cur.results[pollId] && !isOpenHere) throw Object.assign(new Error("already closed"), { code: "failed-precondition", why: "closed" });
    // Only this motion's part of the board is written, from the board read in
    // this transaction: this laptop's list of motions may be a second behind,
    // and must never write its older copy of another motion back.
    const mine = boardFrom(simulate({ [pollId]: { status: "closed", closedAt: null, lockedGroups } }), { justClosed: pollId, now: Date.now() });
    const ops = [];
    if (isOpenHere) ops.push([["open"], null]);              // never clears another motion's open
    ops.push([["lastClosedId"], pollId]);
    if (mine.results[pollId]) {
      ops.push([["results", pollId], { ...mine.results[pollId], closedAt: serverTimestamp() }]);
      // Without meetings the board shows one day: entries (as the board has
      // them) from another day go to past results.
      if (!cur.meeting) {
        const today = localDate(Date.now());
        Object.entries(cur.results || {}).forEach(([id, e]) => {
          if (id !== pollId && tsMillis(e.closedAt) !== null && localDate(e.closedAt) !== today) ops.push([["results", id], undefined]);
        });
      }
    }
    writeOps(tx, ops);
  }));
}

// Close, step 2: count what the server froze and save it once. The ballots are
// read from the server (never the local cache) and counted inside a
// transaction that re-reads the motion: it must still be closed, have no
// result, and have the same closing time as before counting.
// Returns "saved" or "skipped" (already saved, or not closed).
export async function saveResult(pollId, opts = {}) {
  const before = await getDocFromServer(pollRef(pollId));
  if (!before.exists()) return "skipped";
  const b0 = before.data();
  if (b0.status !== "closed" || b0.result) return "skipped";
  const votes = await getVotesFromServer(pollId);
  return commitResult(pollId, votes, b0, { savedBy: "close", mergeMissing: true, ...opts });
}
// The transaction that saves a result. mergeMissing (a normal close): ballots
// that landed after the in-memory list are added to the frozen categories
// before counting. Catch-up never adds any, so what an old motion shows today
// is exactly what is saved.
function commitResult(pollId, votes, b0, opts) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(pollRef(pollId));
    const ls = await tx.get(liveRef());
    if (!snap.exists()) return "skipped";
    const p = snap.data();
    if (p.status !== "closed" || p.result || !sameTime(p.closedAt, b0.closedAt)) return "skipped";
    const patch = {};
    if (!p.lockedGroups) patch.lockedGroups = snapshotGroupsFor(votes);
    else if (opts.mergeMissing) {
      const groups = { ...p.lockedGroups };
      let added = false;
      votes.forEach((v) => { if (v.slug && !(v.slug in groups)) { groups[v.slug] = effectiveGroup(v.slug); added = true; } });
      if (added) patch.lockedGroups = groups;
    }
    const counted = opts.savedBy === "catch-up" ? p : { ...p, ...patch };
    const result = { ...computeResult({ id: pollId, ...counted }, votes, countCtx()),
      closedAt: p.closedAt === undefined ? null : p.closedAt, savedAt: serverTimestamp(), savedBy: opts.savedBy };
    if (opts.quorumNote) result.quorumNote = opts.quorumNote;
    patch.result = result;
    tx.update(pollRef(pollId), patch);
    // The board shows it: fill in its result there too (only that one field).
    if (ls.exists() && ls.data().results && ls.data().results[pollId]) {
      tx.update(liveRef(), new FieldPath("results", pollId, "result"), result, "changedAt", serverTimestamp());
    }
    const wi = newWriteins(votes, pollId);
    if (Object.keys(wi).length) tx.set(rosterRef(), { writeins: wi }, { merge: true });
    if (opts.log) writeLog(tx, opts.log);
    return "saved";
  });
}

// Catch-up: motions closed before results were saved (no `result` and no
// `closedAt`; archived and trashed too) get their result saved now, counted
// exactly as the screen shows them (LEGACY_RULE, their frozen categories if
// they have them, else today's list including write-ins given a category).
// Also the write-in quorum check (M2): a write-in given a category who did
// not vote was left out of the frozen categories of motions closed before this
// fix, so quorum may have been counted too low there. Only motions where the
// quorum outcome (met or not) could differ are flagged; their results are
// saved exactly as shown, with a note.
// Returns { saved, flagged: [ids] }.
export async function saveMissingResults(polls) {
  const todo = polls.filter((p) => p.status === "closed" && !p.result && (p.closedAt === undefined || p.closedAt === null) && !p._pending);
  if (!todo.length) return { saved: 0, flagged: [] };
  const ballots = new Map();
  for (const p of todo) ballots.set(p.id, await getVotesFromServer(p.id));
  // Candidates: people who were, or may have been, a write-in given a category.
  const cand = new Set();
  ballots.forEach((vs) => vs.forEach((v) => { if (v.isWriteIn && v.slug && !ROSTER_BY_SLUG[v.slug]) cand.add(v.slug); }));
  Object.keys(overrideGroups).forEach((slug) => { if (!ROSTER_BY_SLUG[slug] && !addedPeople[slug]) cand.add(slug); });
  const flagged = [];
  for (const p of todo) {
    if (!p.lockedGroups) continue;
    const r = computeResult(p, ballots.get(p.id), countCtx());
    const rule = ruleFor(p, settings);
    const extra = [...cand].filter((s) => !(s in p.lockedGroups) && weightIn(rule, effectiveGroup(s)) > 0).length;
    if (extra && r.quorumCount >= r.quorumNeeded && r.quorumCount < quorumNeededFor(r.eligible + extra, rule.quorumPercent)) flagged.push(p.id);
  }
  const note = flagged.length
    ? `Please check: ${flagged.length} earlier motion${flagged.length === 1 ? "" : "s"} may have counted quorum too low, and the quorum outcome could have been different.`
    : "No earlier motion's result could have been changed by the write-in quorum fix.";
  let saved = 0;
  for (const p of todo) {
    const log = saved === 0 ? { action: "catch-up", text: `Saved the results of ${todo.length} earlier motion${todo.length === 1 ? "" : "s"}. ${note}`.slice(0, 200),
      reason: note, after: { motions: todo.length, flagged } } : null;
    const before = await getDocFromServer(pollRef(p.id));
    if (!before.exists()) continue;
    const r = await commitResult(p.id, ballots.get(p.id), before.data(), { savedBy: "catch-up", quorumNote: flagged.includes(p.id) ? "writein-fix" : null, log });
    if (r === "saved") saved += 1;
  }
  return { saved, flagged };
}
// Re-open a closed motion ("closed by mistake"). Needs a reason, and the
// result saved first (so the earlier count is never lost): it moves to
// priorResults, and the frozen categories go into the log entry's "before"
// (the saved result keeps totals only). The motion keeps its counting rules.
// Refused on a motion already replaced by a re-vote.
export async function reopenMotion(pollId, reason) {
  const cur = await getDocFromServer(pollRef(pollId));
  if (cur.exists() && cur.data().status === "closed" && !cur.data().result) await saveResult(pollId);
  return withBoard(() => runTransaction(db, async (tx) => {
    const snap = await tx.get(pollRef(pollId));
    const ls = await tx.get(liveRef());
    if (!snap.exists()) throw Object.assign(new Error("gone"), { code: "not-found", notBoard: true });
    if (!ls.exists()) throw notFound("board");
    const p = snap.data();
    if (p.status !== "closed") return "skipped";
    if (p.supersededBy) throw Object.assign(new Error("replaced"), { code: "failed-precondition", why: "replaced" });
    if (!p.result) throw Object.assign(new Error("not saved"), { code: "failed-precondition", why: "unsaved" });
    const logId = writeLog(tx, { action: "reopen", pollId, text: p.text, reason,
      before: { ...resultSummary(p.result), lockedGroups: p.lockedGroups || {} }, after: null });
    const priorResults = [...(p.priorResults || []), p.result];
    tx.update(pollRef(pollId), {
      status: "open", archived: false, openedAt: serverTimestamp(),
      result: deleteField(), lockedGroups: deleteField(),
      priorResults, reopenCount: (p.reopenCount || 0) + 1, lastLog: logId,
    });
    // Only this motion's part of the board, from the board read here (see closeMotion).
    const cur = ls.data();
    // (any other motion this laptop still thinks is open is left out: the
    // console closed it first, and the board read here is what counts)
    const sim = boardFrom(simulate({ [pollId]: { ...p, status: "open", archived: false, result: undefined, lockedGroups: undefined, priorResults, reopenCount: (p.reopenCount || 0) + 1 } })
      .map((x) => (x.id !== pollId && x.status === "open" ? { ...x, status: "draft" } : x)));
    const ops = [[["open"], sim.open && sim.open.id === pollId ? sim.open : null]];
    if (cur.results && cur.results[pollId]) ops.push([["results", pollId], undefined]);
    if (cur.lastClosedId === pollId) {
      let last = null;
      Object.entries(cur.results || {}).forEach(([id, e]) => {
        if (id !== pollId && (last === null || (tsMillis(e.closedAt) || 0) > (tsMillis(cur.results[last].closedAt) || 0))) last = id;
      });
      ops.push([["lastClosedId"], last]);
    }
    writeOps(tx, ops);
    return "reopened";
  }));
}

// A clean re-vote of a closed motion with a saved result (the normal way to
// contest one). One batch: a draft copy right after the original (same
// wording, editable before opening), linked both ways; a "revote" log entry;
// the board marks the original "Replaced by a re-vote". Returns the new id.
export async function revoteMotion(pollId, reason) {
  const p = knownPolls.find((x) => x.id === pollId);
  if (!p || p.status !== "closed" || !p.result) throw Object.assign(new Error("not saved"), { code: "failed-precondition", why: "unsaved" });
  if (p.supersededBy) throw Object.assign(new Error("replaced"), { code: "failed-precondition", why: "replaced" });
  const ref = doc(pollsCol());
  const copy = {
    text: p.text, order: (Number(p.order) || 0) + 0.5, status: "draft", voteCount: 0, archived: false, deleted: false,
    createdAt: serverTimestamp(), revoteOf: pollId, round: (p.round || 1) + 1, revoteReason: String(reason).slice(0, 1000),
  };
  ["threshold", "amends", "meetingId", "kind", "options", "optionIds", "seats", "style"].forEach((k) => { if (p[k] !== undefined) copy[k] = p[k]; });
  await withBoard(async () => {
    const b = writeBatch(db);
    b.set(ref, copy);
    const logId = writeLog(b, { action: "revote", pollId, text: p.text, reason, before: resultSummary(p.result), after: { newPollId: ref.id } });
    b.update(pollRef(pollId), { supersededBy: ref.id, lastLog: logId });
    patchBoard(b, live, buildBoard(simulate({ [pollId]: { supersededBy: ref.id } }), []));
    await b.commit();
  });
  return ref.id;
}

// Change history of one motion (one read of its entries, on demand), newest first.
export async function getLogFor(pollId) {
  const snap = await getDocs(query(logCol(), where("pollId", "==", pollId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (tsMillis(b.at) || 0) - (tsMillis(a.at) || 0));
}
// The latest entries, newest first; `after` (an entry from the last page) for "Show more".
export async function getLogPage(n = 50, after = null) {
  const mods = [orderBy("at", "desc")];
  if (after && after._snap) mods.push(startAfter(after._snap));
  mods.push(limit(n));
  const snap = await getDocs(query(logCol(), ...mods));
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), _snap: d }));
}

// Is a result saved for this motion (on the server)?
export async function resultSaved(pollId) {
  const s = await getDocFromServer(pollRef(pollId));
  return s.exists() && !!s.data().result;
}

// Why a close was refused, in plain words, from the motion as the server has it.
export async function whyCloseRefused(pollId, openedAtSeen) {
  if (await rulesNeedUpdate()) return DB_UPDATE_MSG;
  try {
    const s = await getDocFromServer(pollRef(pollId));
    if (!s.exists()) return "it was deleted";
    const p = s.data();
    if (p.status === "closed") return "it is already closed";
    if (!sameTime(p.openedAt, openedAtSeen)) return "it was re-opened since";
  } catch (e) { /* fall through */ }
  return "the database refused it";
}

// Remove one ballot. `voteCount` is the DISTINCT-voter counter that drives the
// "voting started" edit lock and the purge confirmation, so it has to come back
// down with the ballot, otherwise it only ever ratchets up and both of those
// go wrong. Guarded at 0 so a double-removal can't drive it negative.
// Ballots of a closed motion are locked (the rules refuse this).
export async function clearVote(pollId, voteId) {
  const pRef = pollRef(pollId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, "polls", pollId, "votes", voteId));
    if (!snap.exists()) return;                       // already gone
    const poll = await tx.get(pRef);
    const n = (poll.exists() && poll.data().voteCount) || 0;
    tx.delete(doc(db, "polls", pollId, "votes", voteId));
    if (poll.exists()) tx.update(pRef, { voteCount: Math.max(0, n - 1) });
  });
}

// ---- shared tally logic ----------------------------------------------------
// Category that applies to a vote IN THE CONTEXT OF A POLL:
//  • closed poll: the category FROZEN at close time (poll.lockedGroups), so
//    later privilege changes never rewrite a past result.
//  • open/draft: the CURRENT category (live), so mid-meeting fixes apply.
export function groupForVote(v, poll) {
  if (poll && poll.status === "closed" && poll.lockedGroups && (v.slug in poll.lockedGroups))
    return poll.lockedGroups[v.slug];
  return effectiveGroup(v.slug);
}
export function weightForVote(v, poll) {
  const g = groupForVote(v, poll);
  return poll && (poll.rule || poll.result) ? weightIn(ruleFor(poll, settings), g) : (WEIGHTS[g] !== undefined ? WEIGHTS[g] : 0);
}

// Counting itself is pure and lives in count.js; db.js supplies the weights.
export function tally(votes, poll) {
  return tallyVotes(votes, (v) => weightForVote(v, poll));
}
export * from "./count.js";

export { serverTimestamp, copyRule };
