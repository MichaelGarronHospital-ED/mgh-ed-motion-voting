// ============================================================================
//  Security-rule tests for motion voting (../../firestore.rules).
//
//  The promises the rules make, since the three shared passwords (Oct 2026):
//    - only the two shared accounts get in at all: ed@ (the ED password,
//      voters) and leadership@ (the Leadership password). An old anonymous
//      session, any other account, or nobody signed in sees nothing.
//    - a voter can cast or change a ballot only while the motion is open, can
//      only add exactly one to a motion's vote count, and cannot set the
//      leadership-only weight override or delete anything.
//    - a ballot has exactly the shape js/db.js castVote writes: stored under
//      its own slug, a real choice, only the expected fields, a device list
//      that only grows, "flagged" matching that list, server timestamps, and
//      a new ballot always comes with the +1 to the motion's vote count.
//    - only leadership manages motions and settings; since the saved-results
//      rules (R1) a motion is deleted only from the Trash and the ballots of a
//      closed motion are locked, for leadership too (rules.results.test.mjs).
//
//  They run against the local Firestore emulator: no real project, no real
//  data, no credentials. Run with:  npm test   (needs Java)
// ============================================================================

import { before, after, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  runTransaction, writeBatch, serverTimestamp, increment, Timestamp,
} from "firebase/firestore";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "ed-motion-voting-test",
    firestore: {
      rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
      // the port in firebase.json (8181), as the emulator reports it
      host: (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181").split(":")[0],
      port: Number((process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181").split(":")[1]),
    },
  });
});
after(async () => { if (testEnv) await testEnv.cleanup(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("polls/open", { text: "Motion A", status: "open", voteCount: 2 });
  await seed("polls/closed", { text: "Motion B", status: "closed", voteCount: 5 });
  await seed("polls/open/votes/ashcombe", storedBallot("favour"));
  await seed("polls/closed/votes/ashcombe", storedBallot("against"));
  await seed("config/roster", { groups: {} });
});

// A ballot as js/db.js castVote stores it (after the server fills the times).
function storedBallot(choice, extra = {}) {
  const t = Timestamp.fromMillis(Date.now() - 60000);
  return {
    name: "Ashcombe", slug: "ashcombe", group: "1", weight: 1, isWriteIn: false, choice,
    sessionIds: ["dev-a"], submissionCount: 1, flagged: false, firstAt: t, lastAt: t, ...extra,
  };
}
// What castVote writes for a first ballot (server timestamps, as the app sends them).
function newBallot(slug, choice, extra = {}) {
  return {
    name: slug, slug, group: "1", weight: 1, isWriteIn: false, choice,
    sessionIds: ["dev-x"], submissionCount: 1, flagged: false,
    firstAt: serverTimestamp(), lastAt: serverTimestamp(), ...extra,
  };
}
// A first ballot written the way castVote does it: ballot + voteCount +1 together.
function castNew(db, poll, id, ballot) {
  const b = writeBatch(db);
  b.set(doc(db, `polls/${poll}/votes/${id}`), ballot);
  b.update(doc(db, `polls/${poll}`), { voteCount: increment(1) });
  return b.commit();
}
// The exact castVote transaction (js/db.js), for a real end-to-end vote.
function castVote(db, poll, slug, choice, sessionId) {
  const ref = doc(db, `polls/${poll}/votes/${slug}`), pollRef = doc(db, `polls/${poll}`);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      tx.set(ref, {
        name: slug, slug, group: "1", weight: 1, isWriteIn: false, choice,
        sessionIds: [sessionId], submissionCount: 1, flagged: false,
        firstAt: serverTimestamp(), lastAt: serverTimestamp(),
      });
      tx.update(pollRef, { voteCount: increment(1) });
    } else {
      const d = snap.data();
      const sessions = d.sessionIds || [];
      const sessionIds = sessions.includes(sessionId) ? sessions : [...sessions, sessionId];
      const changed = d.choice !== choice;
      tx.update(ref, {
        choice, submissionCount: (d.submissionCount || 1) + (changed ? 1 : 0),
        sessionIds, flagged: sessionIds.length > 1, lastAt: serverTimestamp(),
      });
    }
  });
}

// These emails must match ED_EMAIL and LEADER_EMAIL in js/config.js and the
// list in firestore.rules. Rename one place and not the others, and these fail.
const ed        = () => testEnv.authenticatedContext("u-ed",       { email: "ed@ed-motion-voting.app" }).firestore();
const leader    = () => testEnv.authenticatedContext("u-leader",   { email: "leadership@ed-motion-voting.app" }).firestore();
// the shape of a phone still holding a pre-switch anonymous session
const anonUser  = () => testEnv.authenticatedContext("u-anon").firestore();
const stranger  = () => testEnv.authenticatedContext("u-stranger", { email: "someone@example.com" }).firestore();
const signedOut = () => testEnv.unauthenticatedContext().firestore();

async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

describe("who gets in at all", () => {
  for (const [name, who] of [["ED", ed], ["Leadership", leader]]) {
    it(`${name} can read motions, ballots and settings`, async () => {
      await assertSucceeds(getDocs(collection(who(), "polls")));
      await assertSucceeds(getDocs(collection(who(), "polls/open/votes")));
      await assertSucceeds(getDoc(doc(who(), "config/roster")));
    });
  }
  for (const [name, who] of [["an old anonymous session", anonUser], ["another account", stranger], ["nobody signed in", signedOut]]) {
    it(`${name} can read nothing and vote nowhere`, async () => {
      await assertFails(getDoc(doc(who(), "polls/open")));
      await assertFails(getDocs(collection(who(), "polls/open/votes")));
      await assertFails(getDoc(doc(who(), "config/roster")));
      await assertFails(castNew(who(), "open", "someone", newBallot("someone", "favour")));
      await assertFails(updateDoc(doc(who(), "polls/open"), { voteCount: 3 }));
    });
  }
});

describe("ED password (voters)", () => {
  it("can cast and change a ballot while the motion is open (the real castVote)", async () => {
    await assertSucceeds(castVote(ed(), "open", "trelawney", "favour", "dev-1"));
    await assertSucceeds(castVote(ed(), "open", "trelawney", "against", "dev-1"));   // changes their mind
    await assertSucceeds(castVote(ed(), "open", "trelawney", "against", "dev-1"));   // re-taps the same
    await assertSucceeds(castVote(ed(), "open", "trelawney", "abstain", "dev-2"));   // from a second device
    const d = (await getDoc(doc(ed(), "polls/open/votes/trelawney"))).data();
    assert.equal(d.choice, "abstain");
    assert.equal(d.submissionCount, 3);
    assert.deepEqual(d.sessionIds, ["dev-1", "dev-2"]);
    assert.equal(d.flagged, true);
    assert.equal((await getDoc(doc(ed(), "polls/open"))).data().voteCount, 3);   // counted once
  });
  it("can change a seeded ballot", async () => {
    await assertSucceeds(castVote(ed(), "open", "ashcombe", "against", "dev-a"));
  });
  it("cannot vote or change a ballot once the motion is closed", async () => {
    await assertFails(castVote(ed(), "closed", "trelawney", "favour", "dev-1"));
    await assertFails(castVote(ed(), "closed", "ashcombe", "favour", "dev-a"));
  });
  it("cannot set the leadership-only weight override", async () => {
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { weightOverride: 5 }));
  });
});

describe("ballot shape (ED password)", () => {
  it("cannot put a second ballot for a name under another id", async () => {
    await assertFails(castNew(ed(), "open", "ashcombe-2", newBallot("ashcombe", "against")));
    await assertFails(castNew(ed(), "open", "someone-else", newBallot("trelawney", "favour")));
  });
  it("cannot cast a choice the app does not use", async () => {
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "yes")));
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "toString")));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { choice: "<img src=x onerror=alert(1)>", lastAt: serverTimestamp() }));
  });
  it("cannot add a field, drop one, or use the wrong type", async () => {
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { note: "hi" })));
    const missing = newBallot("trelawney", "favour"); delete missing.weight;
    await assertFails(castNew(ed(), "open", "trelawney", missing));
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { submissionCount: "1" })));
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { name: 42 })));
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { weight: 5 })));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { name: "Someone Else", lastAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { extra: true, lastAt: serverTimestamp() }));
  });
  it("cannot store a slug that the app could not have made", async () => {
    await assertFails(castNew(ed(), "open", "Bad Slug", newBallot("Bad Slug", "favour")));
  });
  it("cannot claim one device when the list has two (flagged must match)", async () => {
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { sessionIds: ["a", "b"], flagged: false })));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"),
      { sessionIds: ["dev-a", "dev-b"], flagged: false, lastAt: serverTimestamp() }));
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { flagged: true })));
  });
  it("cannot shrink or rewrite the device list, or clear a flag", async () => {
    await seed("polls/open/votes/ashcombe", storedBallot("favour", { sessionIds: ["dev-a", "dev-b"], flagged: true, submissionCount: 2 }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"),
      { sessionIds: ["dev-a"], flagged: false, lastAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"),
      { sessionIds: ["dev-a", "dev-c"], lastAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"),
      { sessionIds: ["dev-a", "dev-b", "dev-c", "dev-d"], lastAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"),
      { sessionIds: ["dev-a", "dev-b", "dev-a"], lastAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { flagged: false, lastAt: serverTimestamp() }));
    // the real app adding a third device still works
    await assertSucceeds(castVote(ed(), "open", "ashcombe", "favour", "dev-c"));
  });
  it("cannot fake the submission count or the times", async () => {
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { submissionCount: 9, lastAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { choice: "against", lastAt: serverTimestamp() }));   // a change must count
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { lastAt: Timestamp.fromMillis(0) }));
    await assertFails(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour", { firstAt: Timestamp.fromMillis(0) })));
  });
  it("cannot land a new ballot without adding one to the vote count", async () => {
    await assertFails(setDoc(doc(ed(), "polls/open/votes/trelawney"), newBallot("trelawney", "favour")));
    await assertSucceeds(castNew(ed(), "open", "trelawney", newBallot("trelawney", "favour")));
  });
});

describe("ED password (voters), motions and settings", () => {
  it("can add exactly one to an open motion's vote count, and nothing else", async () => {
    await assertSucceeds(updateDoc(doc(ed(), "polls/open"), { voteCount: 3 }));
    await assertFails(updateDoc(doc(ed(), "polls/open"), { voteCount: 5 }));
    await assertFails(updateDoc(doc(ed(), "polls/open"), { status: "closed" }));
    await assertFails(updateDoc(doc(ed(), "polls/closed"), { voteCount: 6 }));
  });
  it("cannot create, delete or manage motions, ballots or settings", async () => {
    await assertFails(setDoc(doc(ed(), "polls/new"), { text: "x", status: "open" }));
    await assertFails(deleteDoc(doc(ed(), "polls/open")));
    await assertFails(deleteDoc(doc(ed(), "polls/open/votes/ashcombe")));
    await assertFails(setDoc(doc(ed(), "config/roster"), { groups: { x: "y" } }));
  });
});

describe("Leadership password", () => {
  it("manages motions and settings", async () => {
    await assertSucceeds(setDoc(doc(leader(), "polls/new"), { text: "Motion C", status: "draft" }));
    await assertSucceeds(updateDoc(doc(leader(), "polls/open"), { status: "closed" }));
    await assertSucceeds(setDoc(doc(leader(), "config/roster"), { groups: { ashcombe: "2" } }, { merge: true }));
    await assertFails(deleteDoc(doc(leader(), "polls/new")));            // not in the Trash
    await assertSucceeds(updateDoc(doc(leader(), "polls/new"), { deleted: true }));
    await assertSucceeds(deleteDoc(doc(leader(), "polls/new")));         // from the Trash
  });
  it("can adjust and remove ballots while open, never after closing", async () => {
    await assertSucceeds(updateDoc(doc(leader(), "polls/open/votes/ashcombe"), { weightOverride: 2 }));
    await assertSucceeds(deleteDoc(doc(leader(), "polls/open/votes/ashcombe")));
    await assertFails(updateDoc(doc(leader(), "polls/closed/votes/ashcombe"), { weightOverride: 2 }));
    await assertFails(deleteDoc(doc(leader(), "polls/closed/votes/ashcombe")));
  });
});
