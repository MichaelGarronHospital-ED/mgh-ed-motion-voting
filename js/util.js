// ============================================================================
//  Shared UI helpers — used by both the voter (vote.js) and leadership (admin.js)
//  pages. Each page loads this as its own module instance.
// ============================================================================

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
