// Admin console: the Settings view (the gear). The voting rules (points per
// vote, quorum, pass rule, tie wording, how long the change history is kept)
// and the change history itself. Also the name chip in the header: your name
// for the change history.
import {
  getLogPage, setLogName, classify, rulesNeedUpdate, DB_UPDATE_MSG, currentSettings, saveSettings, DEFAULT_RULE,
  keepYears, purgeOldHistory,
} from "./db.js?v=voting-12";
import { escapeHtml, toast } from "./util.js?v=voting-12";
import { $, R } from "./admin-state.js?v=voting-12";
import { logLine } from "./admin-results.js?v=voting-12";

const NAME_KEY = "mv_log_name", ASKED_KEY = "mv_log_name_asked";
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

export function wireSettings() {
  $("open-settings").addEventListener("click", () => { R.showTab("settings"); renderSettings(); });
  wireNameChip();
  $("history-load").addEventListener("click", () => loadHistory(false));
  $("history-more").addEventListener("click", () => loadHistory(true));
  $("rules-form").addEventListener("submit", (e) => { e.preventDefault(); saveRules(); });
  $("history-purge").addEventListener("click", async () => {
    const n = keepYears();
    if (!confirm(`Delete change-history entries older than ${n} years? Entries from the last ${n} years are kept. This cannot be undone.`)) return;
    $("history-purge").disabled = true;
    try { const d = await purgeOldHistory(); toast(d ? `Deleted ${d} old entr${d === 1 ? "y" : "ies"}.` : `Nothing older than ${n} years.`); }
    catch (e) { toast(classify(e) === "refused" ? ((await rulesNeedUpdate()) ? DB_UPDATE_MSG : "Not allowed: some entries are not old enough yet.") : "Not deleted: no connection. Try again."); }
    finally { $("history-purge").disabled = false; }
  });
  $("rules-form").addEventListener("input", () => { formDirty = true; });
}

// ---- the name chip ---------------------------------------------------------------
// Shows the saved name, or "Add your name" with a small dot until it has been
// looked at once on this laptop. Same storage as before (mv_log_name).
function paintChip() {
  const name = store.get(NAME_KEY);
  $("name-chip-text").textContent = name || "Add your name";
  $("name-chip").classList.toggle("empty", !name);
  $("name-chip-dot").classList.toggle("hide", !!name || !!store.get(ASKED_KEY));
}
function wireNameChip() {
  const menu = $("name-menu");
  $("log-name").value = store.get(NAME_KEY);
  paintChip();
  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    store.set(ASKED_KEY, "1");
    paintChip();
    // The field already holds the saved name (set on load and on Save); never
    // overwrite here, as this event can arrive after someone started typing.
    if (document.activeElement !== $("log-name")) $("log-name").focus();
  });
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveName($("log-name").value);
    menu.open = false;
    toast($("log-name").value.trim() ? "Saved on this laptop." : "Name cleared on this laptop.");
  });
}
function saveName(v) {
  const name = String(v || "").trim().slice(0, 80);
  store.set(NAME_KEY, name); store.set(ASKED_KEY, "1");
  setLogName(name);
  paintChip();
}
// ---- the voting rules ------------------------------------------------------------
let formDirty = false;
const DEFAULTS = { weights: DEFAULT_RULE.weights, quorumPercent: DEFAULT_RULE.quorumPercent,
  threshold: DEFAULT_RULE.threshold, tieRule: DEFAULT_RULE.tieRule, retentionYears: 7 };
export function renderSettings(force) {
  if (formDirty && !force) return;
  const st = { ...DEFAULTS, ...(currentSettings() || {}) };
  $("w-1").value = st.weights["1"]; $("w-2").value = st.weights["2"]; $("w-c").value = st.weights.courtesy;
  $("q-pct").value = st.quorumPercent;
  $("threshold").value = st.threshold;
  $("tie-rule").value = st.tieRule;
  $("keep-years").value = st.retentionYears || 7;
  $("check-in").checked = st.checkIn !== false;
  $("rules-err").classList.add("hide");
  $("history-purge").textContent = `Delete history older than ${keepYears()} years`;
  formDirty = false;
}
R.renderSettings = renderSettings;
// The screen refuses invalid values before saving (the rules refuse them too).
function readRules() {
  const num = (id) => Number(String($(id).value).trim());
  const w = { "1": num("w-1"), "2": num("w-2"), courtesy: num("w-c") };
  const problems = [];
  const okW = (x) => Number.isFinite(x) && x >= 0 && x <= 1 && Math.abs(Math.round(x * 20) - x * 20) < 1e-9;
  if (!okW(w["1"]) || !okW(w["2"]) || !okW(w.courtesy)) problems.push("Points per vote must be between 0 and 1, in steps of 0.05.");
  const q = num("q-pct");
  if (!Number.isInteger(q) || q < 1 || q > 100) problems.push("Quorum must be a whole number from 1 to 100.");
  const keep = num("keep-years");
  if (!Number.isInteger(keep) || keep < 7 || keep > 50) problems.push("Keep the change history at least 7 years (whole years, up to 50).");
  return { problems, value: { weights: w, quorumPercent: q, threshold: $("threshold").value, tieRule: $("tie-rule").value, retentionYears: keep, checkIn: $("check-in").checked } };
}
async function saveRules() {
  const { problems, value } = readRules();
  const err = $("rules-err");
  if (problems.length) {
    err.innerHTML = problems.map((p) => escapeHtml(p)).join("<br>");
    err.classList.remove("hide");
    return;
  }
  err.classList.add("hide");
  $("settings-save").disabled = true;
  try {
    await saveSettings(value);
    formDirty = false;
    toast("Saved. Applies to motions opened from now on. Closed motions keep their results. The open motion keeps the rules it opened with.");
  } catch (e) {
    const why = classify(e) === "refused" ? ((await rulesNeedUpdate()) ? DB_UPDATE_MSG : "Not allowed: the database refused these settings.") : "Not saved: no connection. Try again.";
    toast(why);
  } finally { $("settings-save").disabled = false; }
}

let lastEntry = null;
async function loadHistory(more) {
  const box = $("history-list");
  if (!more) { box.innerHTML = `<li class="ed-muted">Loading...</li>`; lastEntry = null; }
  try {
    const list = await getLogPage(50, more ? lastEntry : null);
    const html = list.map((e) => `<li>${escapeHtml(logLine(e))}</li>`).join("");
    if (more) box.insertAdjacentHTML("beforeend", html);
    else box.innerHTML = html || `<li class="ed-muted">No changes recorded yet.</li>`;
    lastEntry = list.length ? list[list.length - 1] : lastEntry;
    $("history-more").classList.toggle("hide", list.length < 50);
  } catch (e) {
    const why = classify(e) === "refused" && (await rulesNeedUpdate()) ? DB_UPDATE_MSG : "Could not load the change history. Check your connection and try again.";
    box.innerHTML = `<li class="ed-muted">${escapeHtml(why)}</li>`;
  }
}
