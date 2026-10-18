"""Behaviour tests for the Motion Voting tool.

Each test drives the real pages in a headless browser against a stubbed
Firestore (see harness.py). Run with:

    cd tests && python3 -m unittest -v

Every group maps to a promise the tool makes to a real person in a meeting.
Tests marked REGRESSION pin a bug that was found and fixed; see CHANGES.md.
"""
import unittest

from playwright.sync_api import sync_playwright

import harness as h


class Base(unittest.TestCase):
    """One browser for the whole suite; a fresh page (and store) per test."""

    @classmethod
    def setUpClass(cls):
        cls._serve = h.serve()
        cls.base = cls._serve.__enter__()
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()
        cls._serve.__exit__(None, None, None)

    def setUp(self):
        self.errors = []
        self.page = self.browser.new_page()
        h.wire(self.page, self.errors)

    def tearDown(self):
        # A console error is a failure even when the assertions passed.
        self.assertEqual(self.errors, [], f"page errors: {self.errors}")
        self.page.close()

    def voter(self):
        h.open_voter(self.page, self.base)
        return self.page

    def admin(self):
        h.open_admin(self.page, self.base)
        return self.page


class TestRosterAndQuorum(Base):
    """The weighting and quorum rules from CLAUDE.md."""

    def test_quorum_is_half_of_eligible(self):
        pg = self.admin()
        summary = pg.inner_text("#roster-summary")
        self.assertIn(f"{h.ELIGIBLE} currently eligible", summary)
        self.assertIn(f"quorum = {h.QUORUM}", summary)

    def test_courtesy_members_are_listed_but_carry_no_weight(self):
        pg = self.admin()
        h.tab(pg, "roster")
        pg.fill("#roster-filter", h.COURTESY[0])
        pg.wait_for_timeout(100)
        row = pg.inner_text("#roster-table")
        self.assertIn("No vote", row)

    def test_courtesy_ballot_does_not_count_toward_quorum(self):
        pg = self.page
        pg.clock.install()
        h.open_voter(pg, self.base)
        h.seed_ballots(pg, "p1", h.COURTESY, group="courtesy", weight=0)
        h.seed_poll(pg, status="closed", vote_count=len(h.COURTESY))
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "closedAt": h.ts(1792000000000)})
        h.build_board(pg)              # closed, result not saved yet: the phone counts it once after 30 s
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.clock.run_for(31000)
        pg.wait_for_selector("text=Count from the ballots")
        # Every courtesy member voting still cannot carry a motion.
        self.assertEqual(h.outcomes(pg.inner_text("#app")), ["No quorum"])

    def test_pass_rule_is_weighted_favour_over_against(self):
        pg = self.admin()
        # 24 full votes for, 2 against -> quorum met, passes.
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP1[:24], choice="favour")
        h.seed_ballots(pg, "p1", h.GROUP1[24:26], choice="against")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        body = pg.inner_text("#results-body")
        self.assertEqual(h.outcomes(body), ["Passes"])
        self.assertIn("24 pts", body)

    def test_tie_is_reported_as_a_tie(self):
        pg = self.admin()
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP1[:13], choice="favour")
        h.seed_ballots(pg, "p1", h.GROUP1[13:26], choice="against")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#results-body")), ["Tie"])

    def test_half_weight_group_counts_as_half_a_point(self):
        pg = self.admin()
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP2, choice="favour", group="2", weight=0.5)
        h.seed_poll(pg, status="closed", vote_count=len(h.GROUP2))
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        body = pg.inner_text("#results-body")
        self.assertIn(f"{h.fmt(len(h.GROUP2) / 2)} pts", body)
        self.assertIn(f"{len(h.GROUP2)} votes", body)

    def test_a_name_counts_once_even_with_a_second_ballot_under_another_id(self):
        # REGRESSION: the tally used to add every ballot document, so a second
        # document carrying the same slug counted that person twice.
        pg = self.admin()
        name = h.GROUP1[0]
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", [name], choice="favour")
        h.seed_poll(pg, status="closed", vote_count=2)
        pg.evaluate(
            "([s, n]) => window.__store.set('polls/p1/votes/dup-' + s, {name:n, slug:s,"
            " choice:'against', group:'1', weight:1, flagged:false, submissionCount:1})",
            [h.slugify(name), name])
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        body = pg.inner_text("#results-body")
        self.assertIn("1 pts · 1 vote", body)       # In favour: the ballot under its own slug wins
        self.assertIn("0 pts · 0 votes", body)      # Against: the duplicate is not counted
        self.assertIn("1 ballot ·", body)
        self.assertIn(f"1 of {h.QUORUM}", body)


class TestCastingAVote(Base):
    """What happens when a physician taps a choice."""

    def test_ballot_is_stored_with_the_right_name_group_and_weight(self):
        pg = self.voter()
        h.seed_poll(pg)
        h.build_board(pg)
        name = h.GROUP1[1]
        h.pick_voter(pg, name)
        pg.click('button[data-c="favour"]')
        pg.wait_for_function(
            "() => Object.keys(window.__store.dump()).some(k => k.includes('/votes/'))")
        v = h.get(pg, f"polls/p1/votes/{h.slugify(name)}")
        self.assertEqual(
            {k: v[k] for k in ("name", "group", "weight", "choice", "submissionCount")},
            {"name": name, "group": "1", "weight": 1,
             "choice": "favour", "submissionCount": 1})
        self.assertEqual(h.get(pg, "polls/p1")["voteCount"], 1)

    def test_changing_a_vote_replaces_it_without_double_counting(self):
        pg = self.voter()
        h.seed_poll(pg)
        h.build_board(pg)
        name = h.GROUP1[1]
        h.pick_voter(pg, name)
        pg.click('button[data-c="favour"]')
        pg.wait_for_timeout(150)
        pg.click('button[data-c="against"]')
        pg.wait_for_timeout(150)
        v = h.get(pg, f"polls/p1/votes/{h.slugify(name)}")
        self.assertEqual(v["choice"], "against")
        self.assertEqual(v["submissionCount"], 2)
        # still ONE distinct voter
        self.assertEqual(h.get(pg, "polls/p1")["voteCount"], 1)

    def test_retapping_the_same_choice_is_not_a_new_submission(self):
        pg = self.voter()
        h.seed_poll(pg)
        h.build_board(pg)
        name = h.GROUP1[1]
        h.pick_voter(pg, name)
        pg.click('button[data-c="favour"]')
        pg.wait_for_timeout(150)
        pg.click('button[data-c="favour"]')
        pg.wait_for_timeout(150)
        self.assertEqual(
            h.get(pg, f"polls/p1/votes/{h.slugify(name)}")["submissionCount"], 1)

    def test_a_write_in_lands_at_zero_weight_for_review(self):
        pg = self.voter()
        h.seed_poll(pg)
        h.build_board(pg)
        pg.click("#writein-btn")
        pg.fill("#writein", "Brand New Locum")
        pg.click("#writein-confirm")
        pg.wait_for_selector('button[data-c="favour"]')
        pg.click('button[data-c="favour"]')
        pg.wait_for_timeout(200)
        v = h.get(pg, "polls/p1/votes/brand-new-locum")
        self.assertTrue(v["isWriteIn"])
        self.assertEqual(v["weight"], 0)

    def test_device_is_locked_to_one_person_after_voting(self):
        pg = self.voter()
        h.seed_poll(pg)
        h.build_board(pg)
        h.pick_voter(pg, h.GROUP1[1])
        pg.click('button[data-c="favour"]')
        pg.wait_for_timeout(200)
        # the "Not you?" escape hatch is replaced by the flagged switch path
        self.assertIn("Switch voter", pg.inner_text("#app"))
        self.assertEqual(pg.evaluate("localStorage.getItem('ed_bound')"),
                         h.slugify(h.GROUP1[1]))

    def test_no_ballot_is_shown_when_no_motion_is_open(self):
        pg = self.voter()
        h.seed_poll(pg, status="draft")
        h.pick_voter(pg, h.GROUP1[1])
        pg.wait_for_timeout(200)
        self.assertIn("No motion open", pg.inner_text("#app"))
        self.assertEqual(pg.locator('button[data-c="favour"]').count(), 0)


class TestResultsAreNeverWrong(Base):
    """REGRESSION: an empty tally scores as NO QUORUM. Shown before the ballots
    arrive, that announces a wrong outcome on a shared screen."""

    def test_voter_sees_counting_not_a_verdict_before_ballots_load(self):
        pg = self.page
        pg.clock.install()
        h.open_voter(pg, self.base)
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "closedAt": h.ts(1792000000000)})
        h.build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector('[data-vtab="results"]')
        # click and read in the same tick: the result is not saved yet
        first = pg.evaluate("""() => {
            document.querySelector('[data-vtab="results"]').click();
            return document.querySelector('#app').innerText; }""")
        self.assertEqual(h.outcomes(first), [], "a verdict was shown before the count")
        self.assertIn("Counting votes", first)
        pg.clock.run_for(31000)
        pg.wait_for_selector("text=Count from the ballots")
        self.assertEqual(h.outcomes(pg.inner_text("#app")), ["Passed"])

    def test_admin_sees_counting_not_a_verdict_before_ballots_load(self):
        # The motion is known but its ballots are still in flight: hold the
        # votes snapshot back so that state is pinned rather than raced.
        pg = self.admin()
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        stalled = pg.inner_text("#results-body")
        self.assertEqual(h.outcomes(stalled), [], "a verdict was shown before the count")
        self.assertIn("Counting votes", stalled)
        pg.evaluate("window.__store.release('polls/p1/votes')")
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#results-body")), ["Passes"])

    def test_voter_results_show_counting_while_ballots_are_in_flight(self):
        pg = self.page
        pg.clock.install()
        h.open_voter(pg, self.base)
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "closedAt": h.ts(1792000000000)})
        h.build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.clock.run_for(31000)
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#app")), [])
        self.assertIn("Counting votes", pg.inner_text("#app"))
        pg.evaluate("window.__store.release('polls/p1/votes')")
        pg.wait_for_selector("text=Count from the ballots")
        self.assertEqual(h.outcomes(pg.inner_text("#app")), ["Passed"])

    def test_export_is_refused_until_the_ballots_are_in(self):
        pg = self.admin()
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.tab(pg, "voters")
        pg.wait_for_timeout(300)
        msg = pg.evaluate("""() => {
            document.querySelector('#export').click();
            return document.querySelector('#toast').textContent; }""")
        self.assertIn("loading", msg.lower())

    def test_export_works_once_the_ballots_are_in(self):
        pg = self.admin()
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.seed_poll(pg, status="closed", vote_count=26)
        pg.wait_for_timeout(300)
        h.tab(pg, "voters")
        with pg.expect_download() as dl:
            pg.click("#export")
        csv = dl.value.path().read_text()
        self.assertIn("Name,Category,Weight,Vote", csv)
        self.assertIn("Result,PASSES", csv)
        self.assertIn("In favour (pts),26", csv)


class TestLeadershipActions(Base):
    def test_removing_a_ballot_brings_the_voter_count_down(self):
        """REGRESSION: voteCount only ever ratcheted up, so the edit lock stuck
        on and the purge dialog over-reported the ballots it would destroy."""
        pg = self.admin()
        h.seed_poll(pg, vote_count=3)
        h.seed_ballots(pg, "p1", h.GROUP1[:3], choice="favour")
        pg.wait_for_timeout(200)
        h.tab(pg, "voters")
        pg.wait_for_selector("#voters-table button[data-del]")
        pg.evaluate("window.confirm = () => true")
        pg.click("#voters-table button[data-del]")
        pg.wait_for_timeout(400)
        left = [k for k in h.store(pg) if "/votes/" in k]
        self.assertEqual(len(left), 2)
        self.assertEqual(h.get(pg, "polls/p1")["voteCount"], 2)

    def test_removing_the_last_ballot_cannot_drive_the_count_negative(self):
        pg = self.admin()
        h.seed_poll(pg, vote_count=0)          # count already out of step
        h.seed_ballots(pg, "p1", h.GROUP1[:1], choice="favour")
        pg.wait_for_timeout(200)
        h.tab(pg, "voters")
        pg.wait_for_selector("#voters-table button[data-del]")
        pg.evaluate("window.confirm = () => true")
        pg.click("#voters-table button[data-del]")
        pg.wait_for_timeout(400)
        self.assertEqual(h.get(pg, "polls/p1")["voteCount"], 0)

    def test_opening_a_motion_makes_it_visible_to_voters(self):
        """REGRESSION: re-opening an archived motion left it archived, so voters
        saw no open motion while leadership saw it as live."""
        pg = self.admin()
        h.seed_poll(pg, pid="pa", text="Old archived motion",
                    status="closed", archived=True)
        pg.wait_for_timeout(250)
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        pg.select_option("#results-selector select", "pa")
        pg.wait_for_timeout(250)
        pg.evaluate("window.confirm = () => true")
        pg.click("#r-open")                     # a closed motion re-opens with a reason
        pg.fill("#reopen-reason", "Closed early by mistake.")
        pg.click("#reopen-go")
        pg.wait_for_function("() => window.__store.get('polls/pa').status === 'open'")
        poll = h.get(pg, "polls/pa")
        self.assertEqual(poll["status"], "open")
        self.assertFalse(poll["archived"], "an open motion must not stay archived")

    def test_an_archived_motion_is_never_the_live_motion(self):
        """REGRESSION: leadership's live-motion filter ignored `archived`,
        disagreeing with the voter page about what was open."""
        pg = self.admin()
        h.seed_poll(pg, pid="p9", text="Archived but open",
                    status="open", archived=True)
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        # Nothing should present itself as the current live motion.
        self.assertEqual(pg.locator("#r-close").count(), 0)

    def test_draft_motions_offer_open_not_reopen(self):
        pg = self.admin()
        # A draft is neither open nor closed, so it is never auto-displayed:
        # it has to be picked from the motion selector.
        h.seed_poll(pg, pid="pd", status="draft", text="Never opened")
        pg.wait_for_timeout(250)
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        pg.select_option("#results-selector select", "pd")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.inner_text("#r-open"), "Open voting")

    def test_closed_motions_offer_reopen(self):
        pg = self.admin()
        h.seed_poll(pg, pid="pc", status="closed", text="Already decided")
        pg.wait_for_timeout(250)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.inner_text("#r-open"), "Re-open voting")

    def test_only_one_motion_is_open_at_a_time(self):
        pg = self.admin()
        h.seed_poll(pg, pid="p1", text="First motion", status="open", order=0)
        h.seed_poll(pg, pid="p2", text="Second motion", status="draft", order=1)
        pg.wait_for_timeout(250)
        h.tab(pg, "motions")
        pg.evaluate("window.confirm = () => true")
        pg.click('#motion-list button[data-act="open"][data-id="p2"]')
        pg.wait_for_timeout(400)
        self.assertEqual(h.get(pg, "polls/p1")["status"], "closed")
        self.assertEqual(h.get(pg, "polls/p2")["status"], "open")

    def test_closing_freezes_the_weights_used_for_that_motion(self):
        """A later category change must not rewrite a historical result."""
        pg = self.admin()
        name = h.GROUP1[0]
        h.seed_poll(pg, vote_count=1)
        h.seed_ballots(pg, "p1", [name], choice="favour")
        pg.wait_for_timeout(250)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="close"]')
        pg.wait_for_timeout(400)
        locked = h.get(pg, "polls/p1")["lockedGroups"]
        self.assertEqual(locked[h.slugify(name)], "1")
        # demote the person now; the closed motion keeps the frozen weight
        h.tab(pg, "roster")
        pg.fill("#roster-filter", name)
        pg.wait_for_timeout(150)
        pg.click(f'#roster-table button[data-setgrp="courtesy"][data-slug="{h.slugify(name)}"]')
        pg.wait_for_timeout(400)
        h.tab(pg, "results")
        pg.wait_for_timeout(400)
        self.assertIn("1 pts", pg.inner_text("#results-body"))



class TestAddRemovePhysicians(Base):
    """Leadership adds and removes physicians in the console. Removing hides,
    never deletes, and no closed motion's result may move."""

    def add(self, pg, name, grp="1"):
        h.tab(pg, "roster")
        pg.fill("#add-name", name)
        pg.click(f'#add-cat button[data-grp="{grp}"]')
        pg.click("#add-go")
        pg.wait_for_timeout(300)

    def remove(self, pg, name):
        h.tab(pg, "roster")
        pg.fill("#roster-filter", name)
        pg.wait_for_timeout(150)
        pg.once("dialog", lambda d: d.accept())
        pg.click(f'#roster-table button[data-remove="{h.slugify(name)}"]')
        pg.wait_for_timeout(400)
        pg.fill("#roster-filter", "")

    def test_adding_a_physician_lists_them_with_their_category(self):
        pg = self.admin()
        self.add(pg, "  Zed   Newdoc ", "2")
        cfg = h.get(pg, "config/roster")
        self.assertEqual(cfg["added"]["zed-newdoc"], {"name": "Zed Newdoc"})
        self.assertEqual(cfg["groups"]["zed-newdoc"], "2")
        pg.fill("#roster-filter", "Zed")
        pg.wait_for_timeout(150)
        self.assertIn("Half vote", pg.inner_text("#roster-table"))
        self.assertIn(f"{h.ELIGIBLE + 1} currently eligible", pg.inner_text("#roster-summary"))
        # the same name again changes nothing
        self.add(pg, "Zed Newdoc", "1")
        self.assertEqual(h.get(pg, "config/roster")["groups"]["zed-newdoc"], "2")

    def test_remove_then_restore(self):
        pg = self.admin()
        name = h.GROUP1[0]
        self.remove(pg, name)
        self.assertTrue(h.get(pg, "config/roster")["removed"][h.slugify(name)])
        self.assertIn(f"{h.ELIGIBLE - 1} currently eligible", pg.inner_text("#roster-summary"))
        pg.fill("#roster-filter", name)
        pg.wait_for_timeout(150)
        self.assertIn("No match", pg.inner_text("#roster-table"))
        self.assertIn(name, pg.inner_text("#removed-list"))
        pg.click(f'#removed-list button[data-restore="{h.slugify(name)}"]')
        pg.wait_for_timeout(300)
        self.assertFalse(h.get(pg, "config/roster")["removed"][h.slugify(name)])
        self.assertIn(f"{h.ELIGIBLE} currently eligible", pg.inner_text("#roster-summary"))
        self.assertTrue(pg.is_hidden("#removed-card"))

    def test_voters_see_added_names_and_not_removed_ones(self):
        pg = self.voter()
        gone = h.GROUP1[0]
        pg.evaluate("""([gone]) => window.__store.set('config/roster', {
            added: { 'zed-newdoc': { name: 'Zed Newdoc' } }, groups: { 'zed-newdoc': '1' },
            removed: { [gone]: true } })""", [h.slugify(gone)])
        pg.wait_for_timeout(200)
        pg.fill("#search", "Zed")
        self.assertIn("Zed Newdoc", pg.inner_text("#namelist"))
        pg.fill("#search", gone.split()[0])
        self.assertIsNone(pg.query_selector(f'#namelist li[data-slug="{h.slugify(gone)}"]'))
        h.pick_voter(pg, "Zed Newdoc")
        pg.wait_for_selector(".tabs")

    def test_removing_never_changes_a_motion_closed_before_freezing_existed(self):
        """An old closed motion with no frozen categories gets a frozen copy
        BEFORE the list changes, so its result stays exactly as it was."""
        pg = self.admin()
        # Ballots first: an old closed motion already has its ballots when the
        # console signs in (it saves the result of such a motion straight away).
        h.seed_ballots(pg, "p1", h.GROUP1[:24], choice="favour")
        h.seed_ballots(pg, "p1", h.GROUP1[24:26], choice="against")
        h.seed_poll(pg, status="closed", vote_count=26)          # no lockedGroups
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        before = pg.inner_text("#results-body")
        self.assertIn("24 pts", before)
        self.remove(pg, h.GROUP1[0])
        self.add(pg, "Zed Newdoc", "1")
        locked = h.get(pg, "polls/p1")["lockedGroups"]
        self.assertEqual(locked[h.slugify(h.GROUP1[0])], "1")
        self.assertNotIn("zed-newdoc", locked)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.inner_text("#results-body"), before)

    def test_removing_never_changes_a_frozen_closed_motion(self):
        pg = self.admin()
        h.seed_poll(pg, vote_count=1)
        h.seed_ballots(pg, "p1", [h.GROUP1[0]], choice="favour")
        pg.wait_for_timeout(250)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="close"]')
        pg.wait_for_timeout(400)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        before = pg.inner_text("#results-body")
        self.remove(pg, h.GROUP1[0])
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.inner_text("#results-body"), before)
        self.assertIn("1 pts", before)

    def test_a_removed_physicians_vote_on_the_open_motion_stops_counting(self):
        pg = self.admin()
        h.seed_poll(pg, vote_count=1)
        h.seed_ballots(pg, "p1", [h.GROUP1[0]], choice="favour")
        self.remove(pg, h.GROUP1[0])
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        self.assertIn("0 pts", pg.inner_text("#results-body"))

class TestSignIn(Base):
    """One sign-in is shared by every tab of the site, so the voter page must
    never replace a leadership session, otherwise the console in the next tab
    (or on the chair's own laptop) silently loses its write access."""

    def test_voter_page_keeps_an_existing_leadership_session(self):
        self.page.add_init_script(h.auth_init(h.LEADER_EMAIL))
        p = self.voter()
        self.assertEqual(p.evaluate("() => window.__auth.current().uid"), h.LEADER_UID)

    def test_voter_page_asks_for_the_ed_password_and_signs_in_as_ed(self):
        # self.voter() goes through the ED-password screen (harness.open_voter)
        p = self.voter()
        self.assertEqual(p.evaluate("() => window.__auth.current().uid"), h.ED_UID)
        self.assertEqual(p.evaluate("() => window.__lastEmail"), h.ED_EMAIL)   # signs in with the email of today
        self.assertFalse(p.evaluate("() => window.__auth.current().isAnonymous"))

    def test_voter_page_shows_the_password_screen_after_a_sign_out_elsewhere(self):
        p = self.voter()
        p.evaluate("() => window.__auth.force(null)")
        p.wait_for_selector("#edpw")
        self.assertIsNone(p.query_selector("#search"))

    def test_a_wrong_ed_password_is_refused_and_says_so(self):
        self.page.add_init_script("window.__authReject = true;")
        self.page.goto(f"{self.base}/index.html")
        self.page.fill("#edpw", "nope")
        self.page.click("#edgo")
        self.page.wait_for_selector("#ederr:not(.hide)")
        self.assertIn("not the ED password", self.page.inner_text("#ederr"))
        self.assertIsNone(self.page.query_selector("#search"))

    def test_a_wrong_leadership_password_opens_nothing(self):
        self.page.add_init_script("window.__authReject = true;")
        h.load_admin(self.page, self.base)
        self.page.fill("#pass", "nope")
        self.page.click("#enter")
        self.page.wait_for_selector("#gate-err:not(.hide)")
        self.assertEqual(self.page.inner_text("#gate-err"), "Incorrect password.")
        self.assertTrue(self.page.evaluate("document.getElementById('console').classList.contains('hide')"))

    def test_password_screens_ignore_stray_spaces_and_name_the_password(self):
        # Safari files saved passwords by username; a fixed one per password stops it
        # filling the wrong saved password (all ED tools share one web address).
        self.page.add_init_script("window.__authReject = true;")
        self.page.goto(f"{self.base}/index.html")
        self.assertEqual(self.page.input_value("#edgate input[autocomplete=username]"), "ED password")
        self.page.fill("#edpw", "  secret1 ")
        self.page.click("#edgo")
        self.page.wait_for_selector("#ederr:not(.hide)")
        self.assertEqual(self.page.evaluate("window.__lastPassword"), "secret1")
        h.load_admin(self.page, self.base)
        # The Admin password keeps the hidden name "Leadership password" (step 11): it is
        # the name phones saved it under, so changing it would stop them matching.
        self.assertEqual(self.page.input_value("#gate-form input[autocomplete=username]"), "Leadership password")
        self.page.fill("#pass", " secret2  ")
        self.page.click("#enter")
        self.page.wait_for_selector("#gate-err:not(.hide)")
        self.assertEqual(self.page.evaluate("window.__lastPassword"), "secret2")

    def test_an_old_anonymous_session_is_not_enough_to_vote(self):
        self.page.add_init_script(
            "window.__authInitial = { uid: 'anon-x', isAnonymous: true, email: null };")
        self.page.goto(f"{self.base}/index.html")
        self.page.wait_for_selector("#edpw")
        self.assertIsNone(self.page.query_selector("#search"))


class TestVoterReview(Base):
    """Duplicate detection: flagged, not blocked."""

    def test_same_name_from_two_devices_is_flagged(self):
        pg = self.admin()
        name = h.GROUP1[0]
        h.seed_poll(pg, vote_count=1)
        pg.evaluate(
            "([s, n]) => window.__store.set('polls/p1/votes/' + s, {name:n, slug:s,"
            " choice:'favour', group:'1', weight:1, flagged:true, submissionCount:2,"
            " sessionIds:['dev-a','dev-b']})",
            [h.slugify(name), name])
        pg.wait_for_timeout(250)
        h.tab(pg, "voters")
        pg.wait_for_timeout(250)
        table = pg.inner_text("#voters-table")
        self.assertIn("Needs review", table)
        self.assertIn("1 to review", pg.inner_text("#voters-note"))

    def test_one_device_under_two_names_is_flagged(self):
        pg = self.admin()
        a, b = h.GROUP1[0], h.GROUP1[1]
        h.seed_poll(pg, vote_count=2)
        pg.evaluate(
            "rows => rows.forEach(r => window.__store.set('polls/p1/votes/' + r.slug, r))",
            [{"name": n, "slug": h.slugify(n), "choice": "favour", "group": "1",
              "weight": 1, "flagged": False, "submissionCount": 1,
              "sessionIds": ["shared-device"]} for n in (a, b)])
        pg.wait_for_timeout(250)
        h.tab(pg, "voters")
        pg.wait_for_timeout(250)
        self.assertIn("Shared device", pg.inner_text("#voters-table"))


class TestBallotFieldsAreNotCode(Base):
    """Ballot fields are typed by voters, so the console must show them as
    text, never run them (the page's Content-Security-Policy is the backstop)."""

    def test_crafted_ballot_fields_are_shown_as_text(self):
        pg = self.admin()
        h.seed_poll(pg, vote_count=1)
        evil = '<img src=x data-evil=1>'
        ballot = {"name": "Pat Q", "slug": 'x" data-evil="1', "choice": evil,
                  "group": "writein", "weight": 0, "isWriteIn": True, "flagged": True,
                  "submissionCount": evil, "sessionIds": ["a", "b"]}
        pg.evaluate("b => window.__store.set('polls/p1/votes/x', b)", ballot)
        pg.wait_for_timeout(250)
        h.tab(pg, "voters")
        pg.wait_for_timeout(250)
        self.assertIn(evil, pg.inner_text("#voters-table"))   # shown as text
        h.tab(pg, "roster")
        pg.fill("#roster-filter", "Pat Q")
        pg.wait_for_timeout(150)
        self.assertIn("Pat Q", pg.inner_text("#roster-table"))
        self.assertEqual(pg.evaluate("document.querySelectorAll('[data-evil]').length"), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
