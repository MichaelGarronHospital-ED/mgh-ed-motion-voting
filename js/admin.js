// ============================================================================
//  Leadership console: the shell (sign-in, tabs) and the live listeners.
//  Each tab lives in its own module; they share state through admin-state.js.
// ============================================================================
import { ORG_NAME } from "./config.js";
import {
  onPolls, onVotesFor, onRosterOverrides, watchAuth, leaderSignIn, leaderSignOut, LEADER_EMAIL, isWrongPassword,
} from "./db.js";
import { toast, icon } from "./util.js";
import { $, S, R } from "./admin-state.js";
import { wireMotions } from "./admin-motions.js";
import { wireResults } from "./admin-results.js";
import { wireRoster } from "./admin-roster.js";
import { wireRecords } from "./records.js";

document.title = ORG_NAME + " · Leadership";

// ----------------------------------------------------------------- gate
let booted = false;
function unlock() {
  $("gate").classList.add("hide");
  $("console").classList.remove("hide");
  if (!booted) { booted = true; boot(); }
  updateTabHint();
}
// A real form: Enter in the field and a tap on Continue both submit it.
$("gate-form").addEventListener("submit", (e) => { e.preventDefault(); tryEnter(); });
// Only now can the form be used (see the comment in admin-9f4k2x7q.html).
$("gate-fields").disabled = false;
// The Leadership password is checked by Firebase itself (it is the password of
// the LEADER_EMAIL account); nothing about it is stored in this public code, and
// the console opens only on a real sign-in, so writes are always authorised.
async function tryEnter() {
  const typed = $("pass").value.trim(), err = $("gate-err");   // passwords never start or end with a space
  if (!typed) return;
  $("enter").disabled = true; err.classList.add("hide");
  try { await leaderSignIn(typed); unlock(); }
  catch (e) {
    const msg = isWrongPassword(e) ? "Incorrect password." : "Couldn't sign in. Check your connection and try again.";
    err.innerHTML = icon("alert", 18) + `<span>${msg}</span>`;
    err.classList.remove("hide");
  } finally { $("enter").disabled = false; }
}
// Auto-unlock on reload if a leadership session is already persisted.
watchAuth((user) => { if (user && user.email === LEADER_EMAIL) unlock(); });
$("lock").addEventListener("click", (e) => { e.preventDefault(); leaderSignOut().finally(() => location.reload()); });

// ----------------------------------------------------------------- tabs
function showTab(name) {
  document.querySelectorAll(".tab").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    x.setAttribute("aria-pressed", String(x.dataset.tab === name));
  });
  ["share", "motions", "results", "voters", "roster"].forEach((n) =>
    $("tab-" + n).classList.toggle("hide", n !== name));
}
R.showTab = showTab;
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => { showTab(t.dataset.tab); t.scrollIntoView({ block: "nearest", inline: "nearest" }); }));
// On a narrow phone the five tabs can run past the edge: fade the edge so it is
// clear there is more to scroll to.
const tabsNav = document.querySelector("#console .tabs");
function updateTabHint() {
  tabsNav.parentElement.classList.toggle("more", tabsNav.scrollLeft + tabsNav.clientWidth < tabsNav.scrollWidth - 2);
}
tabsNav.addEventListener("scroll", updateTabHint, { passive: true });
window.addEventListener("resize", updateTabHint);

// ----------------------------------------------------------------- boot
let votesUnsub = null;
function boot() {
  // share tab
  const url = location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html";
  $("vote-url").textContent = url;
  $("copy-url").addEventListener("click", () => { navigator.clipboard.writeText(url); toast("Link copied."); });

  wireMotions();
  wireResults();
  wireRoster();
  wireRecords();
  // category changes re-weight everything live
  onRosterOverrides(() => { R.roster(); R.results(); R.voters(); });
  R.roster();

  onPolls((p) => {
    S.polls = p;
    // Same filter the voter page uses (js/vote.js): an archived motion is
    // hidden from voters, so leadership must not treat one as the live motion.
    const open = S.polls.find((x) => x.status === "open" && !x.archived && !x.deleted) || null;
    const changed = (S.activePoll && S.activePoll.id) !== (open && open.id);
    S.activePoll = open;
    if (changed) {
      if (votesUnsub) { votesUnsub(); votesUnsub = null; }
      S.activeVotes = []; S.activeLoaded = false;
      if (S.activePoll) votesUnsub = onVotesFor(S.activePoll.id, (vs) => { S.activeVotes = vs; S.activeLoaded = true; R.collectWriteins(vs); R.results(); R.voters(); });
    }
    R.motions();
    R.results();
    R.voters();
  });
}
