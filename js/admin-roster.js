// Leadership console: the Physicians tab (categories, add, remove, restore).
import { ROSTER_BY_SLUG, WEIGHTS } from "./roster.js";
import {
  setPersonGroup, resolvedRoster, effectiveGroup, eligibleCount, quorumThreshold,
  addPhysician, removePhysician, restorePhysician, removedRoster, rosterPerson, isRemoved,
} from "./db.js";
import { escapeHtml, fmt, csv, toast } from "./util.js";
import { $, S, R, catLabel, uiCat, download } from "./admin-state.js";

let rosterFilter = "";
const knownWriteins = {};   // slug -> name, gathered from ballots seen this session

export function wireRoster() {
  $("roster-filter").addEventListener("input", (e) => { rosterFilter = e.target.value; renderRosterTab(); });
  $("export-roster").addEventListener("click", exportRoster);
  wireAddPhysician();
}

export function collectWriteins(votes) {
  let changed = false;
  votes.forEach((v) => { if (v.isWriteIn && !(v.slug in knownWriteins)) { knownWriteins[v.slug] = v.name; changed = true; } });
  if (changed) renderRosterTab();
}
export function renderRosterTab() {
  // base roster (with current category overrides) + any write-ins who've voted,
  // so leadership can grant them a category too.
  $("roster-summary").textContent =
    `${resolvedRoster().length} listed physicians · ${eligibleCount(null)} currently eligible · quorum = ${quorumThreshold(null)} (50% of eligible).`;
  const writeins = Object.keys(knownWriteins)
    .filter((slug) => !ROSTER_BY_SLUG[slug] && !rosterPerson(slug) && !isRemoved(slug))
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
      <td class="act"><div class="row-act"><div class="ed-seg cat-seg" role="group" aria-label="Category for ${escapeHtml(p.name)}">${btn("1", "Full")}${btn("2", "Half")}${btn("courtesy", "No vote")}</div>${p.isWriteIn ? "" : `<button type="button" class="ed-btn btn-quiet btn-sm" data-remove="${escapeHtml(p.slug)}" data-name="${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(p.name)} from the list">Remove</button>`}</div></td>
    </tr>`;
  }).join("");
  $("roster-table").innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th class="num">Points</th><th>Set category</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="ed-muted">No match.</td></tr>`}</tbody>`;
  $("roster-table").querySelectorAll("button[data-setgrp]").forEach((b) =>
    b.addEventListener("click", () => setPersonGroup(b.dataset.slug, b.dataset.setgrp).then(() => toast("Category updated."))));
  $("roster-table").querySelectorAll("button[data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      const live = S.activePoll ? " If they have voted on the open motion, that vote stops counting." : "";
      if (!confirm(`Remove ${b.dataset.name} from the list? They can no longer pick their name to vote. Closed motions keep their results.${live} You can restore them below.`)) return;
      removePhysician(b.dataset.remove).then(() => toast(`${b.dataset.name} removed.`), () => toast("Could not save. Check your connection and try again."));
    }));
  renderRemoved();
}
// Removed physicians, each with Restore (nothing is ever deleted).
function renderRemoved() {
  const gone = removedRoster();
  $("removed-card").classList.toggle("hide", !gone.length);
  $("removed-list").innerHTML = gone.map((p) => `<li><span>${escapeHtml(p.name)}</span><button type="button" class="ed-btn ed-btn-tinted btn-sm" data-restore="${escapeHtml(p.slug)}" data-name="${escapeHtml(p.name)}">Restore</button></li>`).join("");
  $("removed-list").querySelectorAll("button[data-restore]").forEach((b) =>
    b.addEventListener("click", () => restorePhysician(b.dataset.restore).then(() => toast(`${b.dataset.name} restored.`), () => toast("Could not save. Check your connection and try again."))));
}
// Add a physician: a name and a category. Same name as a removed physician
// restores them; same name as someone listed changes nothing.
function wireAddPhysician() {
  let group = "1";
  const seg = $("add-cat");
  seg.querySelectorAll("button[data-grp]").forEach((b) => b.addEventListener("click", () => {
    group = b.dataset.grp;
    seg.querySelectorAll("button[data-grp]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("add-name").value.trim().replace(/\s+/g, " ");
    if (name.length < 3 || !/[a-z]/i.test(name)) { toast("Type the physician's full name."); return; }
    const btn = $("add-go");
    btn.disabled = true;
    try {
      const r = await addPhysician(name, group);
      if (r === "exists") toast(`${name} is already on the list.`);
      else { toast(r === "restored" ? `${name} restored.` : `${name} added.`); $("add-name").value = ""; }
    } catch (err) { console.error(err); toast("Could not save. Check your connection and try again."); }
    finally { btn.disabled = false; }
  });
}
function exportRoster() {
  const lines = ["Name,Category,Points per vote"];
  resolvedRoster().forEach((p) => lines.push([csv(p.name), catLabel(p.group), p.weight].join(",")));
  download(new Blob([lines.join("\n")], { type: "text/csv" }), "physician-roster.csv");
}

R.roster = renderRosterTab;
R.collectWriteins = collectWriteins;
