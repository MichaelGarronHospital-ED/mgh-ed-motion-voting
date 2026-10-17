// Shared set-up for the rules tests: the emulator, the two shared accounts,
// seeding, and the page code itself (js/db.js), run against the emulator.
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, Timestamp, serverTimestamp } from "firebase/firestore";

export let testEnv;
export async function setUp() {
  testEnv = await initializeTestEnvironment({
    projectId: "ed-motion-voting-test",
    firestore: {
      rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
      // the port in firebase.json (8181), as the emulator reports it
      host: (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181").split(":")[0],
      port: Number((process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181").split(":")[1]),
    },
  });
  return testEnv;
}
export async function tearDown() { if (testEnv) await testEnv.cleanup(); }

// The two accounts, by uid (the same as LEADER_UID and ED_UID in js/config.js
// and firestore.rules; tests/test_accounts.py checks). A real sign-in token
// carries the email too and the provider "password".
export const LEADER_UID = "3eigCLaK0RQ5PmVhxfDgI0qoYzQ2";
export const ED_UID = "CXyo7yciWpc78J1TQYRzrPpu77C3";
export const account = (uid, email, provider = "password") =>
  testEnv.authenticatedContext(uid, { email, firebase: { sign_in_provider: provider, identities: {} } }).firestore();
export const ed = () => account(ED_UID, "ed@mgh-ed-voting.invalid");
export const leader = () => account(LEADER_UID, "leadership@mgh-ed-voting.invalid");
export const anonUser = () => testEnv.authenticatedContext("u-anon").firestore();
export const stranger = () => testEnv.authenticatedContext("u-stranger", { email: "someone@example.com" }).firestore();
export const signedOut = () => testEnv.unauthenticatedContext().firestore();

export async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
}
export async function readRaw(path) {
  let out;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const { getDoc } = await import("firebase/firestore");
    const s = await getDoc(doc(ctx.firestore(), path));
    out = s.exists() ? s.data() : null;
  });
  return out;
}
export const past = (ms = 60000) => Timestamp.fromMillis(Date.now() - ms);

// A ballot as js/db.js castVote stores it (after the server fills the times).
export function storedBallot(choice, extra = {}) {
  const t = past();
  return {
    name: "Ashcombe", slug: "ashcombe", group: "1", weight: 1, isWriteIn: false, choice,
    sessionIds: ["dev-a"], submissionCount: 1, flagged: false, firstAt: t, lastAt: t, ...extra,
  };
}
export function ballotFor(slug, choice, extra = {}) {
  const t = past();
  return {
    name: slug, slug, group: "1", weight: 1, isWriteIn: false, choice,
    sessionIds: ["dev-" + slug], submissionCount: 1, flagged: false, firstAt: t, lastAt: t, ...extra,
  };
}
// What castVote writes for a first ballot (server timestamps, as the app sends them).
export function newBallot(slug, choice, extra = {}) {
  return {
    name: slug, slug, group: "1", weight: 1, isWriteIn: false, choice,
    sessionIds: ["dev-x"], submissionCount: 1, flagged: false,
    firstAt: serverTimestamp(), lastAt: serverTimestamp(), ...extra,
  };
}

// The page code. `as(db)` picks the sign-in it runs with.
let appMod = null;
export async function app() {
  if (!appMod) appMod = await import("../../js/db.js");
  return appMod;
}
export function as(db) { globalThis.__appDb = db; return db; }
