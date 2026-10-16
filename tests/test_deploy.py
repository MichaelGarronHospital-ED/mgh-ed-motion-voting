"""What helps during and after an update: the "Starting..." line until the
code runs, the "newer version" banner, and the console listening only to what
this step's rules let it read (checked from the real page)."""
import unittest

import harness as h
from base import Base
from test_saved_results import seed_open


class TestAfterAnUpdate(Base):
    def test_pages_say_starting_until_the_code_runs(self):
        html = (h.REPO / "index.html").read_text()
        self.assertIn("Starting... If this message stays, reload the page.", html)
        self.assertIn("Starting... If this message stays, reload the page.", (h.REPO / "admin-9f4k2x7q.html").read_text())
        pg = self.voter()
        self.assertNotIn("Starting...", pg.inner_text("#app"))
        h.load_admin(pg, self.base)
        self.assertIsNone(pg.query_selector("#boot-note"))

    def test_console_says_a_newer_version_is_available(self):
        pg = self.admin()
        pg.evaluate("window.dispatchEvent(new Event('focus'))")
        pg.wait_for_timeout(300)
        self.assertNotIn("newer version", pg.inner_text("#banners"))   # same version: nothing
        pg.route("**/version.txt", lambda r: r.fulfill(status=200, body="voting-99\n"))
        pg.evaluate("window.dispatchEvent(new Event('focus'))")
        pg.wait_for_selector("text=A newer version is available.")
        self.assertEqual(pg.evaluate("window.__store.reads()") >= 0, True)

    def test_newer_version_only_for_a_higher_voting_number(self):
        for body, shown in (("voting-0\n", False), ("garbage", False), ("voting-1x", False), ("voting-99\n", True)):
            pg = self.browser.new_page()
            errs = []
            h.wire(pg, errs)
            pg.route("**/version.txt", (lambda b: lambda route: route.fulfill(status=200, body=b))(body))
            h.open_admin(pg, self.base)              # checked at load too
            pg.wait_for_timeout(400)
            self.assertEqual("newer version" in pg.inner_text("#banners"), shown, body)
            if shown:
                self.assertIn("If this keeps showing, wait 10 minutes and reload.", pg.inner_text("#banners"))
            self.assertEqual(errs, [])
            pg.close()

    def test_new_code_on_an_old_cached_page_does_not_fail(self):
        """A page from before this version (no "Starting..." line) with the new code."""
        old = (h.REPO / "admin-9f4k2x7q.html").read_text().replace(
            '<p id="boot-note" class="boot-note">Starting... If this message stays, reload the page.</p>', "")
        self.page.route("**/admin-9f4k2x7q.html", lambda r: r.fulfill(status=200, content_type="text/html", body=old))
        h.open_admin(self.page, self.base)
        self.page.wait_for_selector("#console:not(.hide)")

    def test_version_file_matches_the_code(self):
        txt = (h.REPO / "version.txt").read_text().strip()
        js = (h.REPO / "js" / "version.js").read_text()
        self.assertIn(f'VERSION = "{txt}"', js)


class TestConsoleListeners(Base):
    """The real console listens only to sources rules.listeners.test.mjs
    checks are readable under this step's rules."""

    def test_console_listens_only_to_what_the_rules_allow(self):
        pg = self.page
        h.load_admin(pg, self.base)
        seed_open(pg, ballots=h.GROUP1[:2])
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_timeout(400)
        self.assertEqual(sorted(set(pg.evaluate("window.__store.listenerPaths()"))),
                         sorted(EXPECTED_CONSOLE))


# Step 1: motions, the open motion's ballots, the roster and the settings.
# Step 2: + the voters' board and past results.
# Step 4: + meetings.
EXPECTED_CONSOLE = ["polls", "polls/p1/votes", "config/roster", "config/settings", "config/live", "config/history", "meetings"]


if __name__ == "__main__":
    unittest.main(verbosity=2)
