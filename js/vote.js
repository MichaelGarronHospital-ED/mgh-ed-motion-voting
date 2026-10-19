// ============================================================================
//  VOTER PAGE. Phones listen to two small documents only: config/live (the
//  board: the open motion and this meeting's results) and config/roster (the
//  name list). Earlier results are one read of config/history, on a tap.
//  A phone never listens to ballots: "You voted ..." comes from this phone's
//  own record of what it sent.
// ============================================================================
import { slugify } from "./roster.js?v=voting-14";
import { ORG_NAME } from "./config.js?v=voting-14";
import {
  onLive, castVote, getSessionId, onRosterOverrides, resolvedPerson, currentRoster, rosterPerson,
  watchMember, voterSignIn, leaderSignOut, isWrongPassword, classify, withTimeout, getHistoryOnce,
  countOnce, outcomeWords, outcomeKind, localDate, tsMillis, checkIn, getOwnBallot,
  receiptCode, ballotReceipt, clockTime, isLeader,
} from "./db.js?v=voting-14";
import { escapeHtml, labelOf, toast, icon, verdictHTML, stackedBar, fmt, choiceBars } from "./util.js?v=voting-14";

document.title = ORG_NAME;
const app = document.getElementById("app");
const sessionId = getSessionId();

// ---- state -----------------------------------------------------------------
let me = JSON.parse(localStorage.getItem("ed_voter") || "null"); // {name,slug,group,weight,isWriteIn}
let voterTab = "vote";          // "vote" | "results"
let board;                      // undefined: not known yet; null: not created yet; else config/live
let boardFromCache = false;     // the last board came from the phone's cache (no connection)
let boardSlow = false;          // no answer from the server within 15 s
let voteMsg = "";               // a casting problem, shown under the ballot
let earlier = { state: "idle" };   // "Show earlier results"
const stale = new Map();        // motion id -> { timer, state, result } for a late result

// What this phone sent (kept on the phone, last 50 motions): pollId -> { slug, choice, at }.
function receipts() { try { return JSON.parse(localStorage.getItem("ed_receipts") || "{}"); } catch (e) { return {}; } }
function keepReceipt(pollId, slug, choice, picks, count) {
  const r = receipts();
  r[pollId] = { slug, choice, at: Date.now(), code: receiptCode(pollId, slug, choice, picks, count) };
  if (picks) r[pollId].picks = picks;
  const ids = Object.keys(r).sort((a, b) => r[b].at - r[a].at).slice(0, 50);
  const out = {}; ids.forEach((id) => { out[id] = r[id]; });
  try { localStorage.setItem("ed_receipts", JSON.stringify(out)); } catch (e) { /* private mode */ }
  checks.delete(pollId);   // a new receipt: an earlier check no longer applies
}

const openMotion = () => (board ? board.open : null);

// ---- data subscriptions ----------------------------------------------------
function startData() {
  // Keep current categories loaded (names for the picker; a late result is
  // counted with them). Not while the name picker is up: re-rendering it would
  // wipe what they are part-way through typing, so only its list is redrawn.
  onRosterOverrides(() => {
    if (me) { render(); return; }
    const search = document.getElementById("search");
    renderNames(search ? search.value : "");
  });
  const slowT = setTimeout(() => { if (board === undefined || boardFromCache) { boardSlow = true; render(); } }, 15000);
  onLive((data, snap) => {
    const fromCache = !!(snap.metadata && snap.metadata.fromCache);
    if (!fromCache) { clearTimeout(slowT); boardSlow = false; }
    boardFromCache = fromCache;
    if (fromCache && !data && board !== undefined) { render(); return; }   // keep the last screen
    const prevOpen = openMotion();
    // No board yet (only before leadership's console first signs in after the
    // upgrade): nothing is open for phones until it exists.
    if (data) board = data;
    else if (!fromCache) board = null;
    navigate(prevOpen, openMotion());
    render();
  }, { meta: true, onError: failed });
}
// Auto-navigate the voter: to the result when the open motion closes, back to
// the ballot when the next motion opens.
function navigate(prev, now) {
  if (!me || (prev && prev.id) === (now && now.id)) return;
  if (now) { voterTab = "vote"; voteMsg = ""; }
  else if (prev) voterTab = "results";
}
// A listener was refused (the ED sign-in is gone) or failed.
function failed(e) {
  console.warn("listener failed", e && e.code);
  if (classify(e) === "refused") { signedOutAgain(); return; }
  boardSlow = true; render();
}
let askAgain = false;
try { askAgain = !!sessionStorage.getItem("mv_ed_again"); sessionStorage.removeItem("mv_ed_again"); } catch (e) { /* private mode */ }
function signedOutAgain() {
  try { sessionStorage.setItem("mv_ed_again", "1"); } catch (e) { /* private mode */ }
  leaderSignOut();
}

// ---- the ED password ---------------------------------------------------------
// Voting needs the ED password once per device; Firebase remembers the sign-in,
// so after that a voter scans the QR code and goes straight to the ballot. A
// leadership session in the same browser also counts (see db.js). Data starts
// only once someone is signed in: the rules refuse everyone else.
let member = null, authKnown = false, started = false;
watchMember((u) => {
  member = u; authKnown = true;
  if (u && !started) { started = true; startData(); }
  if (!u && started) { location.reload(); return; }   // signed out elsewhere: start clean
  render();
});

// ---- render ----------------------------------------------------------------
function render() {
  if (!authKnown) { app.innerHTML = `<div class="card"><p class="ed-hint center">Checking sign-in...</p></div>`; return; }
  if (!member) { app.innerHTML = gateHTML(); wireGate(); return; }
  if (!me) { app.innerHTML = shell(pickerHTML()); wirePicker(); return; }

  const tabBtn = (k, l) => `<button type="button" class="tab ${voterTab === k ? "active" : ""}" data-vtab="${k}" aria-pressed="${voterTab === k}">${l}</button>`;
  const tabs = `<nav class="tabs ed-seg" aria-label="Vote or results">${tabBtn("vote", "Vote")}${tabBtn("results", "Results")}</nav>`;
  const conn = (boardFromCache || boardSlow) && board !== undefined
    ? `<p class="notice" role="status">${icon("alert", 20)}<span>No connection. Voting will work again when it reconnects. This screen may be out of date.</span></p>` : "";
  const body = voterTab === "vote" ? `<div class="card stack">${voteBody()}</div>` : resultsBody();
  // A redraw keeps keyboard focus on the same control (a vote tile, an
  // option, a tab or any button with an id), so voting by keyboard works.
  const f = document.activeElement;
  const key = f && app.contains(f) ? ["data-c", "data-pick", "data-vtab", "data-check", "data-ci", "id"].find((a) => f.hasAttribute(a)) : null;
  const val = key ? f.getAttribute(key) : null;
  app.innerHTML = shell(conn + tabs + body);
  wireVoter();
  if (key) {
    const again = app.querySelector(`[${key}="${CSS.escape(val)}"]`);
    if (again) again.focus();
  }
}

function shell(inner) {
  const m = board && board.meeting;
  return `<header class="topbar"><span class="ed-badge" aria-hidden="true">ED</span><span class="brand">MGH Emergency Department</span></header>
    <h1 class="ed-title page-title">Motion Voting</h1>
    <p class="lede">${m ? `${escapeHtml(m.title)}, ${escapeHtml(niceDate(m.date))}. ` : ""}Tap to cast your vote. Results update live.</p>${inner}`;
}
function niceDate(d) {
  if (!d) return "";
  const [y, mo, da] = String(d).split("-").map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// ---- ED password screen ------------------------------------------------------
// The same sign-in card as every ED tool (see css/ed-ui.css): badge, title, one
// labelled field, one button.
function gateHTML() {
  return `<div class="gate-screen"><div class="card gate">
    <span class="ed-badge" aria-hidden="true">ED</span>
    <h1>Motion Voting</h1>
    <p class="ed-muted">${askAgain ? "Please enter the ED password again." : "Enter the ED password to vote."}</p>
    <form id="edgate" class="gate-form" autocomplete="on">
      <input class="pw-user" type="text" name="username" autocomplete="username" value="ED password" tabindex="-1" aria-hidden="true" />
      <label class="ed-label" for="edpw">ED password
        <input class="ed-field" id="edpw" name="password" type="password" autocomplete="current-password" aria-describedby="edpw-help" required />
      </label>
      <p class="ed-hint" id="edpw-help">Not working on iPhone? Clear the box, type the password by hand, then tap Save when your phone offers.</p>
      <p id="ederr" class="ed-error err hide" role="alert"></p>
      <button id="edgo" class="ed-btn ed-btn-filled" type="submit">Continue</button>
      <p class="ed-hint">This device remembers it, so you only enter it once.</p>
    </form>
  </div></div>`;
}
function wireGate() {
  const f = document.getElementById("edgate"), pw = document.getElementById("edpw"), err = document.getElementById("ederr");
  pw.focus();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const typed = pw.value.trim();   // the passwords never start or end with a space
    if (!typed) return;
    const btn = document.getElementById("edgo");
    btn.disabled = true; err.classList.add("hide");
    try { await voterSignIn(typed); }           // watchMember re-renders on success
    catch (ex) {
      btn.disabled = false;
      const msg = isWrongPassword(ex) ? "That's not the ED password." : "Couldn't sign in. Check your connection and try again.";
      err.innerHTML = icon("alert", 18) + `<span>${msg}</span>`;
      err.classList.remove("hide"); pw.select();
    }
  });
}

// ---- name picker -----------------------------------------------------------
function pickerHTML() {
  return `<div class="card stack">
    <p class="notice">${icon("warn", 20)}<span>Choose <strong>your own name only</strong> and vote once. Votes are linked to your name and device and checked for duplicates.</span></p>
    <label class="ed-label" for="search">Find your name
      <input class="ed-field" id="search" type="text" placeholder="Start typing your name" autocomplete="off" />
    </label>
    <ul id="namelist" class="namelist" role="listbox" aria-label="Physicians"></ul>
    <button id="writein-btn" type="button" class="ed-btn ed-btn-plain linkbtn" aria-expanded="false" aria-controls="writein-box">My name isn't listed</button>
    <div id="writein-box" class="hide stack">
      <label class="ed-label" for="writein">Type your full name
        <input class="ed-field" id="writein" type="text" placeholder="First Last" autocomplete="off" />
      </label>
      <button id="writein-confirm" type="button" class="ed-btn ed-btn-filled">Continue</button>
      <p class="ed-hint">New names are added to the record for leadership to review.</p>
    </div>
  </div>`;
}
function renderNames(filter = "") {
  const el = document.getElementById("namelist");
  if (!el) return;
  const f = filter.trim().toLowerCase();
  const list = currentRoster().filter((p) => p.name.toLowerCase().includes(f));
  el.innerHTML = list.length
    ? list.map((p) => `<li data-slug="${escapeHtml(p.slug)}" tabindex="0" role="option" aria-selected="false">${escapeHtml(p.name)}</li>`).join("")
    : `<li class="none" role="option" aria-disabled="true" aria-selected="false">No match. Use “My name isn't listed” below.</li>`;
}
function wirePicker() {
  renderNames();
  const search = document.getElementById("search");
  search.addEventListener("input", () => renderNames(search.value));
  // Enter / Space on a focused name does what a tap does (keyboard users)
  document.getElementById("namelist").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("li[data-slug]")) { e.preventDefault(); e.target.click(); }
  });
  document.getElementById("namelist").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-slug]"); if (!li) return;
    const p = rosterPerson(li.dataset.slug); if (!p) return;
    setVoter({ name: p.name, slug: p.slug, group: p.group, weight: p.weight, isWriteIn: false });
  });
  document.getElementById("writein-btn").addEventListener("click", (e) => {
    const open = !document.getElementById("writein-box").classList.toggle("hide");
    e.currentTarget.setAttribute("aria-expanded", String(open));
    if (open) document.getElementById("writein").focus();
  });
  document.getElementById("writein-confirm").addEventListener("click", () => {
    const name = document.getElementById("writein").value.trim();
    if (name.length < 3) { toast("Please type your full name."); return; }
    const slug = slugify(name);
    const p = rosterPerson(slug);
    if (p) {
      setVoter({ name: p.name, slug: p.slug, group: p.group, weight: p.weight, isWriteIn: false });
    } else {
      setVoter({ name, slug, group: "writein", weight: 0, isWriteIn: true });
    }
  });
}
function setVoter(v) {
  if (deviceBound() && deviceBound() !== v.slug) { toast("This device has already voted."); return; }
  me = v; localStorage.setItem("ed_voter", JSON.stringify(v)); render();
}
function deviceBound() { return localStorage.getItem("ed_bound"); }

// ---- vote tab --------------------------------------------------------------
const CHOICES = [["favour", "In favour", "check"], ["against", "Against", "x"], ["abstain", "Abstain", "minus"]];
function voteBody() {
  // Every voter (courtesy and write-ins included) sees the same ballot. The
  // weighting (0 for courtesy) is applied behind the scenes; leadership sees it
  // in the Voters table, but it is never surfaced to the voter.
  // Once any vote is cast on this device it is locked to that person, so you
  // can't switch names and vote again. (Correcting a mis-tap is only possible
  // before your first vote.)
  const bound = deviceBound();
  const head = `<div class="voter-line"><span class="ed-muted">Voting as <strong>${escapeHtml(me.name)}</strong></span>
    ${bound ? `<button type="button" id="switch-voter" class="ed-btn ed-btn-plain linkbtn">Switch voter</button>`
            : `<button type="button" id="change-name" class="ed-btn ed-btn-plain linkbtn">Not you?</button>`}</div>`;
  if (board === undefined && !boardSlow) return head + `<p class="ed-hint">Connecting...</p>`;
  const ci = checkInHTML();
  if (board === undefined) return head + `<p class="notice">${icon("alert", 20)}<span>No connection. Voting will work again when it reconnects.</span></p>`;
  const open = openMotion();
  if (open) {
    // Only reveal a choice if THIS device sent it for this name: you can't
    // peek at how another person voted.
    const r = receipts()[open.id];
    const mine = deviceBound() === me.slug && r && r.slug === me.slug ? r : null;
    if (open.kind === "choice") return head + ci + choiceBallot(open, mine) + receiptLine(open, mine);
    const tile = ([c, l, ic]) => `<button type="button" class="vote" data-c="${c}" aria-pressed="${!!(mine && mine.choice === c)}">${icon(ic, 26)}${l}</button>`;
    const revote = open.revoteOf ? `<p class="ed-hint"><span class="ed-pill ed-pill-info">Re-vote</span> Reason: ${escapeHtml(open.revoteReason || "")}</p>` : "";
    return head + ci + `
      <span class="ed-pill ed-pill-good"><span class="dot"></span>Voting open</span>
      ${open.number ? `<p class="motion-num">Motion ${escapeHtml(open.number)}</p>` : ""}
      <h2 class="motion-text">${escapeHtml(open.text)}</h2>${revote}
      ${open.amendsNumber ? `<details class="about amend-fold"><summary>Amendment to motion ${escapeHtml(open.amendsNumber)}</summary><p class="ed-hint">${escapeHtml(open.amendsText || "")}</p></details>` : ""}
      ${(open.threshold || (open.rule && open.rule.threshold)) === "twoThirds" ? `<p class="ed-hint">Needs two-thirds of the points cast to pass.</p>` : ""}
      <div class="votes" role="group" aria-label="Your vote">${CHOICES.map(tile).join("")}</div>
      ${voteMsg ? `<p class="ed-error err" role="alert">${icon("alert", 18)}<span>${escapeHtml(voteMsg)}</span></p>` : ""}
      <p class="ed-hint">${mine ? `You voted <strong>${escapeHtml(labelOf(mine.choice))}</strong>. You can change it until voting closes.`
        : "You can change your vote until leadership closes the motion."}</p>${receiptLine(open, mine)}`;
  }
  return head + ci + `<div class="ed-empty">${icon("clock", 40)}
    <strong>No motion open right now</strong>
    <span>${board === null ? "Voting starts once the Admin console has been opened." : "Closed motions appear under Results."}</span></div>`;
}

// "Recorded: In favour. Receipt 7F3KQ. 12:04." and, while the motion is open,
// "Check my recorded vote" (once it closes, only Admin can read ballots).
function receiptLine(open, mine) {
  if (!mine || !mine.code) return "";
  const what = mine.choice === "pick" ? "your picks" : labelOf(mine.choice);
  return `<p class="ed-hint receipt-line">Recorded: ${escapeHtml(what)}. Receipt <span class="receipt-code">${escapeHtml(mine.code)}</span>. ${escapeHtml(clockTime(mine.at))}.</p>
    ${checks.has(open.id) ? checkNote(checks.get(open.id))
      : `<div><button type="button" class="ed-btn ed-btn-tinted btn-sm" data-check="${escapeHtml(open.id)}">Check my recorded vote</button></div>`}`;
}
function checkNote(c) {
  return `<p class="${c.ok ? "ed-hint" : "notice"}" role="status">${c.ok ? "" : icon("alert", 18)}<span>${escapeHtml(c.text)}</span></p>`;
}

// ---- check-in (only while the meeting is open and check-in is on) -----------
// One tap, never needed to vote. Kept on the phone: meetingId -> { slug, mode }.
let checkInMsg = "", checkInAgain = false;
function checkIns() { try { return JSON.parse(localStorage.getItem("ed_checkin") || "{}"); } catch (e) { return {}; } }
function keepCheckIn(mid, rec) {
  const c = checkIns(); c[mid] = rec;
  try { localStorage.setItem("ed_checkin", JSON.stringify(c)); } catch (e) { /* private mode */ }
}
function checkInHTML() {
  const m = board && board.meeting;
  if (!m || m.status !== "open" || !m.checkIn) return "";
  const rec = checkIns()[m.id];
  if (rec && rec.slug === me.slug && !checkInAgain) {
    if (rec.mode === "skip") return "";
    return `<p class="ed-hint checked-in">Checked in: ${rec.mode === "remote" ? "remote" : "in the room"}. <button type="button" id="ci-change" class="ed-btn ed-btn-plain linkbtn">Change</button></p>`;
  }
  return `<div class="card-inset stack-sm checkin-card" role="group" aria-labelledby="ci-title">
    <p id="ci-title"><strong>Checking in to ${escapeHtml(m.title)}.</strong> Where are you joining from?</p>
    <div class="row"><button type="button" class="ed-btn ed-btn-filled btn-sm" data-ci="room">In the room</button>
      <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-ci="remote">Remote</button>
      <button type="button" class="ed-btn ed-btn-plain btn-sm" data-ci="skip">Skip</button></div>
    ${checkInMsg ? `<p class="ed-error err" role="alert">${icon("alert", 18)}<span>${escapeHtml(checkInMsg)}</span></p>` : ""}
  </div>`;
}
async function doCheckIn(mode) {
  const m = board && board.meeting;
  if (!m) return;
  checkInMsg = "";
  if (mode === "skip") { keepCheckIn(m.id, { slug: me.slug, mode: "skip" }); checkInAgain = false; render(); return; }
  try {
    await withTimeout(checkIn(m.id, me, mode, sessionId), 10000);
    keepCheckIn(m.id, { slug: me.slug, mode });
    checkInAgain = false;
    toast(mode === "remote" ? "Checked in: remote." : "Checked in: in the room.");
  } catch (e) {
    console.warn(e);
    if (classify(e) === "refused") checkInMsg = board && board.meeting && board.meeting.status === "open" ? "Check-in is not available yet." : "Check-in is closed.";
    else checkInMsg = "Not sent: no connection. Try again.";
  }
  render();
}

// A question or election: one tile per option, plus Abstain. Picking 1: a tap
// is the vote. Picking more: tiles toggle, then "Submit vote".
let picking = { pollId: null, picks: new Set() };
function choiceBallot(open, mine) {
  const seats = open.seats || 1;
  const multi = seats > 1;
  if (picking.pollId !== open.id) picking = { pollId: open.id, picks: new Set(mine && mine.choice === "pick" ? mine.picks || [] : []) };
  const chosen = (id) => (multi ? picking.picks.has(id) : !!(mine && mine.choice === "pick" && (mine.picks || []).includes(id)));
  const tiles = (open.options || []).map((o) => `<button type="button" class="vote option" data-pick="${escapeHtml(o.id)}" aria-pressed="${chosen(o.id)}">${escapeHtml(o.label)}</button>`).join("");
  const revote = open.revoteOf ? `<p class="ed-hint"><span class="ed-pill ed-pill-info">${/^run-off/i.test(open.revoteReason || "") ? "Run-off" : "Re-vote"}</span> Reason: ${escapeHtml(open.revoteReason || "")}</p>` : "";
  const labels = Object.fromEntries((open.options || []).map((o) => [o.id, o.label]));
  const said = mine ? (mine.choice === "abstain" ? "You abstained." : `You voted for ${escapeHtml((mine.picks || []).map((id) => labels[id] || id).join(" and "))}.`) : "";
  return `
    <span class="ed-pill ed-pill-good"><span class="dot"></span>Voting open</span>
    ${open.number ? `<p class="motion-num">Motion ${escapeHtml(open.number)}</p>` : ""}
    <h2 class="motion-text">${escapeHtml(open.text)}</h2>${revote}
    <p class="ed-hint">${multi ? `Pick up to ${seats}.` : open.style === "election" ? "Pick 1 candidate." : "Pick 1."}${seats === 1 && open.threshold === "majority" ? " The winner needs more than half of the points." : ""}</p>
    <div class="votes options" role="group" aria-label="Your vote">${tiles}
      <button type="button" class="vote option abstain-tile" data-c="abstain" aria-pressed="${!!(mine && mine.choice === "abstain")}">${icon("minus", 22)}Abstain</button></div>
    ${multi ? `<p class="ed-hint" aria-live="polite" id="pick-count">Pick up to ${seats}. You picked ${picking.picks.size}.</p>
      <div><button type="button" id="submit-picks" class="ed-btn ed-btn-filled" ${picking.picks.size ? "" : "disabled"}>Submit vote</button></div>` : ""}
    ${voteMsg ? `<p class="ed-error err" role="alert">${icon("alert", 18)}<span>${escapeHtml(voteMsg)}</span></p>` : ""}
    <p class="ed-hint">${said ? `${said} You can change it until voting closes.` : "You can change your vote until leadership closes the vote."}</p>`;
}

// ---- results tab (from the board; earlier ones on a tap) -------------------
function resultsBody() {
  const entries = board && board.results ? Object.entries(board.results).sort((a, b) => b[1].pos - a[1].pos) : [];
  const title = board && board.meeting ? "This meeting" : "Latest results";
  const cards = entries.map(([id, e]) => resultCard(id, e)).join("");
  let html = entries.length ? `<h2 class="section-title">${title}</h2>${cards}`
    : `<div class="card"><div class="ed-empty"><strong>No results yet</strong><span>Closed motions will appear here.</span></div></div>`;
  html += earlierHTML();
  return html;
}
function resultWords(r) { return verdictHTML(outcomeKind(r), escapeHtml(outcomeWords(r, "voter"))); }
function resultCard(id, e) {
  const pills = [];
  if (e.supersededBy) pills.push(`<span class="ed-pill ed-pill-quiet">Replaced by a re-vote</span>`);
  else if (e.revoteOf) pills.push(`<span class="ed-pill ed-pill-info">Re-vote</span>`);
  else pills.push(`<span class="ed-pill ed-pill-quiet">Closed</span>`);
  const top = `<div class="row">${pills.join("")}</div>${e.number ? `<p class="motion-num">Motion ${escapeHtml(e.number)}</p>` : ""}<h2 class="motion-text">${escapeHtml(e.text)}</h2>`;
  let body;
  let r = e.result;
  let note = "";
  if (!r) {
    const st = staleFor(id, e);
    if (st.result) { r = st.result; note = `<p class="ed-hint">Count from the ballots. The saved result will replace it.</p>`; }
    else if (st.state === "failed") note = `<p class="ed-hint">The result will appear when leadership's laptop saves it.</p>`;
  } else stale.delete(id);
  // Until a result exists we know nothing: an empty count reads "No quorum",
  // which on a meeting-room screen looks like a real result.
  body = r && r.kind === "choice" ? `${resultWords(r)}${choiceBars(r)}`
    : r ? `${resultWords(r)}${stackedBar(r.weight)}
    <p class="legend"><span><i class="sw favour"></i>In favour</span><span><i class="sw against"></i>Against</span><span><i class="sw abstain"></i>Abstain</span></p>`
    : `<p class="ed-hint">Counting votes…</p>`;
  const extra = [];
  if (e.revoteOf) extra.push(`<p class="ed-hint">Reason for the re-vote: ${escapeHtml(e.revoteReason || "")}</p>`);
  if (e.supersededBy) extra.push(`<p class="ed-hint">${board && board.results && board.results[e.supersededBy] ? `<a href="#r-${escapeHtml(e.supersededBy)}">See the re-vote result.</a>` : "See the re-vote result when it closes."}</p>`);
  const rc = me && receipts()[id];
  if (rc && rc.code && rc.slug === me.slug) {
    const what = rc.choice === "pick" ? "your picks" : labelOf(rc.choice);
    // Closed: the ballots are Admin only, so the check is Admin's (the console
    // shows the same code from the stored ballot).
    extra.push(`<div class="stack-sm receipt-box"><p class="ed-hint">Your receipt: <span class="receipt-code">${escapeHtml(rc.code)}</span> (${escapeHtml(what)})</p>
      ${checks.has(id) ? checkNote(checks.get(id)) : ""}
      <p class="ed-hint">To check what was recorded under your name, show this code to Admin. It does not prove who tapped.</p></div>`);
  }
  if (e.reopenCount && e.priorOutcome) extra.push(`<p class="ed-hint">Re-opened ${e.reopenCount === 1 ? "once" : e.reopenCount + " times"}. Earlier count: ${escapeHtml(outcomeWords(e.priorOutcome, "voter"))} (${fmt(e.priorOutcome.weight.favour)} to ${fmt(e.priorOutcome.weight.against)} points).</p>`);
  return `<div class="card stack" id="r-${escapeHtml(id)}">${top}${body}${note}${extra.join("")}</div>`;
}
// "Check my recorded vote": one read of this name's ballot, compared with the
// phone's receipt.
const checks = new Map();   // motion id -> { ok, text }
async function checkMyVote(id) {
  const rc = receipts()[id];
  try {
    const v = await withTimeout(getOwnBallot(id, me.slug), 10000);
    if (!v) checks.set(id, { ok: false, text: "No vote is recorded under your name. Please tell leadership." });
    else if (ballotReceipt(id, v) === rc.code) {
      const what = v.choice === "pick" ? "your picks" : labelOf(v.choice);
      checks.set(id, { ok: true, text: `Recorded under your name: ${what}. It matches this phone's receipt.` });
    } else checks.set(id, { ok: false, text: "It does not match this phone's receipt. Please tell leadership." });
  } catch (e) {
    checks.set(id, { ok: false, text: classify(e) === "refused" ? "Could not check right now. Please tell leadership." : "No connection. Try again." });
    setTimeout(() => { checks.delete(id); render(); }, 4000);
  }
  render();
}

// A board entry still without a result 30 seconds after THIS phone received it
// (the phone's own timer: phone clocks can be minutes off) is counted once from
// its ballots, the same way the console saves it. Only with the Admin sign-in:
// a closed motion's ballots are Admin only, so an ED phone waits for the save.
function staleFor(id, e) {
  let st = stale.get(id);
  if (!st) {
    st = { state: "waiting", result: null };
    stale.set(id, st);
    st.timer = setTimeout(async () => {
      if (!board || !board.results || !board.results[id] || board.results[id].result) return;
      if (!isLeader(member)) { st.state = "failed"; render(); return; }
      st.state = "counting";
      try { st.result = await withTimeout(countOnce(id), 15000); st.state = "done"; }
      catch (err) { console.warn(err); st.state = "failed"; }
      render();
    }, 30000);
  }
  return st;
}

function earlierHTML() {
  const e = earlier;
  if (e.state === "idle") return `<div class="card"><button type="button" id="earlier-load" class="ed-btn ed-btn-tinted">Show earlier results</button></div>`;
  if (e.state === "loading") return `<div class="card"><p class="ed-hint">Loading earlier results...</p></div>`;
  if (e.state === "error") return `<div class="card stack"><p class="notice">${icon("alert", 20)}<span>Could not load earlier results. Check your connection.</span></p><button type="button" id="earlier-load" class="ed-btn ed-btn-tinted">Try again</button></div>`;
  const onBoard = new Set(Object.keys((board && board.results) || {}));
  const list = e.entries.filter((x) => !onBoard.has(x.id));
  if (!list.length) return `<div class="card"><p class="ed-hint">No earlier results.</p></div>`;
  // Grouped by meeting (or by the day they closed), newest first.
  const groups = [];
  list.forEach((x) => {
    const key = x.meetingId || x.meetingDate || "";
    let g = groups.find((y) => y.key === key);
    if (!g) { g = { key, title: x.meetingTitle ? `${x.meetingTitle}, ${niceDate(x.meetingDate)}` : (x.meetingDate ? niceDate(x.meetingDate) : "Earlier"), items: [] }; groups.push(g); }
    g.items.push(x);
  });
  return `<h2 class="section-title">Earlier results</h2>` + groups.map((g) => `<h3 class="group-title">${escapeHtml(g.title)}</h3>`
    + g.items.map((x) => resultCard(x.id, { ...x, pos: 0 })).join("")).join("")
    + (e.truncated ? `<p class="ed-hint">Older results are in leadership's records.</p>` : "");
}
async function loadEarlier() {
  earlier = { state: "loading" };
  render();
  try {
    const h = await withTimeout(getHistoryOnce(), 10000);
    earlier = { state: "ok", entries: (h && h.entries) || [], truncated: !!(h && h.truncated) };
  } catch (err) {
    console.warn(err);
    if (classify(err) === "refused") { signedOutAgain(); return; }
    earlier = { state: "error" };
  }
  render();
}

// ---- wiring ----------------------------------------------------------------
function wireVoter() {
  document.querySelectorAll("[data-vtab]").forEach((t) =>
    t.addEventListener("click", () => { voterTab = t.dataset.vtab; render(); }));
  const cn = document.getElementById("change-name");
  if (cn) cn.addEventListener("click", (e) => {
    e.preventDefault();
    if (deviceBound()) { toast("This device is locked after voting."); return; }
    localStorage.removeItem("ed_voter"); me = null; voterTab = "vote"; render();
  });
  const sv = document.getElementById("switch-voter");
  if (sv) sv.addEventListener("click", (e) => {
    e.preventDefault();
    if (!confirm("Switch to a different voter on this device?\n\nYour previous vote stays recorded until a new one is cast. Using one device for more than one name is flagged for leadership review.")) return;
    // clear the lock + identity, but KEEP the device id so multi-name use is still flagged
    localStorage.removeItem("ed_voter");
    localStorage.removeItem("ed_bound");
    me = null; voterTab = "vote"; render();
  });
  document.querySelectorAll("button[data-c]").forEach((b) =>
    b.addEventListener("click", () => submit(b.dataset.c, b.dataset.c === "abstain" && openMotion() && openMotion().kind === "choice" ? [] : undefined)));
  document.querySelectorAll("button[data-pick]").forEach((b) => b.addEventListener("click", () => {
    const open = openMotion();
    if (!open) return;
    const id = b.dataset.pick;
    if ((open.seats || 1) === 1) { submit("pick", [id]); return; }
    if (picking.picks.has(id)) picking.picks.delete(id);
    else if (picking.picks.size < open.seats) picking.picks.add(id);
    else { toast(`Pick up to ${open.seats}. Untick one first.`); return; }
    render();
    const again = document.querySelector(`button[data-pick="${CSS.escape(id)}"]`); if (again) again.focus();
  }));
  const sp = document.getElementById("submit-picks");
  if (sp) sp.addEventListener("click", () => {
    const open = openMotion();
    // in the question's option order, so the same picks are never a new submission
    submit("pick", (open.optionIds || []).filter((id) => picking.picks.has(id)));
  });
  const el = document.getElementById("earlier-load");
  if (el) el.addEventListener("click", loadEarlier);
  document.querySelectorAll("button[data-ci]").forEach((b) => b.addEventListener("click", () => doCheckIn(b.dataset.ci)));
  const cc = document.getElementById("ci-change"); if (cc) cc.addEventListener("click", () => { checkInAgain = true; render(); });
  document.querySelectorAll("button[data-check]").forEach((b) => b.addEventListener("click", () => { b.disabled = true; checkMyVote(b.dataset.check); }));
}
async function submit(choice, picks) {
  const open = openMotion();
  if (!open) return;
  voteMsg = "";
  try {
    // resolve the voter's CURRENT category/weight at submit time (reflects any
    // leadership edits); write-ins keep their 0-weight snapshot.
    const rp = me.isWriteIn ? { group: me.group, weight: me.weight } : resolvedPerson(me.slug);
    const count = await withTimeout(castVote({ pollId: open.id, name: me.name, slug: me.slug, group: rp.group,
      weight: rp.weight, isWriteIn: me.isWriteIn, choice, sessionId, picks }), 15000);
    localStorage.setItem("ed_bound", me.slug);   // lock this device to this person
    keepReceipt(open.id, me.slug, choice, picks, count);
    if (picks) picking = { pollId: open.id, picks: new Set(picks) };
    toast(choice === "pick" ? "Vote recorded." : "Vote recorded: " + labelOf(choice));
  } catch (e) {
    console.warn(e);
    const kind = classify(e);
    // No answer in 15 seconds: the vote may still have landed. Read this
    // name's ballot once; if it says what was sent, it counts as recorded.
    if (e && e.code === "timeout" && (await recordedAnyway(open, choice, picks))) { render(); return; }
    if (kind === "refused") {
      const still = openMotion();
      voteMsg = !still || still.id !== open.id ? "Voting on this motion has closed." : "Your vote could not be recorded. Please tell leadership.";
    } else voteMsg = "No connection. Your vote was not sent. Try again.";
    toast(voteMsg);
  }
  render();
}
async function recordedAnyway(open, choice, picks) {
  try {
    const v = await withTimeout(getOwnBallot(open.id, me.slug), 10000);
    const same = v && v.choice === choice && JSON.stringify(v.picks || []) === JSON.stringify(picks || [])
      && (v.sessionIds || []).includes(sessionId);
    if (!same) return false;
    localStorage.setItem("ed_bound", me.slug);
    keepReceipt(open.id, me.slug, choice, picks, v.submissionCount);
    if (picks) picking = { pollId: open.id, picks: new Set(picks) };
    toast(choice === "pick" ? "Vote recorded." : "Vote recorded: " + labelOf(choice));
    return true;
  } catch (err) { console.warn(err); return false; }
}

render();
