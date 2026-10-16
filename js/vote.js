import { slugify } from "./roster.js";
import { ORG_NAME } from "./config.js";
import { onPolls, onVotesFor, castVote, getSessionId, tally, onRosterOverrides, resolvedPerson, currentRoster, rosterPerson, watchMember, voterSignIn, isWrongPassword, quorumThreshold } from "./db.js";
import { escapeHtml, labelOf, toast, icon, verdictHTML, stackedBar } from "./util.js";

document.title = ORG_NAME;
const app = document.getElementById("app");
const sessionId = getSessionId();

// ---- state -----------------------------------------------------------------
let me = JSON.parse(localStorage.getItem("ed_voter") || "null"); // {name,slug,group,weight,isWriteIn}
let voterTab = "vote";          // "vote" | "results"
let polls = [];
let activePoll = null;

let activeUnsub = null, activeVotes = [];      // live votes for the open motion
const resultSubs = new Map();                  // pollId -> unsub (closed motions, Results tab)
const resultData = new Map();                  // pollId -> votes[]

// ---- data subscriptions ----------------------------------------------------
function startData() {
  // Keep current categories loaded so votes weight correctly, and re-render on
  // a change, so a mid-meeting category fix shows up in the results a voter is
  // already looking at instead of waiting for the next unrelated render.
  // Not while the name picker is up: re-rendering it would wipe what they are
  // part-way through typing, so only its name list is redrawn (a physician
  // added or removed by leadership shows up straight away).
  onRosterOverrides(() => {
    if (me) { render(); return; }
    const search = document.getElementById("search");
    renderNames(search ? search.value : "");
  });
  onPolls((p) => {
    polls = p;
    const open = polls.find((x) => x.status === "open" && !x.archived && !x.deleted) || null;
    const prev = activePoll;
    const changed = (prev && prev.id) !== (open && open.id);
    // Auto-navigate the voter: to the result when the open motion closes,
    // back to the ballot when the next motion opens.
    if (changed && me) {
      if (open) voterTab = "vote";
      else if (prev) voterTab = "results";
    }
    activePoll = open;
    if (changed) {
      if (activeUnsub) { activeUnsub(); activeUnsub = null; }
      activeVotes = [];
      if (activePoll) activeUnsub = onVotesFor(activePoll.id, (vs) => { activeVotes = vs; render(); });
    }
    render();
  });
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
  render();
});

function syncResultSubs() {
  const closedIds = new Set(polls.filter((p) => p.status === "closed" && !p.archived && !p.deleted).map((p) => p.id));
  // tear down subs we no longer need
  for (const [id, unsub] of resultSubs) {
    if (voterTab !== "results" || !closedIds.has(id)) { unsub(); resultSubs.delete(id); resultData.delete(id); }
  }
  if (voterTab !== "results") return;
  // ensure a sub for every closed motion
  for (const id of closedIds) {
    if (!resultSubs.has(id)) {
      resultSubs.set(id, onVotesFor(id, (vs) => { resultData.set(id, vs); render(); }));
    }
  }
}

// ---- render ----------------------------------------------------------------
function render() {
  if (!authKnown) { app.innerHTML = `<div class="card"><p class="ed-hint center">Loading…</p></div>`; return; }
  if (!member) { app.innerHTML = gateHTML(); wireGate(); return; }
  syncResultSubs();
  if (!me) { app.innerHTML = shell(pickerHTML()); wirePicker(); return; }

  const tabBtn = (k, l) => `<button type="button" class="tab ${voterTab === k ? "active" : ""}" data-vtab="${k}" aria-pressed="${voterTab === k}">${l}</button>`;
  const tabs = `<nav class="tabs ed-seg" aria-label="Vote or results">${tabBtn("vote", "Vote")}${tabBtn("results", "Results")}</nav>`;
  const body = voterTab === "vote" ? `<div class="card stack">${voteBody()}</div>` : resultsBody();
  app.innerHTML = shell(tabs + body);
  wireVoter();
}

function shell(inner) {
  return `<header class="topbar"><span class="ed-badge" aria-hidden="true">ED</span><span class="brand">MGH Emergency Department</span></header>
    <h1 class="ed-title page-title">Motion Voting</h1>
    <p class="lede">Tap to cast your vote. Results update live.</p>${inner}`;
}

// ---- ED password screen ------------------------------------------------------
// The same sign-in card as every ED tool (see css/ed-ui.css): badge, title, one
// labelled field, one button.
function gateHTML() {
  return `<div class="gate-screen"><div class="card gate">
    <span class="ed-badge" aria-hidden="true">ED</span>
    <h1>Motion Voting</h1>
    <p class="ed-muted">Enter the ED password to vote.</p>
    <form id="edgate" class="gate-form" autocomplete="on">
      <input class="pw-user" type="text" name="username" autocomplete="username" value="ED password" tabindex="-1" aria-hidden="true" />
      <label class="ed-label" for="edpw">ED password
        <input class="ed-field" id="edpw" name="password" type="password" autocomplete="current-password" required />
      </label>
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
  if (activePoll) {
    // Only reveal a previously-cast choice if THIS device cast it. Otherwise
    // (e.g. browsing to someone else's name) the ballot shows blank: you
    // can't peek at how another person voted.
    const mine = (deviceBound() === me.slug) ? activeVotes.find((v) => v.slug === me.slug) : null;
    const tile = ([c, l, ic]) => `<button type="button" class="vote" data-c="${c}" aria-pressed="${!!(mine && mine.choice === c)}">${icon(ic, 26)}${l}</button>`;
    return head + `
      <span class="ed-pill ed-pill-good"><span class="dot"></span>Voting open</span>
      <h2 class="motion-text">${escapeHtml(activePoll.text)}</h2>
      <div class="votes" role="group" aria-label="Your vote">${CHOICES.map(tile).join("")}</div>
      <p class="ed-hint">${mine ? `You voted <strong>${escapeHtml(labelOf(mine.choice))}</strong>. You can change it until voting closes.`
        : "You can change your vote until leadership closes the motion."}</p>`;
  }
  return head + `<div class="ed-empty">${icon("clock", 40)}
    <strong>No motion open right now</strong>
    <span>Closed motions appear under Results.</span></div>`;
}

// ---- results tab (numbers hidden from voters) ------------------------------
function resultsBody() {
  const closed = polls.filter((p) => p.status === "closed" && !p.archived && !p.deleted).reverse();   // newest first
  if (!closed.length) return `<div class="card"><div class="ed-empty"><strong>No results yet</strong><span>Closed motions will appear here.</span></div></div>`;
  return closed.map(resultCard).join("");
}
function resultCard(poll) {
  // Until this motion's ballots have actually arrived we know nothing, and an
  // empty tally scores as "No quorum", which on a meeting-room screen reads as a
  // real result. Say "counting" instead of announcing a wrong outcome.
  const top = `<span class="ed-pill ed-pill-quiet">Closed</span>
      <h2 class="motion-text">${escapeHtml(poll.text)}</h2>`;
  if (!resultData.has(poll.id)) {
    return `<div class="card stack">${top}<p class="ed-hint">Counting votes…</p></div>`;
  }
  const t = tally(resultData.get(poll.id), poll);
  const quorum = quorumThreshold(poll);
  const met = t.quorumCount >= quorum;
  const outcome = !met ? verdictHTML("noq", "No quorum")
    : t.weight.favour > t.weight.against ? verdictHTML("pass", "Passed")
    : t.weight.favour < t.weight.against ? verdictHTML("fail", "Did not pass")
    : verdictHTML("tie", "Tie");
  return `<div class="card stack">${top}
    ${outcome}
    ${stackedBar(t.weight)}
    <p class="legend"><span><i class="sw favour"></i>In favour</span><span><i class="sw against"></i>Against</span><span><i class="sw abstain"></i>Abstain</span></p>
  </div>`;
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
    b.addEventListener("click", () => submit(b.dataset.c)));
}
async function submit(choice) {
  try {
    // resolve the voter's CURRENT category/weight at submit time (reflects any
    // leadership edits); write-ins keep their 0-weight snapshot.
    const rp = me.isWriteIn ? { group: me.group, weight: me.weight } : resolvedPerson(me.slug);
    await castVote({ pollId: activePoll.id, name: me.name, slug: me.slug, group: rp.group,
      weight: rp.weight, isWriteIn: me.isWriteIn, choice, sessionId });
    localStorage.setItem("ed_bound", me.slug);   // lock this device to this person
    toast("Vote recorded: " + labelOf(choice));
    render();
  } catch (e) { console.error(e); toast("Could not record vote. Try again."); }
}

render();
