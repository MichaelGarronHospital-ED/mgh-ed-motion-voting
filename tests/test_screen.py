"""The meeting screen for the projector (voting upgrade step 5, V5).

It only displays: turnout and quorum while voting is open (the for and
against split hidden unless leadership turns it on), the saved result after,
the QR code, and a timer that never closes the vote. It never signs in over
an existing sign-in.
"""
import unittest

import harness as h
from base import Base
from test_saved_results import seed_open, NOW
from test_voter_board import seed_closed_saved, build_board


class Screen(Base):
    allowed_errors = ("permission-denied", "unavailable")

    def screen(self, signed_in_as=h.ED_EMAIL, clock=False):
        pg = self.page
        if clock:
            pg.clock.install()
        if signed_in_as:
            pg.add_init_script(h.auth_init(signed_in_as))
        h.open_screen(pg, self.base)
        return pg

    def test_screen_reuses_a_leadership_session_and_never_signs_in(self):
        pg = self.screen(h.LEADER_EMAIL)
        pg.wait_for_selector(".screen-head")
        self.assertIsNone(pg.query_selector("#edpw"))
        self.assertEqual(pg.evaluate("window.__auth.current().email"), h.LEADER_EMAIL)
        self.assertIsNone(pg.evaluate("window.__lastPassword || null"))

    def test_screen_asks_for_the_ed_password_when_signed_out(self):
        pg = self.screen(None)
        pg.wait_for_selector("#edpw")
        self.assertIn("Enter the ED password to show the meeting screen.", pg.inner_text("#screen"))
        self.assertNotIn("Leadership", pg.inner_text("#screen"))
        self.assertNotIn("Admin", pg.inner_text("#screen"))
        pg.fill("#edpw", "the-ed-password")
        pg.click("#edgo")
        pg.wait_for_selector(".screen-head")
        self.assertEqual(pg.evaluate("window.__auth.current().email"), h.ED_EMAIL)

    def test_screen_waiting_shows_the_qr_code(self):
        pg = self.screen()
        h.seed(pg, "config/live", {"v": 2, "meeting": {"id": "m1", "title": "ED department meeting", "date": "2026-11-20", "status": "open", "checkIn": True},
                                    "open": None, "results": {}, "lastClosedId": None})
        pg.wait_for_selector(".screen-qr")
        text = pg.inner_text("#screen")
        self.assertIn("Scan to vote. You need the ED password.", text)
        self.assertIn("ED department meeting, Fri, Nov 20", text)

    def test_screen_hides_the_split_by_default(self):
        pg = self.screen()
        seed_open(pg, ballots=h.GROUP1[:10])
        build_board(pg)
        pg.wait_for_selector(".screen-count")
        text = pg.inner_text("#screen")
        self.assertNotIn("In favour", text)
        self.assertNotIn("pts", text)
        h.seed(pg, "config/screen", {"showQr": True, "showTally": True, "timer": None})
        pg.wait_for_selector(".screen-tally")
        self.assertIn("10 pts", pg.inner_text("#screen"))

    def test_screen_shows_turnout_and_quorum_progress(self):
        pg = self.screen()
        seed_open(pg, ballots=h.GROUP1[:17] + h.COURTESY[:3])
        build_board(pg)
        pg.wait_for_selector(".screen-count")
        text = pg.inner_text("#screen")
        self.assertIn("17", text)
        self.assertIn(f"of {h.ELIGIBLE} eligible voters have voted", text)
        self.assertIn(f"Quorum: {h.QUORUM} needed.", text)
        self.assertIn(f"{h.QUORUM - 17} more needed", text)

    def test_screen_shows_the_saved_result_after_close(self):
        pg = self.screen()
        seed_closed_saved(pg, "c1", NOW - 60000, text="Approve the schedule")
        build_board(pg)
        pg.wait_for_selector(".screen-verdict")
        text = pg.inner_text("#screen")
        self.assertIn("Passed", text)
        self.assertIn("Quorum: 30 of 24 met.", text)
        self.assertIn("Closed at", text)

    def test_screen_never_shows_a_verdict_before_the_result(self):
        # The screen's own late count needs the Admin sign-in (closed ballots are Admin only).
        pg = self.screen(h.LEADER_EMAIL, clock=True)
        h.seed_ballots(pg, "c1", h.GROUP1[:30])
        pg.evaluate("window.__store.stall('polls/c1')")
        seed_closed_saved(pg, "c1", NOW - 5000, ballots=0)
        live = None
        build_board(pg)
        live = h.get(pg, "config/live")
        live["results"]["c1"]["result"] = None
        h.seed(pg, "config/live", live)
        pg.wait_for_selector("text=Counting votes...")
        pg.clock.run_for(31000)
        pg.wait_for_timeout(200)
        self.assertEqual(h.outcomes(pg.inner_text("#screen")), [])
        self.assertIn("Counting votes...", pg.inner_text("#screen"))
        pg.evaluate("window.__store.release('polls/c1')")
        pg.wait_for_selector("text=Count from the ballots")
        self.assertEqual(h.outcomes(pg.inner_text("#screen")), ["Passed"])

    def test_screen_timer_counts_down_and_says_time_is_up(self):
        pg = self.screen(clock=True)
        seed_open(pg, ballots=h.GROUP1[:3])
        build_board(pg)
        pg.wait_for_selector(".screen-count")
        h.seed(pg, "config/screen", {"showQr": True, "showTally": False,
                                      "timer": {"pollId": "p1", "startedAt": h.ts(NOW - 999999), "seconds": 120}})
        pg.wait_for_selector(".screen-timer")
        self.assertIn("2:00 left", pg.inner_text(".screen-timer"))     # from when this screen got it
        pg.clock.run_for(36000)
        self.assertRegex(pg.inner_text(".screen-timer"), r"1:2[345] left")
        pg.clock.run_for(60000)
        self.assertIn("soon", pg.get_attribute(".screen-timer", "class"))
        pg.clock.run_for(30000)
        self.assertIn("Time is up. Leadership will close the vote.", pg.inner_text("#screen"))
        self.assertEqual(h.get(pg, "polls/p1")["status"], "open")       # it never closes the vote

    def test_projector_offline_marks_out_of_date(self):
        pg = self.screen()
        seed_closed_saved(pg, "c1", NOW - 60000)
        build_board(pg)
        pg.wait_for_selector(".screen-verdict")
        pg.evaluate("window.__store.offline(true)")
        pg.wait_for_selector("text=No connection. May be out of date.")
        self.assertIn("Passed", pg.inner_text("#screen"))

    def test_screen_signed_out_by_the_rules_says_so(self):
        pg = self.screen()
        pg.evaluate("window.__store.fail('config/live', 'permission-denied', 'r')")
        pg.wait_for_selector("text=This screen is signed out. Ask leadership")

    def test_ed_screen_waits_for_the_saved_result_without_reading_ballots(self):
        """Closed ballots are Admin only (voting-14): signed in with the ED password,
        a late result is never counted from the ballots; the screen waits."""
        pg = self.screen(clock=True)
        h.seed_ballots(pg, "c1", h.GROUP1[:30])
        seed_closed_saved(pg, "c1", NOW - 5000, ballots=0)
        build_board(pg)
        live = h.get(pg, "config/live")
        live["results"]["c1"]["result"] = None
        h.seed(pg, "config/live", live)
        pg.wait_for_selector("text=Counting votes...")
        pg.clock.run_for(61000)
        pg.wait_for_timeout(200)
        self.assertEqual(h.outcomes(pg.inner_text("#screen")), [])
        self.assertIn("Counting votes...", pg.inner_text("#screen"))
        self.assertEqual(h.reads(pg, "polls/c1/votes"), 0)

    def test_refused_ballots_do_not_sign_the_screen_out(self):
        """The open motion's ballots are refused once it closes, which can reach the
        screen before the board does. That is not a sign-out."""
        pg = self.screen()
        seed_open(pg, ballots=h.GROUP1[:3])
        build_board(pg)
        pg.wait_for_selector(".screen-count")
        pg.evaluate("window.__store.fail('polls/p1/votes', 'permission-denied', 'r')")
        pg.wait_for_timeout(500)
        self.assertNotIn("signed out", pg.inner_text("#screen"))
        self.assertIsNone(pg.query_selector("#edpw"))
        self.assertIsNotNone(pg.query_selector(".screen-head"))


class TestConsoleControls(Base):
    def test_console_projector_controls_write_config_screen(self):
        pg = self.admin()
        seed_open(pg, ballots=[])
        pg.wait_for_timeout(300)
        pg.uncheck("#screen-qr")
        pg.wait_for_function("() => (window.__store.get('config/screen') || {}).showQr === false")
        pg.check("#screen-tally")
        pg.wait_for_function("() => (window.__store.get('config/screen') || {}).showTally === true")
        pg.click('[data-timer="120"]')
        pg.wait_for_function("() => ((window.__store.get('config/screen') || {}).timer || {}).seconds === 120")
        t = h.get(pg, "config/screen")["timer"]
        self.assertEqual(t["pollId"], "p1")
        self.assertIsNotNone(t["startedAt"])
        pg.click('[data-timer="0"]')
        pg.wait_for_function("() => window.__store.get('config/screen').timer === null")
        self.assertEqual(pg.get_attribute("#open-screen", "href"), "screen.html")

    def test_hide_the_live_count_on_this_screen(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:5])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#hide-live")                                       # the eye on the result card
        self.assertEqual(pg.get_attribute("#hide-live", "aria-pressed"), "true")
        body = pg.inner_text("#results-body")
        self.assertNotIn("pts", body)
        self.assertIn("The live count is hidden on this screen.", body)
        self.assertEqual(pg.evaluate("localStorage.getItem('mv_hide_live')"), "1")
        pg.click("#r-close")
        pg.wait_for_function("() => (window.__store.get('polls/p1') || {}).result")
        pg.wait_for_timeout(200)
        self.assertIn("5 pts", pg.inner_text("#results-body"))         # closed: shown again


if __name__ == "__main__":
    unittest.main(verbosity=2)
