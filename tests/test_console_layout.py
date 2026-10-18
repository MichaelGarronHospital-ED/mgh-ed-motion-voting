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
        hidden = pg.eval_on_selector_all('#motion-list details.row-more[data-id="c1"] .menu-item', "els => els.map(e => e.dataset.act)")
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


class TestRoundTwo(Console):
    def test_settings_has_a_heading_and_done_goes_back(self):
        pg = self.console(lambda pg: seed_meeting(pg))
        h.tab(pg, "motions")
        pg.click("#open-settings")
        self.assertTrue(pg.is_visible("#tab-settings"))
        self.assertEqual(pg.inner_text("#settings-title"), "Settings")
        self.assertEqual(pg.get_attribute("#open-settings", "aria-pressed"), "true")
        self.assertEqual(pg.inner_text("#tab-settings legend").strip(), "Points per vote")   # the range is on its (i)
        self.assertIn("From 0 to 1, in steps of 0.05.", pg.text_content("#tab-settings legend .info-pop"))
        pg.click("#settings-done")
        self.assertTrue(pg.is_visible("#tab-motions"))
        self.assertEqual(pg.get_attribute("#open-settings", "aria-pressed"), "false")
        pg.click("#open-settings")
        pg.click("#open-settings")                                # the gear again also goes back
        self.assertTrue(pg.is_visible("#tab-motions"))

    def test_results_picker_says_motion_in_plain_words(self):
        pg = self.console(lambda pg: (seed_meeting(pg), seed_motion(pg, "d1", "A draft")))
        h.tab(pg, "results")
        self.assertTrue(pg.inner_text("#results-selector label").startswith("Motion"))
        self.assertEqual(pg.eval_on_selector("#results-selector option", "o => [o.value, o.textContent]"),
                         ["", "The open motion, or the latest one"])

    def test_who_voted_has_no_count_line_unless_something_needs_a_look(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_open(pg, ballots=h.GROUP1[:2], meetingId="m1")
        pg = self.console(seed)
        h.tab(pg, "results")
        pg.wait_for_selector("#voters-table td.who")
        self.assertTrue(pg.is_hidden("#voters-note"))
        h.seed(pg, "polls/p1/votes/zed", {"name": "Zed Locum", "slug": "zed", "choice": "favour", "group": "writein",
                                          "weight": 0, "isWriteIn": True, "flagged": False, "submissionCount": 1})
        pg.wait_for_selector("#voters-note:not(.hide)")
        self.assertEqual(pg.inner_text("#voters-note"), "1 write-in")

    def test_first_run_shows_one_obvious_first_step(self):
        pg = self.console()
        # Meeting: only "Add meeting" (no QR or projector before a meeting exists).
        self.assertTrue(pg.is_visible("#meeting-new-form"))
        self.assertTrue(pg.is_hidden("#share-card"))
        self.assertTrue(pg.is_hidden("#projector-card"))
        h.tab(pg, "motions")
        self.assertTrue(pg.is_visible("#new-motion"))                 # the Add form, nothing else
        self.assertEqual(pg.inner_text("#motion-list").strip(), "")
        h.tab(pg, "results")
        self.assertTrue(pg.is_hidden("#results-selector"))
        self.assertIn("No results yet", pg.inner_text("#results-body"))
        self.assertTrue(pg.is_hidden("#meeting-records"))

    def test_a_draft_shows_no_verdict(self):
        pg = self.console(lambda pg: (seed_meeting(pg), seed_motion(pg, "d1", "A draft")))
        h.tab(pg, "results")
        pg.select_option("#results-selector .motion-select", "d1")
        body = pg.inner_text("#results-body")
        self.assertIn("Not open yet.", body)
        self.assertEqual(h.outcomes(body), [])
        self.assertTrue(pg.is_visible("#r-open"))


class TestRoundThree(Console):
    def seed(self, pg):
        seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
        seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1", ballots=3, text="Closed one", order=0)
        seed_motion(pg, "d1", "A draft", order=1)

    def test_tapping_a_vote_shows_its_receipt_code(self):
        pg = self.console(self.seed)
        h.tab(pg, "results")
        pg.select_option("#results-selector .motion-select", "c1")
        pg.wait_for_selector("#voters-table button.vote-btn")
        slug = h.slugify(h.GROUP1[0])
        code = pg.evaluate("async (v) => (await import('./js/count.js?v=' + window.__V)).ballotReceipt('c1', v)", h.get(pg, f"polls/c1/votes/{slug}"))
        btn = f'#voters-table button[data-receipt="{slug}"]'
        self.assertEqual(pg.get_attribute(btn, "aria-expanded"), "false")
        box = "#" + pg.get_attribute(btn, "aria-controls")
        self.assertTrue(pg.is_hidden(box))
        pg.click(btn)                                                # a tap or a click
        self.assertEqual(pg.get_attribute(btn, "aria-expanded"), "true")
        self.assertTrue(pg.is_visible(box))
        self.assertIn(code, pg.inner_text(box))
        self.assertTrue(pg.get_attribute(f"{btn} >> xpath=..", "title").startswith("Receipt code: "))   # hover text stays
        pg.click(btn)
        self.assertTrue(pg.is_hidden(box))

    def test_focus_returns_to_the_more_button_after_a_cancelled_delete(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        summary = '#motion-list details.row-more[data-id="c1"] summary'
        pg.focus(summary)
        pg.keyboard.press("Enter")
        pg.evaluate("window.confirm = () => false")
        pg.focus('#motion-list button[data-act="del"][data-id="c1"]')
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(100)
        self.assertFalse(pg.evaluate("document.querySelector('details.row-more[data-id=\"c1\"]').open"))
        self.assertEqual(pg.evaluate("document.activeElement.getAttribute('aria-label')"), "More actions for motion 1")
        self.assertFalse(h.get(pg, "polls/c1").get("deleted"))
        self.assertEqual(pg.locator("#motion-list [role=menuitem], #motion-list [role=menu]").count(), 0)   # plain buttons

    def test_tabbing_out_of_a_more_menu_closes_it(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        pg.focus('#motion-list details.row-more[data-id="c1"] summary')
        pg.keyboard.press("Enter")
        for _ in range(6):
            pg.keyboard.press("Tab")
        self.assertFalse(pg.evaluate("document.querySelector('details.row-more[data-id=\"c1\"]').open"))

    def test_an_open_menu_closes_after_a_redraw_only_if_its_items_changed(self):
        pg = self.console(self.seed)
        h.tab(pg, "motions")
        pg.click('#motion-list details.row-more[data-id="c1"] summary')
        h.seed(pg, "polls/d1", {**h.get(pg, "polls/d1"), "text": "A draft, renamed"})
        pg.wait_for_selector("#motion-list :text('A draft, renamed')")
        self.assertTrue(pg.evaluate("document.querySelector('details.row-more[data-id=\"c1\"]').open"))
        h.seed(pg, "polls/c1", {**h.get(pg, "polls/c1"), "supersededBy": "gone"})        # Re-vote is no longer offered
        pg.wait_for_function("() => !document.querySelector('#motion-list button[data-act=\"revote\"]')")
        self.assertFalse(pg.evaluate("document.querySelector('details.row-more[data-id=\"c1\"]').open"))

    def test_attendance_stays_while_the_meeting_is_open_even_with_check_in_off(self):
        pg = self.console(lambda pg: seed_meeting(pg, status="open", checkIn=False, startedAt=h.ts(NOW - 60000)))
        self.assertTrue(pg.is_visible("#attendance-card"))
        self.assertTrue(pg.is_visible("#att-add"))
        pg2 = self.browser.new_page()
        try:
            h.wire(pg2, self.errors)
            h.load_admin(pg2, self.base)
            seed_meeting(pg2, status="planned", checkIn=False)
            h.unlock_admin(pg2)
            pg2.wait_for_selector("#console:not(.hide)")
            pg2.wait_for_timeout(400)
            self.assertTrue(pg2.is_hidden("#attendance-card"))
        finally:
            pg2.close()

    def test_live_redraws_keep_focus_on_the_eye_and_a_tapped_info_open(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_open(pg, ballots=h.GROUP1[:2], meetingId="m1")
        pg = self.console(seed)
        h.tab(pg, "results")
        pg.click("#results-body .foot-line .info-btn")                 # tap the pass rule (i)
        pop = "#results-body .foot-line .info-pop"
        self.assertTrue(pg.is_visible(pop))
        h.seed_ballots(pg, "p1", h.GROUP1[2:3])                         # a vote arrives: the card redraws
        pg.wait_for_function("() => document.querySelector('#results-body .foot-line').textContent.includes('3 ballots')")
        self.assertTrue(pg.is_visible(pop))
        pg.focus("#hide-live")
        h.seed_ballots(pg, "p1", h.GROUP1[3:4])
        pg.wait_for_function("() => document.querySelector('#results-body .foot-line').textContent.includes('4 ballots')")
        self.assertEqual(pg.evaluate("document.activeElement.id"), "hide-live")

    def test_name_chip_label_and_unsaved_text_is_dropped(self):
        pg = self.console()
        self.assertEqual(pg.get_attribute("#name-chip", "aria-label"), "Add your name for the change history")
        pg.click("#name-chip")
        pg.fill("#log-name", "Kyle")
        pg.click("#name-form button[type=submit]")
        self.assertEqual(pg.get_attribute("#name-chip", "aria-label"), "Your name for the change history: Kyle")
        pg.click("#name-chip")
        pg.fill("#log-name", "Somebody else")
        pg.keyboard.press("Escape")                                    # closed without Save
        pg.wait_for_function("() => document.querySelector('#log-name').value === 'Kyle'")
        self.assertEqual(pg.evaluate("localStorage.getItem('mv_log_name')"), "Kyle")

    def test_records_follow_the_motion_picked_on_results(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000), title="November meeting")
            seed_motion(pg, "d1", "A draft", order=0)
            seed_meeting(pg, mid="m0", status="closed", date="2026-09-15", title="September meeting")
            seed_closed_saved(pg, "c0", NOW - 600000, meetingId="m0", ballots=2, text="An old one")
        pg = self.console(seed)
        h.tab(pg, "results")
        pg.select_option("#results-selector .motion-select", "c0")
        self.assertIn("September meeting", pg.inner_text("#records-meeting"))
        pg.select_option("#results-selector .motion-select", "d1")
        self.assertIn("November meeting", pg.inner_text("#records-meeting"))

    def test_add_form_reopens_for_another_empty_meeting(self):
        def seed(pg):
            seed_meeting(pg, title="First", status="open", startedAt=h.ts(NOW - 60000))
            seed_motion(pg, "d1", "A draft")
            seed_meeting(pg, mid="m2", title="Second", date="2026-12-01")
        pg = self.console(seed)
        h.tab(pg, "motions")
        pg.click("#add-motion-toggle")
        pg.click("#add-motion-cancel")                               # closed once on a meeting with motions
        self.assertTrue(pg.is_hidden("#add-motion-card"))
        h.tab(pg, "meeting")
        pg.select_option("#meeting-pick", "m2")                      # an empty meeting
        h.tab(pg, "motions")
        self.assertTrue(pg.is_visible("#add-motion-card"))           # never a blank Agenda card
        self.assertNotIn("A draft", pg.inner_text("#agenda-body") if pg.locator("#agenda-body").count() else "")

    def test_physicians_tab_badge(self):
        pg = self.console(lambda pg: h.seed_roster(pg, writeins={"zed": {"name": "Zed Locum", "status": "new", "firstPollId": "x"}}))
        badge = '.tab[data-tab="roster"] .tab-badge'
        self.assertEqual(pg.text_content(badge), "1")
        self.assertEqual(pg.get_attribute(badge, "aria-hidden"), "true")
        self.assertEqual(pg.get_attribute(badge, "title"), "1 write-in to review")
        self.assertEqual(pg.text_content('.tab[data-tab="roster"] .sr'), ", 1 write-in to review")


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
