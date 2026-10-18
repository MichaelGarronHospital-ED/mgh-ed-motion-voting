// ============================================================================
//  Admin console: the shell (sign-in, tabs), the live listeners, the load
//  gate, the banners, and the close / save / open / re-open flows.
//  Each tab lives in its own module; they share state through admin-state.js.
// ============================================================================
import { ORG_NAME } from "./config.js?v=voting-11";
import {
  onPolls, onVotesFor, onRosterOverrides, onSettings, watchAuth, leaderSignIn, leaderSignOut, isLeader,
  isWrongPassword, gateNeed, gateIsOpen, whenReady, classify, withTimeout, rulesNeedUpdate, DB_UPDATE_MSG,
  closeMotion, saveResult, saveMissingResults, openPoll, reopenMotion, whyCloseRefused, finishPurges,
  setKnownPolls, tsMillis, resultSaved, onLive, onHistoryDoc, ensureBoard, healBoard, writeHistory, boardIsCurrent,
  historyIsCurrent, revoteMotion, runoffMotion, setLogName, currentLive, onMeetings, currentMeetings,
} from "./db.js?v=voting-11";
import { toast, icon, escapeHtml } from "./util.js?v=voting-11";
import { $, S, R } from "./admin-state.js?v=voting-11";
import { watchVersion } from "./version.js?v=voting-11";
import { wireMotions } from "./admin-motions.js?v=voting-11";
import { wireResults } from "./admin-results.js?v=voting-11";
import { wireRoster } from "./admin-roster.js?v=voting-11";
import { wireRecords } from "./records.js?v=voting-11";
import { wireSettings } from "./admin-settings.js?v=voting-11";
import { wireMeeting } from "./admin-meeting.js?v=voting-11";

document.title = ORG_NAME + " · Admin";
// The code loaded: the "Starting..." line (there in case a browser mixes old
// and new files after an update) goes.
$("boot-note")?.remove();   // a page from before this version has none

// ----------------------------------------------------------------- gate (sign-in)
let booted = false;
function unlock() {
  $("gate").classList.add("hide");
  $("console").classList.remove("hide");
  if (!booted) { booted = true; boot(); }
  updateTabHint();
}
// A real form: Enter in the field and a tap on Continue both submit it.
$("gate-form").addEventListener("submit", (e) => { e.preventDefault(); tryEnter(); });
// Only now can the form be used (see the comment in admin-9f4k2x7q.html).
$("gate-fields").disabled = false;
// The Admin password is checked by Firebase itself (it is the password of
// the Admin account, leadership@); nothing about it is stored in this public code, and
// the console opens only on a real sign-in, so writes are always authorised.
async function tryEnter() {
  const typed = $("pass").value.trim(), err = $("gate-err");   // passwords never start or end with a space
  if (!typed) return;
  $("enter").disabled = true; err.classList.add("hide");
  try { await leaderSignIn(typed); unlock(); }
  catch (e) {
    const msg = isWrongPassword(e) ? "Incorrect password." : "Couldn't sign in. Check your connection and try again.";
    err.innerHTML = icon("alert", 18) + `<span>${msg}</span>`;
    err.classList.remove("hide");
  } finally { $("enter").disabled = false; }
}
// After the database refused this sign-in (for example once a password change
// ended old sessions), the page reloads signed out and says so.
try {
  if (sessionStorage.getItem("mv_signin_again")) {
    sessionStorage.removeItem("mv_signin_again");
    const err = $("gate-err");
    err.innerHTML = icon("alert", 18) + "<span>Please sign in again.</span>";
    err.classList.remove("hide");
  }
} catch (e) { /* private mode */ }
// Auto-unlock on reload if an Admin session is already persisted.
watchAuth((user) => { if (isLeader(user)) unlock(); });
$("lock").addEventListener("click", async (e) => {
  e.preventDefault();
  if (S.busy > 0) {
    toast("Saving the result first...");
    while (S.busy > 0) await new Promise((r) => setTimeout(r, 200));
  }
  leaderSignOut().finally(() => location.reload());
});
// A result being saved must not be lost by closing the tab. Desktop browsers
// ask first; iPad and iPhone Safari skip this, so the saving sheet says so.
window.addEventListener("beforeunload", (e) => { if (S.busy > 0) { e.preventDefault(); e.returnValue = ""; } });

// ----------------------------------------------------------------- tabs
function showTab(name) {
  document.querySelectorAll(".tab").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    x.setAttribute("aria-pressed", String(x.dataset.tab === name));
  });
  ["meeting", "motions", "results", "voters", "roster", "settings"].forEach((n) =>
    $("tab-" + n).classList.toggle("hide", n !== name));
  $("open-settings").setAttribute("aria-pressed", String(name === "settings"));
}
R.showTab = showTab;
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => { showTab(t.dataset.tab); t.scrollIntoView({ block: "nearest", inline: "nearest" }); }));
// On a narrow phone the five tabs can run past the edge: fade the edge so it is
// clear there is more to scroll to.
const tabsNav = document.querySelector("#console .tabs");
function updateTabHint() {
  tabsNav.parentElement.classList.toggle("more", tabsNav.scrollLeft + tabsNav.clientWidth < tabsNav.scrollWidth - 2);
}
tabsNav.addEventListener("scroll", updateTabHint, { passive: true });
window.addEventListener("resize", updateTabHint);

// ----------------------------------------------------------------- banners
// One line per problem, at the top of the console, until it clears.
const banners = new Map();
function setBanner(key, html, kind = "warn") {
  if (html) banners.set(key, { html, kind }); else banners.delete(key);
  const el = $("banners");
  el.innerHTML = [...banners.entries()].map(([k, b]) =>
    `<div class="banner ${b.kind}" data-banner="${k}">${icon(b.kind === "warn" ? "alert" : "check", 20)}<div>${b.html}</div></div>`).join("");
}
R.setBanner = setBanner;
// A newer version on the site (an update reached it while this tab was open).
watchVersion(() => setBanner("version", `A newer version is available. <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-reload="1">Reload</button> If this keeps showing, wait 10 minutes and reload.`));
$("banners").addEventListener("click", (e) => { if (e.target.closest("[data-reload]")) location.reload(); });
const NO_CONN = "No connection to the voting database. Open and Close will work again when it reconnects.";
const DB_UPDATE_CONSOLE = "This page needs a database update that has not been published yet. Open and Close are off until it is.";

// Open and Close (and everything that saves a result) wait for the gate.
S.ready = false; S.dbUpdate = false; S.offline = false; S.busy = 0;
S.saving = new Set();       // motions whose result this laptop is saving now
S.reopenFor = null;         // motion whose Re-open form is showing
// From step 2 the voters' board must be known too (actions patch it).
R.canOpenClose = () => S.ready && !S.dbUpdate && currentLive() !== undefined;

// ----------------------------------------------------------------- boot
let votesUnsub = null;
function boot() {
  // share tab
  const url = location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html";
  $("vote-url").textContent = url;
  $("copy-url").addEventListener("click", () => { navigator.clipboard.writeText(url); toast("Link copied."); });

  wireMotions();
  wireResults();
  wireRoster();
  wireRecords();
  wireSettings();
  wireMeeting();

  // The load gate: these three, each from the server, before anything that
  // saves a result or opens and closes runs.
  ["roster", "settings", "polls", "meetings"].forEach(gateNeed);
  const onErr = (src) => (e) => sourceFailed(src, e);
  // category changes re-weight everything live
  onRosterOverrides(() => { R.roster(); R.results(); R.voters(); }, { gate: "roster", onError: onErr("roster") });
  onSettings(() => {
    R.roster(); R.results(); R.syncDefaultThreshold();
    if (!$("tab-settings").classList.contains("hide")) R.renderSettings();
  }, { gate: "settings", onError: onErr("settings") });
  R.roster();

  onPolls((p, snap) => {
    S.polls = p;
    setKnownPolls(p);
    S.offline = !!snap.metadata.fromCache;
    if (!S.offline && gateIsOpen()) { setBanner("conn", null); }
    // Same filter the voter page uses (js/vote.js): an archived motion is
    // hidden from voters, so leadership must not treat one as the live motion.
    const open = S.polls.find((x) => x.status === "open" && !x.archived && !x.deleted) || null;
    const changed = (S.activePoll && S.activePoll.id) !== (open && open.id);
    S.activePoll = open;
    if (changed) {
      if (votesUnsub) { votesUnsub(); votesUnsub = null; }
      S.activeVotes = []; S.activeLoaded = false;
      if (S.activePoll) votesUnsub = onVotesFor(S.activePoll.id, (vs) => { S.activeVotes = vs; S.activeLoaded = true; R.collectWriteins(vs); R.results(); R.voters(); });
    }
    R.motions();
    R.results();
    R.voters();
    R.writeins();
    R.meeting();
    S.pending = !!snap.metadata.hasPendingWrites;
    if (S.ready && !S.offline) healResults();
    // Past results are written in their own write after an action, once the
    // server has confirmed it (so every copied time is real).
    if (S.ready && !S.pending && !S.offline && S.historyDirty) flushHistory();
    checkBoard();
  }, { gate: "polls", onError: onErr("polls") });

  // Meetings (from the step-4 rules on): part of the gate.
  onMeetings(() => { R.meeting(); R.motions(); R.results(); checkBoard(); }, { gate: "meetings", onError: onErr("meetings") });

  // The voters' board and past results: compared with what the motions say.
  onLive(() => checkBoard(), { meta: true, onError: onErr("live") });
  onHistoryDoc(() => checkBoard(), { onError: onErr("history") });

  setTimeout(() => { if (!gateIsOpen()) setBanner("conn", NO_CONN); }, 15000);
  whenReady().then(afterGate);
}

// A listener the gate waits on failed.
function sourceFailed(src, e) {
  const kind = classify(e);
  console.warn("listener failed", src, e && e.code);
  if (kind === "refused" && src === "polls") {
    // The sign-in itself is gone: sign out and ask again.
    try { sessionStorage.setItem("mv_signin_again", "1"); } catch (x) { /* private mode */ }
    leaderSignOut().finally(() => location.reload());
    return;
  }
  if (kind === "refused") { S.dbUpdate = true; setBanner("db", DB_UPDATE_CONSOLE); }
  else setBanner("conn", NO_CONN + (kind === "other" ? " If this stays, reload the page." : ""));
  R.motions(); R.results();
}

async function afterGate() {
  setBanner("conn", null);
  if (await rulesNeedUpdate()) {
    S.dbUpdate = true;
    setBanner("db", DB_UPDATE_MSG);
  }
  if (!S.dbUpdate) {
    // The last step of the gate: the board must exist before Open and Close,
    // because every later change to it is a field-path patch.
    try { await ensureBoard(); }
    catch (e) {
      console.warn("board", e);
      if (classify(e) === "refused") { S.dbUpdate = true; setBanner("db", DB_UPDATE_CONSOLE); }
      else setBanner("conn", NO_CONN);
    }
  }
  S.ready = true;
  R.motions(); R.results(); R.voters(); R.meeting();
  if (S.dbUpdate) return;
  finishPurges();
  healResults();
  checkBoard();
}

// ----------------------------------------------------------------- board checks
// Never writes on its own: if the stored board differs from what the motions
// say for 10 seconds (and this laptop has nothing pending), a banner offers
// "Fix it". This catches a board written by a laptop that was a second behind.
let boardT = null, historyT = null;
function checkBoard() {
  if (!S.ready || S.dbUpdate || S.pending || S.offline) return;
  if (boardIsCurrent()) { clearTimeout(boardT); boardT = null; setBanner("board", null); }
  else if (!boardT) boardT = setTimeout(() => { boardT = null; if (!S.pending && !boardIsCurrent()) showFix("board"); }, 10000);
  if (historyIsCurrent()) { clearTimeout(historyT); historyT = null; if (!S.historyFailed) setBanner("history", null); }
  else if (!historyT && !S.historyDirty) historyT = setTimeout(() => { historyT = null; if (!S.pending && !historyIsCurrent()) showFix("history"); }, 10000);
}
R.checkBoard = checkBoard;
function showFix(which) {
  const text = which === "board" ? "The voters' screen is out of date." : "Past results for voters are out of date.";
  setBanner(which, `${text} <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-fix="${which}">Fix it</button>`);
}
$("banners").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-fix]");
  if (!b) return;
  b.disabled = true;
  // Past results: write them again now. The board: the heal (at most every 30 s).
  if (b.dataset.fix === "history") { await flushHistory(); return; }
  const r = await fixBoard();
  if (r === "wait") toast("Just fixed. Try again in a moment if it is still out of date.");
});
async function fixBoard() {
  try {
    const r = await healBoard({ pending: S.pending });
    if (r !== "wait" && r !== "pending") { S.historyFailed = false; setBanner("board", null); setBanner("history", null); }
    return r;
  } catch (e) { await actionFailed(e, "Not allowed: the database refused the voters' screen."); return "failed"; }
}
R.fixBoard = fixBoard;
S.historyDirty = false; S.historyFailed = false;
async function flushHistory() {
  S.historyDirty = false;
  try { await writeHistory(); S.historyFailed = false; setBanner("history", null); }
  catch (e) {
    // A history failure never blocks or undoes the action; the next heal retries.
    console.warn("history", e);
    S.historyFailed = true;
    showFix("history");
  }
}
// After an action: past results need writing, once the server has confirmed it.
function historyChanged() {
  S.historyDirty = true;
  if (S.ready && !S.pending && !S.offline) flushHistory();
}
R.historyChanged = historyChanged;

// ----------------------------------------------------------------- saving results
// Old motions (closed before results were saved) are saved once, after the
// gate; a result that failed to save is tried again on a later snapshot.
let catchUpRunning = false, catchUpBlocked = false;
const retryAt = new Map();     // motion id -> time to try its save again
S.catchup = null;              // { kind, text } for the catch-up card
function healResults() {
  if (!S.ready || S.dbUpdate) return;
  const old = S.polls.filter((p) => p.status === "closed" && !p.result && (p.closedAt === undefined || p.closedAt === null) && !p._pending);
  if (old.length && !catchUpRunning && !catchUpBlocked) runCatchUp();
  const now = Date.now();
  S.polls.filter((p) => p.status === "closed" && !p.result && tsMillis(p.closedAt) !== null && !S.saving.has(p.id)).forEach((p) => {
    if (!retryAt.has(p.id)) {
      // Another laptop may be saving it right now: give it 30 seconds first.
      retryAt.set(p.id, now + 30000);
      setTimeout(() => healResults(), 30500);
    } else if (now >= retryAt.get(p.id)) {
      retryAt.set(p.id, now + 30000);
      backgroundSave(p.id);
    }
  });
}
R.healResults = healResults;
async function runCatchUp() {
  catchUpRunning = true;
  try {
    const r = await saveMissingResults(S.polls);
    if (r.saved) {
      healBoard({ force: true, pending: false }).then(() => historyChanged(), (e) => console.warn("board", e));
      toast(r.saved === 1 ? "Saved the result of 1 earlier motion. Nothing it shows has changed."
        : `Saved the results of ${r.saved} earlier motions. Nothing they show has changed.`);
      S.catchup = { kind: "ok", text: r.flagged.length ? "" : "No earlier motion's result could have been changed by the write-in quorum fix." };
    }
  } catch (e) {
    const n = S.polls.filter((p) => p.status === "closed" && !p.result && !p.closedAt).length;
    const kind = classify(e);
    console.warn("catch-up failed", e);
    if (kind === "refused") {
      catchUpBlocked = true;
      const why = (await rulesNeedUpdate()) ? DB_UPDATE_MSG : "the database refused it";
      S.catchup = { kind: "fail", text: `${n} earlier result${n === 1 ? "" : "s"} could not be saved: ${why}` };
    } else {
      S.catchup = { kind: "offline", text: `${n} earlier result${n === 1 ? " is" : "s are"} not saved yet: no connection. They save on the next sign-in.` };
      catchUpBlocked = true;
    }
  } finally { catchUpRunning = false; R.results(); }
}
R.retryCatchUp = () => { catchUpBlocked = false; S.catchup = null; healResults(); R.results(); };
async function backgroundSave(id) {
  if (S.saving.has(id)) return;
  S.saving.add(id); S.busy += 1;
  try { await withTimeout(saveResult(id), 20000); }
  catch (e) { console.warn("save failed", id, e && e.code); }
  finally { S.saving.delete(id); S.busy -= 1; R.results(); }
}

// ----------------------------------------------------------------- the saving sheet
// A real dialog: focus moves into it, the status line is read out.
const sheet = {
  open(title, status, hint) {
    $("sheet-title").textContent = title;
    this.status(status);
    this.hint(hint || "");
    this.actions([]);
    $("sheet").classList.remove("hide");
    $("sheet-title").focus();
  },
  status(t) { $("sheet-status").textContent = t; },
  hint(t) { $("sheet-hint").textContent = t; $("sheet-hint").classList.toggle("hide", !t); },
  actions(list) {
    const el = $("sheet-actions");
    el.innerHTML = list.map(([label], i) => `<button type="button" class="ed-btn ${i === 0 ? "ed-btn-filled" : "ed-btn-tinted"}" data-i="${i}">${escapeHtml(label)}</button>`).join("");
    el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => list[Number(b.dataset.i)][1]()));
    if (list.length) el.querySelector("button").focus();
  },
  close() { $("sheet").classList.add("hide"); },
};
const IOS_HINT = "On an iPad or iPhone, keep this screen open until it says Result saved.";

// Close a motion: step 1 freezes it (voting stops), step 2 saves its result.
// Returns true once closed (even if the save is still to come).
async function closeFlow(id) {
  const p = S.polls.find((x) => x.id === id);
  if (!p) return false;
  const seen = { openedAt: p.openedAt === undefined ? null : p.openedAt,
    votes: S.activePoll && S.activePoll.id === id ? S.activeVotes : [] };
  S.busy += 1;
  const waiting = "Closing... waiting for the connection. Voting is still open until this finishes.";
  sheet.open("Closing the vote", S.offline ? waiting : "Closing... Voting is still open until this finishes.", IOS_HINT);
  let stuckT;
  const slowT = setTimeout(() => sheet.status(waiting), 3000);
  const stuck = () => {
    stuckT = setTimeout(() => {
      sheet.status("Still waiting for the connection.");
      sheet.hint("If it does not come back, close the vote from another device.");
      sheet.actions([["Keep waiting", () => { sheet.status(waiting); sheet.hint(IOS_HINT); sheet.actions([]); stuck(); }]]);
    }, 20000);
  };
  stuck();
  try {
    await closeMotion(id, seen);
  } catch (e) {
    clearTimeout(slowT); clearTimeout(stuckT);
    S.busy -= 1;
    if (e && e.why === "closed") {
      sheet.status("Could not close: it is already closed.");
      sheet.hint(""); sheet.actions([["OK", () => sheet.close()]]);
      return false;
    }
    if (classify(e) !== "refused") {
      // A transaction is never queued: nothing happened, voting is still open.
      sheet.status("Not closed: no connection. Voting is still open.");
      sheet.hint("");
      sheet.actions([["Try again", () => { sheet.close(); closeFlow(id); }], ["Cancel", () => sheet.close()]]);
      return false;
    }
    const why = await whyCloseRefused(id, seen.openedAt);
    sheet.status(`Could not close: ${why}${/[.]$/.test(why) ? "" : "."}`);
    sheet.hint("");
    sheet.actions([["OK", () => sheet.close()]]);
    return false;
  }
  clearTimeout(slowT); clearTimeout(stuckT);
  S.busy -= 1;
  await saveFlow(id);
  return true;
}
R.closeFlow = closeFlow;

async function saveFlow(id) {
  S.saving.add(id); S.busy += 1;
  sheet.open("Saving the result", "Saving the result... Keep this page open.", IOS_HINT);
  try {
    const r = await withTimeout(saveResult(id), 20000);
    // "Saved" only when a result really exists (another laptop may have saved
    // it, or the motion may have been re-opened since).
    if (r !== "saved" && !(await resultSaved(id))) {
      sheet.status("Result not saved: the motion was re-opened or changed since it closed.");
      sheet.hint("");
      sheet.actions([["OK", () => sheet.close()]]);
      return;
    }
    historyChanged();
    sheet.close();
    toast("Motion closed. Result saved.");
    const p = S.polls.find((x) => x.id === id);
    if (p && p.amends) {
      setTimeout(() => {
        const q = S.polls.find((x) => x.id === id);
        const nums = R.numbers();
        if (q && q.result && q.result.outcome === "pass") toast(`Amendment ${nums[id] ? nums[id].number : ""} passed. Edit the main motion's wording to include it before opening.`);
      }, 2400);
    }
  } catch (e) {
    console.warn("save failed", e);
    const kind = classify(e);
    if (kind === "refused") {
      const why = (await rulesNeedUpdate()) ? DB_UPDATE_MSG : "the database refused it.";
      sheet.status(`Result not saved: ${why}`);
    } else {
      sheet.status("Result not saved yet: no connection. It saves by itself when the connection is back.");
      retryAt.set(id, 0);   // the next snapshot from the server tries again
    }
    sheet.hint("");
    sheet.actions([["Try again", () => saveFlow(id)], ["Hide this message", () => sheet.close()]]);
  } finally {
    S.saving.delete(id); S.busy -= 1;
    R.results();
  }
}
R.saveFlow = saveFlow;

// A refused or failed action, in plain words.
async function actionFailed(e, refusedText) {
  console.warn(e);
  const kind = classify(e);
  if (kind === "refused") toast((await rulesNeedUpdate()) ? DB_UPDATE_MSG : refusedText);
  else toast("Not saved: no connection. Try again.");
}
R.actionFailed = actionFailed;

// Open a draft motion (closing any other open motion first, with its result).
async function openFlow(id) {
  const p = S.polls.find((x) => x.id === id) || {};
  const nums = R.numbers();
  const n = (x) => (nums[x] ? nums[x].number : "");
  const draftKids = S.polls.filter((a) => a.amends === id && !a.deleted && !a.archived && a.status === "draft");
  if (draftKids.length && !confirm(`Amendment ${n(draftKids[0].id)} hasn't been voted yet. Open the main motion anyway?`)) return;
  const main = p.amends ? S.polls.find((x) => x.id === p.amends) : null;
  if (main && main.status === "closed" && !confirm("The main motion has already been voted. Open this amendment anyway?")) return;
  // Its meeting has not started and another one is open: end that one first
  // (which closes its open motion with its result), as Start meeting does.
  const m = currentMeetings().find((x) => x.id === p.meetingId && !x.deleted);
  const otherM = m && m.status === "planned" ? currentMeetings().find((x) => x.status === "open" && !x.deleted && x.id !== m.id) : null;
  if (otherM) {
    if (!confirm(`${otherM.title || "Another meeting"} is still open. End the other meeting first?`)) return;
    if (!(await R.endFlow(otherM.id))) return;
  }
  const others = S.polls.filter((p) => p.status === "open" && p.id !== id);
  if (others.length && !confirm("This will close the currently open motion. Continue?")) return;
  for (const o of others) { if (!(await closeFlow(o.id))) return; }
  try {
    await openPoll(id);
    toast(m && m.status === "planned" ? "Meeting started and motion opened. Voters can vote now." : "Motion opened. Voters can vote now.");
  } catch (e) {
    if (e && e.why === "meeting-open") toast("Another meeting is still open. End it first (Meeting tab).");
    else await actionFailed(e, "Not allowed: this motion cannot be opened.");
  }
}
R.openFlow = openFlow;

// Re-open a closed motion with a reason (its result is saved first).
async function reopenFlow(id, reason) {
  const p = S.polls.find((x) => x.id === id) || {};
  const m = currentMeetings().find((x) => x.id === p.meetingId);
  if (m && m.status === "closed" && !confirm("This meeting has ended. Re-open anyway?")) return false;
  const others = S.polls.filter((p) => p.status === "open" && p.id !== id);
  if (others.length && !confirm("This will close the currently open motion. Continue?")) return false;
  for (const o of others) { if (!(await closeFlow(o.id))) return false; }
  S.busy += 1;
  try {
    const r = await reopenMotion(id, reason);
    if (r === "reopened") { S.reopenFor = null; historyChanged(); toast("Motion re-opened. Voters can vote again."); }
    return true;
  } catch (e) {
    if (e && e.why === "replaced") toast("Not allowed: this motion was replaced by a re-vote. Re-open the re-vote instead.");
    else await actionFailed(e, "Not allowed: this motion's result is saved and cannot be re-opened.");
    return false;
  } finally { S.busy -= 1; R.results(); }
}
R.reopenFlow = reopenFlow;

// A clean re-vote: the original keeps its result, marked "Replaced by a re-vote".
async function revoteFlow(id, reason) {
  S.busy += 1;
  try {
    // Same meeting, unless it has ended: then the open meeting, or the one on screen.
    const p = S.polls.find((x) => x.id === id) || {};
    const m = currentMeetings().find((x) => x.id === p.meetingId);
    let target = p.meetingId;
    if (m && m.status === "closed") {
      const openM = currentMeetings().find((x) => x.status === "open" && !x.deleted);
      const sel = R.selectedMeeting();
      target = (openM && openM.id) || (sel && sel.id !== m.id ? sel.id : p.meetingId);
    }
    const newId = await revoteMotion(id, reason, target);
    historyChanged();
    S.revoteReady = newId;
    toast("Re-vote ready. Open it when everyone is ready to vote again.");
    return newId;
  } catch (e) {
    if (e && e.why === "replaced") toast("Not allowed: this motion was already replaced by a re-vote.");
    else if (e && e.why === "unsaved") toast("Save the result first, then start the re-vote.");
    // The page already checked the result is saved and not replaced, so a
    // refusal here means the rules that allow re-votes are not published yet.
    else if (classify(e) === "refused") toast("This page needs a database update that has not been published yet. Re-vote is off until it is.");
    else await actionFailed(e, "Not allowed: the database refused the re-vote.");
    return null;
  } finally { S.busy -= 1; R.results(); }
}
R.revoteFlow = revoteFlow;
// Run-off of a question nobody won with more than half: the top two.
async function runoffFlow(id, reason) {
  S.busy += 1;
  try {
    const newId = await runoffMotion(id, reason);
    historyChanged();
    S.revoteReady = newId;
    toast("Run-off ready. Open it when everyone is ready to vote again.");
    return newId;
  } catch (e) {
    if (classify(e) === "refused") toast("This page needs a database update that has not been published yet. Run-off is off until it is.");
    else await actionFailed(e, "Not allowed: the database refused the run-off.");
    return null;
  } finally { S.busy -= 1; R.results(); }
}
R.runoffFlow = runoffFlow;

// Your name for the change history: asked once per laptop, kept on it.
try { setLogName(localStorage.getItem("mv_log_name") || ""); } catch (e) { /* private mode */ }
