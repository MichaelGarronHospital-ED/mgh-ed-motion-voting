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
//    - only leadership manages motions, settings, and votes after closing.
//
//  They run against the local Firestore emulator: no real project, no real
//  data, no credentials. Run with:  npm test   (needs Java)
// ============================================================================

import { before, after, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "ed-motion-voting-test",
    firestore: {
      rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});
after(async () => { if (testEnv) await testEnv.cleanup(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("polls/open", { title: "Motion A", status: "open", voteCount: 2 });
  await seed("polls/closed", { title: "Motion B", status: "closed", voteCount: 5 });
  await seed("polls/open/votes/ashcombe", { choice: "yes" });
  await seed("polls/closed/votes/ashcombe", { choice: "no" });
  await seed("config/roster", { groups: {} });
});

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
      await assertFails(setDoc(doc(who(), "polls/open/votes/someone"), { choice: "yes" }));
      await assertFails(updateDoc(doc(who(), "polls/open"), { voteCount: 3 }));
    });
  }
});

describe("ED password (voters)", () => {
  it("can cast and change a ballot while the motion is open", async () => {
    await assertSucceeds(setDoc(doc(ed(), "polls/open/votes/trelawney"), { choice: "yes" }));
    await assertSucceeds(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { choice: "no" }));
  });
  it("cannot vote or change a ballot once the motion is closed", async () => {
    await assertFails(setDoc(doc(ed(), "polls/closed/votes/trelawney"), { choice: "yes" }));
    await assertFails(updateDoc(doc(ed(), "polls/closed/votes/ashcombe"), { choice: "yes" }));
  });
  it("cannot set the leadership-only weight override", async () => {
    await assertFails(updateDoc(doc(ed(), "polls/open/votes/ashcombe"), { weightOverride: 5 }));
  });
  it("can add exactly one to an open motion's vote count, and nothing else", async () => {
    await assertSucceeds(updateDoc(doc(ed(), "polls/open"), { voteCount: 3 }));
    await assertFails(updateDoc(doc(ed(), "polls/open"), { voteCount: 5 }));
    await assertFails(updateDoc(doc(ed(), "polls/open"), { status: "closed" }));
    await assertFails(updateDoc(doc(ed(), "polls/closed"), { voteCount: 6 }));
  });
  it("cannot create, delete or manage motions, ballots or settings", async () => {
    await assertFails(setDoc(doc(ed(), "polls/new"), { title: "x", status: "open" }));
    await assertFails(deleteDoc(doc(ed(), "polls/open")));
    await assertFails(deleteDoc(doc(ed(), "polls/open/votes/ashcombe")));
    await assertFails(setDoc(doc(ed(), "config/roster"), { groups: { x: "y" } }));
  });
});

describe("Leadership password", () => {
  it("manages motions and settings", async () => {
    await assertSucceeds(setDoc(doc(leader(), "polls/new"), { title: "Motion C", status: "draft" }));
    await assertSucceeds(updateDoc(doc(leader(), "polls/open"), { status: "closed" }));
    await assertSucceeds(setDoc(doc(leader(), "config/roster"), { groups: { ashcombe: "fulltime" } }, { merge: true }));
    await assertSucceeds(deleteDoc(doc(leader(), "polls/new")));
  });
  it("can adjust and remove ballots, even after closing", async () => {
    await assertSucceeds(updateDoc(doc(leader(), "polls/closed/votes/ashcombe"), { weightOverride: 2 }));
    await assertSucceeds(deleteDoc(doc(leader(), "polls/closed/votes/ashcombe")));
  });
});
