// ============================================================================
//  Meetings and the change log's retention (R4).
//    - everyone signed in reads meetings; only leadership writes them; a
//      meeting is deleted only from the Trash
//    - a change-log entry can be deleted only by leadership, and only from
//      the day after its Nth anniversary (N = settings.retentionYears, never
//      less than 7, also when the stored setting is lower or missing)
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, Timestamp } from "firebase/firestore";
import { setUp, tearDown, testEnv, ed, leader, seed, readRaw, past, ballotFor, app, as } from "./helpers.mjs";

before(setUp);
after(tearDown);
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("meetings/m1", { title: "ED department meeting", date: "2026-11-20", status: "planned", deleted: false });
});

describe("meetings", () => {
  it("ED reads meetings and cannot write them; leadership writes", async () => {
    await assertSucceeds(getDoc(doc(ed(), "meetings/m1")));
    await assertSucceeds(getDocs(collection(ed(), "meetings")));
    await assertFails(setDoc(doc(ed(), "meetings/m2"), { title: "x" }));
    await assertFails(updateDoc(doc(ed(), "meetings/m1"), { status: "open" }));
    await assertSucceeds(setDoc(doc(leader(), "meetings/m2"), { title: "x", date: "2026-12-01", status: "planned" }));
    await assertSucceeds(updateDoc(doc(leader(), "meetings/m1"), { status: "open" }));
  });
  it("a meeting is deleted only from the Trash", async () => {
    await assertFails(deleteDoc(doc(leader(), "meetings/m1")));
    await assertSucceeds(updateDoc(doc(leader(), "meetings/m1"), { deleted: true }));
    await assertFails(deleteDoc(doc(ed(), "meetings/m1")));
    await assertSucceeds(deleteDoc(doc(leader(), "meetings/m1")));
  });
  it("the real meeting code: create, start, move a motion in, end, trash, purge", async () => {
    const a = await app();
    as(leader());
    await seed("polls/p1", { text: "Old motion", order: 0, status: "closed", voteCount: 1, archived: false, deleted: false,
      result: { v: 1, kind: "motion", outcome: "pass", totalVotes: 1, quorumCount: 1, quorumNeeded: 1, eligible: 1, rule: {}, savedAt: past(), weight: { favour: 1, against: 0, abstain: 0 }, count: { favour: 1, against: 0, abstain: 0 } } });
    await seed("polls/p1/votes/ash", ballotFor("ash", "favour"));
    const polls = async () => (await getDocs(collection(leader(), "polls"))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const meetings = async () => (await getDocs(collection(leader(), "meetings"))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const sync = async () => { a.setKnownPolls(await polls()); a.setKnownMeetings(await meetings()); };
    a.forgetBoard();
    await sync();
    await a.ensureBoard();
    const id = await a.createMeeting("TEST, please ignore", "2026-11-21");
    await sync();
    const un = a.onLive(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await assertSucceeds(a.startMeeting(id));
    await sync();
    await new Promise((r) => setTimeout(r, 200));
    let live = await readRaw("config/live");
    assert.equal(live.meeting.id, id);
    await assertSucceeds(a.moveToMeeting("p1", id));      // a closed motion can move; its result never changes
    await sync();
    await new Promise((r) => setTimeout(r, 200));
    live = await readRaw("config/live");
    assert.ok(live.results.p1, "the moved motion is on the open meeting's board");
    await assertSucceeds(a.endMeeting(id));
    await sync();
    await new Promise((r) => setTimeout(r, 200));
    live = await readRaw("config/live");
    assert.equal(live.meeting.status, "closed");
    await assertSucceeds(a.setMeetingDeleted(id, true));
    await sync();
    await assertSucceeds(a.purgeMeeting(id));
    assert.equal(await readRaw(`meetings/${id}`), null);
    assert.equal(await readRaw("polls/p1"), null);
    assert.equal(await readRaw("polls/p1/votes/ash"), null);
    const logs = (await getDocs(collection(leader(), "log"))).docs.map((d) => d.data());
    assert.ok(logs.some((e) => e.action === "purge" && e.meetingId === id));
    un();
    a.setKnownPolls([]); a.setKnownMeetings([]);
  });
});

describe("change-log retention", () => {
  const day = 86400000;
  const utc = (y, m, d, h = 12) => Timestamp.fromMillis(Date.UTC(y, m - 1, d, h));
  const now = new Date();
  const cases = [
    ["8 years old, no settings document: deletable", () => Timestamp.fromMillis(Date.now() - 8 * 366 * day), null, true],
    ["6 years old, no settings document: kept", () => Timestamp.fromMillis(Date.now() - 6 * 365 * day), null, false],
    ["2 years old, a stored setting of 1 (before the settings rules): kept (7 is the floor)", () => Timestamp.fromMillis(Date.now() - 2 * 365 * day), { retentionYears: 1 }, false],
    ["8 years old with a setting of 10: kept", () => Timestamp.fromMillis(Date.now() - 8 * 365 * day), { retentionYears: 10 }, false],
    ["11 years old with a setting of 10: deletable", () => Timestamp.fromMillis(Date.now() - 11 * 366 * day), { retentionYears: 10 }, true],
    ["exactly 7 x 365 days old: kept", () => Timestamp.fromMillis(Date.now() - 7 * 365 * day), null, false],
    ["the 7th anniversary is today: kept", () => utc(now.getUTCFullYear() - 7, now.getUTCMonth() + 1, now.getUTCDate(), 0), null, false],
    ["the 7th anniversary was yesterday: deletable", () => { const n = new Date(Date.now() - day); return utc(n.getUTCFullYear() - 7, n.getUTCMonth() + 1, n.getUTCDate(), 23); }, null, true],
    ["Feb 29 2016: anniversary Mar 1 2023, deletable", () => utc(2016, 2, 29), null, true],
    ["Feb 29 2020: anniversary Mar 1 2027, kept", () => utc(2020, 2, 29), null, false],
  ];
  for (const [name, at, settings, ok] of cases) {
    it(name, async () => {
      if (settings) await seed("config/settings", settings);
      await seed("log/e1", { at: at(), action: "close", pollId: "p1" });
      if (ok) await assertSucceeds(deleteDoc(doc(leader(), "log/e1")));
      else await assertFails(deleteDoc(doc(leader(), "log/e1")));
    });
  }
  it("ED can never delete a log entry", async () => {
    await seed("log/e1", { at: Timestamp.fromMillis(Date.now() - 20 * 366 * 86400000), action: "close" });
    await assertFails(deleteDoc(doc(ed(), "log/e1")));
  });
});

describe("Delete history older than 7 years (the real page code)", () => {
  it("deletes only entries past the retention period and records it", async () => {
    await seed("log/old", { at: Timestamp.fromMillis(Date.now() - 8 * 366 * 86400000), action: "close", pollId: "x" });
    await seed("log/new", { at: Timestamp.fromMillis(Date.now() - 6 * 365 * 86400000), action: "close", pollId: "x" });
    const a = await app();
    as(leader());
    assert.equal(await a.purgeOldHistory(), 1);
    assert.equal(await readRaw("log/old"), null);
    assert.ok(await readRaw("log/new"));
    const logs = (await getDocs(collection(leader(), "log"))).docs.map((d) => d.data());
    assert.ok(logs.some((e) => e.action === "history-purge"));
  });
});

describe("meeting delete with an open motion (the real page code)", () => {
  it("is refused before anything is written", async () => {
    await seed("polls/p1", { text: "Open", order: 0, status: "open", voteCount: 0, meetingId: "m1", archived: false, deleted: false });
    const a = await app();
    as(leader());
    a.setKnownPolls([{ id: "p1", ...(await readRaw("polls/p1")) }]);
    a.setKnownMeetings([{ id: "m1", ...(await readRaw("meetings/m1")) }]);
    await assert.rejects(a.setMeetingDeleted("m1", true), (e) => e.why === "open");
    await assert.rejects(a.purgeMeeting("m1"), (e) => e.why === "open");
    assert.equal((await readRaw("meetings/m1")).deleted, false);
    assert.ok(await readRaw("polls/p1"));
    a.setKnownPolls([]); a.setKnownMeetings([]);
  });
});
