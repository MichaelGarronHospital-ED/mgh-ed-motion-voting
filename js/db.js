// ============================================================================
//  DATA LAYER — Firebase Firestore (real-time).
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, runTransaction, serverTimestamp, getDocs, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, LEADER_EMAIL } from "./config.js";
import { ROSTER, ROSTER_BY_SLUG, WEIGHTS } from "./roster.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---- auth ------------------------------------------------------------------
// Voters sign in anonymously; leadership signs in with the passcode as the
// password for LEADER_EMAIL. Both are best-effort: if the providers aren't
// enabled yet (open-rules mode), the app still works.
export function watchAuth(cb) { return onAuthStateChanged(auth, cb); }
export function anonSignIn() { return signInAnonymously(auth); }
export function leaderSignIn(passcode) { return signInWithEmailAndPassword(auth, LEADER_EMAIL, passcode); }
export function leaderSignOut() { return signOut(auth); }
export { LEADER_EMAIL };

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

export function onVotesFor(pollId, cb) {
  return onSnapshot(collection(db, "polls", pollId, "votes"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---- roster category overrides --------------------------------------------
// Editable from the leadership console and saved in Firestore (config/roster)
// so changes persist and sync to everyone. roster.js holds the defaults.
let overrideGroups = {};
export function onRosterOverrides(cb) {
  return onSnapshot(doc(db, "config", "roster"), (snap) => {
    overrideGroups = (snap.exists() && snap.data().groups) || {};
    if (cb) cb(overrideGroups);
  });
}
export async function setPersonGroup(slug, group) {
  await setDoc(doc(db, "config", "roster"), { groups: { [slug]: group } }, { merge: true });
}
export function effectiveGroup(slug) {
  if (overrideGroups[slug]) return overrideGroups[slug];
  const base = ROSTER_BY_SLUG[slug];
  return base ? base.group : "writein";
}
export function resolvedPerson(slug) {
  const g = effectiveGroup(slug);
  return { group: g, weight: WEIGHTS[g] !== undefined ? WEIGHTS[g] : 0 };
}
// Full roster with overrides applied (for the leadership Summary tab).
export function resolvedRoster() {
  return ROSTER.map((p) => {
    const g = overrideGroups[p.slug] || p.group;
    return { ...p, group: g, weight: WEIGHTS[g] };
  });
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
      tx.update(ref, {
        choice,
        submissionCount: (d.submissionCount || 1) + 1,
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
    text: text.trim(), order, status: "draft", voteCount: 0, archived: false,
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

export async function deletePoll(pollId) {
  // delete the votes subcollection first
  const vs = await getDocs(collection(db, "polls", pollId, "votes"));
  await Promise.all(vs.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "polls", pollId));
}

// Open one motion = close every other open motion (only one open at a time).
export async function openPoll(pollId) {
  const all = await getDocs(pollsCol);
  await Promise.all(all.docs.map((d) => {
    if (d.id === pollId) return updateDoc(d.ref, { status: "open" });
    if (d.data().status === "open") return updateDoc(d.ref, { status: "closed" });
    return null;
  }));
}

// Closing FREEZES each physician's category for this motion, so later
// privilege changes never alter this (now historical) result.
export async function closePoll(pollId) {
  const lockedGroups = {};
  ROSTER.forEach((p) => { lockedGroups[p.slug] = effectiveGroup(p.slug); });
  const vs = await getDocs(collection(db, "polls", pollId, "votes"));
  vs.forEach((d) => {
    const s = d.data().slug;
    if (s && !(s in lockedGroups)) lockedGroups[s] = effectiveGroup(s);  // write-ins too
  });
  await updateDoc(doc(db, "polls", pollId), { status: "closed", lockedGroups });
}

export async function clearVote(pollId, voteId) {
  await deleteDoc(doc(db, "polls", pollId, "votes", voteId));
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

export function tally(votes, poll) {
  const w = { favour: 0, against: 0, abstain: 0 };
  const c = { favour: 0, against: 0, abstain: 0 };
  const eligibleVoters = new Set();
  let flags = 0, writeIns = 0;
  for (const v of votes) {
    const ew = weightForVote(v, poll);
    if (v.choice in w) { w[v.choice] += ew; c[v.choice] += 1; }
    if (ew > 0) eligibleVoters.add(v.slug);
    if (v.flagged) flags += 1;
    if (v.isWriteIn) writeIns += 1;
  }
  return {
    weight: w, count: c,
    totalVotes: votes.length,
    quorumCount: eligibleVoters.size,   // distinct eligible voters who voted
    flags, writeIns,
  };
}

export { serverTimestamp };
