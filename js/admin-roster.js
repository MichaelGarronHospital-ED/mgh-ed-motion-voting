// Admin console: the Physicians tab (categories, add, remove, restore,
// write-ins to review, and updating the list by pasting).
import { ROSTER_BY_SLUG } from "./roster.js?v=voting-11";
import {
  setPersonGroup, resolvedRoster, effectiveGroup, addPhysician, removePhysician, restorePhysician,
  removedRoster, rosterPerson, isRemoved, rosterWriteins, dismissWritein, applyRosterChanges, currentRule,
  liveEligible, quorumNeededFor, weightIn, parseRoster,
} from "./db.js?v=voting-11";
import { escapeHtml, fmt, csv, toast } from "./util.js?v=voting-11";
import { $, S, R, catLabel, uiCat, download } from "./admin-state.js?v=voting-11";

let rosterFilter = "";
const knownWriteins = {};   // slug -> name, from ballots seen this session (also kept in config/roster.writeins)

export function wireRoster() {
  $("roster-filter").addEventListener("input", (e) => { rosterFilter = e.target.value; renderRosterTab(); });
  $("export-roster").addEventListener("click", exportRoster);
  $("paste-preview").addEventListener("click", () => { pasteSame = {}; preview(); });
  wireAddPhysician();
}

export function collectWriteins(votes) {
  let changed = false;
  votes.forEach((v) => { if (v.isWriteIn && !(v.slug in knownWriteins)) { knownWriteins[v.slug] = v.name; changed = true; } });
  if (changed) renderRosterTab();
}
const pts = (w) => (w === 1 ? "1 point" : `${fmt(w)} point${w === 1 ? "" : "s"}`);
export function renderRosterTab() {
  const rule = currentRule();
  const eligible = liveEligible(rule);
  const quorum = quorumNeededFor(eligible, rule.quorumPercent);
  $("roster-summary").textContent =
    `${resolvedRoster().length} listed physicians · ${eligible} currently eligible · quorum = ${quorum} (${rule.quorumPercent}% of eligible).`;
  $("keylist").innerHTML = `
    <li><strong>Full vote</strong> <span class="ed-muted">(Group 1, ${pts(rule.weights["1"])}):</span> active staff, 8 or more shifts a month</li>
    <li><strong>Half vote</strong> <span class="ed-muted">(Group 2, ${pts(rule.weights["2"])}):</span> active under 8 shifts, provisional active, active secondary site</li>
    <li><strong>No vote</strong> <span class="ed-muted">(Courtesy, ${fmt(rule.weights.courtesy)}):</span> ${rule.weights.courtesy > 0 ? "counted" : "recorded but not counted"}</li>`;
  // Write-ins who voted: from this session's ballots and config/roster.writeins.
  const wi = rosterWriteins();
  const names = { ...Object.fromEntries(Object.entries(wi).map(([k, v]) => [k, v.name])), ...knownWriteins };
  const writeins = Object.keys(names)
    .filter((slug) => !ROSTER_BY_SLUG[slug] && !rosterPerson(slug) && !isRemoved(slug))
    .map((slug) => { const g = effectiveGroup(slug); return { name: names[slug], slug, group: g, weight: weightIn(rule, g), isWriteIn: true }; });
  const roster = resolvedRoster().map((p) => ({ ...p, weight: weightIn(rule, p.group) })).concat(writeins);
  const g1 = roster.filter((p) => p.group === "1").length;
  const g2 = roster.filter((p) => p.group === "2").length;
  const cy = roster.filter((p) => p.group === "courtesy").length;
  $("roster-counts").innerHTML =
    `Full vote <strong>${g1}</strong> · Half vote <strong>${g2}</strong> · No vote <strong>${cy}</strong> · Eligible <strong>${eligible}</strong> · Quorum <strong>${quorum}</strong>`;

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
    b.addEventListener("click", () => setPersonGroup(b.dataset.slug, b.dataset.setgrp).then(() => toast("Category updated."), (e) => R.actionFailed(e, "Not allowed: the database refused this change."))));
  $("roster-table").querySelectorAll("button[data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      const live = S.activePoll ? " If they have voted on the open motion, that vote stops counting." : "";
      if (!confirm(`Remove ${b.dataset.name} from the list? They can no longer pick their name to vote. Closed motions keep their results.${live} You can restore them below.`)) return;
      removePhysician(b.dataset.remove).then(() => toast(`${b.dataset.name} removed.`), () => toast("Could not save. Check your connection and try again."));
    }));
  renderRemoved();
  renderWriteins();
}

// ---- write-ins to review (always visible: kept in config/roster.writeins) ------
function renderWriteins() {
  const wi = rosterWriteins();
  const motion = (id) => { const p = S.polls.find((x) => x.id === id); return p ? p.text : "a motion since deleted"; };
  const list = Object.entries(wi)
    .filter(([slug, w]) => w && w.status === "new" && !rosterPerson(slug))
    .map(([slug, w]) => ({ slug, ...w }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const tab = document.querySelector('.tab[data-tab="roster"]');
  tab.textContent = list.length ? `Physicians ${list.length}` : "Physicians";
  const card = $("writeins-card");
  card.classList.toggle("hide", !list.length);
  if (!list.length) { card.innerHTML = ""; return; }
  card.innerHTML = `<h2>Write-ins to review</h2>
    <p class="ed-hint">People who typed their own name. Their votes count 0 points until they are added with a category.</p>
    <ul class="plain-list writein-list">${list.map((w) => {
      const removed = isRemoved(w.slug);
      const short = motion(w.firstPollId || "");
      const actions = removed
        ? `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-wi-restore="${escapeHtml(w.slug)}">Restore ${escapeHtml(w.name)}</button>`
        : `<button type="button" class="ed-btn ed-btn-tinted btn-sm" data-wi-add="1" data-slug="${escapeHtml(w.slug)}">Add as Full</button>
           <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-wi-add="2" data-slug="${escapeHtml(w.slug)}">Add as Half</button>
           <button type="button" class="ed-btn ed-btn-tinted btn-sm" data-wi-add="courtesy" data-slug="${escapeHtml(w.slug)}">Add as No vote</button>`;
      return `<li><div><strong>${escapeHtml(w.name)}</strong> <span class="ed-muted">first voted on: ${escapeHtml(short.length > 70 ? short.slice(0, 70) + "..." : short)}</span></div>
        <div class="row">${actions}<button type="button" class="ed-btn btn-quiet btn-sm" data-wi-dismiss="${escapeHtml(w.slug)}">Not a physician</button></div></li>`;
    }).join("")}</ul>`;
  const nameOf = (slug) => (wi[slug] && wi[slug].name) || slug;
  card.querySelectorAll("[data-wi-add]").forEach((b) => b.addEventListener("click", () =>
    addPhysician(nameOf(b.dataset.slug), b.dataset.wiAdd, "writein").then(() => toast(`${nameOf(b.dataset.slug)} added.`), (e) => R.actionFailed(e, "Not allowed: the database refused this change."))));
  card.querySelectorAll("[data-wi-restore]").forEach((b) => b.addEventListener("click", () =>
    restorePhysician(b.dataset.wiRestore).then(() => toast(`${nameOf(b.dataset.wiRestore)} restored.`), (e) => R.actionFailed(e, "Not allowed: the database refused this change."))));
  card.querySelectorAll("[data-wi-dismiss]").forEach((b) => b.addEventListener("click", () =>
    dismissWritein(b.dataset.wiDismiss).then(() => toast("Marked as not a physician. Their votes stay at 0 points."), (e) => R.actionFailed(e, "Not allowed: the database refused this change."))));
}

// ---- update the list by pasting ---------------------------------------------------
let pasteSame = {};   // answers to "same person?": pastedSlug -> existingSlug | "new"
let pasteDiff = null;
function preview() {
  const roster = resolvedRoster().map((p) => ({ name: p.name, slug: p.slug, group: p.group }));
  pasteDiff = parseRoster($("paste-text").value, roster, pasteSame);
  const d = pasteDiff;
  const box = $("paste-result");
  // Long lists fold, so the changes stay in view.
  const section = (title, items, fold) => !items.length ? ""
    : fold && items.length > 8
      ? `<details class="about"><summary>${title} (${items.length})</summary><ul class="plain-list">${items.join("")}</ul></details>`
      : `<h3 class="group-title">${title} (${items.length})</h3><ul class="plain-list">${items.join("")}</ul>`;
  const html = [];
  if (d.tooMany) html.push(`<p class="notice">Only the first 300 lines are read.</p>`);
  html.push(section("New", d.added.map((p) => `<li>${escapeHtml(p.name)}: ${escapeHtml(catLabel(p.group))}</li>`)));
  html.push(section("Category changes", d.changed.map((c) => `<li>${escapeHtml(c.name)}: ${escapeHtml(catLabel(c.from))} to ${escapeHtml(catLabel(c.to))}</li>`)));
  html.push(section("Unchanged", d.unchanged.map((n) => `<li>${escapeHtml(n)}</li>`), true));
  if (d.missing.length) {
    html.push(section("Not in the pasted list", d.missing.map((m) => `<li>${escapeHtml(m.name)}</li>`), true));
    html.push(`<label class="check"><input type="checkbox" id="paste-remove" /> Also remove these ${d.missing.length} name${d.missing.length === 1 ? "" : "s"} (they leave the voters' list; nothing is deleted)</label>`);
  }
  html.push(section("Problems", d.problems.map((p) => `<li><strong>Line ${p.line}:</strong> ${escapeHtml(p.msg)}${p.kind === "alike"
    ? ` <span class="row"><button type="button" class="ed-btn ed-btn-tinted btn-sm" data-same="${escapeHtml(p.slug)}" data-other="${escapeHtml(p.other)}">Same person</button><button type="button" class="ed-btn ed-btn-plain btn-sm" data-new="${escapeHtml(p.slug)}">New person</button></span>`
    : ` <span class="ed-muted">(${escapeHtml(p.text)})</span>`}</li>`)));
  const n = d.added.length + d.changed.length;
  html.push(`<div class="row"><button type="button" id="paste-apply" class="ed-btn ed-btn-filled btn-sm" ${n || d.missing.length ? "" : "disabled"}>Apply changes</button>
    ${d.problems.length ? `<span class="ed-hint">Lines with a problem are left out.</span>` : ""}</div>`);
  box.innerHTML = html.join("");
  box.querySelectorAll("[data-same]").forEach((b) => b.addEventListener("click", () => { pasteSame[b.dataset.same] = b.dataset.other; preview(); }));
  box.querySelectorAll("[data-new]").forEach((b) => b.addEventListener("click", () => { pasteSame[b.dataset.new] = "new"; preview(); }));
  $("paste-apply").addEventListener("click", applyPaste);
}
async function applyPaste() {
  const d = pasteDiff;
  if (!d) return;
  const remove = !!($("paste-remove") && $("paste-remove").checked);
  if (remove && d.missing.length) {
    const live = S.activePoll ? " If any of them voted on the open motion, that vote stops counting." : "";
    if (!confirm(`Remove ${d.missing.length} name${d.missing.length === 1 ? "" : "s"} from the list? Closed motions keep their results.${live} You can restore them later.`)) return;
  }
  $("paste-apply").disabled = true;
  try {
    const n = await applyRosterChanges(d, remove);
    toast(`List updated: ${n} change${n === 1 ? "" : "s"}.`);
    $("paste-text").value = ""; $("paste-result").innerHTML = ""; pasteDiff = null;
  } catch (e) { $("paste-apply").disabled = false; R.actionFailed(e, "Not allowed: the database refused this change."); }
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
  const rule = currentRule();
  const lines = ["Name,Category,Points per vote"];
  resolvedRoster().forEach((p) => lines.push([csv(p.name), catLabel(p.group), weightIn(rule, p.group)].join(",")));
  download(new Blob([lines.join("\n")], { type: "text/csv" }), "physician-roster.csv");
}

R.roster = renderRosterTab;
R.collectWriteins = collectWriteins;
R.writeins = renderWriteins;
