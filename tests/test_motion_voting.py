"""Behaviour tests for the Motion Voting tool.

Each test drives the real pages in a headless browser against a stubbed
Firestore (see harness.py). Run with:

    cd tools/motion-voting/tests && python3 -m unittest -v

Every group maps to a promise the tool makes to a real person in a meeting.
Tests marked REGRESSION pin a bug that was found and fixed — see CHANGES.md.
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
        pg = self.voter()
        h.seed_poll(pg, status="closed", vote_count=len(h.COURTESY))
        h.seed_ballots(pg, "p1", h.COURTESY, group="courtesy", weight=0)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.wait_for_timeout(300)
        # Every courtesy member voting still cannot carry a motion.
        self.assertEqual(h.outcomes(pg.inner_text("#app")), ["NO QUORUM"])

    def test_pass_rule_is_weighted_favour_over_against(self):
        pg = self.admin()
        # 24 full votes for, 2 against -> quorum met, passes.
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:24], choice="favour")
        h.seed_ballots(pg, "p1", h.GROUP1[24:26], choice="against")
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        body = pg.inner_text("#results-body")
        self.assertEqual(h.outcomes(body), ["PASSES ✅"])
        self.assertIn("24 pts", body)

    def test_tie_is_reported_as_a_tie(self):
        pg = self.admin()
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:13], choice="favour")
        h.seed_ballots(pg, "p1", h.GROUP1[13:26], choice="against")
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#results-body")), ["TIE 🤝"])

    def test_half_weight_group_counts_as_half_a_point(self):
        pg = self.admin()
        h.seed_poll(pg, status="closed", vote_count=len(h.GROUP2))
        h.seed_ballots(pg, "p1", h.GROUP2, choice="favour", group="2", weight=0.5)
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        body = pg.inner_text("#results-body")
        self.assertIn(f"{h.fmt(len(h.GROUP2) / 2)} pts", body)
        self.assertIn(f"{len(h.GROUP2)} votes", body)


class TestCastingAVote(Base):
    """What happens when a physician taps a choice."""

    def test_ballot_is_stored_with_the_right_name_group_and_weight(self):
        pg = self.voter()
        h.seed_poll(pg)
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
        pg = self.voter()
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector('[data-vtab="results"]')
        # click and read in the same tick, before the snapshot callback runs
        first = pg.evaluate("""() => {
            document.querySelector('[data-vtab="results"]').click();
            return document.querySelector('#app').innerText; }""")
        self.assertEqual(h.outcomes(first), [], "a verdict was shown before the count")
        self.assertIn("Counting votes", first)
        pg.wait_for_timeout(400)
        self.assertEqual(h.outcomes(pg.inner_text("#app")), ["PASSED ✅"])

    def test_admin_sees_counting_not_a_verdict_before_ballots_load(self):
        # The motion is known but its ballots are still in flight: hold the
        # votes snapshot back so that state is pinned rather than raced.
        pg = self.admin()
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.tab(pg, "results")
        pg.wait_for_timeout(300)
        stalled = pg.inner_text("#results-body")
        self.assertEqual(h.outcomes(stalled), [], "a verdict was shown before the count")
        self.assertIn("Counting votes", stalled)
        pg.evaluate("window.__store.release('polls/p1/votes')")
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#results-body")), ["PASSES ✅"])

    def test_voter_results_show_counting_while_ballots_are_in_flight(self):
        pg = self.voter()
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#app")), [])
        pg.evaluate("window.__store.release('polls/p1/votes')")
        pg.wait_for_timeout(300)
        self.assertEqual(h.outcomes(pg.inner_text("#app")), ["PASSED ✅"])

    def test_export_is_refused_until_the_ballots_are_in(self):
        pg = self.admin()
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
        h.tab(pg, "voters")
        pg.wait_for_timeout(300)
        msg = pg.evaluate("""() => {
            document.querySelector('#export').click();
            return document.querySelector('#toast').textContent; }""")
        self.assertIn("loading", msg.lower())

    def test_export_works_once_the_ballots_are_in(self):
        pg = self.admin()
        h.seed_poll(pg, status="closed", vote_count=26)
        h.seed_ballots(pg, "p1", h.GROUP1[:26], choice="favour")
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
        pg.click("#r-open")
        pg.wait_for_timeout(400)
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
        # A draft is neither open nor closed, so it is never auto-displayed —
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
        self.assertIn("REVIEW", table)
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
        self.assertIn("SHARED DEVICE", pg.inner_text("#voters-table"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
