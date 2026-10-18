// ============================================================================
//  Admin console: state and helpers shared by its modules.
//  admin.js (shell, sign-in, tabs) loads admin-motions.js, admin-results.js,
//  admin-roster.js and records.js; they share state through S and redraw each
//  other through R, so no module imports another (no import cycles).
// ============================================================================
import { escapeHtml, icon } from "./util.js?v=voting-11";

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
export function catLabel(g){return g==="1"?"Full vote":g==="2"?"Half vote":g==="courtesy"?"No vote":g==="removed"?"Removed":"Uncategorized";}
export function uiCat(g){return g==="1"||g==="2"||g==="courtesy"?catLabel(g):"Uncategorized";}   // on screen
export function groupLabel(g){return catLabel(g);}   // same short labels in the Voters table / CSV

// "Fri, Nov 20, 2026" from a stored YYYY-MM-DD date (local text, never shifted).
export function niceDate(d, withYear = true) {
  if (!d) return "";
  const [y, m, day] = String(d).split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}
export function meetingLabel(m) { return m ? `${m.title || "Meeting"}, ${niceDate(m.date)}` : ""; }

// ----------------------------------------------------------------- small controls
// The (i) info button: one per explanation, next to the thing it explains. The
// text shows on hover, on keyboard focus and on a tap, and closes on Escape or a
// tap elsewhere (wireInfo). Screen readers get the text as the button's
// description. `text` is plain text (escaped here); infoButtonHtml takes markup
// the caller has already escaped.
let infoN = 0;
export function infoButtonHtml(html, about) {
  const id = "info-pop-" + (++infoN);
  return `<span class="info"><button type="button" class="info-btn" aria-label="${escapeHtml(about ? "About " + about : "More information")}" aria-describedby="${id}" aria-expanded="false">${icon("info", 18)}</button><span class="info-pop" id="${id}" role="tooltip">${html}</span></span>`;
}
export function infoButton(text, about) { return infoButtonHtml(escapeHtml(text), about); }
// A button that is only an icon: always a name for screen readers and hover text.
export function iconBtn(ic, label, attrs = "", cls = "", title = label) {
  return `<button type="button" class="ed-btn icon-btn ${cls}" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}" ${attrs}>${icon(ic, 18)}</button>`;
}

// One set of listeners for every (i) on the page, now and redrawn later.
export function wireInfo() {
  let shown = null, pinned = false;
  const popOf = (btn) => btn.parentElement.querySelector(".info-pop");
  function hide() {
    if (!shown) return;
    if (shown.isConnected) { shown.setAttribute("aria-expanded", "false"); popOf(shown).classList.remove("show"); }
    shown = null; pinned = false;
  }
  function show(btn, pin) {
    if (shown !== btn) hide();
    const pop = popOf(btn);
    shown = btn; pinned = pinned || !!pin;
    btn.setAttribute("aria-expanded", "true");
    pop.classList.add("show");
    // Fixed to the window and kept inside it, so it never makes the page scroll sideways.
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, ht = pop.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 6 + ht <= window.innerHeight - 8;
    pop.style.left = left + "px";
    pop.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 6 - ht)) + "px";
  }
  const btnFrom = (e) => e.target.closest && e.target.closest(".info-btn");
  document.addEventListener("mouseover", (e) => { const b = btnFrom(e); if (b && !pinned) show(b); });
  document.addEventListener("mouseout", (e) => {
    const b = btnFrom(e);
    if (b && b === shown && !pinned && document.activeElement !== b && !b.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => { const b = btnFrom(e); if (b) show(b); else if (shown && !pinned) hide(); });
  document.addEventListener("focusout", (e) => { const b = btnFrom(e); if (b && b === shown && !pinned) hide(); });
  document.addEventListener("click", (e) => {
    const b = btnFrom(e);
    if (b) { e.preventDefault(); if (b === shown && pinned) hide(); else show(b, true); return; }
    if (shown) hide();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && shown) { const b = shown; hide(); if (b.isConnected) b.focus(); } });
  // Follow the button when the page scrolls (a tap can scroll it into view).
  window.addEventListener("scroll", () => { if (shown && shown.isConnected) show(shown); else hide(); }, { passive: true });
  window.addEventListener("resize", hide);
}

// Drop-down menus (<details class="menu">): one open at a time; a tap outside,
// Escape, or choosing an item closes it.
export function wireMenus() {
  const closeAll = (except) => document.querySelectorAll("details.menu[open]").forEach((d) => { if (d !== except) d.open = false; });
  document.addEventListener("click", (e) => {
    const inMenu = e.target.closest("details.menu");
    closeAll(inMenu);
    if (inMenu && e.target.closest(".menu-pop [role=menuitem]")) inMenu.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector("details.menu[open]");
    if (!open) return;
    open.open = false;
    const s = open.querySelector("summary"); if (s) s.focus();
  });
}

// Download a Blob as a file.
export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
