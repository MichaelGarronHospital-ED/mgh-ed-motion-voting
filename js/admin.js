import { ADMIN_PASSCODE, ORG_NAME } from "./config.js";
import { ROSTER, ROSTER_BY_SLUG, WEIGHTS } from "./roster.js";
import {
  onPolls, onVotesFor, addPoll, updatePoll, deletePoll, openPoll, closePoll,
  clearVote, tally, setArchived, weightForVote, groupForVote,
  onRosterOverrides, setPersonGroup, resolvedRoster, effectiveGroup,
  eligibleCount, quorumThreshold,
  watchAuth, leaderSignIn, leaderSignOut, LEADER_EMAIL,
} from "./db.js";

const $ = (id) => document.getElementById(id);
document.title = ORG_NAME + " — Leadership";

// ----------------------------------------------------------------- gate
let booted = false;
function unlock() {
  $("gate").classList.add("hide");
  $("console").classList.remove("hide");
  if (!booted) { booted = true; boot(); }
}
$("enter").addEventListener("click", tryEnter);
$("pass").addEventListener("keydown", (e) => { if (e.key === "Enter") tryEnter(); });
async function tryEnter() {
  if ($("pass").value !== ADMIN_PASSCODE) { $("gate-err").classList.remove("hide"); return; }
  // Sign in as leadership for write access under locked rules. If the Firebase
  // auth user / provider isn't set up yet, we still open the console (writes
  // work because the rules are still open).
  try { await leaderSignIn($("pass").value); }
  catch (e) { console.warn("leader auth not active (open-rules mode):", e && e.code); }
  unlock();
}
// Auto-unlock on reload if a leadership session is already persisted.
watchAuth((user) => { if (user && user.email === LEADER_EMAIL) unlock(); });
$("lock").addEventListener("click", (e) => { e.preventDefault(); leaderSignOut().finally(() => location.reload()); });

// ----------------------------------------------------------------- tabs
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    ["share", "motions", "results", "voters", "roster"].forEach((name) =>
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
  const url = location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html";
  $("vote-url").value = url;
  $("copy-url").addEventListener("click", () => { navigator.clipboard.writeText(url); toast("Link copied"); });
  $("roster-summary").textContent =
    `${ROSTER.length} listed physicians · ${eligibleCount(null)} currently eligible · quorum = ${quorumThreshold(null)} (50% of eligible).`;

  $("add-motion").addEventListener("click", async () => {
    const text = $("new-motion").value.trim();
    if (text.length < 3) { toast("Type the motion first."); return; }
    await addPoll(text);
    $("new-motion").value = "";
    toast("Motion added");
  });
  $("export").addEventListener("click", exportCsv);

  // ---- roster summary (editable, persisted in Firestore) ----
  $("roster-filter").addEventListener("input", (e) => { rosterFilter = e.target.value; renderRosterTab(); });
  $("export-roster").addEventListener("click", exportRoster);
  // category changes re-weight everything live
  onRosterOverrides(() => { renderRosterTab(); renderResults(); renderVoters(); });
  renderRosterTab();

  onPolls((p) => {
    polls = p;
    const open = polls.find((x) => x.status === "open") || null;
    const changed = (activePoll && activePoll.id) !== (open && open.id);
    activePoll = open;
    if (changed) {
      if (votesUnsub) { votesUnsub(); votesUnsub = null; }
      activeVotes = [];
      if (activePoll) votesUnsub = onVotesFor(activePoll.id, (vs) => { activeVotes = vs; collectWriteins(vs); renderResults(); renderVoters(); });
    }
    renderMotions();
    renderResults();
    renderVoters();
  });
}

// ----------------------------------------------------------------- motions
function renderMotions() {
  const el = $("motion-list");
  const active = polls.filter((p) => !p.archived);
  const archived = polls.filter((p) => p.archived);
  let html = active.length ? active.map(motionRow).join("")
    : `<p class="muted">No motions yet. Add Friday's motions above.</p>`;
  if (archived.length) {
    html += `<h2 style="margin:22px 0 8px;">Archived <span class="muted">(${archived.length})</span></h2>
      <p class="sub">Kept for reference, hidden from voters. Unarchive to view full results again.</p>`;
    html += archived.map(archivedRow).join("");
  }
  el.innerHTML = html;
  el.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => motionAction(b.dataset.act, b.dataset.id)));
}

function motionRow(p) {
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
      ${p.status !== "open" ? `<button class="btn ghost small" data-act="archive" data-id="${p.id}">Archive</button>` : ""}
      ${!locked ? `<button class="btn ghost small" data-act="del" data-id="${p.id}">Delete</button>` : ""}
    </div>
  </div>`;
}

function archivedRow(p) {
  return `<div class="poll-item">
    <div class="text"><span class="pill draft">ARCHIVED</span> ${escapeHtml(p.text)}</div>
    <div class="row">
      <button class="btn ghost small" data-act="unarchive" data-id="${p.id}">Unarchive</button>
      <button class="btn ghost small" data-act="del" data-id="${p.id}">Delete</button>
    </div>
  </div>`;
}

async function motionAction(act, id) {
  if (act === "open") {
    if (polls.some((p) => p.status === "open" && p.id !== id))
      if (!confirm("This will close the currently open motion. Continue?")) return;
    await openPoll(id);
    toast("Motion opened — voters can now vote.");
  } else if (act === "close") {
    await closePoll(id); toast("Motion closed.");
  } else if (act === "archive") {
    await setArchived(id, true); toast("Motion archived.");
  } else if (act === "unarchive") {
    await setArchived(id, false); toast("Motion unarchived.");
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
  const poll = activePoll || [...polls].reverse().find((p) => p.status === "closed" && !p.archived) || null;
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
    displayUnsub = onVotesFor(poll.id, (vs) => { displayVotes = vs; collectWriteins(vs); renderResults(); renderVoters(); });
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
  const t = tally(votes, poll);
  const quorum = quorumThreshold(poll);
  const quorumMet = t.quorumCount >= quorum;
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
      <div class="spread"><span>Quorum${poll.status === "closed" ? " 🔒" : ""}</span>
        <span class="${quorumMet ? "quorum-ok" : "quorum-bad"}">${t.quorumCount} / ${quorum} ${quorumMet ? "✅ met" : "❌ NOT met"}</span></div>
      <div class="bar-track" style="margin-top:6px;"><div class="bar-fill favour" style="width:${Math.min(100,(t.quorumCount/quorum)*100)}%"></div></div>
      ${!quorumMet ? `<p class="sub" style="color:#fca5a5;margin:8px 0 0;">Need ${quorum - t.quorumCount} more eligible voter(s) before this motion can be decided.</p>` : ""}
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
  // Detect one device (session) used to vote under MORE THAN ONE name.
  const sessionToSlugs = {};
  votes.forEach((v) => (v.sessionIds || []).forEach((s) => {
    (sessionToSlugs[s] = sessionToSlugs[s] || new Set()).add(v.slug);
  }));
  const sharedDevice = new Set();
  Object.values(sessionToSlugs).forEach((set) => { if (set.size > 1) set.forEach((slug) => sharedDevice.add(slug)); });
  const reviewCount = votes.filter((v) => v.flagged || sharedDevice.has(v.slug)).length;

  $("voters-note").innerHTML = `Motion: <em>${escapeHtml(poll.text)}</em> · ${votes.length} ballots · ${reviewCount} to review.
    ${poll.status === "closed" ? "Weights are 🔒 frozen as of when this motion closed." : "Set categories/weights on the <strong>Physician Summary</strong> tab."}
    Flags: same name from 2+ devices, or one device used for multiple names. <em>Submissions</em> = times the person voted/changed (counts once).`;
  const frozen = poll.status === "closed";
  const sorted = [...votes].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((v) => {
    const ew = weightForVote(v, poll);
    const g = v.isWriteIn ? "write-in" : groupLabel(groupForVote(v, poll));
    const shared = sharedDevice.has(v.slug);
    return `<tr class="${v.flagged || shared ? "flagged" : ""}">
      <td>${escapeHtml(v.name)} ${v.flagged ? '<span class="pill flag">REVIEW</span>' : ""}${shared ? '<span class="pill flag">SHARED DEVICE</span>' : ""}${v.isWriteIn ? '<span class="pill draft">NEW</span>' : ""}</td>
      <td>${g}</td>
      <td>${fmt(ew)}</td>
      <td>${labelOf(v.choice)}</td>
      <td>${v.submissionCount || 1}</td>
      <td><button class="btn ghost small" data-del="${v.id}">Remove</button></td>
    </tr>`;
  }).join("");
  $("voters-table").innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th>Weight${frozen ? " 🔒" : ""}</th><th>Vote</th><th>Submissions</th><th>Remove</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">No votes yet.</td></tr>`}</tbody>`;
  $("voters-table").querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", () => { if (confirm("Remove this vote? This changes the result for this motion.")) clearVote(poll.id, b.dataset.del); }));
}

function exportCsv() {
  const d = ensureDisplay();
  if (!d) { toast("No motion selected."); return; }
  const poll = d.poll, list = d.votes || [];
  const t = tally(list, poll);
  const header = ["Name", "Category", "Weight", "Vote", "Submissions", "Flagged", "WriteIn"];
  const lines = [header.join(",")];
  [...list].sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => {
    lines.push([
      csv(v.name), v.isWriteIn ? "write-in" : groupLabel(groupForVote(v, poll)), weightForVote(v, poll),
      v.choice, v.submissionCount || 1, v.flagged ? "YES" : "", v.isWriteIn ? "YES" : "",
    ].join(","));
  });
  lines.push("");
  lines.push(csv("MOTION:") + "," + csv(poll.text));
  lines.push(`In favour (pts),${t.weight.favour}`);
  lines.push(`Against (pts),${t.weight.against}`);
  lines.push(`Abstain (pts),${t.weight.abstain}`);
  const quorum = quorumThreshold(poll);
  lines.push(`Quorum,${t.quorumCount} of ${quorum}`);
  lines.push(`Result,${t.quorumCount < quorum ? "NO QUORUM" : (t.weight.favour > t.weight.against ? "PASSES" : "DOES NOT PASS")}`);
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "motion-result.csv";
  a.click();
}

// ----------------------------------------------------------------- roster summary
let rosterFilter = "";
const knownWriteins = {};   // slug -> name, gathered from ballots seen this session
function collectWriteins(votes) {
  let changed = false;
  votes.forEach((v) => { if (v.isWriteIn && !(v.slug in knownWriteins)) { knownWriteins[v.slug] = v.name; changed = true; } });
  if (changed) renderRosterTab();
}
function renderRosterTab() {
  // base roster (with current category overrides) + any write-ins who've voted,
  // so leadership can grant them a category too.
  const writeins = Object.keys(knownWriteins)
    .filter((slug) => !ROSTER_BY_SLUG[slug])
    .map((slug) => { const g = effectiveGroup(slug); return { name: knownWriteins[slug], slug, group: g, weight: WEIGHTS[g] !== undefined ? WEIGHTS[g] : 0, isWriteIn: true }; });
  const roster = resolvedRoster().concat(writeins);
  const g1 = roster.filter((p) => p.group === "1").length;
  const g2 = roster.filter((p) => p.group === "2").length;
  const cy = roster.filter((p) => p.group === "courtesy").length;
  $("roster-counts").innerHTML =
    `Full vote: <strong>${g1}</strong> &nbsp;·&nbsp; Half vote: <strong>${g2}</strong> &nbsp;·&nbsp; No vote: <strong>${cy}</strong> &nbsp;·&nbsp; Eligible: <strong>${eligibleCount(null)}</strong> &nbsp;·&nbsp; Quorum: <strong>${quorumThreshold(null)}</strong>`;

  const f = rosterFilter.trim().toLowerCase();
  const list = roster.filter((p) => p.name.toLowerCase().includes(f)).sort((a, b) => a.name.localeCompare(b.name));
  const rows = list.map((p) => {
    const btn = (g, l) => `<button class="btn ghost small ${p.group === g ? "selected" : ""}" data-setgrp="${g}" data-slug="${p.slug}">${l}</button>`;
    return `<tr>
      <td>${escapeHtml(p.name)}${p.isWriteIn ? ' <span class="pill draft">NEW</span>' : ""}</td>
      <td>${catLabel(p.group)}</td>
      <td>${fmt(p.weight)}</td>
      <td>${btn("1", "Full")}${btn("2", "Half")}${btn("courtesy", "No vote")}</td>
    </tr>`;
  }).join("");
  $("roster-table").innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th>Pts</th><th>Set category</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">No match.</td></tr>`}</tbody>`;
  $("roster-table").querySelectorAll("button[data-setgrp]").forEach((b) =>
    b.addEventListener("click", () => setPersonGroup(b.dataset.slug, b.dataset.setgrp).then(() => toast("Category updated."))));
}
function exportRoster() {
  const lines = ["Name,Category,Points per vote"];
  resolvedRoster().forEach((p) => lines.push([csv(p.name), catLabel(p.group), p.weight].join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "physician-roster.csv";
  a.click();
}

// ----------------------------------------------------------------- utils
function catLabel(g){return g==="1"?"Full vote":g==="2"?"Half vote":g==="courtesy"?"No vote":"— (uncategorized)";}
function groupLabel(g){return catLabel(g);}   // same short labels in the Voters table / CSV
function labelOf(c){return c==="favour"?"In favour":c==="against"?"Against":c==="abstain"?"Abstain":c;}
function fmt(n){return Number.isInteger(n)?n:Number(n).toFixed(1);}
function csv(s){return `"${String(s).replace(/"/g,'""')}"`;}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
let toastT;
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.remove("hide");clearTimeout(toastT);toastT=setTimeout(()=>el.classList.add("hide"),2200);}
