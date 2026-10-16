// Leadership console: the Settings view. In this step of the upgrade it holds
// your name for the change history and the change history itself; the voting
// rules join it in the next step.
import { getLogPage, setLogName, classify, rulesNeedUpdate, DB_UPDATE_MSG } from "./db.js";
import { escapeHtml, toast } from "./util.js";
import { $, R } from "./admin-state.js";
import { logLine } from "./admin-results.js";

const NAME_KEY = "mv_log_name", ASKED_KEY = "mv_log_name_asked";
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

export function wireSettings() {
  $("open-settings").addEventListener("click", () => { R.showTab("settings"); renderSettings(); });
  $("log-name").value = store.get(NAME_KEY);
  $("name-form").addEventListener("submit", (e) => { e.preventDefault(); saveName($("log-name").value); toast("Saved on this laptop."); });
  $("history-load").addEventListener("click", () => loadHistory(false));
  $("history-more").addEventListener("click", () => loadHistory(true));
  // Asked once per laptop, at the top of the console.
  if (!store.get(NAME_KEY) && !store.get(ASKED_KEY)) {
    $("name-card").classList.remove("hide");
    $("ask-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("ask-name").value.trim();
      if (!v) { toast("Type your name, or choose Not now."); return; }
      saveName(v); $("log-name").value = v;
      $("name-card").classList.add("hide");
      toast("Saved on this laptop. You can change it in Settings.");
    });
    $("ask-skip").addEventListener("click", () => { store.set(ASKED_KEY, "1"); $("name-card").classList.add("hide"); });
  }
}
function saveName(v) {
  const name = String(v || "").trim().slice(0, 80);
  store.set(NAME_KEY, name); store.set(ASKED_KEY, "1");
  setLogName(name);
}
function renderSettings() { /* the rules screen arrives in the next step */ }

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
