// Leadership console: records (Excel download and printed results).
// A meeting's votes live only in Firestore, so leadership needs a copy it keeps:
// every motion with its result, every named ballot, and the roster, in one Excel
// file; or the results on paper / as a PDF. Ballots are read fresh for every
// motion (not just the one on screen), so the file is complete.
import { ORG_NAME } from "./config.js";
import {
  tally, weightForVote, groupForVote, getVotesFor, resolvedRoster, eligibleCount, quorumThreshold,
} from "./db.js";
import { escapeHtml, labelOf, fmt, toast } from "./util.js";
import { buildXlsx, XLSX_MIME } from "./xlsx.js";
import { $, S, catLabel, groupLabel, download } from "./admin-state.js";

export function wireRecords() {
  $("export-all").addEventListener("click", () => { closeMenu(); exportAll(); });
  $("print-all").addEventListener("click", () => { closeMenu(); printAll(); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#export-menu")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
}

function closeMenu() { const m = $("export-menu"); if (m) m.open = false; }
const today = () => new Date().toISOString().slice(0, 10);
const statusWord = (p) => p.deleted ? "In trash" : p.status === "open" ? "Open" : p.status === "closed" ? "Closed" : "Draft";

async function gatherRecords() {
  const list = [...S.polls].sort((a, b) => (a.order || 0) - (b.order || 0));
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
        <tr><td>In favour</td><td>${fmt(tt.weight.favour)}</td><td>${tt.count.favour}</td></tr>
        <tr><td>Against</td><td>${fmt(tt.weight.against)}</td><td>${tt.count.against}</td></tr>
        <tr><td>Abstain</td><td>${fmt(tt.weight.abstain)}</td><td>${tt.count.abstain}</td></tr>
      </tbody></table></section>`;
  }).join("");
  showPrint(`<h1>${escapeHtml(ORG_NAME)}: results</h1>
    <p class="pr-sub">Printed ${escapeHtml(new Date().toLocaleString())} &middot; eligible voters today ${eligibleCount(null)}, quorum ${quorumThreshold(null)}</p>
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
