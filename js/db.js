// ============================================================================
//  DATA LAYER: Firebase Firestore (real-time). Counting lives in count.js.
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, runTransaction, serverTimestamp, getDocs, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, LEADER_EMAIL, ED_EMAIL } from "./config.js";
import { ROSTER, ROSTER_BY_SLUG, WEIGHTS, slugify } from "./roster.js";
import { tallyVotes } from "./count.js";

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

const pollsCol = collection(db, "polls");

// ---- session id (per browser) — used to flag the same name voting from two
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

// ---- live subscriptions ----------------------------------------------------
export function onPolls(cb) {
  return onSnapshot(query(pollsCol, orderBy("order")), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// One-off read of a motion's ballots (the leadership export reads every motion).
export async function getVotesFor(pollId) {
  const snap = await getDocs(collection(db, "polls", pollId, "votes"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function onVotesFor(pollId, cb) {
  return onSnapshot(collection(db, "polls", pollId, "votes"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---- roster changes made by leadership --------------------------------------
// Editable from the leadership console and saved in Firestore (config/roster)
// so changes persist and sync to everyone. roster.js holds the defaults.
//   groups:  slug -> category ("1" | "2" | "courtesy"), overriding roster.js
//   added:   slug -> { name }   physicians added in the console
//   removed: slug -> true       taken off the list (false = restored)
// Nothing is ever deleted: a removed physician keeps their category, so
// restoring them puts them back exactly as they were.
let overrideGroups = {}, addedPeople = {}, removedSlugs = {};
export function onRosterOverrides(cb) {
  return onSnapshot(doc(db, "config", "roster"), (snap) => {
    const d = (snap.exists() && snap.data()) || {};
    overrideGroups = d.groups || {};
    addedPeople = d.added || {};
    removedSlugs = d.removed || {};
    if (cb) cb(overrideGroups);
  });
}
export const isRemoved = (slug) => removedSlugs[slug] === true;
const isAdded = (slug) => !ROSTER_BY_SLUG[slug] && !!addedPeople[slug] && !!addedPeople[slug].name;

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

// Before any change to who is listed or their category, give every closed
// motion its own frozen copy of the categories, if it doesn't have one yet
// (motions closed before freezing existed). Closed results then never move.
async function freezeClosedMotions() {
  const all = await getDocs(pollsCol);
  const ops = [];
  for (const d of all.docs) {
    if (d.data().status === "closed" && !d.data().lockedGroups) {
      ops.push(snapshotGroups(d.id).then((lockedGroups) => updateDoc(d.ref, { lockedGroups })));
    }
  }
  await Promise.all(ops);
}
export async function setPersonGroup(slug, group) {
  await freezeClosedMotions();
  await setDoc(doc(db, "config", "roster"), { groups: { [slug]: group } }, { merge: true });
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
  await setDoc(doc(db, "config", "roster"), patch, { merge: true });
  return restoring ? "restored" : "added";
}
export async function removePhysician(slug) {
  await freezeClosedMotions();
  await setDoc(doc(db, "config", "roster"), { removed: { [slug]: true } }, { merge: true });
}
export async function restorePhysician(slug) {
  await freezeClosedMotions();
  await setDoc(doc(db, "config", "roster"), { removed: { [slug]: false } }, { merge: true });
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

// Eligible-to-vote count (weight > 0). Frozen for closed motions, live otherwise.
// Includes write-ins who have been granted a category (they live in overrides).
export function eligibleCount(poll) {
  if (poll && poll.status === "closed" && poll.lockedGroups) {
    return Object.values(poll.lockedGroups).filter((g) => WEIGHTS[g] > 0).length;
  }
  let n = currentRoster().filter((p) => p.weight > 0).length;
  Object.keys(overrideGroups).forEach((slug) => {
    if (!ROSTER_BY_SLUG[slug] && !isAdded(slug) && !isRemoved(slug) && WEIGHTS[overrideGroups[slug]] > 0) n += 1;   // granted write-ins
  });
  return n;
}
// Quorum = 50% of eligible, rounded up.
export function quorumThreshold(poll) {
  return Math.ceil(eligibleCount(poll) / 2);
}

// ---- voter action ----------------------------------------------------------
// Stores ONE row per name per poll (clean tally), but tracks every submission
// so leadership can flag duplicates. Re-voting from the SAME device = changing
// your mind. The same name from a DIFFERENT device = flagged for review.
export async function castVote({ pollId, name, slug, group, weight, isWriteIn, choice, sessionId }) {
  const ref = doc(db, "polls", pollId, "votes", slug);
  const pollRef = doc(db, "polls", pollId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      tx.set(ref, {
        name, slug, group, weight, isWriteIn: !!isWriteIn, choice,
        sessionIds: [sessionId], submissionCount: 1, flagged: false,
        firstAt: serverTimestamp(), lastAt: serverTimestamp(),
      });
      tx.update(pollRef, { voteCount: increment(1) });   // distinct-voter count → edit lock
    } else {
      const d = snap.data();
      const sessions = d.sessionIds || [];
      const sessionIds = sessions.includes(sessionId) ? sessions : [...sessions, sessionId];
      const changed = d.choice !== choice;   // re-tapping the SAME choice is a no-op for the count
      tx.update(ref, {
        choice,
        submissionCount: (d.submissionCount || 1) + (changed ? 1 : 0),
        sessionIds,
        flagged: sessionIds.length > 1,   // same name, 2+ devices → review
        lastAt: serverTimestamp(),
      });
    }
  });
}

// ---- admin actions ---------------------------------------------------------
export async function addPoll(text) {
  const existing = await getDocs(pollsCol);
  const order = existing.size;
  const ref = doc(pollsCol);
  await setDoc(ref, {
    text: text.trim(), order, status: "draft", voteCount: 0, archived: false, deleted: false,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updatePoll(pollId, patch) {
  await updateDoc(doc(db, "polls", pollId), patch);
}

// Archive = keep the motion + its votes for reference, but remove it from the
// active list and from voters' view. Reversible via unarchive.
export async function setArchived(pollId, archived) {
  await updateDoc(doc(db, "polls", pollId), { archived });
}

// Soft delete → moves a motion to the Trash (recoverable). Restore undoes it.
export async function trashPoll(pollId) {
  await updateDoc(doc(db, "polls", pollId), { deleted: true });
}
export async function restorePoll(pollId) {
  await updateDoc(doc(db, "polls", pollId), { deleted: false });
}
// Permanent delete (from the Trash) — removes the motion and all its votes.
export async function purgePoll(pollId) {
  const vs = await getDocs(collection(db, "polls", pollId, "votes"));
  await Promise.all(vs.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "polls", pollId));
}

// Snapshot every physician's CURRENT category for a motion (the list today +
// any write-ins who voted in it). This is what gets frozen on close.
async function snapshotGroups(pollId) {
  const lockedGroups = {};
  currentRoster().forEach((p) => { lockedGroups[p.slug] = p.group; });
  const vs = await getDocs(collection(db, "polls", pollId, "votes"));
  vs.forEach((d) => {
    const s = d.data().slug;
    if (s && !(s in lockedGroups)) lockedGroups[s] = effectiveGroup(s);  // write-ins too
  });
  return lockedGroups;
}

// Open one motion = close every other open motion (only one open at a time).
// Any motion we auto-close here is FROZEN, exactly like an explicit close.
// Opening also UNARCHIVES: voters never see archived motions, so an archived
// motion left "open" would be invisible to them while leadership saw it as live.
export async function openPoll(pollId) {
  const all = await getDocs(pollsCol);
  const ops = [];
  for (const d of all.docs) {
    if (d.id === pollId) {
      ops.push(updateDoc(d.ref, { status: "open", archived: false }));
    } else if (d.data().status === "open") {
      const lockedGroups = await snapshotGroups(d.id);
      ops.push(updateDoc(d.ref, { status: "closed", lockedGroups }));
    }
  }
  await Promise.all(ops);
}

// Closing FREEZES each physician's category for this motion, so later
// privilege changes never alter this (now historical) result.
export async function closePoll(pollId) {
  const lockedGroups = await snapshotGroups(pollId);
  await updateDoc(doc(db, "polls", pollId), { status: "closed", lockedGroups });
}

// Remove one ballot. `voteCount` is the DISTINCT-voter counter that drives the
// "voting started" edit lock and the purge confirmation, so it has to come back
// down with the ballot — otherwise it only ever ratchets up and both of those
// go wrong. Guarded at 0 so a double-removal can't drive it negative.
export async function clearVote(pollId, voteId) {
  const pollRef = doc(db, "polls", pollId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, "polls", pollId, "votes", voteId));
    if (!snap.exists()) return;                       // already gone
    const poll = await tx.get(pollRef);
    const n = (poll.exists() && poll.data().voteCount) || 0;
    tx.delete(doc(db, "polls", pollId, "votes", voteId));
    if (poll.exists()) tx.update(pollRef, { voteCount: Math.max(0, n - 1) });
  });
}

// ---- shared tally logic ----------------------------------------------------
// Category that applies to a vote IN THE CONTEXT OF A POLL:
//  • closed poll  → the category FROZEN at close time (poll.lockedGroups), so
//    later privilege changes never rewrite a past result.
//  • open/draft   → the CURRENT category (live), so mid-meeting fixes apply.
export function groupForVote(v, poll) {
  if (poll && poll.status === "closed" && poll.lockedGroups && (v.slug in poll.lockedGroups))
    return poll.lockedGroups[v.slug];
  return effectiveGroup(v.slug);
}
export function weightForVote(v, poll) {
  const g = groupForVote(v, poll);
  return WEIGHTS[g] !== undefined ? WEIGHTS[g] : 0;
}

// Counting itself is pure and lives in count.js; db.js supplies the weights.
export function tally(votes, poll) {
  return tallyVotes(votes, (v) => weightForVote(v, poll));
}
export * from "./count.js";

export { serverTimestamp };
