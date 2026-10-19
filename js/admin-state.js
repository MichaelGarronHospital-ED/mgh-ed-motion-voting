// ============================================================================
//  Admin console: state and helpers shared by its modules.
//  admin.js (shell, sign-in, tabs) loads admin-motions.js, admin-results.js,
//  admin-roster.js and records.js; they share state through S and redraw each
//  other through R, so no module imports another (no import cycles).
// ============================================================================
import { escapeHtml, icon } from "./util.js?v=voting-13";

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
      ${ic ? icon(ic, 20) : ""}<span class="t">${title}</span>${count ? `<span class="count">${count}</span>` : ""}${icon("chevron", 20)}
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
let infoShown = null, infoPinned = false;
const popOf = (btn) => btn.parentElement.querySelector(".info-pop");
function hideInfo() {
  if (!infoShown) return;
  if (infoShown.isConnected) { infoShown.setAttribute("aria-expanded", "false"); popOf(infoShown).classList.remove("show"); }
  infoShown = null; infoPinned = false;
}
function showInfo(btn, pin) {
  if (infoShown !== btn) hideInfo();
  const pop = popOf(btn);
  infoShown = btn; infoPinned = infoPinned || !!pin;
  btn.setAttribute("aria-expanded", "true");
  pop.classList.add("show");
  // Fixed to the window and kept inside it, so it never makes the page scroll sideways.
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, ht = pop.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 6 + ht <= window.innerHeight - 8;
  pop.style.left = left + "px";
  pop.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 6 - ht)) + "px";
}
export function wireInfo() {
  const btnFrom = (e) => e.target.closest && e.target.closest(".info-btn");
  document.addEventListener("mouseover", (e) => { const b = btnFrom(e); if (b && !infoPinned) showInfo(b); });
  document.addEventListener("mouseout", (e) => {
    const b = btnFrom(e);
    if (b && b === infoShown && !infoPinned && document.activeElement !== b && !b.contains(e.relatedTarget)) hideInfo();
  });
  document.addEventListener("focusin", (e) => { const b = btnFrom(e); if (b) showInfo(b); else if (infoShown && !infoPinned) hideInfo(); });
  document.addEventListener("focusout", (e) => { const b = btnFrom(e); if (b && b === infoShown && !infoPinned) hideInfo(); });
  document.addEventListener("click", (e) => {
    const b = btnFrom(e);
    if (b) { e.preventDefault(); if (b === infoShown && infoPinned) hideInfo(); else showInfo(b, true); return; }
    if (infoShown) hideInfo();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && infoShown) { const b = infoShown; hideInfo(); if (b.isConnected) b.focus(); } });
  // Follow the button when the page scrolls (a tap can scroll it into view).
  window.addEventListener("scroll", () => { if (infoShown && infoShown.isConnected) showInfo(infoShown); else hideInfo(); }, { passive: true });
  window.addEventListener("resize", hideInfo);
}

// Redraw part of the page without losing the person's place: keyboard focus
// (found again by id, else by its aria-label) and an (i) opened with a tap.
export function redrawKeeping(el, paint) {
  const fa = document.activeElement;
  const had = fa && fa !== document.body && el.contains(fa)
    ? { id: fa.id, label: fa.getAttribute("aria-label"), sel: "selectionStart" in fa && fa.selectionStart !== null ? [fa.selectionStart, fa.selectionEnd] : null } : null;
  const info = infoShown && infoPinned && el.contains(infoShown) ? infoShown.getAttribute("aria-label") : null;
  paint();
  const find = (label) => [...el.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === label);
  if (had) {
    const t = (had.id && el.querySelector("#" + CSS.escape(had.id))) || (had.label && find(had.label));
    if (t && t !== document.activeElement) {
      t.focus();
      if (had.sel && t.setSelectionRange) { try { t.setSelectionRange(had.sel[0], had.sel[1]); } catch (e) { /* not a text field */ } }
    }
  }
  if (info) {
    if (infoShown && !infoShown.isConnected) { infoShown = null; infoPinned = false; }
    const b = find(info);
    if (b && b.classList.contains("info-btn")) showInfo(b, true);
  }
}

// Shown on screen? checkVisibility() is missing before Safari 17.4.
export function isVisible(el) {
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
}

// Drop-down menus (<details class="menu">) hold plain buttons (.menu-item).
// One open at a time; a tap outside, Escape, focus leaving it, or choosing an
// item closes it. After an item, focus goes back to the menu's button unless
// the item moved it somewhere else (a form, another tab).
export function wireMenus() {
  const closeAll = (except) => document.querySelectorAll("details.menu[open]").forEach((d) => { if (d !== except) d.open = false; });
  // The menu's button, found again if the list was redrawn meanwhile.
  const summaryOf = (d) => (d.isConnected ? d : (d.id && document.getElementById(d.id))
    || (d.dataset.id && document.querySelector(`details.row-more[data-id="${CSS.escape(d.dataset.id)}"]`)) || d).querySelector("summary");
  document.addEventListener("click", (e) => {
    const inMenu = e.target.closest("details.menu");
    closeAll(inMenu);
    if (inMenu && e.target.closest(".menu-pop .menu-item")) {
      inMenu.open = false;
      setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body || inMenu.contains(a) || !a.isConnected) {
          const s = summaryOf(inMenu);
          if (s && s.isConnected && isVisible(s)) s.focus();
        }
      }, 0);
    }
  });
  document.addEventListener("focusout", (e) => {
    const d = e.target.closest && e.target.closest("details.menu[open]");
    if (d && e.relatedTarget && !d.contains(e.relatedTarget)) d.open = false;
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
