"""Log out in the Admin console (the ED tools' Log out standard, voting-15).

The control says "Log out" in words (it was a grey lock icon), sits last at the
top right of the header at every width, reads "Logging out..." while it works,
waits for a result being saved, asks first when a meeting is open (one sign-in
per browser, so the projector and any voting page in this browser go too), and
lands on the Admin password screen saying "You are logged out."
"""
import unittest

import harness as h
from base import Base
from test_meetings import Console, seed_meeting
from test_saved_results import NOW

STATE = "(await import('./js/admin-state.js?v=' + window.__V)).S"


def wait_gate(pg):
    """The page reloaded to the Admin password screen."""
    pg.wait_for_function("() => window.__auth !== undefined")
    pg.wait_for_selector("#gate:not(.hide)")
    pg.wait_for_function("() => !document.querySelector('#boot-note')")


class TestLogoutButton(Console):
    def test_log_out_is_words_last_in_the_header(self):
        pg = self.console()
        self.assertEqual(pg.locator("#lock").count(), 0)
        b = pg.locator("#logout")
        self.assertEqual(b.inner_text(), "Log out")
        self.assertEqual(b.get_attribute("type"), "button")
        self.assertIn("ed-btn-plain", b.get_attribute("class"))
        self.assertNotIn("icon-btn", b.get_attribute("class"))
        self.assertIsNone(b.get_attribute("aria-label"))       # the words are its name
        self.assertIsNone(b.get_attribute("title"))
        self.assertEqual(b.locator("svg").count(), 0)
        self.assertEqual(pg.evaluate("document.querySelector('.top-actions').lastElementChild.id"), "logout")
        self.assertEqual(pg.get_by_role("button", name="Log out").count(), 1)

    def test_log_out_stays_on_screen_on_one_line_on_a_small_phone(self):
        pg = self.page
        for w in (320, 390, 430, 1280):
            pg.set_viewport_size({"width": w, "height": 800})
            if w == 320:
                self.console()
            pg.wait_for_timeout(50)
            box = pg.locator("#logout").bounding_box()
            self.assertLessEqual(box["x"] + box["width"], w, w)
            self.assertLessEqual(box["height"], 48, w)            # one line
            self.assertLessEqual(pg.evaluate("document.documentElement.scrollWidth"), w, w)
            self.assertTrue(pg.is_visible("#name-chip"), w)        # the chip shrinks, never goes

    def test_log_out_with_no_meeting_open_goes_straight_to_the_gate(self):
        pg = self.console()
        pg.click("#logout")
        wait_gate(pg)
        self.assertIsNone(pg.evaluate("window.__auth.current()"))
        self.assertTrue(pg.is_visible("#gate-note"))
        self.assertEqual(pg.inner_text("#gate-note"), "You are logged out.")
        self.assertTrue(pg.is_hidden("#gate-err"))
        self.assertTrue(pg.is_hidden("#console"))
        # Only once: a later reload of the gate does not say it again.
        pg.reload()
        wait_gate(pg)
        self.assertTrue(pg.is_hidden("#gate-note"))

    def test_a_first_visit_does_not_say_logged_out(self):
        pg = self.page
        h.load_admin(pg, self.base)
        self.assertTrue(pg.is_hidden("#gate-note"))

    def test_logging_out_waits_for_a_result_being_saved(self):
        self.page.set_viewport_size({"width": 320, "height": 700})    # the longer words still fit
        pg = self.console()
        pg.evaluate(f"async () => {{ {STATE}.busy = 1; }}")
        pg.click("#logout")
        pg.wait_for_function("() => document.querySelector('#toast').textContent === 'Saving the result first...'")
        self.assertTrue(pg.is_disabled("#logout"))
        self.assertEqual(pg.inner_text("#logout"), "Logging out…")
        box = pg.locator("#logout").bounding_box()
        self.assertLessEqual(box["x"] + box["width"], 320)
        self.assertLessEqual(box["height"], 48)
        self.assertGreaterEqual(pg.locator("#name-chip").bounding_box()["width"], 40)
        pg.wait_for_timeout(500)
        self.assertIsNotNone(pg.evaluate("window.__auth.current()"))     # still waiting
        with pg.expect_navigation():
            pg.evaluate(f"async () => {{ {STATE}.busy = 0; }}")
        wait_gate(pg)
        self.assertEqual(pg.inner_text("#gate-note"), "You are logged out.")


class TestLogoutWithAMeetingOpen(Console):
    def open_console(self):
        return self.console(lambda pg: seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000)))

    def test_asks_first_and_stay_keeps_you_logged_in(self):
        pg = self.open_console()
        pg.click("#logout")
        pg.wait_for_selector("#sheet:not(.hide)")
        self.assertEqual(pg.inner_text("#sheet-title"), "Log out?")
        self.assertEqual(pg.inner_text("#sheet-status"), "A meeting is open. Logging out also logs out the projector "
                                                          "screen and any voting page open in this browser.")
        self.assertEqual(pg.eval_on_selector_all("#sheet-actions button", "els => els.map(e => e.textContent)"),
                         ["Log out anyway", "Stay"])
        self.assertEqual(pg.evaluate("document.activeElement.textContent"), "Stay")
        self.assertTrue(pg.is_disabled("#logout"))
        self.assertEqual(pg.inner_text("#logout"), "Logging out…")
        pg.click("#sheet-actions button:has-text('Stay')")
        self.assertTrue(pg.is_hidden("#sheet"))
        self.assertTrue(pg.is_enabled("#logout"))
        self.assertEqual(pg.inner_text("#logout"), "Log out")
        pg.wait_for_timeout(300)
        self.assertIsNotNone(pg.evaluate("window.__auth.current()"))
        self.assertTrue(pg.is_visible("#console"))

    def test_log_out_anyway_logs_out(self):
        pg = self.open_console()
        pg.click("#logout")
        pg.wait_for_selector("#sheet:not(.hide)")
        pg.click("#sheet-actions button:has-text('Log out anyway')")
        wait_gate(pg)
        self.assertIsNone(pg.evaluate("window.__auth.current()"))
        self.assertEqual(pg.inner_text("#gate-note"), "You are logged out.")
        self.assertTrue(pg.is_hidden("#console"))

    def test_a_planned_meeting_does_not_ask(self):
        pg = self.console(lambda pg: seed_meeting(pg, status="planned"))
        pg.click("#logout")
        wait_gate(pg)
        self.assertEqual(pg.inner_text("#gate-note"), "You are logged out.")


if __name__ == "__main__":
    unittest.main()
