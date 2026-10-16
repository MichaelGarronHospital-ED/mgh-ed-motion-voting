// The version of this page's code. version.txt (next to the pages) holds the
// version on the site; when they differ, the console says "A newer version is
// available. Reload." Change both together, with every update.
export const VERSION = "voting-1";

// Ask the site which version it has now (no cache, no Firestore read), and
// call onNewer() if it differs from this page's. Checked when the tab comes
// back into view or gets focus.
export function watchVersion(onNewer) {
  let shown = false;
  const check = async () => {
    if (shown || document.visibilityState === "hidden") return;
    try {
      const r = await fetch("version.txt", { cache: "no-store" });
      if (!r.ok) return;
      const v = (await r.text()).trim();
      if (v && v !== VERSION) { shown = true; onNewer(v); }
    } catch (e) { /* offline: try again next time */ }
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  return check;
}
