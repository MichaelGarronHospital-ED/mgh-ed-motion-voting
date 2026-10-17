// ============================================================================
//  Every source each page of THIS step reads must be readable under these
//  rules, as the account that page runs as (ED for the voter page, Leadership
//  for the console). A page waiting on data its live rules refuse would hang,
//  so each step of the voting upgrade adds its sources here.
//
//  Step 1 (saved results): console: polls, ballots, config/roster,
//  config/settings (may be missing), log. Voter page: polls, ballots,
//  config/roster.
//  Step 2 (voters' board): console adds config/live and config/history. The
//  voter page reads config/live, config/roster, config/history (on a tap), and
//  as fallbacks: the open motions (where status == open), the closed motions
//  once, one motion and its ballots (a late result counted once).
//  Step 3 (settings, roster paste): no new source (config/settings was already read).
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, query, orderBy, limit, where } from "firebase/firestore";
import { setUp, tearDown, testEnv, ed, leader, seed, past, ballotFor } from "./helpers.mjs";

before(setUp);
after(tearDown);
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed("polls/p1", { text: "A", order: 0, status: "open", voteCount: 1 });
  await seed("polls/p1/votes/ash", ballotFor("ash", "favour"));
  await seed("config/roster", { groups: {} });
  await seed("log/e1", { at: past(), action: "close", pollId: "p1" });
});

const SOURCES = {
  console: [
    ["polls (ordered)", (db) => getDocs(query(collection(db, "polls"), orderBy("order")))],
    ["a motion's ballots", (db) => getDocs(collection(db, "polls/p1/votes"))],
    ["config/roster", (db) => getDoc(doc(db, "config/roster"))],
    ["config/settings (missing is fine)", (db) => getDoc(doc(db, "config/settings"))],
    ["the change log, newest first", (db) => getDocs(query(collection(db, "log"), orderBy("at", "desc"), limit(50)))],
    ["one motion's change log", (db) => getDocs(query(collection(db, "log"), where("pollId", "==", "p1")))],
    ["config/live (may be missing)", (db) => getDoc(doc(db, "config/live"))],
    ["config/history (may be missing)", (db) => getDoc(doc(db, "config/history"))],
  ],
  voter: [
    ["config/live", (db) => getDoc(doc(db, "config/live"))],
    ["config/roster", (db) => getDoc(doc(db, "config/roster"))],
    ["config/history (on a tap)", (db) => getDoc(doc(db, "config/history"))],
    ["the open motions (fallback)", (db) => getDocs(query(collection(db, "polls"), where("status", "==", "open")))],
    ["the closed motions (fallback for earlier results)", (db) => getDocs(query(collection(db, "polls"), where("status", "==", "closed")))],
    ["one motion (a late result)", (db) => getDoc(doc(db, "polls/p1"))],
    ["its ballots (a late result)", (db) => getDocs(collection(db, "polls/p1/votes"))],
  ],
};

describe("step 3 pages read only what the rules allow", () => {
  for (const [name, read] of SOURCES.console) {
    it(`console (Leadership) can read ${name}`, async () => { await assertSucceeds(read(leader())); });
  }
  for (const [name, read] of SOURCES.voter) {
    it(`voter page (ED) can read ${name}`, async () => { await assertSucceeds(read(ed())); });
  }
  it("the voter page never needs the change log, and cannot read it", async () => {
    await assertFails(getDocs(query(collection(ed(), "log"), limit(1))));
  });
});
