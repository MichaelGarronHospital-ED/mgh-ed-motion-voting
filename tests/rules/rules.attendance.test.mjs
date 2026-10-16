// ============================================================================
//  Attendance (R7): check-in only while the meeting is open, under its own
//  name, in the room or remote, the server's time, no extra fields. Leadership
//  adds and removes. (No proxies: Alvin's decision, Oct 2026.)
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDocs, collection, setDoc, deleteDoc, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { setUp, tearDown, testEnv, ed, leader, seed, readRaw, app, as } from "./helpers.mjs";

before(setUp);
after(tearDown);
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("meetings/open", { title: "Open meeting", date: "2026-11-20", status: "open" });
  await seed("meetings/planned", { title: "Planned", date: "2026-12-01", status: "planned" });
});
const ci = (slug, extra = {}) => ({ name: "Alvin Yang", slug, mode: "room", sessionId: "dev-1", at: serverTimestamp(), ...extra });

describe("check-in (ED)", () => {
  it("the real checkIn passes while the meeting is open, and can change mode", async () => {
    const a = await app();
    as(ed());
    await assertSucceeds(a.checkIn("open", { name: "Alvin Yang", slug: "alvin-yang" }, "room", "dev-1"));
    await assertSucceeds(a.checkIn("open", { name: "Alvin Yang", slug: "alvin-yang" }, "remote", "dev-1"));
    assert.equal((await readRaw("meetings/open/attendance/alvin-yang")).mode, "remote");
  });
  it("refused when the meeting is not open", async () => {
    await assertFails(setDoc(doc(ed(), "meetings/planned/attendance/alvin-yang"), ci("alvin-yang")));
  });
  it("refused under another name, with a wrong mode, the phone's own time, or extra fields", async () => {
    await assertFails(setDoc(doc(ed(), "meetings/open/attendance/someone-else"), ci("alvin-yang")));
    await assertFails(setDoc(doc(ed(), "meetings/open/attendance/alvin-yang"), ci("alvin-yang", { mode: "here" })));
    await assertFails(setDoc(doc(ed(), "meetings/open/attendance/alvin-yang"), ci("alvin-yang", { at: Timestamp.now() })));
    await assertFails(setDoc(doc(ed(), "meetings/open/attendance/alvin-yang"), ci("alvin-yang", { note: "hi" })));
    await assertFails(setDoc(doc(ed(), "meetings/open/attendance/Bad Slug"), ci("Bad Slug")));
  });
  it("a voter cannot delete a check-in; leadership can add and remove", async () => {
    await seed("meetings/open/attendance/alvin-yang", { name: "Alvin Yang", slug: "alvin-yang", mode: "room", sessionId: "d", at: Timestamp.now() });
    await assertFails(deleteDoc(doc(ed(), "meetings/open/attendance/alvin-yang")));
    const a = await app();
    as(leader());
    await assertSucceeds(a.addAttendance("planned", { name: "David Ng", slug: "david-ng" }, "room", "Present, did not use a phone"));
    await assertSucceeds(a.removeAttendance("open", "alvin-yang", "Alvin Yang"));
    const logs = (await getDocs(collection(leader(), "log"))).docs.map((d) => d.data().action);
    assert.deepEqual(logs.sort(), ["attendance", "attendance"]);
  });
  it("there is no proxies collection to write", async () => {
    await assertFails(setDoc(doc(leader(), "meetings/open/proxies/david-ng"), { holder: "alvin-yang" }));
  });
  it("a motion without a meeting behaves exactly as before", async () => {
    await seed("polls/p1", { text: "x", status: "open", voteCount: 0 });
    const a = await app();
    as(ed());
    await assertSucceeds(a.castVote({ pollId: "p1", name: "Zed", slug: "zed", group: "1", weight: 1, isWriteIn: false, choice: "favour", sessionId: "d" }));
  });
});
