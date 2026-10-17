"""Versioned files (since voting step 9): a browser gets a whole old set of the
site's files or a whole new set, never a mix. Every relative import in js/, and
each page's script and stylesheet tags, carry ?v=<the version in js/version.js>,
the same as version.txt. Set them all with: python3 tests/set_version.py voting-N
"""
import re
import unittest

import harness as h

ROOT = h.REPO
PAGES = ("index.html", "screen.html", "admin-9f4k2x7q.html")


def version():
    return re.search(r'export const VERSION = "([^"]+)";', (ROOT / "js/version.js").read_text()).group(1)


class TestVersions(unittest.TestCase):
    def test_version_txt_and_version_js_agree(self):
        self.assertRegex(version(), r"^voting-\d+$")
        self.assertEqual((ROOT / "version.txt").read_text().strip(), version())

    def test_every_relative_import_carries_the_version(self):
        v = version()
        n = 0
        for f in sorted((ROOT / "js").glob("*.js")):
            src = f.read_text()
            specs = re.findall(r'''(?:from|import)\s*\(?\s*["'](\.[^"']+)["']''', src)
            for s in specs:
                n += 1
                self.assertEqual(s.split("?v=")[-1] if "?v=" in s else None, v, f"{f.name}: {s}")
        self.assertGreater(n, 40)

    def test_pages_load_their_script_and_stylesheets_with_the_version(self):
        v = version()
        for p in PAGES:
            html = (ROOT / p).read_text()
            refs = re.findall(r'(?:src|href)="((?:js|css)/[^"]+)"', html)
            self.assertTrue(any(r.startswith("js/") for r in refs), p)
            self.assertEqual(sorted(r.split("?")[0] for r in refs if r.startswith("css/")),
                             ["css/ed-ui.css", "css/styles.css"], p)
            for r in refs:
                self.assertEqual(r.split("?v=")[-1] if "?v=" in r else None, v, f"{p}: {r}")

    def test_every_name_the_live_release_imports_is_still_exported(self):
        """A browser may run a cached module of the live release next to this
        release's files for up to 10 minutes; every name it imports must exist."""
        import json
        from playwright.sync_api import sync_playwright
        prev = json.loads((h.HERE / "previous-imports.json").read_text())
        self.assertNotEqual(prev["from"], version(), "run: python3 tests/set_version.py --snapshot")
        with h.serve() as base, sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page()
            errs = []
            h.wire(pg, errs)
            pg.goto(f"{base}/screen.html")
            for mod, names in prev["imports"].items():
                have = pg.evaluate("async (m) => Object.keys(await import('./js/' + m + '?v=' + window.__V))", mod)
                self.assertEqual(sorted(set(names) - set(have)), [], f"{mod} no longer exports these")
            b.close()

    def test_a_new_page_loads_with_nothing_unversioned(self):
        """Load each page and check every file of the site it fetched was versioned."""
        from playwright.sync_api import sync_playwright
        v = version()
        with h.serve() as base, sync_playwright() as p:
            b = p.chromium.launch()
            for page in PAGES:
                pg = b.new_page()
                errs, urls = [], []
                h.wire(pg, errs)
                pg.add_init_script(h.auth_init(h.LEADER_EMAIL))
                pg.on("request", lambda r: urls.append(r.url))
                pg.goto(f"{base}/{page}")
                pg.wait_for_timeout(800)
                own = [u for u in urls if u.startswith(base) and re.search(r"\.(js|css)(\?|$)", u)]
                self.assertTrue(own, page)
                for u in own:
                    self.assertTrue(u.endswith("?v=" + v), f"{page}: {u}")
                self.assertEqual(errs, [], page)
                pg.close()
            b.close()


if __name__ == "__main__":
    unittest.main()
