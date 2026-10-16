// Leadership console: the Results and Voters tabs, and the one-motion CSV.
import {
  onVotesFor, clearVote, weightForVote, groupForVote, resultOf, outcomeWords, outcomeKind, clockTime,
  classify, rulesNeedUpdate, DB_UPDATE_MSG, sortMotions, getVotesFor, getLogFor,
} from "./db.js";
import { escapeHtml, labelOf, fmt, csv, toast, icon, verdictHTML, stackedBar } from "./util.js";
import { $, S, R, STATUS_WORD, statusPill, groupLabel, download } from "./admin-state.js";
import { tsMillis } from "./count.js";

export function wireResults() {
  $("export").addEventListener("click", exportCsv);
}

// Which motion the Results/Voters tabs show: an explicit selection, else the
// open motion, else the most recent (non-archived, non-deleted) closed one.
function displayPoll() {
  if (S.selectedPollId) {
    const p = S.polls.find((x) => x.id === S.selectedPollId);
    if (p && !p.deleted) return p;
  }
  if (S.activePoll) return S.activePoll;
  // The most recent closed motion, by when it closed (old motions: when added).
  const closed = S.polls.filter((p) => p.status === "closed" && !p.archived && !p.deleted);
  const t = (p) => tsMillis(p.closedAt) ?? tsMillis(p.createdAt) ?? -1;
  return closed.reduce((best, p) => (!best || t(p) >= t(best) ? p : best), null);
}
function motionSelectorHTML() {
  const choosable = sortMotions(S.polls.filter((p) => !p.deleted));
  if (!choosable.length) return "";
  const opts = [`<option value="">Current motion (auto)</option>`].concat(
    choosable.map((p) => {
      const tag = p.archived ? "Archived" : STATUS_WORD[p.status] || escapeHtml(p.status);
      const short = p.text.length > 60 ? p.text.slice(0, 60) + "…" : p.text;
      return `<option value="${escapeHtml(p.id)}" ${p.id === S.selectedPollId ? "selected" : ""}>${tag} · ${escapeHtml(short)}</option>`;
    })).join("");
  return `<label class="ed-label">View motion
    <select class="ed-field motion-select">${opts}</select></label>`;
}
function wireMotionSelect(scope) {
  const s = scope.querySelector(".motion-select");
  if (s) s.addEventListener("change", () => { S.selectedPollId = s.value || null; renderResults(); renderVoters(); });
}

// Ballots for the motion on screen. The open motion: the live listener.
// A closed motion: read once and kept (closed ballots cannot change), and only
// when something on screen needs them (the Voters tab, or a result not saved).
let displayUnsub = null, displayId = null, displayVotes = [], displayLoaded = false;
const closedCache = new Map();     // "id@closedAt" -> ballots
const closedLoading = new Set();
const cacheKey = (p) => `${p.id}@${tsMillis(p.closedAt)}`;
function ensureDisplay(needVotes = true) {
  const poll = displayPoll();
  const stopListener = () => { if (displayUnsub) { displayUnsub(); displayUnsub = null; } displayId = null; displayLoaded = false; };
  if (!poll) { stopListener(); displayVotes = []; return null; }
  if (S.activePoll && poll.id === S.activePoll.id) {
    stopListener();
    return { poll, votes: S.activeVotes, loaded: S.activeLoaded };   // reuse the live subscription
  }
  if (poll.status === "closed") {
    stopListener();
    const key = cacheKey(poll);
    if (closedCache.has(key)) return { poll, votes: closedCache.get(key), loaded: true };
    if (needVotes && !closedLoading.has(key)) {
      closedLoading.add(key);
      getVotesFor(poll.id).then((vs) => {
        closedCache.set(key, vs); R.collectWriteins(vs); renderResults(); renderVoters();
      }).catch((e) => { console.warn(e); toast("Could not load the ballots. Check your connection and try again."); })
        .finally(() => closedLoading.delete(key));
    }
    return { poll, votes: [], loaded: false };
  }
  if (poll.id !== displayId) {                          // a draft (or an archived open motion): listen
    stopListener();
    displayId = poll.id; displayVotes = []; displayLoaded = false;
    displayUnsub = onVotesFor(poll.id, (vs) => { displayVotes = vs; displayLoaded = true; R.collectWriteins(vs); renderResults(); renderVoters(); });
  }
  return { poll, votes: displayVotes, loaded: displayLoaded };
}

export function renderResults() {
  renderCatchUp();
  const sel = $("results-selector");
  sel.innerHTML = motionSelectorHTML() || `<p class="ed-hint">No motions yet.</p>`;
  wireMotionSelect(sel);
  const el = $("results-body");
  const shown = displayPoll();
  const d = ensureDisplay(!(shown && shown.status === "closed" && shown.result));
  if (!d) { el.innerHTML = `<p class="ed-hint">No motion to show. Open one, or choose a motion above.</p>`; return; }
  // Keep a half-typed reason (and an open History fold) when the card redraws.
  const keep = ["reopen-reason", "revote-reason"].map((id) => [id, $(id) ? $(id).value : ""]);
  const histOpen = $("motion-history") && $("motion-history").open;
  paintResults(el, d.poll, d.votes, d.loaded);
  keep.forEach(([id, v]) => { if ($(id) && v) $(id).value = v; });
  if (histOpen && $("motion-history")) { $("motion-history").open = true; loadMotionHistory(d.poll.id); }
}
// "Passed, 21.5 to 6 points, quorum 29 of 24."
export function resultLine(r) {
  return `${outcomeWords(r, "voter")}, ${fmt(r.weight.favour)} to ${fmt(r.weight.against)} points, quorum ${r.quorumCount} of ${r.quorumNeeded}`;
}
function ruleHint(rule) {
  const pass = rule && rule.threshold === "twoThirds"
    ? "Passes with at least two-thirds of the weighted votes for or against; abstentions count only toward quorum."
    : "Passes when weighted In favour beats weighted Against; abstentions count only toward quorum.";
  return pass;
}
function paintResults(el, poll, votes, loaded) {
  // An empty tally scores as "No quorum: cannot pass". Shown before the
  // ballots arrive that is a wrong result on a shared screen, so hold off.
  const top = `${statusPill(poll.status)}<h2 class="motion-text">${escapeHtml(poll.text)}</h2>`;
  const saved = poll.status === "closed" && poll.result ? poll.result : null;
  if (!saved && !loaded) {
    el.innerHTML = `${top}<p class="ed-hint">Counting votes…</p>`;
    return;
  }
  const r = saved || resultOf(poll, votes);
  const quorum = r.quorumNeeded;
  const quorumMet = r.quorumCount >= quorum;
  const need = quorum - r.quorumCount;
  const ready = R.canOpenClose();
  const pendingOpen = poll.status === "open" && (poll._pending || poll.openedAt === null);
  let savedLine = "";
  if (saved) {
    savedLine = `<p class="saved-line">${icon("lock", 18)}<span>Result saved at ${escapeHtml(clockTime(saved.savedAt))}. It can't be changed. If it was closed by mistake, use Re-open. To vote again from the start, use Re-vote.</span></p>`;
    if (saved.quorumNote) savedLine += `<p class="notice">${icon("warn", 20)}<span>Quorum may have been counted too low when this closed (a write-in given a vote may have been left out). Shown as recorded.</span></p>`;
  } else if (poll.status === "closed") {
    savedLine = S.saving.has(poll.id)
      ? `<p class="saved-line">${icon("clock", 18)}<span>Saving the result...</span></p>`
      : `<div class="saved-line warn">${icon("alert", 18)}<span>Result not saved yet.</span><button type="button" class="ed-btn ed-btn-tinted btn-sm" id="r-save" ${ready ? "" : "disabled"}>Save result now</button></div>`;
  }
  const replacedBy = poll.supersededBy ? S.polls.find((x) => x.id === poll.supersededBy) : null;
  let links = "";
  if (poll.supersededBy) links += `<p class="saved-line">${icon("alert", 18)}<span><span class="ed-pill ed-pill-quiet">Replaced by a re-vote</span> ${replacedBy ? `The re-vote is "${escapeHtml(replacedBy.text.slice(0, 80))}" (${escapeHtml(STATUS_WORD[replacedBy.status] || replacedBy.status)}).` : "The re-vote was deleted."}</span></p>`;
  if (poll.revoteOf) links += `<p class="ed-hint"><span class="ed-pill ed-pill-info">Re-vote</span> ${S.polls.some((x) => x.id === poll.revoteOf) ? "Re-vote of an earlier motion." : "Re-vote of a motion that was later deleted."} Reason: ${escapeHtml(poll.revoteReason || "")}</p>`;
  const prior = (poll.priorResults || []);
  const priorLine = prior.length ? `<p class="ed-hint">Re-opened ${prior.length === 1 ? "once" : prior.length + " times"}. Earlier count: ${escapeHtml(outcomeWords(prior[prior.length - 1], "voter"))} (${fmt(prior[prior.length - 1].weight.favour)} to ${fmt(prior[prior.length - 1].weight.against)} points).</p>` : "";
  let actions;
  if (poll.status === "open") {
    actions = `<button type="button" class="ed-btn ed-btn-filled" id="r-close" ${ready && !pendingOpen ? "" : "disabled"}>Close voting</button>`;
  } else if (poll.status === "draft") {
    actions = `<button type="button" class="ed-btn ed-btn-filled" id="r-open" ${ready ? "" : "disabled"}>Open voting</button>`;
  } else if (poll.supersededBy) {
    actions = `<p class="ed-hint">Re-open the re-vote instead.</p>`;
  } else {
    actions = `<button type="button" class="ed-btn ed-btn-filled" id="r-open" aria-expanded="${S.reopenFor === poll.id}" aria-controls="reopen-form" ${ready ? "" : "disabled"}>Re-open voting</button>`
      + (saved ? `<button type="button" class="ed-btn ed-btn-tinted" id="r-revote" aria-expanded="${S.revoteFor === poll.id}" aria-controls="revote-form" ${ready ? "" : "disabled"}>Re-vote</button>` : "");
  }
  if (S.revoteReady && S.revoteReady === poll.supersededBy && replacedBy && replacedBy.status === "draft") {
    actions += `<button type="button" class="ed-btn ed-btn-filled" id="revote-open" ${ready ? "" : "disabled"}>Open the re-vote now</button>`;
  }
  const form = poll.status === "closed" && S.reopenFor === poll.id ? `
    <form class="card-inset stack-sm" id="reopen-form">
      <p><strong>Re-open this motion?</strong> Ballots already cast stay and people can vote or change their vote again. The earlier totals are kept as the earlier count.</p>
      <label class="ed-label" for="reopen-reason">Reason
        <textarea class="ed-field" id="reopen-reason" rows="2" maxlength="1000" aria-required="true"></textarea>
      </label>
      <p class="ed-hint">Kept with the record for at least 7 years. Do not include health or other private details.</p>
      ${!saved ? `<p class="ed-hint" id="reopen-first">The result is saved first, so the earlier count is never lost.</p>` : ""}
      <div class="row"><button type="submit" class="ed-btn ed-btn-filled btn-sm" id="reopen-go">Re-open</button>
        <button type="button" class="ed-btn ed-btn-plain btn-sm" id="reopen-cancel">Cancel</button></div>
    </form>` : "";
  const revoteForm = poll.status === "closed" && saved && !poll.supersededBy && S.revoteFor === poll.id ? `
    <form class="card-inset stack-sm" id="revote-form">
      <p><strong>Start a clean re-vote?</strong> The original result stays on record, marked "Replaced by a re-vote". Everyone votes again from the start.</p>
      <label class="ed-label" for="revote-reason">Reason (voters see this)
        <textarea class="ed-field" id="revote-reason" rows="2" maxlength="1000" aria-required="true"></textarea>
      </label>
      <p class="ed-hint">Kept with the record for at least 7 years. Do not include health or other private details.</p>
      <div class="row"><button type="submit" class="ed-btn ed-btn-filled btn-sm" id="revote-go">Start the re-vote</button>
        <button type="button" class="ed-btn ed-btn-plain btn-sm" id="revote-cancel">Cancel</button></div>
    </form>` : "";
  const history = poll.status !== "draft" ? `<details class="about" id="motion-history"><summary>History</summary><ul class="plain-list" id="motion-history-list"></ul></details>` : "";
  el.innerHTML = `${top}
    ${verdictHTML(outcomeKind(r), escapeHtml(outcomeWords(r, "console")))}
    ${bars(r)}
    <div class="quorum ${quorumMet ? "met" : "short"}">
      <div class="spread"><span class="q-label">Quorum${poll.status === "closed" ? `${icon("lock", 16)}<span class="ed-muted">frozen at close</span>` : ""}</span>
        <span class="q-state">${icon(quorumMet ? "check" : "alert", 18)}${r.quorumCount} of ${quorum} ${quorumMet ? "met" : "not met"}</span></div>
      <div class="bar" aria-hidden="true"><span class="${quorumMet ? "favour" : "short"}" style="width:${quorum > 0 ? Math.min(100, (r.quorumCount / quorum) * 100) : 0}%"></span></div>
      ${!quorumMet ? `<p class="ed-hint">${need} more eligible ${need === 1 ? "voter is" : "voters are"} needed before this motion can be decided.</p>` : ""}
    </div>
    <p class="ed-hint">${r.totalVotes} ${r.totalVotes === 1 ? "ballot" : "ballots"} · ${r.writeIns} write-in${r.writeIns === 1 ? "" : "s"} · ${r.flags} flagged. ${ruleHint(r.rule)}</p>
    ${savedLine}${links}${priorLine}
    <div class="row">${actions}</div>${form}${revoteForm}${history}`;
  const c = $("r-close"), o = $("r-open"), sv = $("r-save");
  if (c) c.addEventListener("click", () => R.closeFlow(poll.id));
  if (sv) sv.addEventListener("click", () => { R.saveFlow(poll.id).then(() => R.fixBoard()); });
  const rv = $("r-revote");
  if (rv) rv.addEventListener("click", () => {
    S.revoteFor = S.revoteFor === poll.id ? null : poll.id; S.reopenFor = null;
    renderResults();
    if ($("revote-reason")) $("revote-reason").focus();
  });
  const ro = $("revote-open");
  if (ro) ro.addEventListener("click", async () => {
    const id = S.revoteReady;
    S.revoteReady = null;
    S.selectedPollId = id;
    await R.openFlow(id);
    renderResults(); renderVoters();
  });
  const rf = $("revote-form");
  if (rf) {
    $("revote-cancel").addEventListener("click", () => { S.revoteFor = null; renderResults(); });
    rf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = $("revote-reason").value.trim();
      if (reason.length < 3) { toast("Type the reason first."); $("revote-reason").focus(); return; }
      $("revote-go").disabled = true;
      const id = await R.revoteFlow(poll.id, reason);
      if (id) S.revoteFor = null;
      else if ($("revote-go")) $("revote-go").disabled = false;
      renderResults();
    });
  }
  const hist = $("motion-history");
  if (hist) hist.addEventListener("toggle", () => { if (hist.open) loadMotionHistory(poll.id); });
  if (o) o.addEventListener("click", () => {
    if (poll.status === "draft") { R.openFlow(poll.id); return; }
    S.reopenFor = S.reopenFor === poll.id ? null : poll.id; S.revoteFor = null;
    renderResults();
    if ($("reopen-reason")) $("reopen-reason").focus();
  });
  const f = $("reopen-form");
  if (f) {
    $("reopen-cancel").addEventListener("click", () => { S.reopenFor = null; renderResults(); });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = $("reopen-reason").value.trim();
      if (reason.length < 3) { toast("Type the reason first."); $("reopen-reason").focus(); return; }
      $("reopen-go").disabled = true;
      if ($("reopen-first")) $("reopen-first").textContent = "Saving the result first...";
      const ok = await R.reopenFlow(poll.id, reason);
      if (!ok && $("reopen-go")) $("reopen-go").disabled = false;
    });
  }
}

// The catch-up card: old results saved this session, failures, and motions
// the write-in quorum check flagged (from the saved results themselves).
function renderCatchUp() {
  const el = $("catchup-card");
  const flagged = S.polls.filter((p) => p.result && p.result.quorumNote);
  const c = S.catchup;
  let html = "";
  if (flagged.length) {
    html += `<h2>Please check</h2>
      <p>${flagged.length} earlier motion${flagged.length === 1 ? "" : "s"} may have counted quorum too low, and the quorum outcome could have been different.</p>
      <ul class="plain-list">${flagged.map((p) => `<li>${escapeHtml(p.text)} <span class="ed-muted">(${escapeHtml(resultLine(p.result))})</span></li>`).join("")}</ul>
      <p class="ed-hint">Each is shown as recorded. For each one, keep it as recorded, or hold a re-vote at the next meeting.</p>`;
  }
  if (c && c.text) {
    html += `<p class="${c.kind === "ok" ? "ed-hint" : "notice"}">${c.kind === "ok" ? "" : icon("warn", 20)}<span>${escapeHtml(c.text)}</span></p>`;
    if (c.kind !== "ok") html += `<div><button type="button" class="ed-btn ed-btn-tinted btn-sm" id="catchup-retry">Try again</button></div>`;
  }
  el.innerHTML = html;
  el.classList.toggle("hide", !html);
  const b = $("catchup-retry"); if (b) b.addEventListener("click", () => R.retryCatchUp());
}

// ---- change history (on demand: one read of the latest 50 entries) ----------
const ACTION_WORDS = {
  open: "Opened", close: "Closed", "catch-up": "Saved earlier results", reopen: "Re-opened",
  revote: "Re-vote started", runoff: "Run-off started", archive: "Archived", unarchive: "Unarchived",
  trash: "Moved to Trash", restore: "Restored", purge: "Deleted permanently", move: "Moved",
  settings: "Settings changed", roster: "Physician list changed", "roster-bulk": "Physician list updated by paste",
  writein: "Write-in reviewed", meeting: "Meeting changed", attendance: "Attendance changed",
  "history-purge": "Old history deleted",
};
R.logAction = (a) => ACTION_WORDS[a] || a;
export function logLine(e) {
  const ms = tsMillis(e.at);
  const when = ms === null ? "" : new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  let s = `${when}. ${ACTION_WORDS[e.action] || e.action}${e.by ? ` by ${e.by}` : ""}.`;
  if (e.text) s += ` ${e.text}`;
  if (e.reason && e.action !== "catch-up") s += ` Reason: ${e.reason}`;
  if (e.before && e.before.outcome) s += ` Earlier count: ${resultLine(e.before)}.`;
  return s;
}
// This motion's change history: one read of its entries, on demand, kept.
const motionLog = new Map();
async function loadMotionHistory(id) {
  const box = $("motion-history-list");
  if (!box) return;
  const show = (list) => {
    box.innerHTML = list.length ? list.map((e) => `<li>${escapeHtml(logLine(e))}</li>`).join("") : `<li class="ed-muted">No changes recorded for this motion.</li>`;
  };
  if (motionLog.has(id)) { show(motionLog.get(id)); return; }
  box.innerHTML = `<li class="ed-muted">Loading...</li>`;
  try {
    const list = await getLogFor(id);
    motionLog.set(id, list);
    setTimeout(() => motionLog.delete(id), 30000);   // read again later, not on every redraw
    if ($("motion-history-list")) show(list);
  } catch (e) {
    const why = classify(e) === "refused" && (await rulesNeedUpdate()) ? DB_UPDATE_MSG : "Could not load the history. Check your connection and try again.";
    if ($("motion-history-list")) $("motion-history-list").innerHTML = `<li class="ed-muted">${escapeHtml(why)}</li>`;
  }
}

// One stacked bar plus a legend with the weighted points and head counts.
function bars(t) {   // t: a result (weight and count per choice)
  const row = (key, label) => `<li><i class="sw ${key}"></i><span class="lbl">${label}</span>
      <span class="num"><strong>${fmt(t.weight[key])} pts</strong> · ${t.count[key]} ${t.count[key] === 1 ? "vote" : "votes"}</span></li>`;
  return `${stackedBar(t.weight)}<ul class="tally">${row("favour", "In favour")}${row("against", "Against")}${row("abstain", "Abstain")}</ul>`;
}

// ----------------------------------------------------------------- voters
export function renderVoters() {
  const sel = $("voters-selector");
  sel.innerHTML = motionSelectorHTML() || `<p class="ed-hint">No motions yet.</p>`;
  wireMotionSelect(sel);
  const d = ensureDisplay(true);
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
    + (poll.status === "closed" ? "Closed: ballots are locked and kept with the result." : "set categories under Physicians");
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
      ${frozen ? "" : `<td class="act"><button type="button" class="ed-btn btn-quiet btn-sm" data-del="${escapeHtml(v.id)}" aria-label="Remove ${escapeHtml(v.name)}'s vote">Remove</button></td>`}
    </tr>`;
  }).join("");
  $("voters-table").innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th class="num">Weight${frozen ? `${icon("lock", 14)}<span class="sr">, frozen</span>` : ""}</th><th>Vote</th><th class="num">Submissions</th>${frozen ? "" : `<th><span class="sr">Remove</span></th>`}</tr></thead><tbody>${rows || `<tr><td colspan="${frozen ? 5 : 6}" class="ed-muted">No votes yet.</td></tr>`}</tbody>`;
  $("voters-table").querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirm("Remove this vote? This changes the result for this motion.")) return;
      clearVote(poll.id, b.dataset.del).catch((e) => R.actionFailed(e, "Not allowed: ballots of a closed motion are locked."));
    }));
}

function exportCsv() {
  const d = ensureDisplay(true);
  if (!d) { toast("No motion selected."); return; }
  // Exporting before the ballots land would write a confident, empty, wrong
  // result to a file someone then circulates.
  if (!d.loaded) { toast("Still loading ballots. Try again in a moment."); return; }
  const poll = d.poll, list = d.votes || [];
  const t = poll.status === "closed" && poll.result ? poll.result : resultOf(poll, list);
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
  lines.push(`Quorum,${t.quorumCount} of ${t.quorumNeeded}`);
  lines.push(`Result,${outcomeWords(t, "console").toUpperCase().replace("NO QUORUM: CANNOT PASS", "NO QUORUM")}`);
  download(new Blob([lines.join("\n")], { type: "text/csv" }), "motion-result.csv");
}

R.results = renderResults;
R.voters = renderVoters;
