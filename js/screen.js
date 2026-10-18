// ============================================================================
//  MEETING SCREEN (projector). It only displays; every control is in the
//  console's Meeting tab. It reuses whatever sign-in this browser already has
//  (Admin or ED) and never signs in over it: Firebase keeps one sign-in
//  per browser for every tab, so signing in as ED here would sign the console
//  out. Only when signed out does it ask for the ED password (never the
//  Admin one, so a shared room PC never holds it).
//
//  Listens to config/live (the board), config/screen (the console's controls),
//  config/roster (who is eligible) and the open motion's ballots (turnout).
// ============================================================================
import { ORG_NAME } from "./config.js?v=voting-11";
import {
  watchMember, voterSignIn, isWrongPassword, onLive, onScreen, onRosterOverrides, onVotesFor, classify, onAttendance,
  resultOf, outcomeWords, outcomeKind, liveEligible, quorumNeededFor, clockTime, countOnce, withTimeout, LEGACY_RULE,
} from "./db.js?v=voting-11";
import { escapeHtml, icon, verdictHTML, stackedBar, fmt, choiceBars } from "./util.js?v=voting-11";
import { watchVersion } from "./version.js?v=voting-11";

document.title = ORG_NAME + " · Meeting screen";
const root = document.getElementById("screen");
const voterUrl = location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html";

let member = null, authKnown = false, started = false, signedOutMsg = false;
let board, controls = null, votes = [], votesFor = null, votesLoaded = false, votesUnsub = null;
let offline = false, slow = false;
let timer = null;               // { pollId, endsAt (this screen's clock), seconds }
let lastTimerKey = null, firstControls = true;
let newer = false;              // a newer version is on the site
watchVersion(() => { newer = true; render(); });
const lateCount = new Map();    // motion id -> { result, state }

watchMember((u) => {
  member = u; authKnown = true;
  if (u && !started) { started = true; start(); }
  if (!u && started) { signedOutMsg = true; }
  render();
});

function start() {
  const slowT = setTimeout(() => { if (board === undefined) { slow = true; render(); } }, 15000);
  onLive((data, snap) => {
    offline = !!(snap.metadata && snap.metadata.fromCache);
    if (!offline) { clearTimeout(slowT); slow = false; }
    if (data || !offline) board = data;
    followOpen();
    render();
  }, { meta: true, onError: failed });
  onScreen((data, snap) => {
    controls = data;
    const t = data && data.timer;
    const key = t ? `${t.pollId}|${t.seconds}|${t.startedAt ? t.startedAt.seconds || t.startedAt.__ts || "" : "p"}` : null;
    if (!t) timer = null;
    else if (key !== lastTimerKey) {
      // Counts down from when this screen got the update; after a reload, from
      // the start time against this screen's own clock.
      const startMs = firstControls && t.startedAt ? (t.startedAt.toMillis ? t.startedAt.toMillis() : (t.startedAt.seconds * 1000)) : Date.now();
      timer = { pollId: t.pollId, seconds: t.seconds, endsAt: startMs + t.seconds * 1000 };
    }
    lastTimerKey = key;
    if (!(snap.metadata && snap.metadata.fromCache)) firstControls = false;
    render();
  }, failed);
  onRosterOverrides(() => render());
  setInterval(() => { if (timer) render(); }, 1000);
}
// The open meeting's check-ins (when check-in is on): "Checked in: 31 (in the room 25, remote 6)".
let att = null, attFor = null, attUnsub = null;
function followAttendance() {
  const m = board && board.meeting;
  const id = m && m.status === "open" && m.checkIn ? m.id : null;
  if (id === attFor) return;
  if (attUnsub) { attUnsub(); attUnsub = null; }
  attFor = id; att = null;
  if (id) attUnsub = onAttendance(id, (list) => { att = list; render(); }, (e) => console.warn("attendance", e && e.code));
}
// Listen to the open motion's ballots (turnout), and only that motion's.
function followOpen() {
  followAttendance();
  const open = board && board.open;
  const id = open ? open.id : null;
  if (id === votesFor) return;
  if (votesUnsub) { votesUnsub(); votesUnsub = null; }
  votesFor = id; votes = []; votesLoaded = false;
  if (id) votesUnsub = onVotesFor(id, (vs) => { votes = vs; votesLoaded = true; render(); }, failed);
}
function failed(e) {
  console.warn("listener failed", e && e.code);
  if (classify(e) === "refused") { signedOutMsg = true; member = null; }
  else slow = true;
  render();
}

// ---- render ------------------------------------------------------------------
function render() {
  if (!authKnown) { root.innerHTML = ""; return; }
  if (!member) { root.innerHTML = gateHTML(); wireGate(); return; }
  const note = (offline || slow ? `<p class="screen-note" role="status">${icon("alert", 18)}No connection. May be out of date.</p>` : "")
    + (newer ? `<p class="screen-note" role="status">${icon("alert", 18)}A newer version is available. <button type="button" class="ed-btn ed-btn-tinted btn-sm" id="screen-reload">Reload</button> If this keeps showing, wait 10 minutes and reload.</p>` : "");
  if (board === undefined) { root.innerHTML = `${note}<p class="screen-wait">Connecting...</p>`; return; }
  const m = board && board.meeting;
  const head = `<header class="screen-head"><span class="ed-badge" aria-hidden="true">ED</span>
    <span>${m ? `${escapeHtml(m.title)}, ${escapeHtml(niceDate(m.date))}` : "Motion Voting"}</span></header>`;
  const open = board && board.open;
  const closedId = board && board.lastClosedId;
  const closed = !open && closedId && board.results && board.results[closedId] ? board.results[closedId] : null;
  let body;
  if (open) body = openHTML(open);
  else if (closed) body = closedHTML(closedId, closed);
  else body = waitingHTML();
  const corner = (open || closed) && (!controls || controls.showQr !== false)
    ? `<div class="screen-qr-small"><img src="voter-qr.png" alt="QR code to vote" width="160" height="160" /><span>${escapeHtml(shortLink())}</span></div>` : "";
  root.innerHTML = `${note}${head}${body}${corner}`;
  const rl = document.getElementById("screen-reload"); if (rl) rl.addEventListener("click", () => location.reload());
}
function niceDate(d) {
  if (!d) return "";
  const [y, mo, da] = String(d).split("-").map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
const shortLink = () => voterUrl.replace(/^https?:\/\//, "").replace(/\/index\.html$/, "/");

function waitingHTML() {
  return `<section class="screen-main screen-waiting">
    <img class="screen-qr" src="voter-qr.png" alt="QR code to the voting page" width="360" height="360" />
    <p class="screen-big">Scan to vote. You need the ED password.</p>
    <p class="screen-link">${escapeHtml(shortLink())}</p>
    ${att ? `<p class="screen-sub">Checked in: ${att.length} (in the room ${att.filter((a) => a.mode === "room").length}, remote ${att.filter((a) => a.mode === "remote").length})</p>` : ""}
  </section>`;
}

function openHTML(open) {
  const rule = open.rule || LEGACY_RULE;
  const title = `${open.number ? `Motion ${escapeHtml(open.number)}. ` : ""}Voting open`;
  const amend = open.amendsNumber ? `<p class="screen-sub">Amendment to motion ${escapeHtml(open.amendsNumber)}</p>` : "";
  let turnout = `<p class="screen-sub">Counting votes...</p>`, quorum = "", split = "";
  if (votesLoaded) {
    const r = resultOf({ id: open.id, status: "open", rule, threshold: open.threshold, kind: open.kind,
      options: open.options, optionIds: open.optionIds, seats: open.seats, style: open.style }, votes);
    const need = r.quorumNeeded, have = r.quorumCount, met = have >= need;
    turnout = `<div class="screen-count"><span class="screen-num">${have}</span>
      <span>of ${r.eligible} eligible voters have voted</span></div>`;
    quorum = `<div class="screen-quorum ${met ? "met" : "short"}">
      <div class="spread"><span>Quorum: ${need} needed.</span><strong>${met ? "Met." : `${need - have} more needed`}</strong></div>
      <div class="bar" aria-hidden="true"><span class="${met ? "favour" : "short"}" style="width:${need > 0 ? Math.min(100, (have / need) * 100) : 0}%"></span></div>
    </div>`;
    if (controls && controls.showTally) split = r.kind === "choice" ? choiceBars(r) : barsHTML(r);
  }
  const two = open.kind === "choice"
    ? `<p class="screen-sub">${escapeHtml((open.options || []).map((o) => o.label).join(", "))}. ${(open.seats || 1) > 1 ? `Pick up to ${open.seats}.` : "Pick 1."}</p>`
    : (open.threshold || rule.threshold) === "twoThirds" ? `<p class="screen-sub">Needs two-thirds of the points cast to pass.</p>` : "";
  return `<section class="screen-main">
    <p class="screen-status"><span class="ed-pill ed-pill-good"><span class="dot"></span>${title}</span></p>
    ${amend}<h1 class="screen-motion">${escapeHtml(open.text)}</h1>${two}
    ${turnout}${quorum}${timerHTML(open.id)}${split}
  </section>`;
}
function timerHTML(pollId) {
  if (!timer || timer.pollId !== pollId) return "";
  const left = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
  if (left <= 0) return `<p class="screen-timer done" role="status">Time is up. Leadership will close the vote.</p>`;
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
  return `<p class="screen-timer ${left < 30 ? "soon" : ""}">${mm}:${ss} left</p>`;
}
function barsHTML(r) {
  const row = (k, l) => `<li><i class="sw ${k}"></i><span class="lbl">${l}</span><span class="num"><strong>${fmt(r.weight[k])} pts</strong> · ${r.count[k]} ${r.count[k] === 1 ? "vote" : "votes"}</span></li>`;
  return `${stackedBar(r.weight)}<ul class="tally screen-tally">${row("favour", "In favour")}${row("against", "Against")}${row("abstain", "Abstain")}</ul>`;
}

// Just closed: the saved result. If the save is late, the once-only count
// after 30 seconds (as on phones); never a verdict before either exists.
function closedHTML(id, e) {
  let r = e.result, note = "";
  if (!r) {
    let st = lateCount.get(id);
    if (!st) {
      st = { state: "waiting", result: null };
      lateCount.set(id, st);
      setTimeout(async () => {
        if (!board || !board.results || !board.results[id] || board.results[id].result) return;
        try { st.result = await withTimeout(countOnce(id), 15000); st.state = "done"; } catch (err) { st.state = "failed"; }
        render();
      }, 30000);
    }
    if (st.result) { r = st.result; note = `<p class="screen-sub">Count from the ballots. The saved result will replace it.</p>`; }
  }
  if (!r) {
    return `<section class="screen-main"><p class="screen-status"><span class="ed-pill ed-pill-quiet">Closed</span></p>
      <h1 class="screen-motion">${escapeHtml(e.text)}</h1><p class="screen-big" aria-live="polite">Counting votes...</p></section>`;
  }
  const met = r.quorumCount >= r.quorumNeeded;
  return `<section class="screen-main">
    <p class="screen-status"><span class="ed-pill ed-pill-quiet">${e.number ? `Motion ${escapeHtml(e.number)}. ` : ""}Closed</span></p>
    <h1 class="screen-motion">${escapeHtml(e.text)}</h1>
    <div class="screen-verdict" aria-live="polite">${verdictHTML(outcomeKind(r), escapeHtml(outcomeWords(r, "voter")))}</div>
    ${r.kind === "choice" ? choiceBars(r) : barsHTML(r)}
    <p class="screen-sub">Quorum: ${r.quorumCount} of ${r.quorumNeeded} ${met ? "met" : "not met"}.${e.closedAt ? ` Closed at ${escapeHtml(clockTime(e.closedAt))}.` : ""}</p>
    ${note}
  </section>`;
}

// ---- signed out: the ED password only ------------------------------------------
function gateHTML() {
  return `<div class="gate-screen"><div class="card gate">
    <span class="ed-badge" aria-hidden="true">ED</span>
    <h1>Meeting screen</h1>
    <p class="ed-muted">${signedOutMsg ? "This screen is signed out. Ask leadership, or enter the ED password." : "Enter the ED password to show the meeting screen."}</p>
    <form id="edgate" class="gate-form" autocomplete="on">
      <input class="pw-user" type="text" name="username" autocomplete="username" value="ED password" tabindex="-1" aria-hidden="true" />
      <label class="ed-label" for="edpw">ED password
        <input class="ed-field" id="edpw" name="password" type="password" autocomplete="current-password" required />
      </label>
      <p id="ederr" class="ed-error err hide" role="alert"></p>
      <button id="edgo" class="ed-btn ed-btn-filled" type="submit">Continue</button>
    </form>
  </div></div>`;
}
function wireGate() {
  const f = document.getElementById("edgate"), pw = document.getElementById("edpw"), err = document.getElementById("ederr");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const typed = pw.value.trim();
    if (!typed) return;
    const btn = document.getElementById("edgo");
    btn.disabled = true; err.classList.add("hide");
    // Listeners that were refused do not come back: start clean after signing in again.
    const restart = started;
    try { await voterSignIn(typed); if (restart) location.reload(); }
    catch (ex) {
      btn.disabled = false;
      const msg = isWrongPassword(ex) ? "That's not the ED password." : "Couldn't sign in. Check your connection and try again.";
      err.innerHTML = icon("alert", 18) + `<span>${msg}</span>`;
      err.classList.remove("hide"); pw.select();
    }
  });
}

render();
