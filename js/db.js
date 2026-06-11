// ============================================================================
//  DATA LAYER — Firebase Firestore (real-time).
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, runTransaction, serverTimestamp, getDocs, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { ROSTER_BY_SLUG } from "./roster.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

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

export async function closePoll(pollId) {
  await updateDoc(doc(db, "polls", pollId), { status: "closed" });
}

// leadership override of a single voter's weight (e.g. assign a write-in).
export async function setVoteWeight(pollId, voteId, weight) {
  await updateDoc(doc(db, "polls", pollId, "votes", voteId), { weightOverride: weight });
}

export async function clearVote(pollId, voteId) {
  await deleteDoc(doc(db, "polls", pollId, "votes", voteId));
}

// ---- shared tally logic ----------------------------------------------------
export function effectiveWeight(v) {
  if (typeof v.weightOverride === "number") return v.weightOverride;
  if (typeof v.weight === "number") return v.weight;
  const r = ROSTER_BY_SLUG[v.slug];
  return r ? r.weight : 0;
}

export function tally(votes) {
  const w = { favour: 0, against: 0, abstain: 0 };
  const c = { favour: 0, against: 0, abstain: 0 };
  const eligibleVoters = new Set();
  let flags = 0, writeIns = 0;
  for (const v of votes) {
    const ew = effectiveWeight(v);
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
