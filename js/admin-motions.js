// Leadership console: the Motions tab (add, open, close, edit, archive, trash).
import {
  addPoll, updatePoll, trashPoll, restorePoll, purgePoll, openPoll, closePoll, setArchived,
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

export async function motionAction(act, id) {
  const polls = S.polls;
  if (act === "open") {
    if (polls.some((p) => p.status === "open" && p.id !== id))
      if (!confirm("This will close the currently open motion. Continue?")) return;
    await openPoll(id);
    toast("Motion opened. Voters can vote now.");
  } else if (act === "close") {
    await closePoll(id); toast("Motion closed.");
  } else if (act === "goto-results") {
    S.selectedPollId = null;          // follow the live/open motion
    R.showTab("results"); R.results(); R.voters();
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

R.motions = renderMotions;
R.motionAction = motionAction;
