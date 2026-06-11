import { ROSTER, ROSTER_BY_SLUG, slugify } from "./roster.js";
import { ORG_NAME, QUORUM_THRESHOLD } from "./config.js";
import { onPolls, onVotesFor, castVote, getSessionId, tally } from "./db.js";

const $ = (id) => document.getElementById(id);
document.title = ORG_NAME;
$("org").textContent = ORG_NAME;

const sessionId = getSessionId();
let me = JSON.parse(localStorage.getItem("ed_voter") || "null"); // {name,slug,group,weight,isWriteIn}
let polls = [];
let activePoll = null;
let votesUnsub = null;
let lastVotes = [];

// ---------------------------------------------------------------- name picker
const search = $("search");
const namelist = $("namelist");

function renderNames(filter = "") {
  const f = filter.trim().toLowerCase();
  const list = ROSTER.filter((p) => p.name.toLowerCase().includes(f));
  namelist.innerHTML = list.length
    ? list.map((p) => `<li data-slug="${p.slug}">${p.name}</li>`).join("")
    : `<li class="muted" style="cursor:default">No match — use “add it” below.</li>`;
}
renderNames();
search.addEventListener("input", () => renderNames(search.value));

namelist.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-slug]");
  if (!li) return;
  const p = ROSTER_BY_SLUG[li.dataset.slug];
  setVoter({ name: p.name, slug: p.slug, group: p.group, weight: p.weight, isWriteIn: false });
});

$("writein-btn").addEventListener("click", () => $("writein-box").classList.toggle("hide"));
$("writein-confirm").addEventListener("click", () => {
  const name = $("writein").value.trim();
  if (name.length < 3) { toast("Please type your full name."); return; }
  const slug = slugify(name);
  if (ROSTER_BY_SLUG[slug]) {
    const p = ROSTER_BY_SLUG[slug];
    setVoter({ name: p.name, slug: p.slug, group: p.group, weight: p.weight, isWriteIn: false });
  } else {
    setVoter({ name, slug, group: "writein", weight: 0, isWriteIn: true });
  }
});

function setVoter(v) {
  me = v;
  localStorage.setItem("ed_voter", JSON.stringify(v));
  showVoteStep();
}

$("change-name").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("ed_voter");
  me = null;
  $("step-vote").classList.add("hide");
  $("step-name").classList.remove("hide");
  search.value = ""; renderNames();
});

// ---------------------------------------------------------------- vote step
function showVoteStep() {
  $("step-name").classList.add("hide");
  $("step-vote").classList.remove("hide");
  $("voter-name").textContent = me.name + (me.isWriteIn ? " (new — pending review)" : "");
  render();
}

onPolls((p) => {
  polls = p;
  const open = polls.find((x) => x.status === "open");
  const newActive = open || null;
  const changedPoll = (activePoll && activePoll.id) !== (newActive && newActive.id);
  activePoll = newActive;
  if (changedPoll) {
    if (votesUnsub) { votesUnsub(); votesUnsub = null; }
    lastVotes = [];
    if (activePoll) votesUnsub = onVotesFor(activePoll.id, (vs) => { lastVotes = vs; if (me) render(); });
  }
  if (me) render();
});

function myVote() {
  return lastVotes.find((v) => v.slug === me.slug);
}

let resultUnsub = null, resultId = null, resultVotes = [];

function render() {
  if (!me) return;
  const body = $("vote-body");

  // an open motion → show the ballot
  if (activePoll) {
    if (resultUnsub) { resultUnsub(); resultUnsub = null; resultId = null; }
    const mine = myVote();
    body.innerHTML = `
      <span class="pill open">● VOTING OPEN</span>
      <h2 style="margin-top:10px;">${escapeHtml(activePoll.text)}</h2>
      ${me.weight === 0 ? `<p class="disclaimer">Your vote is recorded but currently carries <strong>no weight</strong>${me.isWriteIn ? " (pending leadership review)" : ""}.</p>` : ""}
      <div class="choice-row">
        <button class="btn favour ${mine?.choice==="favour"?"selected":""}" data-c="favour">👍 In favour</button>
        <button class="btn against ${mine?.choice==="against"?"selected":""}" data-c="against">👎 Against</button>
        <button class="btn abstain ${mine?.choice==="abstain"?"selected":""}" data-c="abstain">➖ Abstain</button>
      </div>
      ${mine ? `<p class="center muted" style="margin-top:14px;">You voted <strong>${labelOf(mine.choice)}</strong>. You can change it until voting closes.</p>` : ""}
    `;
    body.querySelectorAll("button[data-c]").forEach((b) =>
      b.addEventListener("click", () => submit(b.dataset.c)));
    return;
  }

  // no motion open → maybe show the latest closed result
  const closedVisible = [...polls].reverse().find((p) => p.status === "closed" && p.resultsVisible);
  if (closedVisible) {
    if (resultId !== closedVisible.id) {            // subscribe once per closed poll
      if (resultUnsub) resultUnsub();
      resultId = closedVisible.id; resultVotes = [];
      resultUnsub = onVotesFor(closedVisible.id, (vs) => { resultVotes = vs; if (me) paintResult(body, closedVisible, resultVotes); });
    }
    paintResult(body, closedVisible, resultVotes);
  } else {
    if (resultUnsub) { resultUnsub(); resultUnsub = null; resultId = null; }
    body.innerHTML = `<div class="center" style="padding:24px 0;">
      <div class="big">⏳</div>
      <p class="muted">Waiting for the next motion to open…</p>
    </div>`;
  }
}

async function submit(choice) {
  try {
    await castVote({
      pollId: activePoll.id, name: me.name, slug: me.slug, group: me.group,
      weight: me.weight, isWriteIn: me.isWriteIn, choice, sessionId,
    });
    toast("Vote recorded: " + labelOf(choice));
  } catch (e) {
    console.error(e);
    toast("Could not record vote — try again.");
  }
}

// Result shown to the whole group once a poll closes (if revealed).
function paintResult(body, poll, votes) {
  const t = tally(votes);
  const quorumMet = t.quorumCount >= QUORUM_THRESHOLD;
  const pass = quorumMet && t.weight.favour > t.weight.against;
  const outcome = !quorumMet
    ? `<span class="result-noq">NO QUORUM</span>`
    : pass ? `<span class="result-pass">PASSED ✅</span>` : `<span class="result-fail">DID NOT PASS ❌</span>`;
  body.innerHTML = `
    <span class="pill closed">● VOTING CLOSED</span>
    <h2 style="margin-top:10px;">${escapeHtml(poll.text)}</h2>
    <p class="center big">${outcome}</p>
    ${bars(t)}
    <p class="center ${quorumMet ? "quorum-ok" : "quorum-bad"}">
      Quorum: ${t.quorumCount} / ${QUORUM_THRESHOLD} ${quorumMet ? "met" : "NOT met"}
    </p>`;
}

function bars(t) {
  const max = Math.max(t.weight.favour, t.weight.against, t.weight.abstain, 1);
  const row = (key, label) => `
    <div class="bar-row">
      <div class="bar-label"><span>${label}</span>
        <span>${fmt(t.weight[key])} pts · ${t.count[key]} ${t.count[key]===1?"vote":"votes"}</span></div>
      <div class="bar-track"><div class="bar-fill ${key}" style="width:${(t.weight[key]/max)*100}%"></div></div>
    </div>`;
  return `<div class="bars">${row("favour","In favour")}${row("against","Against")}${row("abstain","Abstain")}</div>`;
}

// ---------------------------------------------------------------- utils
function labelOf(c){return c==="favour"?"In favour":c==="against"?"Against":"Abstain";}
function fmt(n){return Number.isInteger(n)?n:n.toFixed(1);}
function escapeHtml(s){return s.replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
let toastT;
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.remove("hide");clearTimeout(toastT);toastT=setTimeout(()=>el.classList.add("hide"),2200);}

// auto-resume if a name was already chosen on this device
if (me) showVoteStep();
