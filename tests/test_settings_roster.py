"""Voting rules in Settings (voting upgrade step 3, V7) and the physician list:
paste to update, write-ins always visible (V8).

A settings change applies only to motions opened afterwards: closed motions
keep their saved results, the open motion keeps the rules it opened with, and
any motion without its own rule copy counts with today's old rules (LEGACY_RULE).
"""
import unittest

import harness as h
from base import Base
from test_saved_results import seed_open, seed_old_closed, wait_result, NOW


def settings(**kw):
    s = {"v": 1, "weights": {"1": 1, "2": 0.5, "courtesy": 0}, "quorumPercent": 50, "threshold": "majority",
         "tieRule": "tie", "checkIn": True, "retentionYears": 7, "updatedAt": h.ts(NOW - 1000)}
    s.update(kw)
    return s


def save_rules(pg, **fields):
    pg.click("#open-settings")
    for k, v in fields.items():
        if k in ("threshold", "tie-rule"):
            pg.select_option(f"#{k}", v)
        else:
            pg.fill(f"#{k}", str(v))
    pg.click("#settings-save")


class TestSettings(Base):
    def unit(self, body):
        return self.page.evaluate("async () => { const c = await import('./js/count.js'); %s }" % body)

    def test_decide_table(self):
        self.admin()
        rows = self.unit("""
            const r = (t, q) => ({ ...c.LEGACY_RULE, threshold: t, quorumPercent: q || 50 });
            const T = (f, a, qc = 30) => ({ units: { favour: f * 100, against: a * 100 }, quorumCount: qc });
            return [
              c.decide(T(10, 5), r('majority'), 24), c.decide(T(5, 10), r('majority'), 24), c.decide(T(5, 5), r('majority'), 24),
              c.decide(T(0, 0), r('majority'), 24), c.decide(T(10, 5, 10), r('majority'), 24),
              c.decide(T(10, 5), r('twoThirds'), 24), c.decide(T(9, 5), r('twoThirds'), 24), c.decide(T(5, 5), r('twoThirds'), 24),
              c.decide(T(0, 0), r('twoThirds'), 24), c.decide(T(10, 5, 23), r('twoThirds'), 24) ];""")
        self.assertEqual(rows, ["pass", "fail", "tie", "tie", "noq", "pass", "fail", "fail", "fail", "noq"])

    def test_two_thirds_exactly_passes(self):
        self.admin()
        self.assertEqual(self.unit("return c.decide({ units: { favour: 1000, against: 500 }, quorumCount: 30 }, { threshold: 'twoThirds' }, 24);"), "pass")
        self.assertEqual(self.unit("return c.decide({ units: { favour: 650, against: 350 }, quorumCount: 30 }, { threshold: 'twoThirds' }, 24);"), "fail")

    def test_two_thirds_equal_points_fails_not_tie(self):
        self.admin()
        words = self.unit("""
            const rule = { ...c.LEGACY_RULE, threshold: 'twoThirds' };
            const eq = { outcome: c.decide({ units: { favour: 500, against: 500 }, quorumCount: 30 }, rule, 24), rule, weight: { favour: 5, against: 5 } };
            const none = { outcome: c.decide({ units: { favour: 0, against: 0 }, quorumCount: 30 }, rule, 24), rule, weight: { favour: 0, against: 0 } };
            return [eq.outcome, c.outcomeWords(eq, 'voter'), none.outcome, c.outcomeWords(none, 'voter')];""")
        self.assertEqual(words, ["fail", "Did not pass (needed two-thirds)", "fail", "Did not pass: no points for or against"])

    def test_quorum_percent_rounds_up(self):
        self.admin()
        self.assertEqual(self.unit("return [c.quorumNeededFor(48, 50), c.quorumNeededFor(49, 50), c.quorumNeededFor(48, 60), c.quorumNeededFor(7, 33), c.quorumNeededFor(48, 100)];"),
                         [24, 25, 29, 3, 48])

    def test_tie_wording_follows_the_motion_not_todays_settings(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed(pg, "config/settings", settings(tieRule="fails"))
        seed_old_closed(pg, "p1", [])          # an old motion: 0 and 0, no quorum
        h.seed_ballots(pg, "p2", h.GROUP1[:13], choice="favour")
        h.seed_ballots(pg, "p2", h.GROUP1[13:26], choice="against")
        h.seed(pg, "polls/p2", {"text": "Tie motion", "order": 1, "status": "closed", "voteCount": 26, "archived": False, "deleted": False})
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        p = wait_result(pg, "p2")
        self.assertEqual(p["result"]["rule"]["tieRule"], "tie")    # old motion: the old rules
        h.tab(pg, "results")
        pg.select_option("#results-selector select", "p2")
        pg.wait_for_timeout(200)
        self.assertEqual(h.outcomes(pg.inner_text("#results-body")), ["Tie"])

    def test_old_motion_uses_the_legacy_rule_after_a_settings_change(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed(pg, "config/settings", settings(quorumPercent=60, weights={"1": 1, "2": 1, "courtesy": 0}))
        seed_old_closed(pg, "p1", h.GROUP1[:25])
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        p = wait_result(pg)
        self.assertEqual(p["result"]["rule"]["quorumPercent"], 50)
        self.assertEqual(p["result"]["quorumNeeded"], h.QUORUM)
        self.assertEqual(p["result"]["outcome"], "pass")

    def test_settings_change_never_changes_a_closed_result(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:24])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        before = wait_result(pg)["result"]
        h.tab(pg, "results")
        text = pg.inner_text("#results-body")
        save_rules(pg, **{"q-pct": 80, "w-2": 1})
        pg.wait_for_function("() => (window.__store.get('config/settings') || {}).quorumPercent === 80")
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        self.assertEqual(h.get(pg, "polls/p1")["result"], before)
        self.assertEqual(pg.inner_text("#results-body"), text)

    def test_open_motion_keeps_the_rules_it_opened_with(self):
        pg = self.admin()
        h.seed_ballots(pg, "p1", h.GROUP2[:2], choice="favour", group="2", weight=0.5)
        seed_open(pg, ballots=[])
        pg.wait_for_timeout(300)
        save_rules(pg, **{"w-2": 1, "q-pct": 75})
        pg.wait_for_function("() => (window.__store.get('config/settings') || {}).quorumPercent === 75")
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        body = pg.inner_text("#results-body")
        self.assertIn("1 pts · 2 votes", body)          # still half a point each
        self.assertIn(f"2 of {h.QUORUM}", body)          # still 50%
        pg.click("#r-close")
        r = wait_result(pg)["result"]
        self.assertEqual(r["weight"]["favour"], 1)
        self.assertEqual(r["rule"]["quorumPercent"], 50)

    def test_custom_weights_used_for_new_motions(self):
        pg = self.admin()
        h.seed_ballots(pg, "pd", h.GROUP2[:2], choice="favour", group="2", weight=0.5)
        h.seed_poll(pg, pid="pd", status="draft", text="Next motion")
        pg.wait_for_timeout(300)
        save_rules(pg, **{"w-2": 1})
        pg.wait_for_function("() => ((window.__store.get('config/settings') || {}).weights || {})['2'] === 1")
        self.assertIn("Saved. Applies to motions opened from now on.", pg.inner_text("#toast"))
        h.tab(pg, "roster")
        self.assertIn("Group 2, 1 point", pg.inner_text("#keylist"))
        self.assertIn(f"Eligible {h.ELIGIBLE}", pg.inner_text("#roster-counts"))
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="pd"]')
        pg.wait_for_function("() => window.__store.get('polls/pd').status === 'open'")
        self.assertEqual(h.get(pg, "polls/pd")["rule"]["weights"]["2"], 1)
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        self.assertIn("2 pts · 2 votes", pg.inner_text("#results-body"))
        log = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "settings"]
        self.assertEqual(log[0]["after"]["weights"]["2"], 1)

    def test_motion_opened_after_settings_change_uses_new_rule(self):
        pg = self.admin()
        h.seed_poll(pg, pid="pd", status="draft", text="Next motion")
        h.seed(pg, "polls/pd", {**h.get(pg, "polls/pd"), "threshold": "majority"})
        pg.wait_for_timeout(300)
        save_rules(pg, **{"q-pct": 60, "threshold": "twoThirds", "tie-rule": "fails"})
        pg.wait_for_function("() => (window.__store.get('config/settings') || {}).quorumPercent === 60")
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="pd"]')
        pg.wait_for_function("() => window.__store.get('polls/pd').status === 'open'")
        rule = h.get(pg, "polls/pd")["rule"]
        self.assertEqual((rule["quorumPercent"], rule["tieRule"]), (60, "fails"))
        # the draft was added before the change: it keeps the pass rule it was added with
        self.assertEqual(rule["threshold"], "majority")
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        self.assertIn("0 of 29", pg.inner_text("#results-body"))
        # a motion added now gets the new default pass rule
        h.tab(pg, "motions")
        self.assertEqual(pg.input_value("#new-threshold"), "twoThirds")

    def test_settings_screen_refuses_invalid_values(self):
        pg = self.admin()
        pg.wait_for_timeout(200)
        save_rules(pg, **{"w-1": 1.5, "q-pct": 50.5, "keep-years": 6})
        pg.wait_for_selector("#rules-err:not(.hide)")
        err = pg.inner_text("#rules-err")
        self.assertIn("between 0 and 1", err)
        self.assertIn("whole number from 1 to 100", err)
        self.assertIn("at least 7 years", err)
        self.assertIsNone(h.get(pg, "config/settings"))

    def test_voter_ballot_says_two_thirds_when_it_applies(self):
        pg = self.voter()
        seed_open(pg, ballots=[], threshold="twoThirds",
                  rule={"v": 1, "weights": {"1": 1, "2": 0.5, "courtesy": 0}, "quorumPercent": 50, "threshold": "twoThirds", "tieRule": "tie"})
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector("text=Needs two-thirds of the points cast to pass.")


class TestRosterPaste(Base):
    def preview(self, pg, text):
        h.tab(pg, "roster")
        if not pg.evaluate("document.querySelector('#paste-fold').open"):
            pg.click("#paste-fold summary")
        pg.fill("#paste-text", text)
        pg.click("#paste-preview")
        pg.wait_for_selector("#paste-apply")
        return pg.inner_text("#paste-result")

    def test_paste_preview_lists_new_changed_unchanged_missing(self):
        pg = self.admin()
        g2 = h.GROUP2[0]
        text = "\n".join([f"{n}\tFull" for n in h.GROUP1] + [f"{g2}\tFull", "Zed Newdoc\tHalf"])
        out = self.preview(pg, text)
        self.assertIn("New (1)", out)
        self.assertIn("Zed Newdoc: Half vote", out)
        self.assertIn("Category changes (1)", out)
        self.assertIn(f"{g2}: Half vote to Full vote", out)
        self.assertIn(f"Unchanged ({len(h.GROUP1)})", out)
        missing = len(h.GROUP2) - 1 + len(h.COURTESY)
        self.assertIn(f"Not in the pasted list ({missing})", out)
        pg.click("#paste-apply")
        pg.wait_for_function("() => (window.__store.get('config/roster') || {}).groups")
        r = h.get(pg, "config/roster")
        self.assertEqual(r["groups"][h.slugify(g2)], "1")
        self.assertEqual(r["added"]["zed-newdoc"], {"name": "Zed Newdoc"})
        log = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "roster-bulk"]
        self.assertEqual(len(log), 1)
        self.assertIn("Zed Newdoc (Half vote)", log[0]["after"]["added"])

    def test_paste_does_not_remove_unless_ticked(self):
        pg = self.admin()
        out = self.preview(pg, f"{h.GROUP1[0]}, Full")
        self.assertIn("Also remove these", out)
        self.assertFalse(pg.is_checked("#paste-remove"))
        pg.click("#paste-apply")
        pg.wait_for_function("() => document.querySelector('#toast').textContent.startsWith('List updated')")
        self.assertNotIn("removed", h.get(pg, "config/roster") or {})
        # ticked: they are hidden (never deleted)
        self.preview(pg, f"{h.GROUP1[0]}, Full")
        pg.check("#paste-remove")
        pg.evaluate("window.confirm = () => true")
        pg.click("#paste-apply")
        pg.wait_for_function("() => (window.__store.get('config/roster') || {}).removed")
        removed = h.get(pg, "config/roster")["removed"]
        self.assertTrue(removed[h.slugify(h.GROUP1[1])])
        self.assertNotIn(h.slugify(h.GROUP1[0]), [k for k, v in removed.items() if v])

    def test_paste_understands_last_first_and_category_words(self):
        pg = self.admin()
        out = self.preview(pg, "Newdoc, Zed, Group 2\nOther, Amy\t0\nThird Person, courtesy\nFourth Person, 1\nBad Line, maybe")
        self.assertIn("Zed Newdoc: Half vote", out)
        self.assertIn("Amy Other: No vote", out)
        self.assertIn("Third Person: No vote", out)
        self.assertIn("Fourth Person: Full vote", out)
        self.assertIn("Line 5:", out)
        self.assertIn("No category for a new name: maybe Bad Line", out)   # read as "Last, First"

    def test_paste_flags_a_likely_duplicate(self):
        pg = self.admin()
        out = self.preview(pg, "Reynolds, Megan, Half")
        self.assertIn("Looks like Meg Reynolds: same person?", out)
        pg.click("#paste-result [data-same]")
        pg.wait_for_timeout(100)
        out = pg.inner_text("#paste-result")
        self.assertIn("Meg Reynolds: Full vote to Half vote", out)
        self.assertNotIn("New (", out)

    def test_paste_never_merges_a_slug_collision_silently(self):
        pg = self.admin()
        out = self.preview(pg, "Zed Newdoc, Full\nzed  newdoc, Half")
        self.assertIn("Listed twice: zed newdoc", out)


class TestWriteins(Base):
    def seed_writein(self, pg, status="new"):
        h.seed_roster(pg, writeins={"brand-new-locum": {"name": "Brand New Locum", "firstPollId": "p1", "status": status}})
        h.seed_ballots(pg, "p1", [])
        h.seed(pg, "polls/p1/votes/brand-new-locum", {"name": "Brand New Locum", "slug": "brand-new-locum", "choice": "favour",
                                                    "group": "writein", "weight": 0, "isWriteIn": True, "flagged": False, "submissionCount": 1})

    def test_writeins_show_after_reload(self):
        pg = self.page
        h.load_admin(pg, self.base)
        self.seed_writein(pg)
        h.seed_poll(pg, status="draft", text="A motion")
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.inner_text('.tab[data-tab="roster"]'), "Physicians 1")
        h.tab(pg, "roster")
        card = pg.inner_text("#writeins-card")
        self.assertIn("Brand New Locum", card)
        self.assertIn("first voted on: A motion", card)

    def test_writein_add_as_full_counts_for_quorum(self):
        pg = self.page
        h.load_admin(pg, self.base)
        self.seed_writein(pg)
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        h.tab(pg, "roster")
        pg.click('#writeins-card [data-wi-add="1"]')
        pg.wait_for_function("() => (window.__store.get('config/roster').added || {})['brand-new-locum']")
        pg.wait_for_timeout(200)
        self.assertIn(f"{h.ELIGIBLE + 1} currently eligible", pg.inner_text("#roster-summary"))
        self.assertTrue(pg.is_hidden("#writeins-card"))
        self.assertEqual(pg.inner_text('.tab[data-tab="roster"]'), "Physicians")
        log = [v for k, v in h.store(pg).items() if k.startswith("log/")]
        self.assertEqual([l["action"] for l in log], ["writein"])

    def test_dismissed_writein_stays_at_zero(self):
        pg = self.page
        h.load_admin(pg, self.base)
        self.seed_writein(pg)
        h.seed(pg, "polls/p1", {"text": "Open", "order": 0, "status": "open", "voteCount": 1, "archived": False, "deleted": False})
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        h.tab(pg, "roster")
        pg.click("#writeins-card [data-wi-dismiss]")
        pg.wait_for_function("() => window.__store.get('config/roster').writeins['brand-new-locum'].status === 'dismissed'")
        pg.wait_for_timeout(200)
        self.assertTrue(pg.is_hidden("#writeins-card"))
        h.tab(pg, "results")
        self.assertIn("1 ballot · 1 write-in", pg.inner_text("#results-body"))
        self.assertIn("0 pts · 1 vote", pg.inner_text("#results-body"))

    def test_close_gathers_write_ins_for_review(self):
        pg = self.admin()
        h.seed(pg, "polls/p1/votes/zed-locum", {"name": "Zed Locum", "slug": "zed-locum", "choice": "favour",
                                              "group": "writein", "weight": 0, "isWriteIn": True, "flagged": False, "submissionCount": 1})
        seed_open(pg, ballots=[], voteCount=1)
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        self.assertEqual(h.get(pg, "config/roster")["writeins"]["zed-locum"]["status"], "new")
        pg.wait_for_timeout(200)
        self.assertEqual(pg.inner_text('.tab[data-tab="roster"]'), "Physicians 1")

    def test_roster_change_never_changes_a_closed_result(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:24])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        before = wait_result(pg)["result"]
        h.tab(pg, "roster")
        pg.fill("#roster-filter", h.GROUP1[0])
        pg.wait_for_timeout(150)
        pg.click(f'#roster-table button[data-setgrp="courtesy"][data-slug="{h.slugify(h.GROUP1[0])}"]')
        pg.wait_for_timeout(300)
        self.assertEqual(h.get(pg, "polls/p1")["result"], before)
        log = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "roster"]
        self.assertIn("Full vote to No vote", log[0]["text"])

    def test_uncategorized_has_no_dash(self):
        pg = self.admin()
        label = pg.evaluate("async () => (await import('./js/admin-state.js')).catLabel('writein')")
        self.assertEqual(label, "Uncategorized")


if __name__ == "__main__":
    unittest.main(verbosity=2)
