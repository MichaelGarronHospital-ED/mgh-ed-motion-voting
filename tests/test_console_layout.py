"""The Admin console's layout after the UX pass (2026-10-18).

Tabs follow the order of work (Meeting, Physicians, Motions, Results); "Who
voted" is part of Results; receipts are the vote's hover text instead of a
column; the name for the change history lives in a chip in the header; rarely
used motion actions sit under each row's More menu; explanations sit behind
(i) buttons that work with a mouse, a keyboard and a tap.
"""
import unittest

import harness as h
from base import Base
from test_meetings import Console, seed_meeting, seed_motion
from test_saved_results import seed_open, wait_result, NOW
from test_voter_board import seed_closed_saved


class TestTabs(Console):
    def test_tab_order_follows_the_work(self):
        pg = self.console(lambda pg: (seed_meeting(pg), seed_motion(pg, "d1", "A draft")))
        self.assertEqual(pg.eval_on_selector_all(".tab", "els => els.map(e => e.textContent.trim())"),
                         ["Meeting", "Physicians", "Motions", "Results"])
        self.assertEqual(pg.locator('.tab[data-tab="voters"]').count(), 0)
        h.tab(pg, "results")
        # Who voted and the meeting's records are part of Results, under the one motion picker.
        self.assertEqual(pg.locator("#tab-results .motion-select").count(), 1)
        self.assertEqual(pg.locator("#tab-results #voters-table").count(), 1)
        self.assertEqual(pg.locator("#tab-results #meeting-export").count(), 1)

    def test_who_voted_follows_the_results_picker(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1", ballots=3, text="First motion")
            seed_open(pg, ballots=h.GROUP1[3:5], meetingId="m1", order=1, text="Second motion")
        pg = self.console(seed)
        h.tab(pg, "results")
        pg.wait_for_selector("#voters-table td.who")
        self.assertEqual(pg.locator("#voters-table td.who").count(), 2)       # the open motion
        pg.select_option("#results-selector .motion-select", "c1")
        pg.wait_for_function("() => document.querySelectorAll('#voters-table td.who').length === 3")
        self.assertIn("First motion", pg.inner_text("#results-body"))


class TestWhoVoted(Base):
    def test_no_receipt_or_weight_column_but_the_receipt_is_on_the_vote(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:2])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.wait_for_selector("#voters-table td.choice")
        head = pg.eval_on_selector_all("#voters-table thead th", "els => els.map(e => e.textContent.trim())")
        self.assertEqual(head[:3], ["Name", "Category", "Vote"])
        self.assertNotIn("Receipt", head)
        self.assertNotIn("Weight", head)
        self.assertNotIn("Submissions", head)                  # nobody flagged
        slug = h.slugify(h.GROUP1[0])
        ballot = h.get(pg, f"polls/p1/votes/{slug}")
        code = pg.evaluate("async (v) => (await import('./js/count.js?v=' + window.__V)).ballotReceipt('p1', v)", ballot)
        row = pg.locator("#voters-table tr", has_text=h.GROUP1[0])
        self.assertEqual(row.locator("td.choice").get_attribute("title"), f"Receipt code: {code}")

    def test_submissions_column_only_when_someone_is_flagged(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:1])
        h.seed(pg, "polls/p1/votes/x", {"name": h.GROUP1[1], "slug": h.slugify(h.GROUP1[1]), "choice": "against",
                                        "group": "1", "weight": 1, "flagged": True, "submissionCount": 3})
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.wait_for_selector("#voters-table .ed-pill-warn")
        self.assertIn("Submissions", pg.inner_text("#voters-table thead"))
        self.assertIn("1 to review", pg.inner_text("#voters-note"))

    def test_result_footer_shows_only_counts_above_zero(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.wait_for_selector("#results-body .foot-line")
        foot = pg.inner_text("#results-body .foot-line")
        self.assertIn("3 ballots", foot)
        self.assertNotIn("write-in", foot)
        self.assertNotIn("flagged", foot)


class TestNameChip(Base):
    def test_name_chip_saves_the_name_the_change_log_uses(self):
        pg = self.admin()
        self.assertEqual(pg.locator("#log-name").count(), 1)       # one name field, never two
        self.assertEqual(pg.locator("#name-card, #ask-form").count(), 0)
        self.assertEqual(pg.inner_text("#name-chip-text"), "Add your name")
        self.assertTrue(pg.is_visible("#name-chip-dot"))           # the first-run nudge
        pg.click("#name-chip")
        pg.wait_for_selector("#name-chip-dot", state="hidden")
        pg.fill("#log-name", "Kyle")
        pg.click("#name-form button[type=submit]")
        self.assertTrue(pg.is_hidden("#name-form"))
        self.assertEqual(pg.inner_text("#name-chip-text"), "Kyle")
        self.assertEqual(pg.evaluate("localStorage.getItem('mv_log_name')"), "Kyle")
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        closes = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "close"]
        self.assertEqual([c.get("by") for c in closes], ["Kyle"])

    def test_saved_name_shows_on_the_chip_after_a_reload(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.evaluate("localStorage.setItem('mv_log_name', 'Kyle'); localStorage.setItem('mv_log_name_asked', '1')")
        pg.reload()
        pg.wait_for_function("() => window.__auth !== undefined")
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        self.assertEqual(pg.inner_text("#name-chip-text"), "Kyle")
        self.assertTrue(pg.is_hidden("#name-chip-dot"))


class TestMoreMenu(Console):
    def seed(self, pg):
        seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
        seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1", ballots=3, text="Closed one", order=0)
        seed_motion(pg, "d1", "A draft", order=1)

    def test_rows_show_only_what_is_needed_now(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        visible = lambda pid: pg.eval_on_selector_all(
            f'#motion-list button[data-act][data-id="{pid}"]',
            "els => els.filter(e => e.checkVisibility()).map(e => e.dataset.act)")
        self.assertEqual(visible("c1"), ["view-results", "up", "down"])
        self.assertEqual(visible("d1"), ["open", "edit", "up", "down"])
        hidden = pg.eval_on_selector_all('#motion-list details.row-more[data-id="c1"] [role=menuitem]', "els => els.map(e => e.dataset.act)")
        self.assertEqual(hidden, ["reopen", "revote", "archive", "del"])
        self.assertEqual(pg.get_attribute('#motion-list details.row-more[data-id="c1"] summary', "aria-label"), "More actions for motion 1")

    def test_more_menu_actions_still_work(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        pg.click('#motion-list details.row-more[data-id="d1"] summary')
        self.assertTrue(pg.is_visible('#motion-list button[data-act="archive"][data-id="d1"]'))
        pg.keyboard.press("Escape")                                  # Escape closes it
        self.assertTrue(pg.is_hidden('#motion-list button[data-act="archive"][data-id="d1"]'))
        h.motion_act(pg, "archive", "d1")
        pg.wait_for_function("() => window.__store.get('polls/d1').archived === true")
        pg.evaluate("window.confirm = () => true")
        h.motion_act(pg, "del", "c1")
        pg.wait_for_function("() => window.__store.get('polls/c1').deleted === true")

    def test_reopen_from_the_menu_opens_the_form_on_results(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        h.motion_act(pg, "reopen", "c1")
        pg.wait_for_selector("#reopen-form")
        self.assertTrue(pg.is_visible("#tab-results"))
        self.assertEqual(pg.evaluate("document.activeElement.id"), "reopen-reason")

    def test_results_button_shows_that_motion(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="view-results"][data-id="c1"]')
        self.assertTrue(pg.is_visible("#tab-results"))
        self.assertIn("Closed one", pg.inner_text("#results-body"))
        self.assertEqual(pg.input_value("#results-selector .motion-select"), "c1")

    def test_lock_line_is_an_icon_with_hover_text(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        self.assertEqual(pg.get_attribute("#motion-list .locknote", "title"), "Result saved")

    def test_add_form_opens_by_default_only_on_an_empty_agenda(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        self.assertTrue(pg.is_hidden("#add-motion-card"))
        pg.click("#add-motion-toggle")
        self.assertTrue(pg.is_visible("#new-motion"))
        self.assertEqual(pg.get_attribute("#add-motion-toggle", "aria-expanded"), "true")
        pg2 = self.browser.new_page()
        try:
            h.wire(pg2, self.errors)
            h.load_admin(pg2, self.base)
            seed_meeting(pg2)
            h.unlock_admin(pg2)
            pg2.wait_for_selector("#console:not(.hide)")
            pg2.wait_for_timeout(300)
            h.tab(pg2, "motions")
            self.assertTrue(pg2.is_visible("#new-motion"))
        finally:
            pg2.close()


class TestInfoAndIcons(Console):
    def test_info_button_shows_on_hover_focus_and_tap_and_closes_on_escape(self):
        pg = self.console(lambda pg: seed_meeting(pg))
        btn = "#projector-card .info-btn"
        pop_id = pg.get_attribute(btn, "aria-describedby")
        pop = f"#{pop_id}"
        self.assertTrue(pg.get_attribute(btn, "aria-label").startswith("About"))
        self.assertIn("A screen for the room", pg.text_content(pop))   # the text screen readers get
        self.assertTrue(pg.is_hidden(pop))
        pg.hover(btn)
        self.assertTrue(pg.is_visible(pop))
        pg.mouse.move(0, 0)
        self.assertTrue(pg.is_hidden(pop))
        pg.focus(btn)                                                # keyboard
        self.assertTrue(pg.is_visible(pop))
        pg.keyboard.press("Escape")
        self.assertTrue(pg.is_hidden(pop))
        pg.click(btn)                                                # a tap keeps it open
        pg.mouse.move(0, 0)
        self.assertTrue(pg.is_visible(pop))
        self.assertEqual(pg.get_attribute(btn, "aria-expanded"), "true")
        pg.click("#meeting-card h2")                                 # a tap elsewhere closes it
        self.assertTrue(pg.is_hidden(pop))

    def test_every_icon_button_has_a_name_and_hover_text(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_open(pg, ballots=h.GROUP1[:2], meetingId="m1")
            h.seed(pg, f"meetings/m1/attendance/{h.slugify(h.GROUP1[0])}", {"name": h.GROUP1[0], "slug": h.slugify(h.GROUP1[0]), "mode": "room", "sessionId": "d", "at": h.ts(NOW)})
        pg = self.console(seed)
        for t in ("meeting", "roster", "motions", "results"):
            h.tab(pg, t)
            missing = pg.eval_on_selector_all(
                "#console .icon-btn",
                "els => els.filter(e => !e.getAttribute('aria-label') || !e.getAttribute('title')).map(e => e.outerHTML.slice(0, 80))")
            self.assertEqual(missing, [], t)
            infos = pg.eval_on_selector_all(
                "#console .info-btn", "els => els.filter(e => !e.getAttribute('aria-label') || !document.getElementById(e.getAttribute('aria-describedby'))).length")
            self.assertEqual(infos, 0, t)

    def test_no_paragraph_hints_left_on_the_tabs(self):
        # At most one short grey line per card: no long hint text in view.
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_open(pg, ballots=h.GROUP1[:2], meetingId="m1")
        pg = self.console(seed)
        for t in ("meeting", "roster", "motions", "results"):
            h.tab(pg, t)
            long = pg.eval_on_selector_all(
                f"#tab-{t} .ed-hint", "els => els.filter(e => e.checkVisibility() && e.innerText.trim().length > 90).map(e => e.innerText.trim())")
            self.assertEqual(long, [], t)


class TestCatchUpQuiet(Base):
    def test_nothing_to_report_shows_no_card(self):
        from test_saved_results import seed_old_closed
        pg = self.page
        h.load_admin(pg, self.base)
        seed_old_closed(pg, "p1", h.GROUP1[:25])
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        wait_result(pg)
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        self.assertTrue(pg.is_hidden("#catchup-card"))
        self.assertNotIn("could have been changed", pg.inner_text("#console"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
