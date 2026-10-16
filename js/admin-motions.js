// Leadership console: the Motions tab (add, open, close, edit, archive, trash).
import {
  addPoll, updatePoll, trashPoll, restorePoll, purgePoll, setArchived,
} from "./db.js";
import { escapeHtml, toast, icon } from "./util.js";
import { $, S, R, collapsibleCard, statusPill } from "./admin-state.js";

let editingId = null;          // motion currently being edited (only allowed before first vote)
let activeExpanded = true;     // active Motions card starts open
let archivedExpanded = false;  // Archived + Trash cards are collapsed by default
let trashExpanded = false;

export function wireMotions() {
  $("add-motion").addEventListener("click", async () => {
    const text = $("new-motion").value.trim();
    if (text.length < 3) { toast("Type the motion first."); return; }
    await addPoll(text);
    $("new-motion").value = "";
    toast("Motion added");
  });
}

export function renderMotions() {
  const el = $("motion-list");
  const polls = S.polls;
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

function motionRow(p) {
  // editing allowed only before the first vote, and never once a result is saved
  const locked = (p.voteCount || 0) > 0 || !!p.result;
  const canDelete = p.status !== "open" || !locked;  // closed/draft deletable; an OPEN motion only before its first vote
  const ready = R.canOpenClose();
  // Close waits until the server has confirmed the opening (its time is known).
  const pendingOpen = p.status === "open" && (p._pending || p.openedAt === null);
  if (editingId === p.id) {
    return `<div class="poll-item editing">
      <label class="ed-label">Motion wording
        <textarea class="ed-field" data-edit="${escapeHtml(p.id)}" rows="3">${escapeHtml(p.text)}</textarea>
      </label>
      <div class="row"><button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="save" data-id="${escapeHtml(p.id)}">Save</button>
        <button type="button" class="ed-btn ed-btn-plain btn-sm" data-act="cancel" data-id="${escapeHtml(p.id)}">Cancel</button></div></div>`;
  }
  return `<div class="poll-item">
    <div class="text"><div class="meta">${statusPill(p.status)}${locked ? `<span class="locknote">${icon("lock", 16)}${p.result ? "Result saved" : "Locked: voting started"}</span>` : ""}</div>
      <p>${escapeHtml(p.text)}</p></div>
    <div class="row">
      ${p.status === "draft"
        ? `<button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="open" data-id="${escapeHtml(p.id)}" ${ready ? "" : "disabled"}>Open</button>`
        : p.status === "closed"
        ? `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-act="reopen" data-id="${escapeHtml(p.id)}" ${ready ? "" : "disabled"}>Re-open</button>`
        : `<button type="button" class="ed-btn ed-btn-filled btn-sm" data-act="close" data-id="${escapeHtml(p.id)}" ${ready && !pendingOpen ? "" : "disabled"}>Close</button>`}
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

export async function motionAction(act, id) {
  const polls = S.polls;
  if (act === "open") {
    await R.openFlow(id);
  } else if (act === "close") {
    await R.closeFlow(id);
  } else if (act === "reopen") {
    // Re-open needs a reason: the form is on the Results tab.
    S.selectedPollId = id; S.reopenFor = id;
    R.showTab("results"); R.results(); R.voters();
    const r = $("reopen-reason"); if (r) r.focus();
  } else if (act === "goto-results") {
    S.selectedPollId = null;          // follow the live/open motion
    R.showTab("results"); R.results(); R.voters();
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
    if (await guard(updatePoll(id, { text }), "Motion updated.", "Not allowed: voting has started, so the wording is locked.")) editingId = null;
  } else if (act === "del") {
    if (confirm("Move this motion to Trash? It's hidden from voters but you can restore it from the Trash section below.")) {
      await guard(trashPoll(id), "Moved to Trash.");
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

// Run a save; toast on success, or say in plain words why it failed.
async function guard(promise, okText, refusedText = "Not allowed: the database refused this change.") {
  try { await promise; toast(okText); R.historyChanged(); return true; }
  catch (e) { await R.actionFailed(e, refusedText); return false; }
}

R.motions = renderMotions;
R.motionAction = motionAction;
