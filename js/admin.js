import { ORG_NAME } from "./config.js";
import { ROSTER, ROSTER_BY_SLUG, WEIGHTS } from "./roster.js";
import {
  onPolls, onVotesFor, addPoll, updatePoll, trashPoll, restorePoll, purgePoll, openPoll, closePoll,
  clearVote, tally, setArchived, weightForVote, groupForVote, getVotesFor,
  onRosterOverrides, setPersonGroup, resolvedRoster, effectiveGroup,
  eligibleCount, quorumThreshold,
  watchAuth, leaderSignIn, leaderSignOut, LEADER_EMAIL, isWrongPassword,
} from "./db.js";
import { escapeHtml, labelOf, fmt, csv, toast, icon, verdictHTML, stackedBar } from "./util.js";
import { buildXlsx, XLSX_MIME } from "./xlsx.js";

const $ = (id) => document.getElementById(id);
document.title = ORG_NAME + " · Leadership";

// ----------------------------------------------------------------- gate
let booted = false;
function unlock() {
  $("gate").classList.add("hide");
  $("console").classList.remove("hide");
  if (!booted) { booted = true; boot(); }
  updateTabHint();
}
// A real form: Enter in the field and a tap on Continue both submit it.
$("gate-form").addEventListener("submit", (e) => { e.preventDefault(); tryEnter(); });
// The Leadership password is checked by Firebase itself (it is the password of
// the LEADER_EMAIL account); nothing about it is stored in this public code, and
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
// Auto-unlock on reload if a leadership session is already persisted.
watchAuth((user) => { if (user && user.email === LEADER_EMAIL) unlock(); });
$("lock").addEventListener("click", (e) => { e.preventDefault(); leaderSignOut().finally(() => location.reload()); });

// ----------------------------------------------------------------- tabs
function showTab(name) {
  document.querySelectorAll(".tab").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    x.setAttribute("aria-pressed", String(x.dataset.tab === name));
  });
  ["share", "motions", "results", "voters", "roster"].forEach((n) =>
    $("tab-" + n).classList.toggle("hide", n !== name));
}
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

// ----------------------------------------------------------------- state
let polls = [];
let activePoll = null;
let activeVotes = [];
let activeLoaded = false;   // has the open motion's first ballot snapshot arrived?
let votesUnsub = null;
let editingId = null;       // motion currently being edited (only allowed before first vote)
let selectedPollId = null;  // Results/Voters: which motion to view (null = current/open)
let activeExpanded = true;     // active Motions card starts open
let archivedExpanded = false;  // Archived + Trash cards are collapsed by default
let trashExpanded = false;

function boot() {
  // share tab
  const url = location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html";
  $("vote-url").textContent = url;
  $("copy-url").addEventListener("click", () => { navigator.clipboard.writeText(url); toast("Link copied."); });
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
  $("export-all").addEventListener("click", () => { closeMenu(); exportAll(); });
  $("print-all").addEventListener("click", () => { closeMenu(); printAll(); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#export-menu")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  // category changes re-weight everything live
  onRosterOverrides(() => { renderRosterTab(); renderResults(); renderVoters(); });
  renderRosterTab();

  onPolls((p) => {
    polls = p;
    // Same filter the voter page uses (js/vote.js): an archived motion is
    // hidden from voters, so leadership must not treat one as the live motion.
    const open = polls.find((x) => x.status === "open" && !x.archived && !x.deleted) || null;
    const changed = (activePoll && activePoll.id) !== (open && open.id);
    activePoll = open;
    if (changed) {
      if (votesUnsub) { votesUnsub(); votesUnsub = null; }
      activeVotes = []; activeLoaded = false;
      if (activePoll) votesUnsub = onVotesFor(activePoll.id, (vs) => { activeVotes = vs; activeLoaded = true; collectWriteins(vs); renderResults(); renderVoters(); });
    }
    renderMotions();
    renderResults();
    renderVoters();
  });
}

// ----------------------------------------------------------------- motions
function renderMotions() {
  const el = $("motion-list");
  const active = polls.filter((p) => !p.archived && !p.deleted);
  const archived = polls.filter((p) => p.archived && !p.deleted);
  const trashed = polls.filter((p) => p.deleted);
  let html = collapsibleCard("active", "", "Motions", active.length, activeExpanded, "",
    active.length ? active.map(motionRow).join("") : `<p class="ed-hint">No motions yet. Add one above.</p>`);
  if (archived.length) {
    html += collapsibleCard("arch", "folder", "Archived", archived.length, archivedExpanded,
      "Kept for reference, hidden from voters. Unarchive to see full results again.",
      archived.map(archivedRow).join(""));
  }
  if (trashed.length) {
    html += collapsibleCard("trash", "trash", "Trash", trashed.length, trashExpanded,
      "Hidden from voters. Restore a motion, or delete it permanently.",
      trashed.map(trashedRow).join(""));
  }
  el.innerHTML = html;
  el.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => motionAction(b.dataset.act, b.dataset.id)));
  const xh = $("active-header"); if (xh) xh.addEventListener("click", () => { activeExpanded = !activeExpanded; renderMotions(); });
  const ah = $("arch-header"); if (ah) ah.addEventListener("click", () => { archivedExpanded = !archivedExpanded; renderMotions(); });
  const th = $("trash-header"); if (th) th.addEventListener("click", () => { trashExpanded = !trashExpanded; renderMotions(); });
}

// A collapsible card. The header is a real button (keyboard and screen-reader
// reachable) that says whether it is open; it expands to an optional hint + rows.
function collapsibleCard(id, ic, title, count, expanded, blurb, rowsHtml) {
  return `<section class="card group">
    <h2 class="group-head"><button type="button" class="disclosure" id="${id}-header" aria-expanded="${expanded}" aria-controls="${id}-body">
      ${ic ? icon(ic, 20) : ""}<span class="t">${title}</span><span class="count">${count}</span>${icon("chevron", 20)}
    </button></h2>
    ${expanded ? `<div class="group-body" id="${id}-body">${blurb ? `<p class="ed-hint">${blurb}</p>` : ""}${rowsHtml}</div>` : ""}
  </section>`;
}
const STATUS_PILL = { open: "ed-pill-good", closed: "ed-pill-quiet", draft: "ed-pill-info" };
const STATUS_WORD = { open: "Open", closed: "Closed", draft: "Draft" };
function statusPill(status) {
  return `<span class="ed-pill ${STATUS_PILL[status] || "ed-pill-quiet"}">${status === "open" ? '<span class="dot"></span>' : ""}${STATUS_WORD[status] || escapeHtml(status)}</span>`;
}

function motionRow(p) {
  const locked = (p.voteCount || 0) > 0;        // editing allowed only before the first vote
  const canDelete = p.status !== "open" || !locked;  // closed/draft deletable; an OPEN motion only before its first vote
  if (editingId === p.id) {
    return `<div class="poll-item editing">
      <label class="ed-label">Motion wording
        <textarea class="ed-field" data-edit="${escapeHtml(p.id)}" rows="3">${escapeHtml(p.text)}</textarea>
      </label>
      <div class="row"><button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="save" data-id="${escapeHtml(p.id)}">Save</button>
        <button type="button" class="ed-btn ed-btn-plain btn-sm" data-act="cancel" data-id="${escapeHtml(p.id)}">Cancel</button></div></div>`;
  }
  return `<div class="poll-item">
    <div class="text"><div class="meta">${statusPill(p.status)}${locked ? `<span class="locknote">${icon("lock", 16)}Locked: voting started</span>` : ""}</div>
      <p>${escapeHtml(p.text)}</p></div>
    <div class="row">
      ${p.status !== "open"
        ? `<button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="open" data-id="${escapeHtml(p.id)}">Open</button>`
        : `<button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="close" data-id="${escapeHtml(p.id)}">Close</button>`}
      ${p.status === "open" ? `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="goto-results" data-id="${escapeHtml(p.id)}">Live results</button>` : ""}
      ${!locked ? `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="edit" data-id="${escapeHtml(p.id)}">Edit</button>` : ""}
      ${p.status !== "open" ? `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="archive" data-id="${escapeHtml(p.id)}">Archive</button>` : ""}
      ${canDelete ? `<button type="button" class="ed-btn btn-quiet btn-sm" data-act="del" data-id="${escapeHtml(p.id)}">Delete</button>` : ""}
    </div>
  </div>`;
}

function archivedRow(p) {
  return `<div class="poll-item">
    <div class="text"><div class="meta"><span class="ed-pill ed-pill-quiet">Archived</span></div><p>${escapeHtml(p.text)}</p></div>
    <div class="row">
      <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="unarchive" data-id="${escapeHtml(p.id)}">Unarchive</button>
    </div>
  </div>`;
}
function trashedRow(p) {
  return `<div class="poll-item">
    <div class="text"><div class="meta"><span class="ed-pill ed-pill-quiet">In trash</span></div><p>${escapeHtml(p.text)}</p></div>
    <div class="row">
      <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="restore" data-id="${escapeHtml(p.id)}">Restore</button>
      <button type="button" class="ed-btn ed-btn-danger btn-sm" data-act="purge" data-id="${escapeHtml(p.id)}">Delete permanently</button>
    </div>
  </div>`;
}

async function motionAction(act, id) {
  if (act === "open") {
    if (polls.some((p) => p.status === "open" && p.id !== id))
      if (!confirm("This will close the currently open motion. Continue?")) return;
    await openPoll(id);
    toast("Motion opened. Voters can vote now.");
  } else if (act === "close") {
    await closePoll(id); toast("Motion closed.");
  } else if (act === "goto-results") {
    selectedPollId = null;          // follow the live/open motion
    showTab("results"); renderResults(); renderVoters();
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
    if ((poll.voteCount || 0) > 0) { toast("Locked: voting has started."); editingId = null; renderMotions(); return; }
    const ta = document.querySelector(`textarea[data-edit="${id}"]`);
    const text = ta.value.trim();
    if (text.length < 3) { toast("Motion text too short."); return; }
    await updatePoll(id, { text });
    editingId = null; toast("Motion updated.");
  } else if (act === "del") {
    if (confirm("Move this motion to Trash? It's hidden from voters but you can restore it from the Trash section below.")) {
      await trashPoll(id); toast("Moved to Trash.");
    }
  } else if (act === "restore") {
    await restorePoll(id); toast("Motion restored.");
  } else if (act === "purge") {
    const poll = polls.find((p) => p.id === id);
    const n = poll && poll.voteCount ? poll.voteCount : 0;
    if (confirm(`Permanently delete this motion${n ? ` and its ${n} recorded vote(s)` : ""}? This cannot be undone.`)) {
      await purgePoll(id); toast("Permanently deleted.");
    }
  }
}

// ----------------------------------------------------------------- results
// Which motion the Results/Voters tabs show: an explicit selection, else the
// open motion, else the most recent (non-archived, non-deleted) closed one.
function displayPoll() {
  if (selectedPollId) {
    const p = polls.find((x) => x.id === selectedPollId);
    if (p && !p.deleted) return p;
  }
  return activePoll || [...polls].reverse().find((p) => p.status === "closed" && !p.archived && !p.deleted) || null;
}
function motionSelectorHTML() {
  const choosable = polls.filter((p) => !p.deleted);
  if (!choosable.length) return "";
  const opts = [`<option value="">Current motion (auto)</option>`].concat(
    choosable.map((p) => {
      const tag = p.archived ? "Archived" : STATUS_WORD[p.status] || escapeHtml(p.status);
      const short = p.text.length > 60 ? p.text.slice(0, 60) + "…" : p.text;
      return `<option value="${escapeHtml(p.id)}" ${p.id === selectedPollId ? "selected" : ""}>${tag} · ${escapeHtml(short)}</option>`;
    })).join("");
  return `<label class="ed-label">View motion
    <select class="ed-field motion-select">${opts}</select></label>`;
}
function wireMotionSelect(scope) {
  const s = scope.querySelector(".motion-select");
  if (s) s.addEventListener("change", () => { selectedPollId = s.value || null; renderResults(); renderVoters(); });
}

let displayUnsub = null, displayId = null, displayVotes = [], displayLoaded = false;
function ensureDisplay() {
  const poll = displayPoll();
  if (!poll) {
    if (displayUnsub) { displayUnsub(); displayUnsub = null; }
    displayId = null; displayVotes = []; displayLoaded = false;
    return null;
  }
  if (activePoll && poll.id === activePoll.id) {
    if (displayUnsub) { displayUnsub(); displayUnsub = null; displayId = null; displayLoaded = false; }
    return { poll, votes: activeVotes, loaded: activeLoaded };   // reuse the live subscription
  }
  if (poll.id !== displayId) {                          // a closed poll: subscribe once
    if (displayUnsub) displayUnsub();
    displayId = poll.id; displayVotes = []; displayLoaded = false;
    displayUnsub = onVotesFor(poll.id, (vs) => { displayVotes = vs; displayLoaded = true; collectWriteins(vs); renderResults(); renderVoters(); });
  }
  return { poll, votes: displayVotes, loaded: displayLoaded };
}

function renderResults() {
  const sel = $("results-selector");
  sel.innerHTML = motionSelectorHTML() || `<p class="ed-hint">No motions yet.</p>`;
  wireMotionSelect(sel);
  const el = $("results-body");
  const d = ensureDisplay();
  if (!d) { el.innerHTML = `<p class="ed-hint">No motion to show. Open one, or choose a motion above.</p>`; return; }
  paintResults(el, d.poll, d.votes, d.loaded);
}
function paintResults(el, poll, votes, loaded) {
  // An empty tally scores as "No quorum: cannot pass". Shown before the
  // ballots arrive that is a wrong result on a shared screen, so hold off.
  const top = `${statusPill(poll.status)}<h2 class="motion-text">${escapeHtml(poll.text)}</h2>`;
  if (!loaded) {
    el.innerHTML = `${top}<p class="ed-hint">Counting votes…</p>`;
    return;
  }
  const t = tally(votes, poll);
  const quorum = quorumThreshold(poll);
  const quorumMet = t.quorumCount >= quorum;
  const outcome = !quorumMet ? verdictHTML("noq", "No quorum: cannot pass")
    : t.weight.favour > t.weight.against ? verdictHTML("pass", "Passes")
    : t.weight.favour < t.weight.against ? verdictHTML("fail", "Does not pass")
    : verdictHTML("tie", "Tie");
  const need = quorum - t.quorumCount;
  el.innerHTML = `${top}
    ${outcome}
    ${bars(t)}
    <div class="quorum ${quorumMet ? "met" : "short"}">
      <div class="spread"><span class="q-label">Quorum${poll.status === "closed" ? `${icon("lock", 16)}<span class="ed-muted">frozen at close</span>` : ""}</span>
        <span class="q-state">${icon(quorumMet ? "check" : "alert", 18)}${t.quorumCount} of ${quorum} ${quorumMet ? "met" : "not met"}</span></div>
      <div class="bar" aria-hidden="true"><span class="${quorumMet ? "favour" : "short"}" style="width:${quorum > 0 ? Math.min(100, (t.quorumCount / quorum) * 100) : 0}%"></span></div>
      ${!quorumMet ? `<p class="ed-hint">${need} more eligible ${need === 1 ? "voter is" : "voters are"} needed before this motion can be decided.</p>` : ""}
    </div>
    <p class="ed-hint">${t.totalVotes} ${t.totalVotes === 1 ? "ballot" : "ballots"} · ${t.writeIns} write-in${t.writeIns === 1 ? "" : "s"} · ${t.flags} flagged. Passes when weighted In favour beats weighted Against; abstentions count only toward quorum.</p>
    <div class="row">
      ${poll.status === "open"
        ? `<button type="button" class="ed-btn ed-btn-filled" id="r-close">Close voting</button>`
        : `<button type="button" class="ed-btn ed-btn-filled" id="r-open">${poll.status === "draft" ? "Open voting" : "Re-open voting"}</button>`}
    </div>`;
  const c = $("r-close"), o = $("r-open");
  if (c) c.addEventListener("click", () => motionAction("close", poll.id));
  if (o) o.addEventListener("click", () => motionAction("open", poll.id));
}

// One stacked bar plus a legend with the weighted points and head counts.
function bars(t) {
  const row = (key, label) => `<li><i class="sw ${key}"></i><span class="lbl">${label}</span>
      <span class="num"><strong>${fmt(t.weight[key])} pts</strong> · ${t.count[key]} ${t.count[key] === 1 ? "vote" : "votes"}</span></li>`;
  return `${stackedBar(t.weight)}<ul class="tally">${row("favour", "In favour")}${row("against", "Against")}${row("abstain", "Abstain")}</ul>`;
}

// ----------------------------------------------------------------- voters
function renderVoters() {
  const sel = $("voters-selector");
  sel.innerHTML = motionSelectorHTML() || `<p class="ed-hint">No motions yet.</p>`;
  wireMotionSelect(sel);
  const d = ensureDisplay();
  if (!d) {
    $("voters-table").innerHTML = "";
    $("voters-note").textContent = "No motion to show. Choose one above.";
    return;
  }
  if (!d.loaded) {
    $("voters-table").innerHTML = "";
    $("voters-note").textContent = "Loading ballots…";
    return;
  }
  paintVoters(d.poll, d.votes);
}
function paintVoters(poll, votes) {
  // Detect one device (session) used to vote under MORE THAN ONE name.
  const sessionToSlugs = new Map();   // a Map, so a stored id like "__proto__" is just a key
  votes.forEach((v) => (Array.isArray(v.sessionIds) ? v.sessionIds : []).forEach((s) => {
    if (!sessionToSlugs.has(s)) sessionToSlugs.set(s, new Set());
    sessionToSlugs.get(s).add(v.slug);
  }));
  const sharedDevice = new Set();
  sessionToSlugs.forEach((set) => { if (set.size > 1) set.forEach((slug) => sharedDevice.add(slug)); });
  const reviewCount = votes.filter((v) => v.flagged || sharedDevice.has(v.slug)).length;

  // One hint line; what the flags mean sits in the "What the flags mean" fold.
  $("voters-note").textContent = `${votes.length} ${votes.length === 1 ? "ballot" : "ballots"} · ${reviewCount} to review · `
    + (poll.status === "closed" ? "weights frozen when this motion closed" : "set categories under Physicians");
  const frozen = poll.status === "closed";
  const sorted = [...votes].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((v) => {
    const ew = weightForVote(v, poll);
    const g = v.isWriteIn ? "Write-in" : groupLabel(groupForVote(v, poll));
    const shared = sharedDevice.has(v.slug);
    return `<tr class="${v.flagged || shared ? "flagged" : ""}">
      <td class="who">${escapeHtml(v.name)}${v.flagged ? ' <span class="ed-pill ed-pill-warn">Needs review</span>' : ""}${shared ? ' <span class="ed-pill ed-pill-warn">Shared device</span>' : ""}${v.isWriteIn ? ' <span class="ed-pill ed-pill-info">New</span>' : ""}</td>
      <td class="cat">${g}</td>
      <td class="num">${fmt(ew)}</td>
      <td class="choice">${escapeHtml(labelOf(v.choice))}</td>
      <td class="num subs">${(v.flagged || shared) ? escapeHtml(v.submissionCount || 1) : ""}</td>
      <td class="act"><button type="button" class="ed-btn btn-quiet btn-sm" data-del="${escapeHtml(v.id)}" aria-label="Remove ${escapeHtml(v.name)}'s vote">Remove</button></td>
    </tr>`;
  }).join("");
  $("voters-table").innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th class="num">Weight${frozen ? `${icon("lock", 14)}<span class="sr">, frozen</span>` : ""}</th><th>Vote</th><th class="num">Submissions</th><th><span class="sr">Remove</span></th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="ed-muted">No votes yet.</td></tr>`}</tbody>`;
  $("voters-table").querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", () => { if (confirm("Remove this vote? This changes the result for this motion.")) clearVote(poll.id, b.dataset.del); }));
}

function exportCsv() {
  const d = ensureDisplay();
  if (!d) { toast("No motion selected."); return; }
  // Exporting before the ballots land would write a confident, empty, wrong
  // result to a file someone then circulates.
  if (!d.loaded) { toast("Still loading ballots. Try again in a moment."); return; }
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
  const result = t.quorumCount < quorum ? "NO QUORUM"
    : t.weight.favour > t.weight.against ? "PASSES"
    : t.weight.favour < t.weight.against ? "DOES NOT PASS" : "TIE";
  lines.push(`Result,${result}`);
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
    `Full vote <strong>${g1}</strong> · Half vote <strong>${g2}</strong> · No vote <strong>${cy}</strong> · Eligible <strong>${eligibleCount(null)}</strong> · Quorum <strong>${quorumThreshold(null)}</strong>`;

  const f = rosterFilter.trim().toLowerCase();
  const list = roster.filter((p) => p.name.toLowerCase().includes(f)).sort((a, b) => a.name.localeCompare(b.name));
  const rows = list.map((p) => {
    // The category picker is a segmented control: one track, the current one raised.
    const btn = (g, l) => `<button type="button" data-setgrp="${g}" data-slug="${escapeHtml(p.slug)}" aria-pressed="${p.group === g}">${l}</button>`;
    return `<tr>
      <td class="who">${escapeHtml(p.name)}${p.isWriteIn ? ' <span class="ed-pill ed-pill-info">New</span>' : ""}</td>
      <td class="cat">${uiCat(p.group)}</td>
      <td class="num">${fmt(p.weight)}</td>
      <td class="act"><div class="ed-seg cat-seg" role="group" aria-label="Category for ${escapeHtml(p.name)}">${btn("1", "Full")}${btn("2", "Half")}${btn("courtesy", "No vote")}</div></td>
    </tr>`;
  }).join("");
  $("roster-table").innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th class="num">Points</th><th>Set category</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="ed-muted">No match.</td></tr>`}</tbody>`;
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

// ----------------------------------------------------------------- records (export + print)
// A meeting's votes live only in Firestore, so leadership needs a copy it keeps:
// every motion with its result, every named ballot, and the roster, in one Excel
// file; or the results on paper / as a PDF. Ballots are read fresh for every
// motion (not just the one on screen), so the file is complete.
function closeMenu() { const m = $("export-menu"); if (m) m.open = false; }
const today = () => new Date().toISOString().slice(0, 10);
const statusWord = (p) => p.deleted ? "In trash" : p.status === "open" ? "Open" : p.status === "closed" ? "Closed" : "Draft";

async function gatherRecords() {
  const list = [...polls].sort((a, b) => (a.order || 0) - (b.order || 0));
  const votes = await Promise.all(list.map((p) => getVotesFor(p.id)));
  return list.map((p, i) => {
    const vs = votes[i], t = tally(vs, p), q = quorumThreshold(p);
    const met = t.quorumCount >= q;
    const verdict = !vs.length ? (p.status === "draft" ? "Not yet voted" : "No ballots")
      : !met ? "No quorum"
      : t.weight.favour > t.weight.against ? "Passed" : t.weight.favour < t.weight.against ? "Did not pass" : "Tie";
    const result = p.status === "open" && vs.length ? `${verdict} (voting still open)` : verdict;
    return { n: i + 1, poll: p, votes: vs, t, quorum: q, result };
  });
}

function recordTables(recs) {
  const roster = resolvedRoster();
  const motions = [["#", "Motion", "Status", "Archived", "Result",
    "In favour (pts)", "Against (pts)", "Abstain (pts)", "In favour (votes)", "Against (votes)", "Abstain (votes)",
    "Ballots", "Eligible who voted", "Quorum needed", "Write-ins", "Flagged for review"]];
  const ballots = [["#", "Motion", "Name", "Category", "Weight", "Vote", "Submissions", "Flagged", "Write-in"]];
  recs.forEach((r) => {
    const { poll: p, t } = r;
    motions.push([r.n, p.text, statusWord(p), p.archived ? "Yes" : "", r.result,
      t.weight.favour, t.weight.against, t.weight.abstain, t.count.favour, t.count.against, t.count.abstain,
      t.totalVotes, t.quorumCount, r.quorum, t.writeIns, t.flags]);
    [...r.votes].sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => ballots.push([
      r.n, p.text, v.name, v.isWriteIn ? "Write-in" : groupLabel(groupForVote(v, p)), weightForVote(v, p),
      labelOf(v.choice), v.submissionCount || 1, v.flagged ? "Yes" : "", v.isWriteIn ? "Yes" : ""]));
  });
  const rosterRows = [["Name", "Category", "Points per vote"]];
  [...roster].sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => rosterRows.push([p.name, catLabel(p.group), p.weight]));
  const live = recs.filter((r) => !r.poll.deleted);
  const summary = [["Item", "Value"],
    ["Exported", new Date().toLocaleString()],
    ["Tool", ORG_NAME],
    ["Motions", live.length],
    ["In trash", recs.length - live.length],
    ["Eligible voters (today)", eligibleCount(null)],
    ["Quorum (today)", quorumThreshold(null)],
    ["Full vote", roster.filter((p) => p.group === "1").length],
    ["Half vote", roster.filter((p) => p.group === "2").length],
    ["No vote", roster.filter((p) => p.group === "courtesy").length],
    ["Pass rule", "Weighted In favour must exceed weighted Against; abstentions count toward quorum only. Quorum is half of eligible voters, rounded up; closed motions keep the eligibility they closed with."]];
  return { summary, motions, ballots, roster: rosterRows };
}

async function exportAll() {
  const btn = $("export-menu").querySelector("summary");
  btn.classList.add("busy");
  try {
    const t = recordTables(await gatherRecords());
    const bytes = buildXlsx([
      { name: "Summary", rows: t.summary, widths: [26, 80] },
      { name: "Motions", rows: t.motions }, { name: "Ballots", rows: t.ballots }, { name: "Roster", rows: t.roster },
    ]);
    const blob = new Blob([bytes], { type: XLSX_MIME });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `motion-voting-records-${today()}.xlsx`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    toast("Records downloaded.");
  } catch (e) { console.error(e); toast("Could not export. Check your connection and try again."); }
  finally { btn.classList.remove("busy"); }
}

async function printAll() {
  let recs;
  try { recs = (await gatherRecords()).filter((r) => !r.poll.deleted); }
  catch (e) { console.error(e); toast("Could not load the results. Check your connection and try again."); return; }
  const t = recordTables(recs);
  const blocks = recs.map((r) => {
    const { poll: p, t: tt } = r;
    return `<section class="pr-motion"><h2>${r.n}. ${escapeHtml(p.text)}</h2>
      <p class="pr-line"><b>${escapeHtml(r.result)}</b> &middot; ${escapeHtml(statusWord(p))}${p.archived ? " (archived)" : ""}
        &middot; Quorum ${tt.quorumCount} of ${r.quorum} &middot; ${tt.totalVotes} ballot${tt.totalVotes === 1 ? "" : "s"}</p>
      <table><thead><tr><th>Vote</th><th>Points</th><th>Votes</th></tr></thead><tbody>
        <tr><td>In favour</td><td>${fmt(tt.weight.favour)}</td><td>${tt.count.favour}</td></tr>
        <tr><td>Against</td><td>${fmt(tt.weight.against)}</td><td>${tt.count.against}</td></tr>
        <tr><td>Abstain</td><td>${fmt(tt.weight.abstain)}</td><td>${tt.count.abstain}</td></tr>
      </tbody></table></section>`;
  }).join("");
  let el = document.getElementById("printReport");
  if (!el) { el = document.createElement("div"); el.id = "printReport"; document.body.appendChild(el); }
  el.innerHTML = `<h1>${escapeHtml(ORG_NAME)}: results</h1>
    <p class="pr-sub">Printed ${escapeHtml(new Date().toLocaleString())} &middot; eligible voters today ${eligibleCount(null)}, quorum ${quorumThreshold(null)}</p>
    ${blocks || "<p>No motions yet.</p>"}
    <p class="pr-sub">${escapeHtml(t.summary[t.summary.length - 1][1])} Named ballots are in the Excel export.</p>`;
  document.body.classList.add("printing-report");
  const done = () => { document.body.classList.remove("printing-report"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1000);
}

// ----------------------------------------------------------------- category labels
// catLabel feeds the CSV and Excel records: keep its words exactly as they are.
function catLabel(g){return g==="1"?"Full vote":g==="2"?"Half vote":g==="courtesy"?"No vote":"\u2014 (uncategorized)";}
function uiCat(g){return g==="1"||g==="2"||g==="courtesy"?catLabel(g):"Uncategorized";}   // on screen
function groupLabel(g){return catLabel(g);}   // same short labels in the Voters table / CSV
