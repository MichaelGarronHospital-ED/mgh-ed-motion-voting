// Leadership console: the Results and Voters tabs, and the one-motion CSV.
import {
  onVotesFor, clearVote, tally, weightForVote, groupForVote, quorumThreshold,
} from "./db.js";
import { escapeHtml, labelOf, fmt, csv, toast, icon, verdictHTML, stackedBar } from "./util.js";
import { $, S, R, STATUS_WORD, statusPill, groupLabel, download } from "./admin-state.js";

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
  return S.activePoll || [...S.polls].reverse().find((p) => p.status === "closed" && !p.archived && !p.deleted) || null;
}
function motionSelectorHTML() {
  const choosable = S.polls.filter((p) => !p.deleted);
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

let displayUnsub = null, displayId = null, displayVotes = [], displayLoaded = false;
function ensureDisplay() {
  const poll = displayPoll();
  if (!poll) {
    if (displayUnsub) { displayUnsub(); displayUnsub = null; }
    displayId = null; displayVotes = []; displayLoaded = false;
    return null;
  }
  if (S.activePoll && poll.id === S.activePoll.id) {
    if (displayUnsub) { displayUnsub(); displayUnsub = null; displayId = null; displayLoaded = false; }
    return { poll, votes: S.activeVotes, loaded: S.activeLoaded };   // reuse the live subscription
  }
  if (poll.id !== displayId) {                          // a closed poll: subscribe once
    if (displayUnsub) displayUnsub();
    displayId = poll.id; displayVotes = []; displayLoaded = false;
    displayUnsub = onVotesFor(poll.id, (vs) => { displayVotes = vs; displayLoaded = true; R.collectWriteins(vs); renderResults(); renderVoters(); });
  }
  return { poll, votes: displayVotes, loaded: displayLoaded };
}

export function renderResults() {
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
  if (c) c.addEventListener("click", () => R.motionAction("close", poll.id));
  if (o) o.addEventListener("click", () => R.motionAction("open", poll.id));
}

// One stacked bar plus a legend with the weighted points and head counts.
function bars(t) {
  const row = (key, label) => `<li><i class="sw ${key}"></i><span class="lbl">${label}</span>
      <span class="num"><strong>${fmt(t.weight[key])} pts</strong> · ${t.count[key]} ${t.count[key] === 1 ? "vote" : "votes"}</span></li>`;
  return `${stackedBar(t.weight)}<ul class="tally">${row("favour", "In favour")}${row("against", "Against")}${row("abstain", "Abstain")}</ul>`;
}

// ----------------------------------------------------------------- voters
export function renderVoters() {
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
  download(new Blob([lines.join("\n")], { type: "text/csv" }), "motion-result.csv");
}

R.results = renderResults;
R.voters = renderVoters;
