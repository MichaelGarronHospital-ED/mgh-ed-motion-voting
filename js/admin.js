import { ADMIN_PASSCODE, QUORUM_THRESHOLD, ORG_NAME } from "./config.js";
import { ROSTER, ELIGIBLE_COUNT } from "./roster.js";
import {
  onPolls, onVotesFor, addPoll, updatePoll, deletePoll, openPoll, closePoll,
  setVoteWeight, clearVote, tally, effectiveWeight,
} from "./db.js";

const $ = (id) => document.getElementById(id);
document.title = ORG_NAME + " — Leadership";

// ----------------------------------------------------------------- gate
function unlock() {
  $("gate").classList.add("hide");
  $("console").classList.remove("hide");
  boot();
}
$("enter").addEventListener("click", tryEnter);
$("pass").addEventListener("keydown", (e) => { if (e.key === "Enter") tryEnter(); });
function tryEnter() {
  if ($("pass").value === ADMIN_PASSCODE) { sessionStorage.setItem("ed_admin", "1"); unlock(); }
  else $("gate-err").classList.remove("hide");
}
$("lock").addEventListener("click", (e) => { e.preventDefault(); sessionStorage.removeItem("ed_admin"); location.reload(); });
if (sessionStorage.getItem("ed_admin") === "1") unlock();

// ----------------------------------------------------------------- tabs
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    ["share", "motions", "results", "voters"].forEach((name) =>
      $("tab-" + name).classList.toggle("hide", name !== t.dataset.tab));
  }));

// ----------------------------------------------------------------- state
let polls = [];
let activePoll = null;
let activeVotes = [];
let votesUnsub = null;
let editingId = null;   // motion currently being edited (only allowed before first vote)

function boot() {
  // share tab
  const url = location.origin + location.pathname.replace(/admin\.html$/, "") + "index.html";
  $("vote-url").value = url;
  if (window.QRCode) QRCode.toCanvas($("qr"), url, { width: 240, margin: 1 }, () => {});
  $("copy-url").addEventListener("click", () => { navigator.clipboard.writeText(url); toast("Link copied"); });
  $("roster-summary").textContent =
    `${ROSTER.length} physicians on the roster · ${ELIGIBLE_COUNT} eligible to vote · quorum = ${QUORUM_THRESHOLD} (50% of eligible would be ${Math.ceil(ELIGIBLE_COUNT / 2)}).`;

  $("add-motion").addEventListener("click", async () => {
    const text = $("new-motion").value.trim();
    if (text.length < 3) { toast("Type the motion first."); return; }
    await addPoll(text);
    $("new-motion").value = "";
    toast("Motion added");
  });
  $("export").addEventListener("click", exportCsv);

  onPolls((p) => {
    polls = p;
    const open = polls.find((x) => x.status === "open") || null;
    const changed = (activePoll && activePoll.id) !== (open && open.id);
    activePoll = open;
    if (changed) {
      if (votesUnsub) { votesUnsub(); votesUnsub = null; }
      activeVotes = [];
      if (activePoll) votesUnsub = onVotesFor(activePoll.id, (vs) => { activeVotes = vs; renderResults(); renderVoters(); });
    }
    renderMotions();
    renderResults();
    renderVoters();
  });
}

// ----------------------------------------------------------------- motions
function renderMotions() {
  const el = $("motion-list");
  if (!polls.length) { el.innerHTML = `<p class="muted">No motions yet. Add Friday's motions above.</p>`; return; }
  el.innerHTML = polls.map((p) => {
    const locked = (p.voteCount || 0) > 0;   // edit allowed only before the first vote
    if (editingId === p.id) {
      return `<div class="poll-item"><div class="text" style="width:100%">
        <textarea data-edit="${p.id}" style="margin-bottom:8px">${escapeHtml(p.text)}</textarea>
        <div class="row"><button class="btn accent small" data-act="save" data-id="${p.id}">Save</button>
          <button class="btn ghost small" data-act="cancel" data-id="${p.id}">Cancel</button></div></div></div>`;
    }
    const pill = `<span class="pill ${p.status}">${p.status.toUpperCase()}</span>`;
    return `<div class="poll-item">
      <div class="text">${pill} ${escapeHtml(p.text)}${locked ? `<span class="sub"> · 🔒 locked (voting started)</span>` : ""}</div>
      <div class="row">
        ${p.status !== "open"
          ? `<button class="btn favour small" data-act="open" data-id="${p.id}">Open</button>`
          : `<button class="btn against small" data-act="close" data-id="${p.id}">Close</button>`}
        ${!locked ? `<button class="btn ghost small" data-act="edit" data-id="${p.id}">Edit</button>` : ""}
        ${!locked ? `<button class="btn ghost small" data-act="del" data-id="${p.id}">Delete</button>` : ""}
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => motionAction(b.dataset.act, b.dataset.id)));
}

async function motionAction(act, id) {
  if (act === "open") {
    if (polls.some((p) => p.status === "open" && p.id !== id))
      if (!confirm("This will close the currently open motion. Continue?")) return;
    await openPoll(id);
    toast("Motion opened — voters can now vote.");
  } else if (act === "close") {
    await closePoll(id); toast("Motion closed.");
  } else if (act === "edit") {
    editingId = id; renderMotions();
  } else if (act === "cancel") {
    editingId = null; renderMotions();
  } else if (act === "save") {
    const poll = polls.find((p) => p.id === id);
    if ((poll.voteCount || 0) > 0) { toast("Locked — voting has started."); editingId = null; renderMotions(); return; }
    const ta = document.querySelector(`textarea[data-edit="${id}"]`);
    const text = ta.value.trim();
    if (text.length < 3) { toast("Motion text too short."); return; }
    await updatePoll(id, { text });
    editingId = null; toast("Motion updated.");
  } else if (act === "del") {
    if (confirm("Delete this motion and its votes?")) { await deletePoll(id); toast("Deleted."); }
  }
}

// ----------------------------------------------------------------- results
// The "display poll" is the open motion, or else the most recent closed one.
// Both the Results and Voters tabs read from this single subscription.
let displayUnsub = null, displayId = null, displayVotes = [];
function ensureDisplay() {
  const poll = activePoll || [...polls].reverse().find((p) => p.status === "closed") || null;
  if (!poll) {
    if (displayUnsub) { displayUnsub(); displayUnsub = null; }
    displayId = null; displayVotes = [];
    return null;
  }
  if (activePoll && poll.id === activePoll.id) {
    if (displayUnsub) { displayUnsub(); displayUnsub = null; displayId = null; }
    return { poll, votes: activeVotes };               // reuse the live subscription
  }
  if (poll.id !== displayId) {                          // a closed poll — subscribe once
    if (displayUnsub) displayUnsub();
    displayId = poll.id; displayVotes = [];
    displayUnsub = onVotesFor(poll.id, (vs) => { displayVotes = vs; renderResults(); renderVoters(); });
  }
  return { poll, votes: displayVotes };
}

function renderResults() {
  const el = $("results-body");
  const d = ensureDisplay();
  if (!d) { el.innerHTML = `<p class="muted">Open a motion to see live results.</p>`; return; }
  paintResults(el, d.poll, d.votes);
}
function paintResults(el, poll, votes) {
  const t = tally(votes);
  const quorumMet = t.quorumCount >= QUORUM_THRESHOLD;
  const pass = quorumMet && t.weight.favour > t.weight.against;
  const statusPill = `<span class="pill ${poll.status}">${poll.status.toUpperCase()}</span>`;
  const outcome = !quorumMet
    ? `<span class="result-noq">NO QUORUM — cannot pass</span>`
    : pass ? `<span class="result-pass">PASSES ✅</span>` : `<span class="result-fail">DOES NOT PASS ❌</span>`;
  el.innerHTML = `
    ${statusPill}
    <h2 style="margin-top:8px;">${escapeHtml(poll.text)}</h2>
    <p class="center big">${outcome}</p>
    ${bars(t)}
    <div class="card" style="background:var(--card2); margin-top:8px;">
      <div class="spread"><span>Quorum</span>
        <span class="${quorumMet ? "quorum-ok" : "quorum-bad"}">${t.quorumCount} / ${QUORUM_THRESHOLD} ${quorumMet ? "✅ met" : "❌ NOT met"}</span></div>
      <div class="bar-track" style="margin-top:6px;"><div class="bar-fill favour" style="width:${Math.min(100,(t.quorumCount/QUORUM_THRESHOLD)*100)}%"></div></div>
      ${!quorumMet ? `<p class="sub" style="color:#fca5a5;margin:8px 0 0;">Need ${QUORUM_THRESHOLD - t.quorumCount} more eligible voter(s) before this motion can be decided.</p>` : ""}
    </div>
    <p class="sub">${t.totalVotes} total ballots · ${t.writeIns} write-in(s) · ${t.flags} flagged for review.
      Pass rule: weighted <em>In favour</em> &gt; weighted <em>Against</em>; abstentions count to quorum only. Results are always visible to voters once closed.</p>
    <div class="row" style="margin-top:6px;">
      ${poll.status === "open"
        ? `<button class="btn against small" id="r-close">Close voting</button>`
        : `<button class="btn favour small" id="r-open">Re-open voting</button>`}
    </div>`;
  const c = $("r-close"), o = $("r-open");
  if (c) c.addEventListener("click", () => motionAction("close", poll.id));
  if (o) o.addEventListener("click", () => motionAction("open", poll.id));
}

function bars(t) {
  const max = Math.max(t.weight.favour, t.weight.against, t.weight.abstain, 1);
  const row = (key, label) => `
    <div class="bar-row">
      <div class="bar-label"><span>${label}</span>
        <span><strong>${fmt(t.weight[key])} pts</strong> · ${t.count[key]} ${t.count[key]===1?"vote":"votes"}</span></div>
      <div class="bar-track"><div class="bar-fill ${key}" style="width:${(t.weight[key]/max)*100}%"></div></div>
    </div>`;
  return `<div class="bars">${row("favour","In favour")}${row("against","Against")}${row("abstain","Abstain")}</div>`;
}

// ----------------------------------------------------------------- voters
function renderVoters() {
  const d = ensureDisplay();
  if (!d) { $("voters-table").innerHTML = ""; $("voters-note").textContent = "No motion selected."; return; }
  paintVoters(d.poll, d.votes);
}
function paintVoters(poll, votes) {
  $("voters-note").innerHTML = `Motion: <em>${escapeHtml(poll.text)}</em> · ${votes.length} ballots. Flagged rows = same name voted from 2+ devices.`;
  const sorted = [...votes].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((v) => {
    const ew = effectiveWeight(v);
    const g = v.isWriteIn ? "write-in" : groupLabel(v.group);
    return `<tr class="${v.flagged ? "flagged" : ""}">
      <td>${escapeHtml(v.name)} ${v.flagged ? '<span class="pill flag">REVIEW</span>' : ""}${v.isWriteIn ? '<span class="pill draft">NEW</span>' : ""}</td>
      <td>${g}</td>
      <td>${fmt(ew)}</td>
      <td>${labelOf(v.choice)}</td>
      <td>${v.submissionCount || 1}×</td>
      <td>
        <button class="btn ghost small" data-w="1" data-id="${v.id}">1</button>
        <button class="btn ghost small" data-w="0.5" data-id="${v.id}">½</button>
        <button class="btn ghost small" data-w="0" data-id="${v.id}">0</button>
        <button class="btn ghost small" data-del="${v.id}">✕</button>
      </td>
    </tr>`;
  }).join("");
  $("voters-table").innerHTML =
    `<thead><tr><th>Name</th><th>Group</th><th>Weight</th><th>Vote</th><th>Subs</th><th>Set weight / remove</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">No votes yet.</td></tr>`}</tbody>`;
  $("voters-table").querySelectorAll("button[data-w]").forEach((b) =>
    b.addEventListener("click", () => setVoteWeight(poll.id, b.dataset.id, parseFloat(b.dataset.w)).then(() => toast("Weight updated"))));
  $("voters-table").querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", () => { if (confirm("Remove this vote?")) clearVote(poll.id, b.dataset.del); }));
}

function exportCsv() {
  const d = ensureDisplay();
  if (!d) { toast("No motion selected."); return; }
  const poll = d.poll, list = d.votes || [];
  const t = tally(list);
  const header = ["Name", "Group", "Weight", "Vote", "Submissions", "Flagged", "WriteIn"];
  const lines = [header.join(",")];
  [...list].sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => {
    lines.push([
      csv(v.name), v.isWriteIn ? "write-in" : groupLabel(v.group), effectiveWeight(v),
      v.choice, v.submissionCount || 1, v.flagged ? "YES" : "", v.isWriteIn ? "YES" : "",
    ].join(","));
  });
  lines.push("");
  lines.push(csv("MOTION:") + "," + csv(poll.text));
  lines.push(`In favour (pts),${t.weight.favour}`);
  lines.push(`Against (pts),${t.weight.against}`);
  lines.push(`Abstain (pts),${t.weight.abstain}`);
  lines.push(`Quorum,${t.quorumCount} of ${QUORUM_THRESHOLD}`);
  lines.push(`Result,${t.quorumCount < QUORUM_THRESHOLD ? "NO QUORUM" : (t.weight.favour > t.weight.against ? "PASSES" : "DOES NOT PASS")}`);
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "motion-result.csv";
  a.click();
}

// ----------------------------------------------------------------- utils
function groupLabel(g){return g==="1"?"Group 1 (1)":g==="2"?"Group 2 (½)":g==="courtesy"?"Courtesy (0)":g;}
function labelOf(c){return c==="favour"?"In favour":c==="against"?"Against":c==="abstain"?"Abstain":c;}
function fmt(n){return Number.isInteger(n)?n:Number(n).toFixed(1);}
function csv(s){return `"${String(s).replace(/"/g,'""')}"`;}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
let toastT;
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.remove("hide");clearTimeout(toastT);toastT=setTimeout(()=>el.classList.add("hide"),2200);}
