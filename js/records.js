// Admin console: records (Excel download and printed results).
// A meeting's votes live only in Firestore, so leadership needs a copy it keeps:
// every motion with its result, every named ballot, and the roster, in one Excel
// file; or the results on paper / as a PDF. Ballots are read fresh for every
// motion (not just the one on screen), so the file is complete.
import { ORG_NAME } from "./config.js?v=voting-14";
import {
  weightForVote, groupForVote, getVotesFor, resolvedRoster, eligibleCount, quorumThreshold,
  resultOf, outcomeWords, sortMotions, currentRule, liveEligible, quorumNeededFor, weightIn,
  currentMeetings, agendaOrder, getLogForMeeting, tsMillis, getAttendanceOnce, ballotReceipt,
} from "./db.js?v=voting-14";
import { escapeHtml, labelOf, fmt, toast, voteWords } from "./util.js?v=voting-14";
import { buildXlsx, XLSX_MIME } from "./xlsx.js?v=voting-14";
import { $, S, R, catLabel, groupLabel, download, meetingLabel, niceDate } from "./admin-state.js?v=voting-14";

export function wireRecords() {
  $("export-all").addEventListener("click", () => { closeMenu(); exportAll(); });
  $("print-all").addEventListener("click", () => { closeMenu(); printAll(); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#export-menu")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
}

function closeMenu() { const m = $("export-menu"); if (m) m.open = false; }
const today = () => new Date().toISOString().slice(0, 10);
const statusWord = (p) => p.deleted ? "In trash" : p.status === "open" ? "Open" : p.status === "closed" ? "Closed" : "Draft";

// Closed motions use their saved result; others are counted from their ballots.
async function gatherRecords() {
  const list = sortMotions(S.polls);
  const votes = await Promise.all(list.map((p) => getVotesFor(p.id)));
  return list.map((p, i) => {
    const vs = votes[i];
    const t = p.status === "closed" && p.result ? p.result : resultOf(p, vs);
    const verdict = !t.totalVotes ? (p.status === "draft" ? "Not yet voted" : "No ballots") : outcomeWords(t, "record");
    let result = p.status === "open" && vs.length ? `${verdict} (voting still open)` : verdict;
    if (p.status === "closed" && !p.result && vs.length) result += " (result not saved yet)";
    return { n: i + 1, poll: p, votes: vs, t, quorum: t.quorumNeeded, result };
  });
}

function recordTables(recs) {
  const roster = resolvedRoster();
  const motions = [["#", "Motion", "Status", "Archived", "Result",
    "In favour (pts)", "Against (pts)", "Abstain (pts)", "In favour (votes)", "Against (votes)", "Abstain (votes)",
    "Ballots", "Eligible who voted", "Quorum needed", "Write-ins", "Flagged for review", "Options (points, votes)"]];
  const ballots = [["#", "Motion", "Name", "Category", "Weight", "Vote", "Submissions", "Flagged", "Write-in"]];
  recs.forEach((r) => {
    const { poll: p, t } = r;
    motions.push([r.n, p.text, statusWord(p), p.archived ? "Yes" : "", r.result,
      t.weight.favour, t.weight.against, t.weight.abstain, t.count.favour, t.count.against, t.count.abstain,
      t.totalVotes, t.quorumCount, r.quorum, t.writeIns, t.flags, optionsText(t)]);
    [...r.votes].sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => ballots.push([
      r.n, p.text, v.name, v.isWriteIn ? "Write-in" : groupLabel(groupForVote(v, p)), weightForVote(v, p),
      voteWords(v, p), v.submissionCount || 1, v.flagged ? "Yes" : "", v.isWriteIn ? "Yes" : ""]));
  });
  const rosterRows = [["Name", "Category", "Points per vote"]];
  const rule = currentRule();
  [...roster].sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => rosterRows.push([p.name, catLabel(p.group), weightIn(rule, p.group)]));
  const eligibleNow = liveEligible(rule), quorumNow = quorumNeededFor(eligibleNow, rule.quorumPercent);
  const live = recs.filter((r) => !r.poll.deleted);
  const summary = [["Item", "Value"],
    ["Exported", new Date().toLocaleString()],
    ["Tool", ORG_NAME],
    ["Motions", live.length],
    ["In trash", recs.length - live.length],
    ["Eligible voters (today)", eligibleNow],
    ["Quorum (today)", quorumNow],
    ["Full vote", roster.filter((p) => p.group === "1").length],
    ["Half vote", roster.filter((p) => p.group === "2").length],
    ["No vote", roster.filter((p) => p.group === "courtesy").length],
    ["Pass rule", `Today's default for new motions: ${rule.threshold === "twoThirds" ? "at least two-thirds of the weighted votes for or against" : "weighted In favour must exceed weighted Against"}; abstentions count toward quorum only. Quorum is ${rule.quorumPercent}% of eligible voters, rounded up. Each motion is counted with the rules it opened with, and closed motions keep their saved results.`]];
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
    download(new Blob([bytes], { type: XLSX_MIME }), `motion-voting-records-${today()}.xlsx`);
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
        ${tt.kind === "choice" ? (tt.options || []).map((o) => `<tr><td>${escapeHtml(o.label)}</td><td>${fmt(o.weight)}</td><td>${o.count}</td></tr>`).join("")
          : `<tr><td>In favour</td><td>${fmt(tt.weight.favour)}</td><td>${tt.count.favour}</td></tr>
        <tr><td>Against</td><td>${fmt(tt.weight.against)}</td><td>${tt.count.against}</td></tr>`}
        <tr><td>Abstain</td><td>${fmt(tt.weight.abstain)}</td><td>${tt.count.abstain}</td></tr>
      </tbody></table></section>`;
  }).join("");
  showPrint(`<h1>${escapeHtml(ORG_NAME)}: results</h1>
    <p class="pr-sub">Printed ${escapeHtml(new Date().toLocaleString())} &middot; eligible voters today ${liveEligible(currentRule())}, quorum ${quorumNeededFor(liveEligible(currentRule()), currentRule().quorumPercent)}</p>
    ${blocks || "<p>No motions yet.</p>"}
    <p class="pr-sub">${escapeHtml(t.summary[t.summary.length - 1][1])} Named ballots are in the Excel export.</p>`);
}

export function showPrint(html) {
  let el = document.getElementById("printReport");
  if (!el) { el = document.createElement("div"); el.id = "printReport"; document.body.appendChild(el); }
  el.innerHTML = html;
  document.body.classList.add("printing-report");
  const done = () => { document.body.classList.remove("printing-report"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1000);
}

// A question's or election's options with their points and votes.
function optionsText(t) {
  return t.kind === "choice" ? (t.options || []).map((o) => `${o.label}: ${o.weight} pts, ${o.count} votes`).join("; ") : "";
}

// ---- one meeting's records -------------------------------------------------------
// Five sheets: Meeting, Motions, Ballots, Attendance, Changes. Built from the
// saved results; each motion's ballots read once.
const when = (t) => { const ms = tsMillis(t); return ms === null ? "" : new Date(ms).toLocaleString(); };
const ruleWords = (r) => !r ? "" : `${r.threshold === "twoThirds" ? "Two-thirds of the points cast" : "More points in favour than against"}; quorum ${r.quorumPercent}%; points ${r.weights["1"]} / ${r.weights["2"]} / ${r.weights.courtesy}${r.tieRule === "fails" ? "; a tie does not pass" : ""}`;
async function gatherMeeting(meetingId) {
  const m = currentMeetings().find((x) => x.id === meetingId);
  const rows = agendaOrder(S.polls.filter((p) => p.meetingId === meetingId));
  const votes = await Promise.all(rows.map((r) => getVotesFor(r.poll.id)));
  let log = [], attendance = [];
  try { log = await getLogForMeeting(meetingId); } catch (e) { console.warn(e); }
  try { attendance = await getAttendanceOnce(meetingId); } catch (e) { console.warn(e); }
  const recs = rows.map((r, i) => {
    const p = r.poll, vs = votes[i];
    const t = p.status === "closed" && p.result ? p.result : resultOf(p, vs);
    const verdict = !t.totalVotes ? (p.status === "draft" ? "Not yet voted" : "No ballots") : outcomeWords(t, "record");
    return { number: r.number, poll: p, votes: vs, t, result: p.status === "open" && vs.length ? `${verdict} (voting still open)` : verdict };
  });
  return { m, recs, log, attendance };
}
function meetingTables({ m, recs, log, attendance = [] }) {
  const att = Object.fromEntries(attendance.map((a) => [a.slug, a]));
  const numOf = Object.fromEntries(recs.map((r) => [r.poll.id, r.number]));
  const people = new Map();   // slug -> { name, group, motions }
  recs.forEach((r) => r.votes.forEach((v) => {
    const e = people.get(v.slug) || { name: v.name, group: v.isWriteIn ? "writein" : groupForVote(v, r.poll), motions: [] };
    e.motions.push(r.number);
    people.set(v.slug, e);
  }));
  const rules = [...new Set(recs.filter((r) => r.poll.status !== "draft").map((r) => ruleWords(r.t.rule)))];
  const meeting = [["Item", "Value"],
    ["Meeting", m.title || ""], ["Date", niceDate(m.date)], ["Status", m.status === "open" ? "Open" : m.status === "closed" ? "Ended" : "Planned"],
    ["Started", when(m.startedAt)], ["Ended", when(m.endedAt)], ["Chair", m.chair || ""], ["Notes", m.notes || ""],
    ["Checked in", attendance.length], ["In the room", attendance.filter((a) => a.mode === "room").length],
    ["Remote", attendance.filter((a) => a.mode === "remote").length],
    ["Voted at this meeting", people.size], ["Motions", recs.length], ["Pass rules used", rules.join(" | ")],
    ["Exported", new Date().toLocaleString()]];
  const motions = [["Number", "Motion", "Amendment of", "Type", "Mover", "Seconder", "Opened", "Closed", "Pass rule", "Result",
    "In favour (pts)", "Against (pts)", "Abstain (pts)", "In favour (votes)", "Against (votes)", "Abstain (votes)", "Quorum",
    "Re-vote or re-open", "Notes", "Options (points, votes)"]];
  recs.forEach((r) => {
    const p = r.poll, t = r.t;
    const notes = [];
    if (p.revoteOf) notes.push(`Re-vote. Reason: ${p.revoteReason || ""}`);
    if (p.supersededBy) notes.push("Replaced by a re-vote");
    if ((p.priorResults || []).length) notes.push(`Re-opened ${p.priorResults.length} time(s); earlier count: ${outcomeWords(p.priorResults[p.priorResults.length - 1], "record")}`);
    motions.push([r.number, p.text, p.amends ? (numOf[p.amends] || "") : "", p.amends ? "Amendment" : "Motion", p.mover || "", p.seconder || "",
      when(p.openedAt), p.status === "closed" ? when(p.closedAt) : "", ruleWords(t.rule), r.result,
      t.weight.favour, t.weight.against, t.weight.abstain, t.count.favour, t.count.against, t.count.abstain,
      `${t.quorumCount} of ${t.quorumNeeded}`, notes.join("; "), p.notes || "", optionsText(t)]);
  });
  const ballots = [["Number", "Motion", "Name", "Category", "Weight", "Vote", "Remote", "Receipt", "Submissions", "Flagged", "Write-in"]];
  recs.forEach((r) => [...r.votes].sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => ballots.push([
    r.number, r.poll.text, v.name, v.isWriteIn ? "Write-in" : groupLabel(groupForVote(v, r.poll)), weightForVote(v, r.poll),
    voteWords(v, r.poll), att[v.slug] && att[v.slug].mode === "remote" ? "Yes" : "", ballotReceipt(r.poll.id, v),
    v.submissionCount || 1, v.flagged ? "Yes" : "", v.isWriteIn ? "Yes" : ""])));
  // Everyone who checked in, was added, or voted.
  const sheet = [["Name", "Category", "Checked in as", "Time", "Motions voted on", "Note"]];
  const slugs = new Set([...Object.keys(att), ...people.keys()]);
  [...slugs].map((s) => {
    const a = att[s], e = people.get(s);
    const name = (a && a.name) || (e && e.name) || s;
    const how = a ? `${a.mode === "remote" ? "Remote" : "In the room"}${a.by === "leadership" ? " (added in the Admin console)" : ""}` : "Voted, did not check in";
    return [name, e ? (e.group === "writein" ? "Write-in" : catLabel(e.group)) : "", how, a ? when(a.at) : "", e ? e.motions.join(", ") : "", (a && a.note) || ""];
  }).sort((x, y) => x[0].localeCompare(y[0])).forEach((row) => sheet.push(row));
  const changes = [["Time", "Change", "By", "Details", "Reason"]];
  log.forEach((e) => changes.push([when(e.at), R.logAction ? R.logAction(e.action) : e.action, e.by || "", e.text || "", e.action === "catch-up" ? "" : (e.reason || "")]));
  return { meeting, motions, ballots, attendance: sheet, changes };
}
export async function exportMeeting(meetingId) {
  const btn = $("meeting-export");
  btn.disabled = true;
  try {
    const data = await gatherMeeting(meetingId);
    const t = meetingTables(data);
    const bytes = buildXlsx([
      { name: "Meeting", rows: t.meeting, widths: [24, 80] }, { name: "Motions", rows: t.motions },
      { name: "Ballots", rows: t.ballots }, { name: "Attendance", rows: t.attendance }, { name: "Changes", rows: t.changes },
    ]);
    const slug = String(data.m.title || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    download(new Blob([bytes], { type: XLSX_MIME }), `motion-voting-${data.m.date || today()}-${slug}.xlsx`);
    toast("Meeting records downloaded.");
  } catch (e) { console.error(e); toast("Could not export. Check your connection and try again."); }
  finally { btn.disabled = false; }
}
// Minutes style: no named ballots.
export async function printMeeting(meetingId) {
  let data;
  try { data = await gatherMeeting(meetingId); }
  catch (e) { console.error(e); toast("Could not load the results. Check your connection and try again."); return; }
  const { m, recs } = data;
  const blocks = recs.map((r) => {
    const p = r.poll, t = r.t;
    return `<section class="pr-motion"><h2>${escapeHtml(r.number)}. ${escapeHtml(p.text)}</h2>
      ${p.mover || p.seconder ? `<p class="pr-line">Moved by ${escapeHtml(p.mover || "(not recorded)")}; seconded by ${escapeHtml(p.seconder || "(not recorded)")}</p>` : ""}
      <p class="pr-line"><b>${escapeHtml(r.result)}</b> &middot; Quorum ${t.quorumCount} of ${t.quorumNeeded} &middot; ${t.totalVotes} ballot${t.totalVotes === 1 ? "" : "s"}${p.revoteOf ? ` &middot; Re-vote (${escapeHtml(p.revoteReason || "")})` : ""}${p.supersededBy ? " &middot; Replaced by a re-vote" : ""}</p>
      <table><thead><tr><th>Vote</th><th>Points</th><th>Votes</th></tr></thead><tbody>
        ${t.kind === "choice" ? (t.options || []).map((o) => `<tr><td>${escapeHtml(o.label)}</td><td>${fmt(o.weight)}</td><td>${o.count}</td></tr>`).join("")
          : `<tr><td>In favour</td><td>${fmt(t.weight.favour)}</td><td>${t.count.favour}</td></tr>
        <tr><td>Against</td><td>${fmt(t.weight.against)}</td><td>${t.count.against}</td></tr>`}
        <tr><td>Abstain</td><td>${fmt(t.weight.abstain)}</td><td>${t.count.abstain}</td></tr>
      </tbody></table>${p.notes ? `<p class="pr-line">Notes: ${escapeHtml(p.notes)}</p>` : ""}</section>`;
  }).join("");
  showPrint(`<h1>${escapeHtml(meetingLabel(m))}</h1>
    <p class="pr-sub">${m.startedAt ? `Started ${escapeHtml(when(m.startedAt))}. ` : ""}${m.endedAt ? `Ended ${escapeHtml(when(m.endedAt))}. ` : ""}${m.chair ? `Chair: ${escapeHtml(m.chair)}. ` : ""}Printed ${escapeHtml(new Date().toLocaleString())}.</p>
    ${blocks || "<p>No motions on this agenda.</p>"}
    <p class="pr-sub">Named ballots are in the Excel download.</p>`);
}
