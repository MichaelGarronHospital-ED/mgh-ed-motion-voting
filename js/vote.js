import { ROSTER, ROSTER_BY_SLUG, slugify } from "./roster.js";
import { ORG_NAME, QUORUM_THRESHOLD } from "./config.js";
import { onPolls, onVotesFor, castVote, getSessionId, tally, onRosterOverrides, resolvedPerson, anonSignIn } from "./db.js";

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
  onRosterOverrides(() => {});   // keep current categories loaded so votes weight correctly
  onPolls((p) => {
    polls = p;
    const open = polls.find((x) => x.status === "open" && !x.archived) || null;
    const changed = (activePoll && activePoll.id) !== (open && open.id);
    activePoll = open;
    if (changed) {
      if (activeUnsub) { activeUnsub(); activeUnsub = null; }
      activeVotes = [];
      if (activePoll) activeUnsub = onVotesFor(activePoll.id, (vs) => { activeVotes = vs; render(); });
    }
    render();
  });
}
// Anonymous sign-in first so reads/writes are authenticated under locked rules.
// If anonymous auth isn't enabled yet, we proceed anyway (open-rules mode).
anonSignIn().catch((e) => console.warn("anon auth unavailable, continuing:", e && e.code)).finally(startData);

function syncResultSubs() {
  const closedIds = new Set(polls.filter((p) => p.status === "closed" && !p.archived).map((p) => p.id));
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
  syncResultSubs();
  if (!me) { app.innerHTML = shell(pickerHTML()); wirePicker(); return; }

  const tabs = `<div class="tabs">
      <div class="tab ${voterTab === "vote" ? "active" : ""}" data-vtab="vote">Vote</div>
      <div class="tab ${voterTab === "results" ? "active" : ""}" data-vtab="results">Results</div>
    </div>`;
  const body = voterTab === "vote" ? `<div class="card">${voteBody()}</div>` : resultsBody();
  app.innerHTML = shell(tabs + body);
  wireVoter();
}

function shell(inner) {
  return `<h1>${escapeHtml(ORG_NAME)}</h1>
    <p class="sub">Tap to cast your vote. Live and anonymous to the group.</p>${inner}`;
}

// ---- name picker -----------------------------------------------------------
function pickerHTML() {
  return `<div class="card">
    <div class="disclaimer">⚠️ Please select <strong>your own name only</strong>, and vote once. Votes are linked to your name and reviewed for duplicates. You must select your name to vote or view results.</div>
    <label for="search">Find your name</label>
    <input id="search" type="text" placeholder="Start typing your name…" autocomplete="off" />
    <ul id="namelist" class="namelist"></ul>
    <button id="writein-btn" class="btn ghost" style="margin-top:12px;">My name isn't listed — add it</button>
    <div id="writein-box" class="hide" style="margin-top:12px;">
      <label for="writein">Type your full name</label>
      <input id="writein" type="text" placeholder="First Last" autocomplete="off" />
      <button id="writein-confirm" class="btn accent">Continue</button>
      <p class="sub" style="margin-top:8px;">New / unlisted names are added to the record for leadership.</p>
    </div>
  </div>`;
}
function renderNames(filter = "") {
  const el = document.getElementById("namelist");
  if (!el) return;
  const f = filter.trim().toLowerCase();
  const list = ROSTER.filter((p) => p.name.toLowerCase().includes(f));
  el.innerHTML = list.length
    ? list.map((p) => `<li data-slug="${p.slug}">${escapeHtml(p.name)}</li>`).join("")
    : `<li class="muted" style="cursor:default">No match — use “add it” below.</li>`;
}
function wirePicker() {
  renderNames();
  const search = document.getElementById("search");
  search.addEventListener("input", () => renderNames(search.value));
  document.getElementById("namelist").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-slug]"); if (!li) return;
    const p = ROSTER_BY_SLUG[li.dataset.slug];
    setVoter({ name: p.name, slug: p.slug, group: p.group, weight: p.weight, isWriteIn: false });
  });
  document.getElementById("writein-btn").addEventListener("click", () =>
    document.getElementById("writein-box").classList.toggle("hide"));
  document.getElementById("writein-confirm").addEventListener("click", () => {
    const name = document.getElementById("writein").value.trim();
    if (name.length < 3) { toast("Please type your full name."); return; }
    const slug = slugify(name);
    if (ROSTER_BY_SLUG[slug]) {
      const p = ROSTER_BY_SLUG[slug];
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
function voteBody() {
  // Every voter — including courtesy / write-ins — sees the same ballot. The
  // weighting (0 for courtesy) is applied behind the scenes; leadership sees it
  // in the Voters table, but it is never surfaced to the voter.
  // Once any vote is cast on this device it is locked to that person, so you
  // can't switch names and vote again. (Correcting a mis-tap is only possible
  // before your first vote.)
  const bound = deviceBound();
  const head = `<div class="spread"><span class="muted">Voting as <strong>${escapeHtml(me.name)}</strong></span>
    ${bound ? `<a href="#" id="switch-voter" class="sub">Switch voter</a>` : `<a href="#" id="change-name" class="sub">Not you?</a>`}</div>`;
  if (activePoll) {
    const mine = activeVotes.find((v) => v.slug === me.slug);
    return head + `
      <span class="pill open">● VOTING OPEN</span>
      <h2 style="margin-top:10px;">${escapeHtml(activePoll.text)}</h2>
      <div class="choice-row">
        <button class="btn favour ${mine && mine.choice === "favour" ? "selected" : ""}" data-c="favour">👍 In favour</button>
        <button class="btn against ${mine && mine.choice === "against" ? "selected" : ""}" data-c="against">👎 Against</button>
        <button class="btn abstain ${mine && mine.choice === "abstain" ? "selected" : ""}" data-c="abstain">➖ Abstain</button>
      </div>
      ${mine ? `<p class="center muted" style="margin-top:14px;">You voted <strong>${labelOf(mine.choice)}</strong>. You can change it until voting closes.</p>` : ""}`;
  }
  return head + `<div class="center" style="padding:24px 0;">
    <div class="big">⏳</div>
    <p class="muted">No motion open right now.<br>Closed motions appear under the <strong>Results</strong> tab.</p></div>`;
}

// ---- results tab (numbers hidden from voters) ------------------------------
function resultsBody() {
  const closed = polls.filter((p) => p.status === "closed" && !p.archived);
  if (!closed.length) return `<div class="card"><p class="muted center" style="padding:16px 0;">No results yet. Closed motions will appear here.</p></div>`;
  return closed.map(resultCard).join("");
}
function resultCard(poll) {
  const t = tally(resultData.get(poll.id) || []);
  const met = t.quorumCount >= QUORUM_THRESHOLD;
  const pass = met && t.weight.favour > t.weight.against;
  const outcome = !met ? `<span class="result-noq">NO QUORUM</span>`
    : pass ? `<span class="result-pass">PASSED ✅</span>` : `<span class="result-fail">DID NOT PASS ❌</span>`;
  const max = Math.max(t.weight.favour, t.weight.against, t.weight.abstain, 1);
  const bar = (k, l) => `<div class="bar-row"><div class="bar-label"><span>${l}</span></div>
    <div class="bar-track"><div class="bar-fill ${k}" style="width:${(t.weight[k] / max) * 100}%"></div></div></div>`;
  return `<div class="card">
    <span class="pill closed">● CLOSED</span>
    <h2 style="margin:8px 0;">${escapeHtml(poll.text)}</h2>
    <p class="center" style="font-size:1.4rem;font-weight:800;margin:6px 0;">${outcome}</p>
    <div class="bars">${bar("favour", "In favour")}${bar("against", "Against")}${bar("abstain", "Abstain")}</div>
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
  } catch (e) { console.error(e); toast("Could not record vote — try again."); }
}

// ---- utils -----------------------------------------------------------------
function labelOf(c){return c==="favour"?"In favour":c==="against"?"Against":"Abstain";}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
let toastT;
function toast(msg){const el=document.getElementById("toast");el.textContent=msg;el.classList.remove("hide");clearTimeout(toastT);toastT=setTimeout(()=>el.classList.add("hide"),2200);}

render();
