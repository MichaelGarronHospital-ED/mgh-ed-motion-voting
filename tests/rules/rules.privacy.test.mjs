// ============================================================================
//  Closed ballots are Admin only (voting-14). Ballots carry names and choices.
//  While a motion is open the ED account can read them (a voter's own ballot
//  when voting or checking it, the projector's turnout and live count). Once
//  the motion closes, only Admin (leadership@) can; everyone sees the saved
//  result instead. A re-opened motion is readable again while it is open.
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, onSnapshot } from "firebase/firestore";
import { setUp, tearDown, testEnv, ed, leader, seed, ballotFor } from "./helpers.mjs";

before(setUp);
after(tearDown);
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("polls/open", { text: "A", order: 0, status: "open", voteCount: 1 });
  await seed("polls/closed", { text: "B", order: 1, status: "closed", voteCount: 1 });
  await seed("polls/draft", { text: "C", order: 2, status: "draft", voteCount: 0 });
  await seed("polls/open/votes/ash", ballotFor("ash", "favour"));
  await seed("polls/closed/votes/ash", ballotFor("ash", "against"));
});

describe("who reads ballots", () => {
  it("ED reads an open motion's ballots, one or all", async () => {
    await assertSucceeds(getDoc(doc(ed(), "polls/open/votes/ash")));
    await assertSucceeds(getDocs(collection(ed(), "polls/open/votes")));
  });
  it("ED cannot read a closed motion's ballots, one or all", async () => {
    await assertFails(getDoc(doc(ed(), "polls/closed/votes/ash")));
    await assertFails(getDoc(doc(ed(), "polls/closed/votes/nobody")));
    await assertFails(getDocs(collection(ed(), "polls/closed/votes")));
  });
  it("ED cannot read a draft's or a missing motion's ballots", async () => {
    await assertFails(getDocs(collection(ed(), "polls/draft/votes")));
    await assertFails(getDoc(doc(ed(), "polls/draft/votes/ash")));
    await assertFails(getDocs(collection(ed(), "polls/gone/votes")));
  });
  it("only the motion's status counts: an open motion that is archived is still open", async () => {
    await seed("polls/open", { text: "A", order: 0, status: "open", voteCount: 1, archived: true });
    await assertSucceeds(getDocs(collection(ed(), "polls/open/votes")));
  });
  it("Admin reads every motion's ballots", async () => {
    for (const p of ["open", "closed", "draft", "gone"]) {
      await assertSucceeds(getDocs(collection(leader(), `polls/${p}/votes`)));
    }
    await assertSucceeds(getDoc(doc(leader(), "polls/closed/votes/ash")));
  });
  it("a re-opened motion's ballots are readable by ED again while it is open", async () => {
    await seed("polls/closed", { text: "B", order: 1, status: "open", voteCount: 1 });
    await assertSucceeds(getDocs(collection(ed(), "polls/closed/votes")));
  });
});

// What the projector's live listener does when its motion closes under it.
// The page copes either way (screen.js ballotsFailed: a refused ballot
// listener is not a sign-out). The emulator keeps a listener started while
// the motion was open (no new snapshot, no error); a fresh read is refused.
describe("the projector's ballot listener across a close", () => {
  it("gets nothing new after the close, and a fresh read is refused", async () => {
    const seen = [];
    let error = null;
    const unsub = onSnapshot(collection(ed(), "polls/open/votes"),
      (s) => seen.push(s.size), (e) => { error = e; });
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(seen, [1], "the open motion's ballot arrives");
    await seed("polls/open", { text: "A", order: 0, status: "closed", voteCount: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    unsub();
    assert.deepEqual(seen, [1], "no snapshot after the close");
    console.log(`listener after close: error ${error ? error.code : "none"}`);
    await assertFails(getDocs(collection(ed(), "polls/open/votes")));
  });
});
