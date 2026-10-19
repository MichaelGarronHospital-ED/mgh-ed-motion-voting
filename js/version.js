// The version of this page's code. version.txt (next to the pages) holds the
// version on the site; when it is a higher "voting-N" than this page's, the
// console says "A newer version is available." Change both together, with
// every update.
export const VERSION = "voting-13";

const num = (v) => { const m = /^voting-(\d+)$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; };

// Ask the site which version it has now (no cache, no Firestore read), and
// call onNewer() once if it is newer than this page's. Checked at load, every
// 5 minutes (a projector may never get focus), and when the tab comes back
// into view or gets focus.
export function watchVersion(onNewer) {
  let shown = false;
  const mine = num(VERSION);
  const check = async () => {
    if (shown || document.visibilityState === "hidden") return;
    try {
      const r = await fetch("version.txt", { cache: "no-store" });
      if (!r.ok) return;
      const v = num(await r.text());
      if (v !== null && mine !== null && v > mine) { shown = true; onNewer(v); }
    } catch (e) { /* offline: try again next time */ }
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  setInterval(check, 5 * 60 * 1000);
  check();
  return check;
}
