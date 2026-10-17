"""Questions and elections (voting upgrade step 6, V10).

Each pick adds the voter's full points to that option; winners are the top
`seats` options with points; a tie only when an option outside the winners is
level with the last winner; "more than half" for single-pick questions, with a
run-off of the top two.
"""
import unittest

import harness as h
from base import Base
from test_saved_results import seed_open, wait_result, NOW
from test_voter_board import build_board

OPTS = [{"id": "o1", "label": "Dr A"}, {"id": "o2", "label": "Dr B"}, {"id": "o3", "label": "Dr C"}]
RULE = {"v": 1, "weights": {"1": 1, "2": 0.5, "courtesy": 0}, "quorumPercent": 50, "threshold": "plurality", "tieRule": "tie"}


def seed_choice(pg, pid="q1", seats=1, style="question", threshold="plurality", status="open", **extra):
    d = {"text": "Which schedule?" if style == "question" else "Elect the committee", "order": 0, "status": status,
         "voteCount": 0, "archived": False, "deleted": False, "kind": "choice", "style": style, "options": OPTS,
         "optionIds": ["o1", "o2", "o3"], "seats": seats, "threshold": threshold, "openedAt": h.ts(NOW - 60000),
         "rule": {**RULE, "threshold": threshold}}
    d.update(extra)
    h.seed(pg, f"polls/{pid}", d)


def pick_ballots(pg, pid, names, picks, group="1", weight=1):
    for n in names:
        h.seed(pg, f"polls/{pid}/votes/{h.slugify(n)}", {"name": n, "slug": h.slugify(n), "choice": "pick" if picks else "abstain",
                                                       "picks": picks, "group": group, "weight": weight, "flagged": False, "submissionCount": 1})


class TestChoiceCounting(Base):
    def count(self, seats, threshold, ballots, style="election"):
        """ballots: list of (group, picks or None for abstain)."""
        return self.page.evaluate("""async ([seats, threshold, ballots, style]) => {
            const c = await import('./js/count.js');
            const poll = { kind: 'choice', status: 'open', seats, style, threshold,
              options: [{ id: 'o1', label: 'Dr A' }, { id: 'o2', label: 'Dr B' }, { id: 'o3', label: 'Dr C' }],
              rule: { ...c.LEGACY_RULE, threshold } };
            const votes = ballots.map(([g, p], i) => ({ slug: 's' + i, group: g, choice: p ? 'pick' : 'abstain', picks: p || [] }));
            const groups = Object.fromEntries(votes.map((v) => [v.slug, v.group]));
            const r = c.computeResult(poll, votes, { groupOf: (s) => groups[s], liveEligible: () => 4, settings: null });
            return { outcome: r.outcome, words: c.outcomeWords(r), winners: r.winners, tied: r.tied, note: r.note,
                     points: r.options.map((o) => [o.id, o.weight]) }; }""", [seats, threshold, ballots, style])

    def setUp(self):
        super().setUp()
        h.open_admin(self.page, self.base)

    def test_question_single_pick_counts_weighted_points(self):
        r = self.count(1, "plurality", [["1", ["o2"]], ["2", ["o1"]], ["2", ["o1"]], ["2", ["o1"]]], style="question")
        self.assertEqual(r["points"], [["o1", 1.5], ["o2", 1], ["o3", 0]])
        self.assertEqual(r["words"], "Chosen: Dr A")

    def test_election_two_seats(self):
        r = self.count(2, "plurality", [["1", ["o1", "o2"]], ["1", ["o1", "o3"]], ["1", ["o2"]]])
        self.assertEqual((r["outcome"], r["winners"], r["words"]), ("decided", ["o1", "o2"], "Elected: Dr A, Dr B"))

    def test_level_options_inside_the_winners_are_not_a_tie(self):
        r = self.count(2, "plurality", [["1", ["o1", "o2"]], ["1", ["o1", "o2"]], ["1", ["o3"]]])
        self.assertEqual((r["outcome"], r["winners"]), ("decided", ["o1", "o2"]))

    def test_tie_for_last_seat_is_reported(self):
        r = self.count(2, "plurality", [["1", ["o1", "o2"]], ["1", ["o1", "o3"]]])
        self.assertEqual((r["outcome"], r["winners"], r["tied"]), ("tie", ["o1"], ["o2", "o3"]))
        self.assertEqual(r["words"], "Tie for the last seat: Dr B and Dr C")
        r = self.count(1, "plurality", [["1", ["o1"]], ["1", ["o2"]]], style="question")
        self.assertEqual(r["words"], "Tie for first place: Dr A and Dr B")

    def test_zero_point_option_never_wins(self):
        r = self.count(2, "plurality", [["1", ["o1"]], ["1", ["o1"]], ["courtesy", ["o3"]]])
        self.assertEqual((r["outcome"], r["winners"]), ("decided", ["o1"]))
        self.assertEqual(r["note"], "Only 1 option received points.")

    def test_fewer_options_with_points_than_seats(self):
        r = self.count(2, "plurality", [["1", ["o2"]], ["1", ["o2"]], ["1", None]])
        self.assertEqual((r["outcome"], r["winners"], r["note"]), ("decided", ["o2"], "Only 1 option received points."))
        r = self.count(2, "plurality", [["1", None], ["1", None]])
        self.assertEqual((r["outcome"], r["words"]), ("none", "No choice made"))

    def test_more_than_half_rule(self):
        r = self.count(1, "majority", [["1", ["o1"]], ["1", ["o1"]], ["1", ["o2"]], ["1", ["o3"]]], style="question")
        self.assertEqual((r["outcome"], r["words"]), ("noMajority", "No option has more than half. Dr A leads."))
        r = self.count(1, "majority", [["1", ["o1"]], ["1", ["o1"]], ["1", ["o2"]], ["1", None]], style="question")
        self.assertEqual(r["outcome"], "decided")         # abstentions not counted: 2 of 3


class TestChoiceConsole(Base):
    def test_add_an_election_from_the_console(self):
        pg = self.admin()
        h.tab(pg, "motions")
        pg.click('#new-kind button[data-kind="election"]')
        self.assertIn("Candidates, one per line", pg.inner_text("#choice-fields"))
        pg.fill("#new-motion", "Elect two members of the scheduling committee")
        pg.fill("#new-options", "Dr A\nDr B")
        pg.fill("#new-seats", "2")
        pg.click("#add-motion")
        self.assertIn("Seats must be fewer than the number of candidates.", pg.inner_text("#toast"))
        pg.fill("#new-options", "Dr A\nDr B\nDr C")
        pg.click("#add-motion")
        pg.wait_for_function("() => Object.values(window.__store.dump()).some(v => v.kind === 'choice')")
        p = [v for k, v in h.store(pg).items() if k.startswith("polls/") and v.get("kind") == "choice"][0]
        self.assertEqual((p["style"], p["seats"], p["optionIds"], p["threshold"]), ("election", 2, ["o1", "o2", "o3"], "plurality"))
        self.assertEqual([o["label"] for o in p["options"]], ["Dr A", "Dr B", "Dr C"])

    def test_more_than_half_rule_and_runoff(self):
        pg = self.admin()
        pick_ballots(pg, "q1", h.GROUP1[:5], ["o1"])
        pick_ballots(pg, "q1", h.GROUP1[5:9], ["o2"])
        pick_ballots(pg, "q1", h.GROUP1[9:12], ["o3"])
        seed_choice(pg, threshold="majority", voteCount=12)
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        r = wait_result(pg, "q1")["result"]
        self.assertEqual(r["outcome"], "noq")              # 12 of 48: no quorum yet
        # with quorum: a fresh question
        pick_ballots(pg, "q2", h.GROUP1[:12], ["o1"])
        pick_ballots(pg, "q2", h.GROUP1[12:22], ["o2"])
        pick_ballots(pg, "q2", h.GROUP1[22:30], ["o3"])
        seed_choice(pg, "q2", threshold="majority", voteCount=30, order=1)
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.select_option("#results-selector select", "q2")
        pg.wait_for_timeout(200)
        pg.click("#r-close")
        r = wait_result(pg, "q2")["result"]
        self.assertEqual(r["outcome"], "noMajority")
        pg.wait_for_timeout(200)
        self.assertIn("No option has more than half. Dr A leads.", pg.inner_text("#results-body"))
        pg.evaluate("window.confirm = () => true")
        pg.click("#r-runoff")
        pg.wait_for_function("() => window.__store.get('polls/q2').supersededBy")
        new = h.get(pg, "polls/" + h.get(pg, "polls/q2")["supersededBy"])
        self.assertEqual([o["label"] for o in new["options"]], ["Dr A", "Dr B"])
        self.assertEqual((new["seats"], new["threshold"], new["revoteOf"]), (1, "majority", "q2"))
        self.assertTrue(any(v["action"] == "runoff" for k, v in h.store(pg).items() if k.startswith("log/")))

    def test_options_lock_after_first_vote(self):
        pg = self.admin()
        pick_ballots(pg, "q1", h.GROUP1[:1], ["o1"])
        seed_choice(pg, voteCount=1)
        pg.wait_for_timeout(300)
        h.tab(pg, "motions")
        self.assertEqual(pg.locator('#motion-list button[data-act="edit"][data-id="q1"]').count(), 0)
        self.assertIn("Locked: voting started", pg.inner_text("#motion-list"))

    def test_voters_tab_shows_the_picks(self):
        pg = self.admin()
        pick_ballots(pg, "q1", h.GROUP1[:1], ["o1", "o3"])
        seed_choice(pg, seats=2, style="election", voteCount=1)
        pg.wait_for_timeout(300)
        h.tab(pg, "voters")
        self.assertIn("Dr A, Dr C", pg.inner_text("#voters-table"))


class TestChoiceVoter(Base):
    allowed_errors = ("permission-denied",)

    def test_single_pick_is_a_tap(self):
        pg = self.voter()
        seed_choice(pg)
        build_board(pg)
        h.pick_voter(pg, h.GROUP2[0])
        pg.click('button[data-pick="o2"]')
        pg.wait_for_function(f"() => window.__store.get('polls/q1/votes/{h.slugify(h.GROUP2[0])}')")
        b = h.get(pg, f"polls/q1/votes/{h.slugify(h.GROUP2[0])}")
        self.assertEqual((b["choice"], b["picks"]), ("pick", ["o2"]))
        pg.wait_for_selector("text=You voted for Dr B.")
        self.assertEqual(pg.get_attribute('button[data-pick="o2"]', "aria-pressed"), "true")

    def test_same_picks_in_another_order_is_not_a_new_submission(self):
        pg = self.voter()
        seed_choice(pg, seats=2, style="election")
        build_board(pg)
        slug = h.slugify(h.GROUP1[0])
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('button[data-pick="o3"]')
        self.assertEqual(pg.inner_text("#pick-count"), "Pick up to 2. You picked 1.")
        self.assertEqual(pg.get_attribute("#pick-count", "aria-live"), "polite")
        pg.click('button[data-pick="o1"]')
        pg.click("#submit-picks")
        pg.wait_for_function(f"() => window.__store.get('polls/q1/votes/{slug}')")
        self.assertEqual(h.get(pg, f"polls/q1/votes/{slug}")["picks"], ["o1", "o3"])     # option order
        pg.click('button[data-pick="o1"]')
        pg.click('button[data-pick="o3"]')
        pg.click('button[data-pick="o3"]')
        pg.click('button[data-pick="o1"]')
        pg.click("#submit-picks")
        pg.wait_for_timeout(300)
        self.assertEqual(h.get(pg, f"polls/q1/votes/{slug}")["submissionCount"], 1)
        pg.click('button[data-pick="o3"]')
        pg.click('button[data-pick="o2"]')
        pg.click("#submit-picks")
        pg.wait_for_function(f"() => window.__store.get('polls/q1/votes/{slug}').submissionCount === 2")
        self.assertEqual(h.get(pg, f"polls/q1/votes/{slug}")["picks"], ["o1", "o2"])

    def test_abstain_on_a_question(self):
        pg = self.voter()
        seed_choice(pg)
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('button[data-c="abstain"]')
        pg.wait_for_function(f"() => window.__store.get('polls/q1/votes/{h.slugify(h.GROUP1[0])}')")
        b = h.get(pg, f"polls/q1/votes/{h.slugify(h.GROUP1[0])}")
        self.assertEqual((b["choice"], b["picks"]), ("abstain", []))
        pg.wait_for_selector("text=You abstained.")

    def test_voter_sees_the_election_result(self):
        pg = self.voter()
        seed_choice(pg, seats=2, style="election", status="closed", closedAt=h.ts(NOW - 5000), result={
            "v": 1, "kind": "choice", "seats": 2, "style": "election", "outcome": "decided",
            "options": [{"id": "o2", "label": "Dr B", "weight": 18, "count": 20}, {"id": "o1", "label": "Dr A", "weight": 15.5, "count": 17},
                        {"id": "o3", "label": "Dr C", "weight": 4, "count": 5}],
            "abstain": {"weight": 1, "count": 1}, "winners": ["o2", "o1"], "tied": [], "note": "",
            "weight": {"favour": 0, "against": 0, "abstain": 1}, "count": {"favour": 0, "against": 0, "abstain": 1},
            "totalVotes": 30, "quorumCount": 29, "quorumNeeded": 24, "eligible": 48, "rule": RULE, "savedAt": h.ts(NOW - 4000)})
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        text = pg.inner_text("#app")
        self.assertIn("Elected: Dr B, Dr A", text)
        self.assertIn("18 pts · 20 votes", text)
        self.assertNotIn("options", h.get(pg, "config/live")["results"]["q1"])     # labels only in the result

    def test_choice_vote_on_rules_without_questions_says_tell_leadership(self):
        """Step-6 page on the step-5 rules: a question ballot is refused."""
        pg = self.voter()
        seed_choice(pg)
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.evaluate("window.__store.fail('polls/q1/votes', 'permission-denied', 'w')")
        pg.click('button[data-pick="o1"]')
        pg.wait_for_selector("text=Your vote could not be recorded. Please tell leadership.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
