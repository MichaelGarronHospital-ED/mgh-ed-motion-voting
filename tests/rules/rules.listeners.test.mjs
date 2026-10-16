// ============================================================================
//  Every source each page of THIS step reads must be readable under these
//  rules, as the account that page runs as (ED for the voter page, Leadership
//  for the console). A page waiting on data its live rules refuse would hang,
//  so each step of the voting upgrade adds its sources here.
//
//  Step 1 (saved results): console: polls, ballots, config/roster,
//  config/settings (may be missing), log. Voter page: polls, ballots,
//  config/roster.
// ============================================================================
import { before, after, beforeEach, describe, it } from "node:test";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, query, orderBy, limit } from "firebase/firestore";
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
  ],
  voter: [
    ["polls (ordered)", (db) => getDocs(query(collection(db, "polls"), orderBy("order")))],
    ["the open motion's ballots", (db) => getDocs(collection(db, "polls/p1/votes"))],
    ["config/roster", (db) => getDoc(doc(db, "config/roster"))],
  ],
};

describe("step 1 pages read only what the rules allow", () => {
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
