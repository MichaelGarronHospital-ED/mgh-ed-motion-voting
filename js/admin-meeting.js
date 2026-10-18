// Admin console: the Meeting tab. Pick or add a meeting, Start and End, its
// details behind "Edit details" (title, date, chair, notes, check-in), the
// link and QR code for voters, attendance, the projector, and meetings in the
// Trash. Also fills the "Records of this meeting" card on the Results tab.
import {
  onScreen, setScreen, onAttendance, addAttendance, removeAttendance, rosterPerson, createMeeting, updateMeeting, startMeeting, endMeeting, setMeetingDeleted, purgeMeeting, currentMeetings,
  resolvedRoster, todayLocal, clockTime, serverTimestamp,
} from "./db.js?v=voting-11";
import { escapeHtml, toast, icon } from "./util.js?v=voting-11";
import { slugify } from "./roster.js?v=voting-11";
import { $, S, R, niceDate, meetingLabel, infoButton, iconBtn } from "./admin-state.js?v=voting-11";
import { exportMeeting, printMeeting } from "./records.js?v=voting-11";

const STATUS = { planned: "Planned", open: "Open", closed: "Ended" };
const live = () => currentMeetings().filter((m) => !m.deleted);
// The meeting on screen: the one picked on this laptop, else the open one,
// else the next planned one, else the latest.
export function selectedMeeting() {
  const ms = live();
  const picked = ms.find((m) => m.id === S.meetingId);
  if (picked) return picked;
  const open = ms.find((m) => m.status === "open");
  if (open) return open;
  const today = todayLocal();
  const next = ms.filter((m) => m.status === "planned" && (m.date || "") >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (next) return next;
  return ms.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0] || null;
}
R.selectedMeeting = selectedMeeting;

let newOpen = false;
let editFor = null;            // meeting whose "Edit details" is open
export function wireMeeting() {
  // The projector's controls: each is one write to config/screen.
  onScreen((d) => {
    S.screen = d || {};
    $("screen-qr").checked = !d || d.showQr !== false;
    $("screen-tally").checked = !!(d && d.showTally);
  });
  const save = (patch, ok) => setScreen(patch).then(() => ok && toast(ok), (e) => R.actionFailed(e, "Not allowed: the database refused the change."));
  $("screen-qr").addEventListener("change", (e) => save({ showQr: e.target.checked }));
  $("screen-tally").addEventListener("change", (e) => save({ showTally: e.target.checked }));
  document.querySelectorAll("[data-timer]").forEach((b) => b.addEventListener("click", () => {
    const secs = Number(b.dataset.timer);
    if (!secs) { save({ timer: null }, "Timer stopped."); return; }
    if (!S.activePoll) { toast("Open a motion first."); return; }
    save({ timer: { pollId: S.activePoll.id, startedAt: serverTimestamp(), seconds: secs } }, `Timer started: ${secs / 60} min.`);
  }));
  $("meeting-export").addEventListener("click", () => { const m = selectedMeeting(); if (m) exportMeeting(m.id); else toast("Add a meeting first."); });
  $("meeting-print").addEventListener("click", () => { const m = selectedMeeting(); if (m) printMeeting(m.id); else toast("Add a meeting first."); });
}

export function renderMeeting() {
  const el = $("meeting-card");
  const m = selectedMeeting();
  const ms = live().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  renderRecords(m);
  // Keep typing in the details form when another device changes something.
  if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
  const names = resolvedRoster().map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join("");
  // The picker only when there is a choice; one meeting is just named.
  const picker = ms.length > 1 ? `<label class="sr" for="meeting-pick">Meeting</label>
      <select class="ed-field" id="meeting-pick">${ms.map((x) => `<option value="${escapeHtml(x.id)}" ${m && x.id === m.id ? "selected" : ""}>${escapeHtml(meetingLabel(x))} (${STATUS[x.status] || x.status})</option>`).join("")}</select>`
    : m ? `<p class="meeting-name">${escapeHtml(meetingLabel(m))}</p>`
    : `<p class="ed-hint">No meetings yet. Add one, or just add a motion: today's meeting is made for you.</p>`;
  const newForm = newOpen || !ms.length ? `<form id="meeting-new-form" class="card-inset stack-sm">
      <label class="ed-label" for="meeting-new-title">Title
        <input class="ed-field" id="meeting-new-title" type="text" maxlength="200" value="ED department meeting" /></label>
      <label class="ed-label" for="meeting-new-date">Date
        <input class="ed-field narrow-date" id="meeting-new-date" type="date" value="${todayLocal()}" /></label>
      <div class="row"><button type="submit" class="ed-btn ed-btn-filled btn-sm">Add meeting</button>
        ${ms.length ? `<button type="button" id="meeting-new-cancel" class="ed-btn ed-btn-plain btn-sm">Cancel</button>` : ""}</div>
    </form>` : "";
  const newBtn = newOpen || !ms.length ? "" : `<button type="button" id="meeting-new" class="ed-btn ed-btn-tinted btn-sm">${icon("plus", 18)}New meeting</button>`;
  let details = "";
  if (m) {
    const when = m.status === "open" ? `Open since ${escapeHtml(clockTime(m.startedAt))}` : m.status === "closed" ? `Ended${m.endedAt ? " at " + escapeHtml(clockTime(m.endedAt)) : ""}${m.startedAt ? ` (started ${escapeHtml(clockTime(m.startedAt))})` : ""}` : "";
    // Collapsed once the meeting has a title (every saved meeting has one).
    const editOpen = editFor === m.id || !m.title;
    details = `<div class="meeting-status">
        <span class="ed-pill ${m.status === "open" ? "ed-pill-good" : m.status === "closed" ? "ed-pill-quiet" : "ed-pill-info"}">${m.status === "open" ? '<span class="dot"></span>' : ""}${STATUS[m.status] || m.status}</span>${when ? `<span class="ed-hint">${when}</span>` : ""}
        ${infoButton("Start the meeting when it begins: voters then see its title, and this meeting's results. End it at the end: any open motion is closed and its result saved first.", "starting and ending")}
      </div>
      <div class="row">
        ${m.status === "open" ? `<button type="button" id="meeting-end" class="ed-btn ed-btn-filled" ${R.canOpenClose() ? "" : "disabled"}>End meeting</button>`
          : m.status === "planned" ? `<button type="button" id="meeting-start" class="ed-btn ed-btn-filled" ${R.canOpenClose() ? "" : "disabled"}>Start meeting</button>` : ""}
        <button type="button" id="meeting-edit" class="ed-btn ed-btn-plain btn-sm" aria-expanded="${editOpen}" aria-controls="meeting-form">${icon("pencil", 18)}Edit details</button>
      </div>
      <form id="meeting-form" class="card-inset stack-sm ${editOpen ? "" : "hide"}">
        <label class="ed-label" for="meeting-title">Title<input class="ed-field" id="meeting-title" type="text" maxlength="200" value="${escapeHtml(m.title || "")}" /></label>
        <label class="ed-label" for="meeting-date">Date<input class="ed-field narrow-date" id="meeting-date" type="date" value="${escapeHtml(m.date || "")}" /></label>
        <label class="ed-label" for="meeting-chair">Chair<input class="ed-field" id="meeting-chair" type="text" maxlength="200" list="roster-names" value="${escapeHtml(m.chair || "")}" /></label>
        <label class="ed-label" for="meeting-notes">Notes<textarea class="ed-field" id="meeting-notes" rows="2" maxlength="2000">${escapeHtml(m.notes || "")}</textarea></label>
        <label class="check"><input type="checkbox" id="meeting-checkin" ${m.checkIn !== false ? "checked" : ""} /> Ask phones to check in (in the room or remote)</label>
        <div class="row"><button type="submit" class="ed-btn ed-btn-tinted btn-sm">Save details</button>
          ${m.status !== "open" ? `<button type="button" id="meeting-trash-btn" class="ed-btn btn-quiet btn-sm">${icon("trash", 18)}Move meeting to Trash</button>` : ""}</div>
      </form>`;
  }
  el.innerHTML = `<div class="spread"><h2>Meeting</h2>${newBtn}</div>${picker}${newForm}${details}<datalist id="roster-names">${names}</datalist>`;
  const ed = $("meeting-edit");
  if (ed) ed.addEventListener("click", () => {
    const open = ed.getAttribute("aria-expanded") === "true";
    editFor = open ? null : m.id;
    ed.setAttribute("aria-expanded", String(!open));
    $("meeting-form").classList.toggle("hide", open);
    if (!open) $("meeting-title").focus();
  });
  const pick = $("meeting-pick");
  if (pick) pick.addEventListener("change", () => { S.meetingId = pick.value; renderAll(); });
  const nb = $("meeting-new"); if (nb) nb.addEventListener("click", () => { newOpen = true; renderMeeting(); $("meeting-new-title").focus(); });
  const nc = $("meeting-new-cancel"); if (nc) nc.addEventListener("click", () => { newOpen = false; renderMeeting(); });
  const nf = $("meeting-new-form");
  if (nf) nf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("meeting-new-title").value.trim() || "ED department meeting";
    const date = $("meeting-new-date").value || todayLocal();
    try { S.meetingId = await createMeeting(title, date); newOpen = false; toast("Meeting added."); renderAll(); }
    catch (err) { R.actionFailed(err, "Not allowed: the database refused the meeting."); }
  });
  const f = $("meeting-form");
  if (f) f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = { title: $("meeting-title").value.trim() || "ED department meeting", date: $("meeting-date").value || m.date,
      chair: $("meeting-chair").value.trim().slice(0, 200), notes: $("meeting-notes").value.slice(0, 2000),
      checkIn: $("meeting-checkin").checked };
    try { await updateMeeting(m.id, patch); editFor = null; toast("Meeting details saved."); renderMeeting(); }
    catch (err) { R.actionFailed(err, "Not allowed: the database refused the change."); }
  });
  const sb = $("meeting-start"); if (sb) sb.addEventListener("click", () => startFlow(m.id));
  const eb = $("meeting-end"); if (eb) eb.addEventListener("click", () => endFlow(m.id));
  const tb = $("meeting-trash-btn");
  if (tb) tb.addEventListener("click", async () => {
    if (!confirm(`Move ${meetingLabel(m)} to Trash? It is hidden from voters and from your lists. You can restore it, or delete it permanently, from the Trash below.`)) return;
    try { await setMeetingDeleted(m.id, true); S.meetingId = null; toast("Meeting moved to Trash."); renderAll(); }
    catch (err) {
      if (err && err.why === "open") toast("Close the open motion first.");
      else R.actionFailed(err, "Not allowed: the database refused the change.");
    }
  });
  renderMeetingTrash();
  renderAttendance();
}

// ---- attendance: who checked in (a claim, never a lock), plus who leadership added
const attendance = new Map();     // meetingId -> { list, loaded, unsub, failed }
export function attendanceFor(meetingId) {
  if (!meetingId) return null;
  if (!attendance.has(meetingId)) {
    const a = { list: [], loaded: false, failed: null };
    attendance.set(meetingId, a);
    a.unsub = onAttendance(meetingId, (list) => { a.list = list; a.loaded = true; renderAttendance(); R.voters(); },
      (e) => { a.failed = e; renderAttendance(); });
    // keep at most the two meetings on screen (Meeting tab and Voters tab)
    if (attendance.size > 2) {
      const [old] = [...attendance.keys()].filter((k) => k !== meetingId && k !== (selectedMeeting() || {}).id);
      if (old) { attendance.get(old).unsub(); attendance.delete(old); }
    }
  }
  return attendance.get(meetingId);
}
R.attendanceFor = attendanceFor;
let addOpen = false;
function renderAttendance() {
  const el = $("attendance-card");
  const m = selectedMeeting();
  el.classList.toggle("hide", !m);
  if (!m) return;
  if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) return;
  const a = attendanceFor(m.id);
  // Check-in off for this meeting and nobody checked in: nothing to show.
  el.classList.toggle("hide", m.checkIn === false && a.loaded && !a.list.length && !addOpen && !a.failed);
  const head = `<div class="card-head"><h2>Attendance</h2>${infoButton("A check-in is what someone said on a phone (one tap; never needed to vote). Anyone who votes is listed as present in the meeting's Excel file even without one.", "attendance")}</div>`;
  if (a.failed) {
    el.innerHTML = `${head}<p class="notice">${icon("alert", 20)}<span>${a.failed.code && String(a.failed.code).includes("permission") ? "This page needs a database update that has not been published yet. Attendance shows once it is." : "Could not load attendance. Check your connection."}</span></p>`;
    return;
  }
  const list = a.list.slice().sort((x, y) => x.name.localeCompare(y.name));
  const room = list.filter((x) => x.mode === "room").length, remote = list.filter((x) => x.mode === "remote").length;
  el.innerHTML = `${head}
    <p>${a.loaded ? `Checked in: <strong>${list.length}</strong>${list.length ? ` (${[room ? `in the room ${room}` : "", remote ? `remote ${remote}` : ""].filter(Boolean).join(", ")})` : ""}` : "Loading attendance..."}</p>
    ${list.length ? `<ul class="removed-list">${list.map((x) => `<li><span>${escapeHtml(x.name)} <span class="ed-muted">${x.mode === "remote" ? "remote" : "in the room"}${x.by === "leadership" ? ", added in the Admin console" : ""}${x.note ? `: ${escapeHtml(x.note)}` : ""}</span></span>
      ${iconBtn("x", `Remove ${x.name} from attendance`, `data-att-remove="${escapeHtml(x.slug)}" data-name="${escapeHtml(x.name)}"`, "btn-quiet")}</li>`).join("")}</ul>` : ""}
    ${addOpen ? `<form id="att-form" class="card-inset stack-sm">
      <label class="ed-label" for="att-name">Name<input class="ed-field" id="att-name" type="text" list="roster-names" autocomplete="off" /></label>
      <div class="row" role="radiogroup" aria-label="Where"><label class="check"><input type="radio" name="att-mode" value="room" checked /> In the room</label>
        <label class="check"><input type="radio" name="att-mode" value="remote" /> Remote</label></div>
      <label class="ed-label" for="att-note">Note (optional)<input class="ed-field" id="att-note" type="text" maxlength="300" placeholder="Present, did not use a phone" /></label>
      <div class="row"><button type="submit" class="ed-btn ed-btn-filled btn-sm">Add</button><button type="button" id="att-cancel" class="ed-btn ed-btn-plain btn-sm">Cancel</button></div>
    </form>` : `<div><button type="button" id="att-add" class="ed-btn ed-btn-tinted btn-sm">${icon("plus", 18)}Add someone</button></div>`}`;
  const add = $("att-add"); if (add) add.addEventListener("click", () => { addOpen = true; renderAttendance(); $("att-name").focus(); });
  const cancel = $("att-cancel"); if (cancel) cancel.addEventListener("click", () => { addOpen = false; renderAttendance(); });
  const f = $("att-form");
  if (f) f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("att-name").value.trim().replace(/\s+/g, " ");
    if (name.length < 3) { toast("Type the name first."); return; }
    const slug = slugify(name);
    const p = rosterPerson(slug);
    try {
      await addAttendance(m.id, { name: p ? p.name : name, slug }, f.querySelector("input[name=att-mode]:checked").value, $("att-note").value.trim());
      addOpen = false; toast("Added to attendance."); renderAttendance();
    } catch (err) { R.actionFailed(err, "Not allowed: the database refused the change."); }
  });
  el.querySelectorAll("[data-att-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Remove ${b.dataset.name} from this meeting's attendance? Their votes are not affected.`)) return;
    try { await removeAttendance(m.id, b.dataset.attRemove, b.dataset.name); toast("Removed from attendance."); }
    catch (err) { R.actionFailed(err, "Not allowed: the database refused the change."); }
  }));
}

function renderMeetingTrash() {
  const el = $("meeting-trash");
  const gone = currentMeetings().filter((m) => m.deleted);
  if (!gone.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<section class="card stack"><div class="card-head"><h2>Meetings in Trash</h2>${infoButton("Hidden from voters and from your lists. Restore one, or delete it permanently (its motions and ballots too; the change history keeps a record).", "the trash")}</div>
    <ul class="removed-list">${gone.map((m) => `<li><span>${escapeHtml(meetingLabel(m))}</span><span class="row">
      <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-m-restore="${escapeHtml(m.id)}">Restore</button>
      <button type="button" class="ed-btn ed-btn-danger btn-sm" data-m-purge="${escapeHtml(m.id)}">Delete meeting permanently</button></span></li>`).join("")}</ul></section>`;
  el.querySelectorAll("[data-m-restore]").forEach((b) => b.addEventListener("click", () =>
    setMeetingDeleted(b.dataset.mRestore, false).then(() => toast("Meeting restored."), (e) => R.actionFailed(e, "Not allowed: the database refused the change."))));
  el.querySelectorAll("[data-m-purge]").forEach((b) => b.addEventListener("click", async () => {
    const m = currentMeetings().find((x) => x.id === b.dataset.mPurge);
    const n = S.polls.filter((p) => p.meetingId === m.id).length;
    if (!confirm(`Delete ${meetingLabel(m)} permanently? This deletes the meeting and its ${n} motion${n === 1 ? "" : "s"} with their ballots. The change history keeps a record of each result. This cannot be undone.`)) return;
    b.disabled = true;
    try { await purgeMeeting(m.id); toast("Meeting deleted permanently."); }
    catch (e) {
      b.disabled = false;
      if (e && e.why === "open") toast("Close the open motion first.");
      else R.actionFailed(e, "Not allowed: only a meeting in the Trash can be deleted permanently.");
    }
  }));
}

// The Results tab's "Records of this meeting": the meeting on screen here.
function renderRecords(m) {
  $("meeting-records").classList.toggle("hide", !m);
  $("records-meeting").textContent = m ? meetingLabel(m) : "";
}

// Only one meeting is open at a time.
async function startFlow(id) {
  const other = currentMeetings().find((m) => m.status === "open" && !m.deleted && m.id !== id);
  if (other) {
    if (!confirm(`${meetingLabel(other)} is still open. End the other meeting first?`)) return;
    if (!(await endFlow(other.id))) return;
  }
  try { await startMeeting(id); toast("Meeting started."); }
  catch (e) { R.actionFailed(e, "Not allowed: the database refused the change."); }
}
// End: any open motion is closed (both steps), saves are waited for, then the
// meeting ends; past results are written after it, in their own write.
async function endFlow(id) {
  for (const p of S.polls.filter((x) => x.status === "open")) {
    if (!(await R.closeFlow(p.id))) return false;
  }
  while (S.busy > 0) await new Promise((r) => setTimeout(r, 200));
  try {
    await endMeeting(id);
    R.historyChanged();
    toast("Meeting ended.");
    return true;
  } catch (e) { await R.actionFailed(e, "Not allowed: the database refused the change."); return false; }
}
R.endFlow = endFlow;

// A motion needs a meeting: the one on screen, else today's (made now).
export async function meetingForNewMotion() {
  const m = selectedMeeting();
  if (m) return m.id;
  const id = await createMeeting("ED department meeting", todayLocal());
  S.meetingId = id;
  return id;
}
R.meetingForNewMotion = meetingForNewMotion;

function renderAll() { renderMeeting(); R.motions(); R.results(); R.voters(); }
R.meeting = renderMeeting;
