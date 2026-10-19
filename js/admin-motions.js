// Admin console: the Motions tab. "Add a motion" (a form that opens inline,
// with "Paste an agenda" inside it), then the selected meeting's agenda
// (numbered 1, 2, 2a, 2a.1; move up and down; amendments; mover, seconder,
// notes), then other meetings and earlier motions (folded), then Archived and
// Trash. Each row shows only the actions needed now; the rest are under More.
import {
  addPoll, addPolls, updatePoll, trashPoll, restorePoll, purgePoll, setArchived, currentSettings, currentMeetings,
  movePoll, moveToMeeting, agendaOrder, parseAgenda, clockTime, localDate, tsMillis,
} from "./db.js?v=voting-14";
import { escapeHtml, toast, icon } from "./util.js?v=voting-14";
import { $, S, R, collapsibleCard, statusPill, meetingLabel, niceDate, iconBtn } from "./admin-state.js?v=voting-14";

let editingId = null;          // motion currently being edited (only allowed before first vote)
let amendingId = null;         // motion getting a new amendment
const expanded = { agenda: true, arch: false, trash: false };   // others: folded unless opened
let pendingFocus = null;       // [act, id] to focus after a redraw (Move up / down)
let addOpen = null;            // the Add form: null = open only when the agenda is empty

export function wireMotions() {
  // Type: Motion, Question or Election.
  $("new-kind").querySelectorAll("button[data-kind]").forEach((b) => b.addEventListener("click", () => {
    newKind = b.dataset.kind;
    $("new-kind").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    syncKind();
  }));
  $("new-seats").addEventListener("input", syncKind);
  $("add-motion").addEventListener("click", async () => {
    const text = $("new-motion").value.trim();
    if (text.length < 3) { toast(newKind === "motion" ? "Type the motion first." : "Type the question first."); return; }
    let choice = null;
    if (newKind !== "motion") {
      const c = readChoice();
      if (c.problem) { toast(c.problem); return; }
      choice = c.value;
    }
    try {
      const meetingId = await R.meetingForNewMotion();
      const threshold = choice ? (choice.seats === 1 ? $("new-winner").value : "plurality") : $("new-threshold").value;
      await addPoll(text, threshold, meetingId, null, choice);
      $("new-motion").value = ""; $("new-options").value = ""; $("new-seats").value = "1";
      toast(choice ? (newKind === "election" ? "Election added" : "Question added") : "Motion added");
    } catch (e) { R.actionFailed(e, "Not allowed: the database refused the new motion."); }
  });
  $("agenda-preview").addEventListener("click", previewAgenda);
  $("add-motion-toggle").addEventListener("click", () => {
    addOpen = $("add-motion-card").classList.contains("hide");
    syncAddForm();
    if (addOpen) $("new-motion").focus();
  });
  $("add-motion-cancel").addEventListener("click", () => { addOpen = false; syncAddForm(); renderMotions(); $("add-motion-toggle").focus(); });
  // A redraw skipped while someone was typing in a row happens when they leave it.
  $("motion-list").addEventListener("focusout", () => setTimeout(() => {
    if (R.motionsStale && !$("motion-list").contains(document.activeElement)) renderMotions();
  }, 0));
  syncDefaultThreshold();
}
let newKind = "motion";
function syncKind() {
  const choice = newKind !== "motion";
  const election = newKind === "election";
  $("choice-fields").classList.toggle("hide", !choice);
  $("new-threshold-wrap").classList.toggle("hide", choice);
  $("new-motion-label").textContent = choice ? (election ? "What the election is for" : "The question") : "Motion wording";
  $("new-options-label").textContent = election ? "Candidates, one per line" : "Options, one per line";
  $("new-seats-label").textContent = election ? "Seats (fewer than the number of candidates)" : "How many can each person pick?";
  $("new-winner-wrap").classList.toggle("hide", Number($("new-seats").value) !== 1);
}
// The options typed for a question or election, checked.
function readChoice() {
  const lines = $("new-options").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seats = Number($("new-seats").value);
  const word = newKind === "election" ? "candidates" : "options";
  if (lines.length < 2 || lines.length > 20) return { problem: `Type 2 to 20 ${word}, one per line.` };
  if (lines.some((l) => l.length > 120)) return { problem: `Each of the ${word} can be up to 120 characters.` };
  if (new Set(lines.map((l) => l.toLowerCase())).size !== lines.length) return { problem: `Two of the ${word} are the same.` };
  if (!Number.isInteger(seats) || seats < 1 || seats > lines.length - 1)
    return { problem: newKind === "election" ? "Seats must be fewer than the number of candidates." : "People must be able to pick at least 1, and fewer than all the options." };
  return { value: { style: newKind === "election" ? "election" : "question", seats, options: lines.map((label, i) => ({ id: `o${i + 1}`, label })) } };
}

// The Add form's pass rule starts at the default from Settings.
let thresholdTouched = false;
export function syncDefaultThreshold() {
  const sel = $("new-threshold");
  if (!sel.dataset.wired) { sel.dataset.wired = "1"; sel.addEventListener("change", () => { thresholdTouched = true; }); }
  if (!thresholdTouched) sel.value = (currentSettings() && currentSettings().threshold) || "majority";
}
R.syncDefaultThreshold = syncDefaultThreshold;
const THRESH_SELECT = (id, v) => `<label class="ed-label">Pass rule
        <select class="ed-field" data-thresh="${id}">
          <option value="majority" ${v !== "twoThirds" ? "selected" : ""}>More points in favour than against</option>
          <option value="twoThirds" ${v === "twoThirds" ? "selected" : ""}>At least two-thirds of the points cast</option>
        </select></label>`;

// Agenda numbers of every motion (per meeting), for the rows and messages.
export function numbers() {
  const out = {};
  const byM = {};
  S.polls.forEach((p) => { if (p.meetingId) (byM[p.meetingId] = byM[p.meetingId] || []).push(p); });
  Object.values(byM).forEach((list) => agendaOrder(list).forEach((r) => { out[r.poll.id] = r; }));
  return out;
}
R.numbers = numbers;

// The Add form is open by default only while the meeting on screen has no motions.
function syncAddForm(empty) {
  if (empty !== undefined) lastEmpty = empty;
  const open = addOpen === null ? lastEmpty : addOpen;
  $("add-motion-card").classList.toggle("hide", !open);
  $("add-motion-toggle").setAttribute("aria-expanded", String(open));
  $("add-motion-toggle").parentElement.classList.toggle("hide", open && addOpen === null);
  // Cancel only when there is a list to go back to.
  $("add-motion-cancel").classList.toggle("hide", addOpen === null);
}
let lastEmpty = true;
let lastSelId;                 // the meeting the Add form's open state belongs to
// The actions a row's More menu offers, to tell whether it changed in a redraw.
const itemsOf = (d) => [...d.querySelectorAll(".menu-item")].map((b) => b.dataset.act).join(",");

export function renderMotions() {
  const el = $("motion-list");
  // Keep what is being typed in a row's details when another device changes something.
  if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) { R.motionsStale = true; return; }
  // A redraw keeps keyboard focus on the same button of the same motion.
  const fa = document.activeElement;
  if (!pendingFocus && fa && el.contains(fa) && fa.dataset && fa.dataset.act && fa.dataset.id) pendingFocus = [fa.dataset.act, fa.dataset.id];
  // An open More menu stays open through the redraw.
  // (closed if its list of actions changed meanwhile), and focus on its button stays.
  const openMore = el.querySelector("details.row-more[open]");
  const keepMore = openMore ? [openMore.dataset.id, itemsOf(openMore)] : null;
  const moreBtn = fa && el.contains(fa) && fa.matches("details.row-more > summary") ? fa.parentElement.dataset.id : null;
  const polls = S.polls;
  const meetings = currentMeetings().filter((m) => !m.deleted);
  const mIds = new Set(meetings.map((m) => m.id));
  const sel = R.selectedMeeting();
  const active = polls.filter((p) => !p.archived && !p.deleted);
  const archived = polls.filter((p) => p.archived && !p.deleted);
  const trashed = polls.filter((p) => p.deleted);
  const nums = numbers();
  let html = "";
  if (sel) {
    const rows = agendaOrder(active.filter((p) => p.meetingId === sel.id));
    html += collapsibleCard("agenda", "", `Agenda<span class="group-sub">${escapeHtml(meetingLabel(sel))}</span>`, rows.length, expanded.agenda, "",
      rows.length ? rows.map((r) => motionRow(r.poll, r)).join("")
        : (sel.id === lastSelId && addOpen === false ? `<p class="ed-hint">No motions yet.</p>` : ""));
  }
  meetings.filter((m) => !sel || m.id !== sel.id).sort((a, b) => (b.date || "").localeCompare(a.date || "")).forEach((m) => {
    const rows = agendaOrder(active.filter((p) => p.meetingId === m.id));
    if (!rows.length) return;
    const key = "m-" + m.id;
    html += collapsibleCard(key, "folder", escapeHtml(meetingLabel(m)), rows.length, !!expanded[key], "", rows.map((r) => motionRow(r.poll, r)).join(""));
  });
  // Motions made before meetings existed (or whose meeting is gone), by the date added.
  const earlier = active.filter((p) => !p.meetingId || !mIds.has(p.meetingId));
  // Before any meeting or motion exists, the Add form above is the whole tab.
  if (earlier.length) {
    const byDate = {};
    earlier.forEach((p) => { const d = localDate(p.createdAt) || ""; (byDate[d] = byDate[d] || []).push(p); });
    const body = earlier.length ? Object.keys(byDate).sort().reverse().map((d) => `${d ? `<h3 class="group-title">Added ${escapeHtml(niceDate(d))}</h3>` : ""}`
      + byDate[d].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)).map((p) => motionRow(p, null)).join("")).join("")
      : `<p class="ed-hint">No motions yet. Add one above.</p>`;
    // Before any meeting exists this is the whole list, so it starts open.
    const open = meetings.length ? !!expanded.earlier : expanded.earlier !== false;
    html += collapsibleCard("earlier", "", meetings.length ? "Earlier motions (before meetings)" : "Motions", earlier.length, open, "", body);
  }
  if (archived.length) {
    html += collapsibleCard("arch", "folder", "Archived", archived.length, expanded.arch,
      "Kept for reference, hidden from voters. Unarchive to see full results again.",
      archived.map(archivedRow).join(""));
  }
  if (trashed.length) {
    html += collapsibleCard("trash", "trash", "Trash", trashed.length, expanded.trash,
      "Hidden from voters. Restore a motion, or delete it permanently.",
      trashed.map(trashedRow).join(""));
  }
  el.innerHTML = html;
  R.motionsStale = false;
  const moreOf = (id) => el.querySelector(`details.row-more[data-id="${CSS.escape(id)}"]`);
  if (keepMore) { const d = moreOf(keepMore[0]); if (d && itemsOf(d) === keepMore[1]) d.open = true; }
  if (moreBtn && moreOf(moreBtn)) moreOf(moreBtn).querySelector("summary").focus();
  // A different meeting on screen: the Add form goes back to "open when its agenda is empty".
  const selId = sel ? sel.id : null;
  if (selId !== lastSelId) { lastSelId = selId; addOpen = null; }
  // Open the Add form by default while this meeting (or, with no meetings, the list) is empty.
  syncAddForm(sel ? !active.some((p) => p.meetingId === sel.id) : !active.length);
  el.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => motionAction(b.dataset.act, b.dataset.id)));
  el.querySelectorAll("button.disclosure").forEach((b) => b.addEventListener("click", () => {
    const key = b.id.replace(/-header$/, "");
    const isOpen = b.getAttribute("aria-expanded") === "true";
    expanded[key] = !isOpen;
    renderMotions();
  }));
  el.querySelectorAll("form[data-details]").forEach((f) => f.addEventListener("submit", (e) => { e.preventDefault(); saveDetails(f); }));
  el.querySelectorAll("form[data-amend]").forEach((f) => f.addEventListener("submit", (e) => { e.preventDefault(); addAmendment(f); }));
  $("agenda-fold").classList.toggle("hide", !sel);
  if (sel) $("agenda-fold").querySelector("summary").textContent = "Paste an agenda instead";
  if (pendingFocus) {
    const [act, id] = pendingFocus;
    pendingFocus = null;
    const b = el.querySelector(`button[data-act="${act}"][data-id="${CSS.escape(id)}"]`) || el.querySelector(`button[data-act="${act === "up" ? "down" : "up"}"][data-id="${CSS.escape(id)}"]`);
    // An item of a menu that closed (its actions changed), or one that is gone: the row's three-dot button.
    const menu = b && b.closest("details.row-more");
    if (b && !(menu && !menu.open)) b.focus();
    else if (menu) menu.querySelector("summary").focus();
    else if (moreOf(id)) moreOf(id).querySelector("summary").focus();
  }
}

function motionRow(p, agenda) {
  // editing allowed only before the first vote, and never once a result is saved
  const locked = (p.voteCount || 0) > 0 || !!p.result;
  const canDelete = p.status !== "open" || !locked;  // closed/draft deletable; an OPEN motion only before its first vote
  const ready = R.canOpenClose();
  // Close waits until the server has confirmed the opening (its time is known).
  const pendingOpen = p.status === "open" && (p._pending || p.openedAt === null);
  const id = escapeHtml(p.id);
  const num = agenda ? agenda.number : "";
  const label = num ? `motion ${num}` : "this motion";
  if (editingId === p.id) {
    return `<div class="poll-item editing">
      <label class="ed-label">Motion wording
        <textarea class="ed-field" data-edit="${id}" rows="3">${escapeHtml(p.text)}</textarea>
      </label>
      ${p.status === "draft" && p.kind !== "choice" ? THRESH_SELECT(id, p.threshold) : ""}
      <div class="row"><button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="save" data-id="${id}">Save</button>
        <button type="button" class="ed-btn ed-btn-plain btn-sm" data-act="cancel" data-id="${id}">Cancel</button></div></div>`;
  }
  const amendPassed = S.polls.some((a) => a.amends === p.id && a.result && a.result.outcome === "pass") && p.status === "draft";
  const times = [p.openedAt && `Opened ${clockTime(p.openedAt)}`, p.status === "closed" && p.closedAt && `closed ${clockTime(p.closedAt)}`].filter(Boolean).join(", ");
  const meetings = currentMeetings().filter((m) => !m.deleted && m.id !== p.meetingId);
  const move = !agenda && !p.amends && meetings.length ? `<span class="row move-to">
      <label class="sr" for="move-${id}">Meeting to move ${escapeHtml(label)} to</label>
      <select class="ed-field btn-sm" id="move-${id}" data-move-target="${id}">${meetings.sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(meetingLabel(m))}</option>`).join("")}</select>
      <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="move-to" data-id="${id}">Move to a meeting</button></span>` : "";
  const order = agenda ? iconBtn("up", `Move ${label} up`, `data-act="up" data-id="${id}"`, "ed-btn-plain", "Move up")
      + iconBtn("down", `Move ${label} down`, `data-act="down" data-id="${id}"`, "ed-btn-plain", "Move down") : "";
  const canAmend = agenda && agenda.depth < 2 && p.status !== "closed";
  const amendForm = amendingId === p.id ? `<form class="card-inset stack-sm" data-amend="${id}">
      <label class="ed-label" for="amend-${id}">Amendment wording (what it changes)
        <textarea class="ed-field" id="amend-${id}" rows="2"></textarea></label>
      <div class="row"><button type="submit" class="ed-btn ed-btn-filled btn-sm">Add amendment</button>
        <button type="button" class="ed-btn ed-btn-plain btn-sm" data-act="amend-cancel" data-id="${id}">Cancel</button></div></form>` : "";
  const details = `<details class="about details-fold"><summary>Details</summary>
      <form class="stack-sm" data-details="${id}">
        <div class="rules-grid two">
          <label class="ed-label">Mover<input class="ed-field" name="mover" type="text" maxlength="200" list="roster-names" value="${escapeHtml(p.mover || "")}" /></label>
          <label class="ed-label">Seconder<input class="ed-field" name="seconder" type="text" maxlength="200" list="roster-names" value="${escapeHtml(p.seconder || "")}" /></label>
        </div>
        <label class="ed-label">Notes<textarea class="ed-field" name="notes" rows="2" maxlength="2000">${escapeHtml(p.notes || "")}</textarea></label>
        ${times ? `<p class="ed-hint">${escapeHtml(times)}</p>` : ""}
        <div><button type="submit" class="ed-btn ed-btn-tinted btn-sm">Save details</button></div>
      </form></details>`;
  // Only what is needed now is on the row; the rest is under More.
  const dis = ready ? "" : "disabled";
  const more = [
    p.status === "open" && !locked ? `<button type="button" class="menu-item" data-act="edit" data-id="${id}">Edit</button>` : "",
    p.status === "closed" ? `<button type="button" class="menu-item" data-act="reopen" data-id="${id}" ${dis}>Re-open</button>` : "",
    p.status === "closed" && p.result && !p.supersededBy ? `<button type="button" class="menu-item" data-act="revote" data-id="${id}" ${dis}>Re-vote</button>` : "",
    canAmend ? `<button type="button" class="menu-item" data-act="amend" data-id="${id}">Add amendment</button>` : "",
    p.status !== "open" ? `<button type="button" class="menu-item" data-act="archive" data-id="${id}">Archive</button>` : "",
    canDelete ? `<button type="button" class="menu-item danger" data-act="del" data-id="${id}">Delete</button>` : "",
  ].filter(Boolean).join("");
  const moreMenu = more ? `<details class="menu row-more" data-id="${id}">
      <summary class="ed-btn ed-btn-plain icon-btn no-caret" aria-label="More actions for ${escapeHtml(label)}" title="More">${icon("more", 18)}</summary>
      <div class="menu-pop">${more}</div></details>` : "";
  const lockWords = p.result ? "Result saved" : "Locked: voting started";
  return `<div class="poll-item depth-${agenda ? agenda.depth : 0}">
    <div class="text"><div class="meta">${num ? `<span class="agenda-num">${escapeHtml(num)}</span>` : ""}${statusPill(p.status)}${p.amends ? '<span class="ed-pill ed-pill-quiet">Amendment</span>' : ""}${p.kind === "choice" ? `<span class="ed-pill ed-pill-quiet">${p.style === "election" ? "Election" : "Question"}</span>` : ""}${(p.threshold || (p.rule && p.rule.threshold)) === "twoThirds" ? '<span class="ed-pill ed-pill-quiet">Two-thirds</span>' : ""}${locked ? `<span class="locknote" title="${lockWords}">${icon("lock", 16)}<span class="sr">${lockWords}</span></span>` : ""}</div>
      <p>${escapeHtml(p.text)}</p>
      ${p.kind === "choice" ? `<p class="ed-hint">${escapeHtml((p.options || []).map((o) => o.label).join(", "))}. ${p.seats > 1 ? `Pick up to ${p.seats}.` : "Pick 1."}${p.seats === 1 && p.threshold === "majority" ? " Winner needs more than half." : ""}</p>` : ""}
      ${amendPassed ? `<p class="ed-hint">An amendment to this motion passed. Edit this motion's wording to include it before opening.</p>` : ""}
      ${details}</div>
    <div class="row acts">
      ${p.status === "draft"
        ? `<button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="open" data-id="${id}" ${dis}>Open</button>`
          + (!locked ? `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="edit" data-id="${id}">Edit</button>` : "")
        : p.status === "open"
        ? `<button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="close" data-id="${id}" ${ready && !pendingOpen ? "" : "disabled"}>Close</button>`
          + `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="goto-results" data-id="${id}">Live results</button>`
        : `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="view-results" data-id="${id}">Results</button>`}
      ${move}<span class="row-end">${order}${moreMenu}</span>
    </div>${amendForm}
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

async function saveDetails(f) {
  const id = f.dataset.details;
  const patch = { mover: f.mover.value.trim().slice(0, 200), seconder: f.seconder.value.trim().slice(0, 200), notes: f.notes.value.slice(0, 2000) };
  const b = f.querySelector("button[type=submit]");
  b.disabled = true;
  try { await updatePoll(id, patch); toast("Details saved."); }
  catch (e) { R.actionFailed(e, "Not allowed: the database refused this change."); }
  finally { b.disabled = false; if (R.motionsStale) renderMotions(); }
}
async function addAmendment(f) {
  const id = f.dataset.amend;
  const text = f.querySelector("textarea").value.trim();
  if (text.length < 3) { toast("Type the amendment first."); return; }
  const parent = S.polls.find((p) => p.id === id);
  try {
    await addPoll(text, parent.threshold, parent.meetingId, id);
    amendingId = null;
    toast("Amendment added.");
    renderMotions();
  } catch (e) { R.actionFailed(e, "Not allowed: the database refused the amendment."); }
}

export async function motionAction(act, id) {
  const polls = S.polls;
  const nums = numbers();
  if (act === "open") {
    await R.openFlow(id);
  } else if (act === "close") {
    await R.closeFlow(id);
  } else if (act === "reopen") {
    // Re-open needs a reason: the form is on the Results tab.
    S.selectedPollId = id; S.reopenFor = id;
    R.showTab("results"); R.results(); R.voters();
    const r = $("reopen-reason"); if (r) r.focus();
  } else if (act === "revote") {
    // Same as on the Results tab: closed, result saved, not yet replaced.
    S.selectedPollId = id; S.revoteFor = id; S.reopenFor = null;
    R.showTab("results"); R.results(); R.voters();
    const r = $("revote-reason"); if (r) r.focus();
  } else if (act === "view-results") {
    S.selectedPollId = id; S.reopenFor = null; S.revoteFor = null;
    R.showTab("results"); R.results(); R.voters();
  } else if (act === "goto-results") {
    S.selectedPollId = null;          // follow the live/open motion
    R.showTab("results"); R.results(); R.voters();
  } else if (act === "up" || act === "down") {
    pendingFocus = [act, id];
    try { if (!(await movePoll(id, act))) { toast(act === "up" ? "Already first." : "Already last."); renderMotions(); } }
    catch (e) { pendingFocus = null; R.actionFailed(e, "Not allowed: the database refused this change."); }
  } else if (act === "amend") {
    const r = nums[id];
    if (r && r.depth >= 2) { toast("Vote on this amendment first."); return; }
    amendingId = amendingId === id ? null : id; renderMotions();
    const t = document.getElementById("amend-" + id); if (t) t.focus();
  } else if (act === "amend-cancel") {
    amendingId = null; renderMotions();
  } else if (act === "move-to") {
    const sel = document.querySelector(`select[data-move-target="${CSS.escape(id)}"]`);
    if (!sel) return;
    const m = currentMeetings().find((x) => x.id === sel.value);
    if (!m) return;
    await guard(moveToMeeting(id, m.id), `Moved to ${meetingLabel(m)}.`);
  } else if (act === "archive") {
    await guard(setArchived(id, true), "Motion archived.");
  } else if (act === "unarchive") {
    await guard(setArchived(id, false), "Motion unarchived.");
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
    const patch = { text };
    const th = document.querySelector(`select[data-thresh="${id}"]`);
    if (th && poll.status === "draft") patch.threshold = th.value;
    if (await guard(updatePoll(id, patch), "Motion updated.", "Not allowed: voting has started, so the wording is locked.")) { editingId = null; renderMotions(); }
  } else if (act === "del") {
    const kids = polls.filter((p) => !p.deleted && p.amends === id);
    if (!confirm("Move this motion to Trash? It's hidden from voters but you can restore it from the Trash section below.")) return;
    const withKids = kids.length && confirm(`Also move its ${kids.length} amendment${kids.length === 1 ? "" : "s"} to Trash?`);
    if (await guard(trashPoll(id), "Moved to Trash.") && withKids) {
      for (const k of kids) await guard(trashPoll(k.id), "Moved to Trash.");
    }
  } else if (act === "restore") {
    await guard(restorePoll(id), "Motion restored.");
  } else if (act === "purge") {
    const poll = polls.find((p) => p.id === id);
    const n = poll && poll.voteCount ? poll.voteCount : 0;
    if (confirm(`Permanently delete this motion${n ? ` and its ${n} recorded vote(s)` : ""}? This cannot be undone.`)) {
      await guard(purgePoll(id), "Permanently deleted.", "Not allowed: only a motion in the Trash can be deleted permanently.");
    }
  }
}

// ---- paste an agenda ------------------------------------------------------------
let agendaRows = null;
function previewAgenda() {
  const m = R.selectedMeeting();
  const { rows, tooMany } = parseAgenda($("agenda-text").value);
  agendaRows = rows;
  const good = rows.filter((r) => !r.problem);
  $("agenda-result").innerHTML = (tooMany ? `<p class="notice">Only the first 50 lines are read.</p>` : "")
    + `<ul class="plain-list agenda-preview">${rows.map((r) => `<li class="depth-${r.depth}">${r.problem ? `<span class="ed-pill ed-pill-warn">${escapeHtml(r.problem)}</span> ` : `<span class="agenda-num">${escapeHtml(r.number)}</span> `}${escapeHtml(r.text)}</li>`).join("") || `<li class="ed-muted">Nothing to add.</li>`}</ul>`
    + `<div class="row"><button type="button" id="agenda-add" class="ed-btn ed-btn-filled btn-sm" ${good.length && m ? "" : "disabled"}>Add ${good.length} motion${good.length === 1 ? "" : "s"} to ${escapeHtml(m ? meetingLabel(m) : "the meeting")}</button>
      ${rows.length > good.length ? `<span class="ed-hint">Lines with a problem are left out, with anything that amends them.</span>` : ""}</div>`;
  $("agenda-add").addEventListener("click", addAgenda);
}
async function addAgenda() {
  const m = R.selectedMeeting();
  if (!m || !agendaRows) return;
  // Keep only good rows whose parents are also kept; re-point parents.
  const keep = [];
  const map = {};
  agendaRows.forEach((r, i) => {
    if (r.problem) return;
    if (r.parent !== null && map[r.parent] === undefined) return;
    map[i] = keep.length;
    keep.push({ text: r.text, parent: r.parent === null ? null : map[r.parent] });
  });
  $("agenda-add").disabled = true;
  try {
    await addPolls(keep, m.id);
    toast(`Added ${keep.length} motion${keep.length === 1 ? "" : "s"} to ${meetingLabel(m)}.`);
    $("agenda-text").value = ""; $("agenda-result").innerHTML = ""; agendaRows = null;
  } catch (e) { $("agenda-add").disabled = false; R.actionFailed(e, "Not allowed: the database refused the agenda."); }
}

// Run a save; toast on success, or say in plain words why it failed.
async function guard(promise, okText, refusedText = "Not allowed: the database refused this change.") {
  try { await promise; toast(okText); R.historyChanged(); return true; }
  catch (e) { await R.actionFailed(e, refusedText); return false; }
}

R.motions = renderMotions;
R.motionAction = motionAction;
