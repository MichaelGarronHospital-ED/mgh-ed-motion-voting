// ============================================================================
//  Leadership console: state and helpers shared by its modules.
//  admin.js (shell, sign-in, tabs) loads admin-motions.js, admin-results.js,
//  admin-roster.js and records.js; they share state through S and redraw each
//  other through R, so no module imports another (no import cycles).
// ============================================================================
import { escapeHtml, icon } from "./util.js";

export const $ = (id) => document.getElementById(id);

// Shared state, filled by admin.js's listeners.
export const S = {
  polls: [],
  activePoll: null,
  activeVotes: [],
  activeLoaded: false,   // has the open motion's first ballot snapshot arrived?
  selectedPollId: null,  // Results/Voters: which motion to view (null = current/open)
};

// Redraw hooks, set by each module: R.motions(), R.results(), R.voters(),
// R.roster(), and R.showTab(name), R.motionAction(act, id).
export const R = {};

// A collapsible card. The header is a real button (keyboard and screen-reader
// reachable) that says whether it is open; it expands to an optional hint + rows.
export function collapsibleCard(id, ic, title, count, expanded, blurb, rowsHtml) {
  return `<section class="card group">
    <h2 class="group-head"><button type="button" class="disclosure" id="${id}-header" aria-expanded="${expanded}" aria-controls="${id}-body">
      ${ic ? icon(ic, 20) : ""}<span class="t">${title}</span><span class="count">${count}</span>${icon("chevron", 20)}
    </button></h2>
    ${expanded ? `<div class="group-body" id="${id}-body">${blurb ? `<p class="ed-hint">${blurb}</p>` : ""}${rowsHtml}</div>` : ""}
  </section>`;
}
export const STATUS_PILL = { open: "ed-pill-good", closed: "ed-pill-quiet", draft: "ed-pill-info" };
export const STATUS_WORD = { open: "Open", closed: "Closed", draft: "Draft" };
export function statusPill(status) {
  return `<span class="ed-pill ${STATUS_PILL[status] || "ed-pill-quiet"}">${status === "open" ? '<span class="dot"></span>' : ""}${STATUS_WORD[status] || escapeHtml(status)}</span>`;
}

// ----------------------------------------------------------------- category labels
// catLabel feeds the CSV and Excel records: keep its words exactly as they are.
export function catLabel(g){return g==="1"?"Full vote":g==="2"?"Half vote":g==="courtesy"?"No vote":g==="removed"?"Removed":"— (uncategorized)";}
export function uiCat(g){return g==="1"||g==="2"||g==="courtesy"?catLabel(g):"Uncategorized";}   // on screen
export function groupLabel(g){return catLabel(g);}   // same short labels in the Voters table / CSV

// Download a Blob as a file.
export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
