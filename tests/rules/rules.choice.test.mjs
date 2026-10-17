// ============================================================================
//  Questions and elections (R6).
//    - a choice ballot is "pick" with 1 to `seats` different known options, or
//      "abstain" with none; a motion ballot never has picks
//    - a change of picks counts as a new submission (and needs it)
//    - a question has 2 to 20 options with as many ids, seats from 1 to one
//      fewer than the options; options, seats and type lock once voting starts
//  The real castVote runs against the emulator.
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, writeBatch, increment, serverTimestamp } from "firebase/firestore";
import { setUp, tearDown, testEnv, ed, leader, seed, readRaw, newBallot, app, as } from "./helpers.mjs";

before(setUp);
after(tearDown);
const OPTS = [{ id: "o1", label: "Dr A" }, { id: "o2", label: "Dr B" }, { id: "o3", label: "Dr C" }];
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("polls/q1", { text: "Pick one", order: 0, status: "open", voteCount: 0, kind: "choice", style: "question",
    options: OPTS, optionIds: ["o1", "o2", "o3"], seats: 1 });
  await seed("polls/e2", { text: "Elect two", order: 1, status: "open", voteCount: 0, kind: "choice", style: "election",
    options: OPTS, optionIds: ["o1", "o2", "o3"], seats: 2 });
  await seed("polls/m1", { text: "A motion", order: 2, status: "open", voteCount: 0 });
});
const cast = async (poll, slug, choice, picks, sessionId = "dev-" + slug) => {
  const a = await app();
  as(ed());
  return a.castVote({ pollId: poll, name: slug, slug, group: "1", weight: 1, isWriteIn: false, choice, sessionId, picks });
};
function castNew(db, poll, id, ballot) {
  const b = writeBatch(db);
  b.set(doc(db, `polls/${poll}/votes/${id}`), ballot);
  b.update(doc(db, `polls/${poll}`), { voteCount: increment(1) });
  return b.commit();
}

describe("choice ballots (the real castVote)", () => {
  it("single pick, change of pick, abstain", async () => {
    await assertSucceeds(cast("q1", "ash", "pick", ["o2"]));
    assert.equal(await cast("q1", "ash", "pick", ["o3"]), 2);
    assert.equal(await cast("q1", "ash", "pick", ["o3"]), 2);       // same picks: not a new submission
    await assertSucceeds(cast("q1", "ash", "abstain", []));
    const b = await readRaw("polls/q1/votes/ash");
    assert.deepEqual([b.choice, b.picks, b.submissionCount], ["abstain", [], 3]);
  });
  it("multiple picks up to the seats", async () => {
    await assertSucceeds(cast("e2", "ash", "pick", ["o1", "o3"]));
    await assertSucceeds(cast("e2", "ash", "pick", ["o1"]));
  });
  it("refuses more picks than seats, duplicates, unknown ids, favour on a question, abstain with picks", async () => {
    await assertFails(cast("q1", "a1", "pick", ["o1", "o2"]));
    await assertFails(cast("e2", "a2", "pick", ["o1", "o1"]));
    await assertFails(cast("q1", "a3", "pick", ["o9"]));
    await assertFails(cast("q1", "a4", "favour", undefined));
    await assertFails(cast("q1", "a5", "abstain", ["o1"]));
    await assertFails(cast("q1", "a6", "pick", []));
  });
  it("refuses picks on a motion; a motion ballot still works", async () => {
    await assertFails(cast("m1", "a1", "favour", ["o1"]));
    await assertSucceeds(cast("m1", "a2", "favour", undefined));
  });
  it("refuses a change of picks without the +1 to the submission count", async () => {
    await assertSucceeds(cast("e2", "ash", "pick", ["o1"]));
    await assertFails(updateDoc(doc(ed(), "polls/e2/votes/ash"), { picks: ["o2"], lastAt: serverTimestamp() }));
  });
  it("a hand-made new choice ballot of the right shape passes", async () => {
    await assertSucceeds(castNew(ed(), "q1", "zed", newBallot("zed", "pick", { picks: ["o1"] })));
  });
});

describe("question shape (leadership)", () => {
  const q = (extra = {}) => ({ text: "Q", order: 9, status: "draft", voteCount: 0, kind: "choice", style: "question",
    options: OPTS, optionIds: ["o1", "o2", "o3"], seats: 1, ...extra });
  it("valid questions are accepted", async () => {
    await assertSucceeds(setDoc(doc(leader(), "polls/n1"), q()));
    await assertSucceeds(setDoc(doc(leader(), "polls/n2"), q({ seats: 2 })));
  });
  it("refuses seats of 0 or not below the option count, and options and ids of different sizes", async () => {
    await assertFails(setDoc(doc(leader(), "polls/n1"), q({ seats: 0 })));
    await assertFails(setDoc(doc(leader(), "polls/n1"), q({ seats: 3 })));
    await assertFails(setDoc(doc(leader(), "polls/n1"), q({ options: OPTS.slice(0, 2) })));
    await assertFails(setDoc(doc(leader(), "polls/n1"), q({ options: [OPTS[0]], optionIds: ["o1"], seats: 1 })));
  });
  it("options cannot change after the first vote", async () => {
    await cast("q1", "ash", "pick", ["o1"]);
    await assertFails(updateDoc(doc(leader(), "polls/q1"), { options: [{ id: "o1", label: "X" }, OPTS[1], OPTS[2]] }));
    await assertFails(updateDoc(doc(leader(), "polls/q1"), { seats: 2 }));
    await assertFails(updateDoc(doc(leader(), "polls/q1"), { kind: "motion" }));
    await assertSucceeds(updateDoc(doc(leader(), "polls/e2"), { seats: 1 }));    // no vote yet there
  });
});
