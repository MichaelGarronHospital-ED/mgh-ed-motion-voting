// ============================================================================
//  Shared UI helpers, used by both the voter (vote.js) and the Admin console (admin.js)
//  pages. Each page loads this as its own module instance.
// ============================================================================

// Line icons (the shared ED look uses inline SVG drawn in currentColor, never
// emoji). Decorative: hidden from screen readers, so the words beside them carry
// the meaning. The filled "v-" verdict icons knock their mark out in the card colour.
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  minus: '<path d="M6 12h12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  trash: '<path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V4.5h5V7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  warn: '<path d="M10.3 4.4L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2v.1"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  "v-pass": '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="knock" d="M7.5 12.3l3 3 6-6.3"/>',
  "v-fail": '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="knock" d="M8.7 8.7l6.6 6.6M15.3 8.7l-6.6 6.6"/>',
  "v-tie": '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="knock" d="M8 10h8M8 14h8"/>',
  "v-noq": '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="knock" d="M12 7v6.2M12 16.6v.2"/>',
};
export function icon(name, size = 20) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

// The verdict line shared by both results views: one size, one icon per outcome.
// `kind` is pass | fail | tie | noq; `text` is the visible words.
export function verdictHTML(kind, text) {
  return `<p class="verdict ${kind}">${icon("v-" + kind, 28)}<span>${text}</span></p>`;
}

// One stacked bar of the weighted vote (in favour, against, abstain).
export function stackedBar(w) {
  const total = w.favour + w.against + w.abstain;
  const seg = (k) => total > 0 && w[k] > 0 ? `<span class="${k}" style="width:${(w[k] / total) * 100}%"></span>` : "";
  return `<div class="bar" aria-hidden="true">${seg("favour")}${seg("against")}${seg("abstain")}</div>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// Human label for a ballot choice (returns the input unchanged if unknown).
export function labelOf(c) {
  return c === "favour" ? "In favour" : c === "against" ? "Against" : c === "abstain" ? "Abstain" : c;
}

// Whole numbers as-is, otherwise one decimal (e.g. 1, 0.5, 1.5).
export function fmt(n) {
  return Number.isInteger(n) ? n : Number(n).toFixed(1);
}

// Quote a value for CSV output.
export function csv(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

// Brief toast notification (expects a #toast element on the page).
let toastT;
export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hide");
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.add("hide"), 2200);
}

// Ranked bars for a question or election result (options sorted by points):
// one row per option with its points and votes; winners marked.
export function choiceBars(r) {
  const opts = r.options || [];
  const max = Math.max(0, ...opts.map((o) => o.weight));
  const won = new Set(r.winners || []);
  const row = (o) => `<li class="${won.has(o.id) ? "won" : ""}">
      <div class="spread"><span class="lbl">${won.has(o.id) ? icon("check", 16) : ""}${escapeHtml(o.label)}</span>
        <span class="num"><strong>${fmt(o.weight)} pts</strong> · ${o.count} ${o.count === 1 ? "vote" : "votes"}</span></div>
      <div class="bar" aria-hidden="true"><span class="${won.has(o.id) ? "favour" : "abstain"}" style="width:${max > 0 ? (o.weight / max) * 100 : 0}%"></span></div>
    </li>`;
  const ab = r.abstain || { weight: 0, count: 0 };
  return `<ul class="choice-bars">${opts.map(row).join("")}</ul>
    <p class="ed-hint">Abstain: ${fmt(ab.weight)} pts · ${ab.count} ${ab.count === 1 ? "vote" : "votes"}${r.note ? `. ${escapeHtml(r.note)}` : ""}</p>`;
}
// What a ballot says, in words (a motion's choice, or a question's picks).
export function voteWords(v, poll) {
  if (v.choice === "pick") {
    const labels = Object.fromEntries(((poll && poll.options) || []).map((o) => [o.id, o.label]));
    return (v.picks || []).map((id) => labels[id] || id).join(", ");
  }
  return labelOf(v.choice);
}
