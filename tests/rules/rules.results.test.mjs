// ============================================================================
//  Saved results (R1): what the rules promise once a result is saved.
//    - a result is written once, only to a motion already closed, in its own
//      write, with the server's time; it never changes afterwards
//    - re-opening needs a "reopen" change-log entry made in the same write, a
//      saved result, priorResults extended by exactly that result, and the
//      frozen categories dropped; never on a motion replaced by a re-vote
//    - a close names the opening it closes (closeOfOpenedAt)
//    - ballots of a closed motion are locked, for leadership too
//    - a motion is deleted only from the Trash, its ballots only after it
//    - the change log is leadership's only, and never edited
//  Many cases run the REAL page code (js/db.js) against the emulator.
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
  deleteField, Timestamp, query, limit,
} from "firebase/firestore";
import { setUp, tearDown, testEnv, ed, leader, seed, readRaw, past, ballotFor, app, as } from "./helpers.mjs";

before(setUp);
after(tearDown);

const OPENED = past(120000);
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("config/roster", { groups: {} });
  // open motion opened by the new page (has openedAt and a rule)
  await seed("polls/m1", { text: "Motion one", order: 0, status: "open", voteCount: 2, archived: false, deleted: false,
    openedAt: OPENED, rule: { v: 1, weights: { "1": 1, "2": 0.5, courtesy: 0 }, quorumPercent: 50, threshold: "majority", tieRule: "tie" } });
  await seed("polls/m1/votes/alvin-yang", ballotFor("alvin-yang", "favour"));
  await seed("polls/m1/votes/david-ng", ballotFor("david-ng", "against", { group: "2", weight: 0.5 }));
  // an old closed motion: no result, no closedAt, no lockedGroups
  await seed("polls/old", { text: "Old motion", order: 1, status: "closed", voteCount: 1, archived: false, deleted: false });
  await seed("polls/old/votes/alvin-yang", ballotFor("alvin-yang", "favour"));
  // a draft
  await seed("polls/d1", { text: "Draft", order: 2, status: "draft", voteCount: 0, archived: false, deleted: false });
});

async function closeAndSave(id = "m1") {
  const a = await app();
  as(leader());
  const votes = await a.getVotesFromServer(id);
  await a.closeMotion(id, { openedAt: OPENED, votes });
  return a.saveResult(id);
}
const resultObj = (extra = {}) => ({
  v: 1, kind: "motion", outcome: "pass", weight: { favour: 1, against: 0.5, abstain: 0 },
  count: { favour: 1, against: 1, abstain: 0 }, totalVotes: 2, quorumCount: 2, quorumNeeded: 24, eligible: 48,
  rule: { v: 1, weights: { "1": 1, "2": 0.5, courtesy: 0 }, quorumPercent: 50, threshold: "majority", tieRule: "tie" },
  closedAt: null, savedAt: serverTimestamp(), savedBy: "close", ...extra,
});

describe("closing and saving (the real closeMotion and saveResult)", () => {
  it("closes, saves once, and the saved result is what the ballots say", async () => {
    assert.equal(await closeAndSave(), "saved");
    const p = await readRaw("polls/m1");
    assert.equal(p.status, "closed");
    assert.ok(p.closedAt instanceof Timestamp);
    assert.ok(p.result.savedAt instanceof Timestamp);
    assert.equal(p.result.outcome, "noq");             // 2 voters of 48 eligible
    assert.deepEqual(p.result.weight, { favour: 1, against: 0.5, abstain: 0 });
    assert.equal(p.lockedGroups["alvin-yang"], "1");
    const a = await app();
    assert.equal(await a.saveResult("m1"), "skipped");   // never twice
  });
  it("a saved result cannot change or be removed", async () => {
    await closeAndSave();
    const L = leader();
    await assertFails(updateDoc(doc(L, "polls/m1"), { result: resultObj({ outcome: "fail" }) }));
    await assertFails(updateDoc(doc(L, "polls/m1"), { result: deleteField() }));
    await assertFails(updateDoc(doc(L, "polls/m1"), { lockedGroups: { x: "1" } }));
    await assertFails(updateDoc(doc(L, "polls/m1"), { text: "Changed wording" }));
    await assertFails(updateDoc(doc(L, "polls/m1"), { voteCount: 9 }));
  });
  it("archive, trash, move, reorder, mover, seconder and notes still work on a saved motion", async () => {
    await closeAndSave();
    const L = leader();
    await assertSucceeds(updateDoc(doc(L, "polls/m1"), { archived: true }));
    await assertSucceeds(updateDoc(doc(L, "polls/m1"), { deleted: true }));
    await assertSucceeds(updateDoc(doc(L, "polls/m1"), { deleted: false, archived: false, order: 5, meetingId: "mtg",
      mover: "Kyle Vojdani", seconder: "Meg Reynolds", notes: "Friendly amendment.", number: "2a" }));
  });
  it("a result in the same write as the close is refused", async () => {
    await assertFails(updateDoc(doc(leader(), "polls/m1"), { status: "closed", closedAt: serverTimestamp(),
      closeOfOpenedAt: OPENED, result: resultObj() }));
  });
  it("a result on an open motion or a draft is refused", async () => {
    await assertFails(updateDoc(doc(leader(), "polls/m1"), { result: resultObj() }));
    await assertFails(updateDoc(doc(leader(), "polls/d1"), { result: resultObj() }));
  });
  it("a result with the laptop's own time instead of the server's is refused", async () => {
    await assertFails(updateDoc(doc(leader(), "polls/old"), { result: resultObj({ savedAt: Timestamp.now() }) }));
    await assertSucceeds(updateDoc(doc(leader(), "polls/old"), { result: resultObj() }));
  });
  it("a close whose closeOfOpenedAt is not this opening is refused (a close queued before a re-open)", async () => {
    await assertFails(updateDoc(doc(leader(), "polls/m1"), { status: "closed", closedAt: serverTimestamp(),
      closeOfOpenedAt: past(999999) }));
    await assertFails(updateDoc(doc(leader(), "polls/m1"), { status: "closed", closedAt: serverTimestamp() }));
  });
  it("a motion is closed once: a second close from a laptop that missed the first is refused", async () => {
    const a = await app();
    as(leader());
    a.setKnownPolls([{ id: "m1", text: "Motion one", status: "open", openedAt: OPENED }]);   // out of date
    await assertSucceeds(a.closeMotion("m1", { openedAt: OPENED, votes: [] }));
    const first = await readRaw("polls/m1");
    await assertFails(a.closeMotion("m1", { openedAt: OPENED, votes: [] }));
    assert.ok((await readRaw("polls/m1")).closedAt.isEqual(first.closedAt));
    // the previous page's close (no closing time) of a closed motion still passes, as before
    await assertSucceeds(updateDoc(doc(leader(), "polls/m1"), { status: "closed", lockedGroups: { x: "1" } }));
    a.setKnownPolls([]);
  });
  it("back-dated closing or opening times are refused", async () => {
    await assertFails(updateDoc(doc(leader(), "polls/m1"), { status: "closed", closedAt: past(5000), closeOfOpenedAt: OPENED }));
    await assertFails(updateDoc(doc(leader(), "polls/d1"), { status: "open", openedAt: past(5000) }));
    await assertSucceeds(updateDoc(doc(leader(), "polls/d1"), { status: "open", openedAt: serverTimestamp() }));
  });
  it("the real openPoll passes and takes a rule snapshot", async () => {
    const a = await app();
    as(leader());
    a.setKnownPolls([{ id: "d1", text: "Draft", status: "draft" }]);
    await assertSucceeds(a.openPoll("d1"));
    const p = await readRaw("polls/d1");
    assert.equal(p.status, "open");
    assert.ok(p.openedAt instanceof Timestamp);
    assert.equal(p.rule.quorumPercent, 50);
    a.setKnownPolls([]);
  });
});

describe("re-opening", () => {
  it("the real reopenMotion passes: result to priorResults, categories to the log", async () => {
    await closeAndSave();
    const a = await app();
    as(leader());
    assert.equal(await a.reopenMotion("m1", "Closed early by mistake."), "reopened");
    const p = await readRaw("polls/m1");
    assert.equal(p.status, "open");
    assert.equal(p.result, undefined);
    assert.equal(p.lockedGroups, undefined);
    assert.equal(p.priorResults.length, 1);
    assert.equal(p.reopenCount, 1);
    const log = await readRaw(`log/${p.lastLog}`);
    assert.equal(log.action, "reopen");
    assert.equal(log.reason, "Closed early by mistake.");
    assert.equal(log.before.lockedGroups["alvin-yang"], "1");
    // and it can be closed and saved again, with its new opening time
    const votes = await a.getVotesFromServer("m1");
    await a.closeMotion("m1", { openedAt: p.openedAt, votes });
    assert.equal(await a.saveResult("m1"), "saved");
    assert.equal((await readRaw("polls/m1")).priorResults.length, 1);
  });
  it("re-opening of an unsaved motion saves first (the real code)", async () => {
    const a = await app();
    as(leader());
    assert.equal(await a.reopenMotion("old", "Wrong motion closed."), "reopened");
    const p = await readRaw("polls/old");
    assert.equal(p.priorResults[0].savedBy, "close");
  });
  async function reopenWrites(L, logData, priorOverride) {
    const cur = await readRaw("polls/m1");
    const b = writeBatch(L);
    const logRef = doc(collection(L, "log"));
    if (logData) b.set(logRef, { at: serverTimestamp(), ...logData });
    b.update(doc(L, "polls/m1"), { status: "open", openedAt: serverTimestamp(), result: deleteField(), lockedGroups: deleteField(),
      priorResults: priorOverride || [...(cur.priorResults || []), cur.result], reopenCount: 1, lastLog: logRef.id });
    return b.commit();
  }
  it("with no log, a log for another motion, or a wrong priorResults: refused", async () => {
    await closeAndSave();
    const L = leader();
    await assertFails(reopenWrites(L, null));
    await assertFails(reopenWrites(L, { action: "reopen", pollId: "other" }));
    await assertFails(reopenWrites(L, { action: "close", pollId: "m1" }));
    await assertFails(reopenWrites(L, { action: "reopen", pollId: "m1" }, []));
    await assertSucceeds(reopenWrites(L, { action: "reopen", pollId: "m1" }));
  });
  it("reusing an existing log entry is refused", async () => {
    await closeAndSave();
    await seed("log/used", { at: past(), action: "reopen", pollId: "m1" });
    const cur = await readRaw("polls/m1");
    await assertFails(updateDoc(doc(leader(), "polls/m1"), { status: "open", openedAt: serverTimestamp(), result: deleteField(),
      lockedGroups: deleteField(), priorResults: [cur.result], lastLog: "used" }));
  });
  it("closed to open with no saved result is refused even with a log (save first)", async () => {
    const L = leader();
    const b = writeBatch(L);
    const logRef = doc(collection(L, "log"));
    b.set(logRef, { at: serverTimestamp(), action: "reopen", pollId: "old" });
    b.update(doc(L, "polls/old"), { status: "open", openedAt: serverTimestamp(), lastLog: logRef.id, priorResults: [] });
    await assertFails(b.commit());
    await assertFails(updateDoc(doc(L, "polls/old"), { status: "open" }));   // the old page's "Re-open voting"
  });
  it("a motion replaced by a re-vote cannot be re-opened", async () => {
    await closeAndSave();
    await testEnv.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "polls/m1"), { supersededBy: "m2" }));
    await assertFails(reopenWrites(leader(), { action: "reopen", pollId: "m1" }));
  });
});

describe("ballots and deleting", () => {
  it("ballots of a closed motion cannot be created, changed or deleted, by anyone", async () => {
    await closeAndSave();
    const a = await app();
    as(ed());
    await assertFails(a.castVote({ pollId: "m1", name: "Zed", slug: "zed", group: "1", weight: 1, isWriteIn: false, choice: "favour", sessionId: "dev-z" }));
    for (const who of [leader(), ed()]) {
      await assertFails(setDoc(doc(who, "polls/m1/votes/zed"), ballotFor("zed", "favour")));
      await assertFails(updateDoc(doc(who, "polls/m1/votes/alvin-yang"), { choice: "against" }));
      await assertFails(deleteDoc(doc(who, "polls/m1/votes/alvin-yang")));
    }
  });
  it("a motion can be deleted only from the Trash, and its ballots only after it (the real purgePoll)", async () => {
    await closeAndSave();
    const L = leader();
    await assertFails(deleteDoc(doc(L, "polls/m1")));
    await assertSucceeds(updateDoc(doc(L, "polls/m1"), { deleted: true }));
    await assertFails(deleteDoc(doc(L, "polls/m1/votes/alvin-yang")));   // the old page deleted ballots first
    const a = await app();
    as(L);
    a.setKnownPolls([await readRaw("polls/m1")].map((p) => ({ id: "m1", ...p })));
    await assertSucceeds(a.purgePoll("m1"));
    assert.equal(await readRaw("polls/m1"), null);
    assert.equal(await readRaw("polls/m1/votes/alvin-yang"), null);
    const logs = await getDocs(query(collection(L, "log")));
    const purge = logs.docs.map((d) => d.data()).find((e) => e.action === "purge");
    assert.equal(purge.before.outcome, "noq");
    a.setKnownPolls([]);
  });
});

describe("catch-up of old motions (the real saveMissingResults)", () => {
  it("saves an old closed motion once, with a catch-up log entry", async () => {
    const a = await app();
    as(leader());
    const polls = [{ id: "old", ...(await readRaw("polls/old")) }];
    const r = await a.saveMissingResults(polls);
    assert.equal(r.saved, 1);
    const p = await readRaw("polls/old");
    assert.equal(p.result.savedBy, "catch-up");
    assert.equal(p.result.closedAt, null);
    assert.ok(p.lockedGroups["alvin-yang"]);
    const r2 = await a.saveMissingResults([{ id: "old", ...p }]);
    assert.equal(r2.saved, 0);
    const logs = (await getDocs(collection(leader(), "log"))).docs.map((d) => d.data());
    assert.equal(logs.filter((e) => e.action === "catch-up").length, 1);
  });
});

describe("the previous page's exact writes still pass", () => {
  it("addPoll, openPoll, closePoll, castVote and roster changes", async () => {
    const L = leader();
    await assertSucceeds(setDoc(doc(L, "polls/new"), { text: "New", order: 3, status: "draft", voteCount: 0, archived: false, deleted: false, createdAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(L, "polls/new"), { status: "open", archived: false }));
    const a = await app();
    as(ed());
    await assertSucceeds(a.castVote({ pollId: "new", name: "Zed", slug: "zed", group: "1", weight: 1, isWriteIn: false, choice: "favour", sessionId: "dev-z" }));
    await assertSucceeds(a.castVote({ pollId: "new", name: "Zed", slug: "zed", group: "1", weight: 1, isWriteIn: false, choice: "against", sessionId: "dev-z" }));
    await assertSucceeds(updateDoc(doc(L, "polls/new"), { status: "closed", lockedGroups: { zed: "1" } }));
    await assertSucceeds(setDoc(doc(L, "config/roster"), { groups: { zed: "2" } }, { merge: true }));
    await assertSucceeds(updateDoc(doc(L, "polls/d1"), { text: "Reworded draft" }));
    await assertSucceeds(updateDoc(doc(L, "polls/d1"), { deleted: true }));
    await assertSucceeds(updateDoc(doc(L, "polls/d1"), { deleted: false }));
  });
});

describe("voters and the change log", () => {
  it("a voter writes nothing but a ballot and the +1", async () => {
    const E = ed();
    await assertFails(updateDoc(doc(E, "polls/old"), { result: resultObj() }));
    await assertFails(updateDoc(doc(E, "polls/m1"), { status: "closed", closedAt: serverTimestamp(), closeOfOpenedAt: OPENED }));
    await assertFails(setDoc(doc(E, "log/x"), { at: serverTimestamp(), action: "close", pollId: "m1" }));
    await assertFails(getDocs(query(collection(E, "log"), limit(1))));
  });
  it("nobody edits or deletes a log entry; bad shapes are refused", async () => {
    await seed("log/e1", { at: past(), action: "close", pollId: "m1" });
    const L = leader();
    await assertSucceeds(getDoc(doc(L, "log/e1")));
    await assertFails(updateDoc(doc(L, "log/e1"), { reason: "edited" }));
    await assertFails(deleteDoc(doc(L, "log/e1")));
    await assertFails(setDoc(doc(L, "log/n1"), { at: past(), action: "close" }));                       // client time
    await assertFails(setDoc(doc(L, "log/n2"), { at: serverTimestamp(), action: "rewrite" }));           // unknown action
    await assertFails(setDoc(doc(L, "log/n3"), { at: serverTimestamp(), action: "close", extra: 1 }));   // unknown field
    await assertFails(setDoc(doc(L, "log/n4"), { at: serverTimestamp(), action: "reopen", reason: "x".repeat(1001) }));
    await assertSucceeds(setDoc(doc(L, "log/n5"), { at: serverTimestamp(), action: "reopen", pollId: "m1", reason: "Fine.", by: "Kyle" }));
  });
});
