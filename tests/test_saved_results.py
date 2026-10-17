"""Saved results (voting upgrade step 1, V1): closing saves the result once,
old motions are saved on the first sign-in exactly as they show, re-opening
needs a reason and keeps the earlier count, closed ballots are locked, and
every waiting state has a plain message instead of a hang.
"""
import time
import unittest

import harness as h
from base import Base

NOW = int(time.time() * 1000)
WRITEIN = "brand-new-locum"          # a write-in who was given a category (not in roster.js)


def wait_result(pg, pid="p1"):
    pg.wait_for_function("p => { const d = window.__store.get('polls/' + p); return d && d.result; }", arg=pid)
    return h.get(pg, f"polls/{pid}")


def seed_open(pg, pid="p1", text="Test motion", ballots=(), choice="favour", order=0, **extra):
    h.seed_ballots(pg, pid, list(ballots), choice=choice)
    data = {"text": text, "order": order, "status": "open", "voteCount": len(ballots), "archived": False,
            "deleted": False, "openedAt": h.ts(NOW - 60000), "createdAt": h.ts(NOW - 120000),
            "rule": {"v": 1, "weights": {"1": 1, "2": 0.5, "courtesy": 0}, "quorumPercent": 50,
                     "threshold": "majority", "tieRule": "tie"}}
    data.update(extra)
    h.seed(pg, f"polls/{pid}", data)


def seed_old_closed(pg, pid, ballots, choice="favour", locked=None, order=0, writein=None):
    """A motion closed by the previous page: no result, no closedAt."""
    h.seed_ballots(pg, pid, list(ballots), choice=choice)
    if writein:
        h.seed(pg, f"polls/{pid}/votes/{writein}", {"name": "Zed Locum", "slug": writein, "choice": "favour",
                                                  "group": "writein", "weight": 0, "isWriteIn": True,
                                                  "flagged": False, "submissionCount": 1})
    data = {"text": f"Old motion {pid}", "order": order, "status": "closed", "voteCount": len(ballots),
            "archived": False, "deleted": False}
    if locked is not None:
        data["lockedGroups"] = locked
    h.seed(pg, f"polls/{pid}", data)


def roster_locked():
    """lockedGroups as the old page froze them: the roster.js list."""
    out = {h.slugify(n): "1" for n in h.GROUP1}
    out.update({h.slugify(n): "2" for n in h.GROUP2})
    out.update({h.slugify(n): "courtesy" for n in h.COURTESY})
    return out


def numbers(text):
    """The part of a Results card that a save must not change (verdict, tally, quorum)."""
    for cut in ("Result saved", "Result not saved", "Saving the result", "Close voting", "Re-open voting"):
        if cut in text:
            text = text[:text.index(cut)]
    return text.strip()


class TestClosing(Base):
    def test_closing_saves_the_result_once(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:30])
        pg.wait_for_timeout(300)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="close"]')
        p = wait_result(pg)
        self.assertEqual(p["status"], "closed")
        self.assertEqual(p["result"]["savedBy"], "close")
        self.assertEqual(p["result"]["outcome"], "pass")
        self.assertEqual(p["result"]["count"]["favour"], 30)
        self.assertIsNotNone(p["closedAt"])
        self.assertEqual(p["closeOfOpenedAt"], h.ts(NOW - 60000))
        pg.wait_for_timeout(300)
        logs = [v for k, v in h.store(pg).items() if k.startswith("log/")]
        self.assertEqual([l["action"] for l in logs].count("close"), 1)
        self.assertEqual(h.get(pg, "polls/p1")["result"], p["result"])   # saved once, not rewritten
        self.assertIn("Motion closed. Result saved.", pg.inner_text("#toast"))
        h.tab(pg, "results")
        self.assertIn("Result saved at", pg.inner_text("#results-body"))
        self.assertIn("It can't be changed", pg.inner_text("#results-body"))

    def test_saved_result_matches_the_live_count(self):
        """M2: a write-in given a category who did not vote stays eligible after close."""
        pg = self.admin()
        h.seed_roster(pg, groups={WRITEIN: "1"})
        seed_open(pg, ballots=h.GROUP1[:24])          # 24 of 49 eligible: quorum 25, not met
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        live = numbers(pg.inner_text("#results-body"))
        self.assertIn("24 of 25 not met", live)
        pg.click("#r-close")
        p = wait_result(pg)
        self.assertEqual(p["result"]["eligible"], h.ELIGIBLE + 1)
        self.assertEqual(p["lockedGroups"][WRITEIN], "1")
        pg.wait_for_timeout(200)
        saved = numbers(pg.inner_text("#results-body"))
        self.assertEqual(saved.replace("Closed", "Open").replace("\nfrozen at close", ""), live)

    def test_eligible_before_close_equals_after_close(self):
        pg = self.admin()
        h.seed_roster(pg, groups={WRITEIN: "1"})
        pg.wait_for_timeout(200)
        before, after = pg.evaluate("""async () => {
            const m = await import('./js/db.js?v=' + window.__V);
            const lg = m.snapshotGroupsFor([]);
            return [m.eligibleCount({ status: 'open' }), m.eligibleCount({ status: 'closed', lockedGroups: lg })]; }""")
        self.assertEqual(before, h.ELIGIBLE + 1)
        self.assertEqual(before, after)

    def test_closed_motion_has_no_remove_buttons(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "voters")
        self.assertEqual(pg.locator("#voters-table button[data-del]").count(), 3)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        h.tab(pg, "voters")
        pg.wait_for_timeout(200)
        self.assertEqual(pg.locator("#voters-table button[data-del]").count(), 0)
        self.assertIn("Closed: ballots are locked and kept with the result.", pg.inner_text("#voters-note"))

    def test_motion_opened_in_step1_has_a_rule_snapshot(self):
        pg = self.admin()
        h.seed_poll(pg, pid="pd", status="draft", text="A new motion")
        pg.wait_for_timeout(300)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="pd"]')
        pg.wait_for_function("() => window.__store.get('polls/pd').status === 'open'")
        p = h.get(pg, "polls/pd")
        self.assertEqual(p["rule"]["weights"], {"1": 1, "2": 0.5, "courtesy": 0})
        self.assertEqual(p["rule"]["quorumPercent"], 50)
        self.assertIsNotNone(p["openedAt"])
        self.assertTrue(any(v["action"] == "open" for k, v in h.store(pg).items() if k.startswith("log/")))

    def test_close_waits_for_the_opening_to_be_confirmed(self):
        pg = self.admin()
        h.seed_poll(pg, pid="pd", status="draft", text="A new motion")
        pg.wait_for_timeout(300)
        pg.evaluate("window.__store.offline(true)")
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="pd"]')
        pg.wait_for_timeout(200)
        # the open is still waiting for the server: Close is not offered yet
        self.assertTrue(pg.is_disabled('#motion-list button[data-act="close"][data-id="pd"]'))
        pg.evaluate("window.__store.offline(false)")
        pg.wait_for_function("() => !document.querySelector('#motion-list button[data-act=\"close\"][data-id=\"pd\"]').disabled")


class TestCatchUp(Base):
    def test_catch_up_saves_old_motions_without_changing_what_they_show(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_roster(pg, groups={WRITEIN: "1"})
        seed_old_closed(pg, "p1", h.GROUP1[:25])        # no lockedGroups: shows the live count
        pg.evaluate("window.__store.fail('polls/p1', 'unavailable', 'w')")   # hold the save back
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        h.tab(pg, "results")
        pg.wait_for_function("() => document.querySelector('#results-body').innerText.includes('Result not saved')")
        before = numbers(pg.inner_text("#results-body"))
        self.assertIn("25 of 25 met", before)
        self.assertIn("not saved yet", pg.inner_text("#catchup-card"))
        pg.evaluate("window.__store.unfail('polls/p1')")
        pg.click("#catchup-retry")
        p = wait_result(pg)
        self.assertEqual(p["result"]["savedBy"], "catch-up")
        self.assertIsNone(p["result"]["closedAt"])
        self.assertEqual(p["lockedGroups"][WRITEIN], "1")
        pg.wait_for_timeout(200)
        self.assertEqual(numbers(pg.inner_text("#results-body")), before)
        self.assertIn("Nothing it shows has changed", pg.inner_text("#toast"))

    def test_catch_up_waits_for_the_roster(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_roster(pg, groups={WRITEIN: "1"})
        seed_old_closed(pg, "p1", h.GROUP1[:25])
        pg.evaluate("window.__store.stall('config/roster'); window.__store.order(['polls'])")
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_timeout(600)
        self.assertNotIn("result", h.get(pg, "polls/p1"), "saved before the roster arrived")
        self.assertTrue(pg.is_disabled('#motion-list button[data-act="reopen"]') if pg.locator('#motion-list button[data-act="reopen"]').count() else True)
        pg.evaluate("window.__store.release('config/roster')")
        p = wait_result(pg)
        self.assertEqual(p["result"]["eligible"], h.ELIGIBLE + 1)   # the write-in counted
        self.assertEqual(p["result"]["outcome"], "pass")           # 25 of 25 needed

    def test_catch_up_flags_a_motion_that_lost_a_granted_write_in(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_roster(pg, groups={WRITEIN: "1"})
        seed_old_closed(pg, "p1", h.GROUP1[:24], locked=roster_locked())   # 24 of 24: met; with the write-in 24 of 25
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        p = wait_result(pg)
        self.assertEqual(p["result"]["quorumNote"], "writein-fix")
        self.assertEqual(p["result"]["outcome"], "pass")                    # kept as recorded
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        self.assertIn("Please check", pg.inner_text("#catchup-card"))
        self.assertIn("Old motion p1", pg.inner_text("#catchup-card"))
        self.assertIn("Quorum may have been counted too low", pg.inner_text("#results-body"))
        log = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "catch-up"][0]
        self.assertEqual(log["after"]["flagged"], ["p1"])

    def test_catch_up_counts_a_writein_later_added_as_a_candidate(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_roster(pg, groups={"zed-locum": "1"}, added={"zed-locum": {"name": "Zed Locum"}})
        seed_old_closed(pg, "p1", h.GROUP1[:24], locked=roster_locked())
        seed_old_closed(pg, "p2", h.GROUP1[:5], order=1, writein="zed-locum")
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        p = wait_result(pg, "p1")
        wait_result(pg, "p2")
        self.assertEqual(p["result"].get("quorumNote"), "writein-fix")

    def test_physician_added_by_the_form_is_not_a_candidate(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_roster(pg, groups={"zed-locum": "1"}, added={"zed-locum": {"name": "Zed Locum"}})
        seed_old_closed(pg, "p1", h.GROUP1[:24], locked=roster_locked())
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        p = wait_result(pg, "p1")
        self.assertNotIn("quorumNote", p["result"])
        log = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "catch-up"][0]
        self.assertIn("No earlier motion's result could have been changed", log["reason"])

    def test_catch_up_lists_only_motions_whose_quorum_outcome_could_differ(self):
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_roster(pg, groups={WRITEIN: "1"})
        seed_old_closed(pg, "p1", h.GROUP1[:24], locked=roster_locked())          # could differ
        seed_old_closed(pg, "p2", h.GROUP1[:30], locked=roster_locked(), order=1)  # met either way
        seed_old_closed(pg, "p3", h.GROUP1[:10], locked=roster_locked(), order=2)  # not met either way
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        for pid in ("p1", "p2", "p3"):
            wait_result(pg, pid)
        flagged = [pid for pid in ("p1", "p2", "p3") if h.get(pg, f"polls/{pid}")["result"].get("quorumNote")]
        self.assertEqual(flagged, ["p1"])
        h.tab(pg, "results")
        pg.wait_for_timeout(200)
        self.assertIn("1 earlier motion may have counted quorum too low", pg.inner_text("#catchup-card"))


class TestReopen(Base):
    def close_now(self, pg):
        h.tab(pg, "results")
        pg.click("#r-close")
        return wait_result(pg)

    def reopen(self, pg, reason="Closed early by mistake."):
        h.tab(pg, "results")
        pg.click("#r-open")
        pg.fill("#reopen-reason", reason)
        pg.click("#reopen-go")
        pg.wait_for_function("() => window.__store.get('polls/p1').status === 'open'")

    def test_reopen_needs_a_reason(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        self.close_now(pg)
        pg.click("#r-open")
        pg.click("#reopen-go")
        pg.wait_for_timeout(300)
        self.assertEqual(h.get(pg, "polls/p1")["status"], "closed")
        self.assertIn("Type the reason first.", pg.inner_text("#toast"))
        self.assertIn("Do not include health or other private details.", pg.inner_text("#reopen-form"))

    def test_reopen_keeps_the_earlier_count_and_logs_the_reason(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:30])
        pg.wait_for_timeout(300)
        first = self.close_now(pg)["result"]
        self.reopen(pg)
        p = h.get(pg, "polls/p1")
        self.assertEqual(p["priorResults"], [first])
        self.assertNotIn("result", p)
        self.assertNotIn("lockedGroups", p)
        log = h.get(pg, "log/" + p["lastLog"])
        self.assertEqual(log["reason"], "Closed early by mistake.")
        self.assertEqual(log["before"]["outcome"], "pass")

    def test_reopen_after_category_fix_saves_the_live_count(self):
        """M1: re-open drops the frozen categories, so the re-close counts today's."""
        pg = self.admin()
        name = h.GROUP2[0]
        h.seed_ballots(pg, "p1", [name], choice="favour", group="2", weight=0.5)
        seed_open(pg, ballots=[])
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "voteCount": 1})
        pg.wait_for_timeout(300)
        self.assertEqual(self.close_now(pg)["result"]["weight"]["favour"], 0.5)
        self.reopen(pg)
        h.tab(pg, "roster")
        pg.fill("#roster-filter", name)
        pg.wait_for_timeout(150)
        pg.click(f'#roster-table button[data-setgrp="1"][data-slug="{h.slugify(name)}"]')
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        self.assertIn("1 pts", pg.inner_text("#results-body"))
        pg.click("#r-close")
        pg.wait_for_function("() => (window.__store.get('polls/p1').result || {}).weight")
        self.assertEqual(h.get(pg, "polls/p1")["result"]["weight"]["favour"], 1)

    def test_reopen_of_unsaved_motion_saves_first_and_logs_old_categories(self):
        pg = self.admin()
        h.seed_ballots(pg, "p1", h.GROUP1[:3])
        h.seed(pg, "polls/p1", {"text": "Closed, save failed", "order": 0, "status": "closed", "voteCount": 3,
                                "archived": False, "deleted": False, "closedAt": h.ts(NOW - 5000),
                                "openedAt": h.ts(NOW - 60000), "lockedGroups": roster_locked()})
        pg.wait_for_timeout(300)
        self.reopen(pg, "Wrong motion was closed.")
        p = h.get(pg, "polls/p1")
        self.assertEqual(len(p["priorResults"]), 1)
        self.assertEqual(p["priorResults"][0]["count"]["favour"], 3)
        log = h.get(pg, "log/" + p["lastLog"])
        self.assertEqual(log["before"]["lockedGroups"][h.slugify(h.GROUP1[0])], "1")


class TestFailurePaths(Base):
    allowed_errors = ("permission-denied", "unavailable")

    def test_failed_save_is_retried(self):
        """A motion another laptop closed but did not save (it slept): saved here after 30 s."""
        pg = self.page
        pg.clock.install()
        h.load_admin(pg, self.base)
        h.seed_ballots(pg, "p1", h.GROUP1[:3])
        h.seed(pg, "polls/p1", {"text": "Closed elsewhere", "order": 0, "status": "closed", "voteCount": 3,
                                "archived": False, "deleted": False, "closedAt": h.ts(NOW - 5000),
                                "openedAt": h.ts(NOW - 60000), "lockedGroups": roster_locked()})
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_timeout(300)
        self.assertNotIn("result", h.get(pg, "polls/p1"))      # first, give the other laptop time
        h.tab(pg, "results")
        self.assertIn("Result not saved yet.", pg.inner_text("#results-body"))
        pg.clock.fast_forward(31000)
        p = wait_result(pg)
        self.assertEqual(p["result"]["savedBy"], "close")

    def test_save_result_offline_retries_when_back(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        pg.click("#r-close")
        pg.wait_for_function("() => window.__store.get('polls/p1').status === 'closed'")
        pg.evaluate("window.__store.offline(true); window.__store.release('polls/p1/votes')")
        pg.wait_for_function("() => document.querySelector('#sheet-status').textContent.includes('It saves by itself')")
        pg.click("#sheet-actions button:nth-child(2)")      # Hide this message
        h.tab(pg, "results")
        self.assertIn("Result not saved yet.", pg.inner_text("#results-body"))
        pg.evaluate("window.__store.offline(false)")
        wait_result(pg)
        pg.wait_for_timeout(200)
        self.assertIn("Result saved at", pg.inner_text("#results-body"))

    def test_save_says_saved_only_when_a_result_exists(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        pg.click("#r-close")
        pg.wait_for_function("() => window.__store.get('polls/p1').status === 'closed'")
        # another laptop re-opens it before this one has counted
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "status": "open", "openedAt": h.ts(NOW + 1000)})
        pg.evaluate("window.__store.release('polls/p1/votes')")
        pg.wait_for_function("() => document.querySelector('#sheet-status').textContent.includes('Result not saved: the motion was re-opened')")
        self.assertNotIn("Result saved", pg.inner_text("#toast"))
        self.assertNotIn("result", h.get(pg, "polls/p1"))

    def test_leaving_while_saving_asks_first(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.evaluate("window.__store.stall('polls/p1/votes')")
        pg.click("#r-close")
        pg.wait_for_function("() => document.querySelector('#sheet-status').textContent.includes('Saving the result')")
        self.assertIn("keep this screen open until it says Result saved", pg.inner_text("#sheet"))
        asked = pg.evaluate("() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }")
        self.assertTrue(asked)
        pg.evaluate("window.__store.release('polls/p1/votes')")
        wait_result(pg)
        pg.wait_for_timeout(100)
        asked = pg.evaluate("() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }")
        self.assertFalse(asked)

    def test_close_offline_shows_not_closed_with_focus(self):
        """From step 2 the close is a transaction: offline it fails at once, never queues."""
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        pg.evaluate("window.__store.offline(true)")
        h.tab(pg, "results")
        pg.click("#r-close")
        pg.wait_for_function("() => document.querySelector('#sheet-status').textContent.includes('Not closed')")
        self.assertEqual(pg.get_attribute("#sheet .sheet", "role"), "dialog")
        self.assertTrue(pg.evaluate("document.querySelector('#sheet').contains(document.activeElement)"))
        self.assertIn("Not closed: no connection. Voting is still open.", pg.inner_text("#sheet-status"))
        self.assertEqual(h.get(pg, "polls/p1")["status"], "open")
        self.assertEqual(pg.evaluate("window.__store.pending()"), 0)       # nothing queued
        pg.evaluate("window.__store.offline(false)")
        pg.click("#sheet-actions button:first-child")                     # Try again
        wait_result(pg)

    def test_purge_keeps_a_log_entry(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:30])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "deleted": True})
        pg.wait_for_timeout(200)
        h.tab(pg, "motions")
        pg.click("#trash-header")
        pg.evaluate("window.confirm = () => true")
        pg.click('#motion-list button[data-act="purge"]')
        pg.wait_for_function("() => window.__store.get('polls/p1') === null")
        pg.wait_for_function("() => !Object.keys(window.__store.dump()).some(k => k.startsWith('polls/p1/'))")
        purge = [v for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "purge"]
        self.assertEqual(len(purge), 1)
        self.assertEqual(purge[0]["before"]["outcome"], "pass")

    def test_refused_action_shows_a_message(self):
        pg = self.admin()
        h.seed_poll(pg, pid="pd", status="draft", text="Draft")
        pg.wait_for_timeout(300)
        pg.evaluate("window.__store.fail('polls/pd', 'permission-denied', 'w')")
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="archive"][data-id="pd"]')
        pg.wait_for_function("() => document.querySelector('#toast').textContent.startsWith('Not allowed')")

    def test_console_listener_refused_asks_to_sign_in_again(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.evaluate("window.__store.fail('polls', 'permission-denied', 'r')")
        h.unlock_admin(pg)
        pg.wait_for_selector("#gate-err:not(.hide)")      # the page reloaded, signed out
        self.assertIn("Please sign in again.", pg.inner_text("#gate-err"))
        self.assertTrue(pg.is_hidden("#console"))

    def test_console_newer_source_refused_says_database_update(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.evaluate("window.__store.fail('config/settings', 'permission-denied', 'r')")
        h.unlock_admin(pg)
        pg.wait_for_selector("#banners .banner")
        self.assertIn("needs a database update", pg.inner_text("#banners"))
        h.seed_poll(pg, pid="pd", status="draft")
        pg.wait_for_timeout(200)
        h.tab(pg, "motions")
        self.assertTrue(pg.is_disabled('#motion-list button[data-act="open"]'))

    def test_page_on_rules_without_the_change_log_says_database_update(self):
        """Step-1 page on the old rules (R0): the change log is refused."""
        pg = self.page
        h.load_admin(pg, self.base)
        pg.evaluate("window.__store.fail('log', 'permission-denied')")
        h.seed_poll(pg, pid="pd", status="draft")
        seed_old_closed(pg, "p1", h.GROUP1[:5], order=1)
        h.unlock_admin(pg)
        pg.wait_for_selector("#banners .banner")
        self.assertIn("Voting still works; Open and Close do not.", pg.inner_text("#banners"))
        pg.wait_for_timeout(300)
        self.assertNotIn("result", h.get(pg, "polls/p1"))     # catch-up does not run
        h.tab(pg, "motions")
        self.assertTrue(pg.is_disabled('#motion-list button[data-act="open"]'))

    def test_console_offline_at_load_says_no_connection_then_recovers(self):
        pg = self.page
        pg.clock.install()
        h.load_admin(pg, self.base)
        h.seed_poll(pg, pid="pd", status="draft")
        pg.evaluate("window.__store.offline(true)")
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.clock.fast_forward(16000)
        pg.wait_for_selector("#banners .banner")
        self.assertIn("No connection to the voting database", pg.inner_text("#banners"))
        self.assertNotIn("Loading", pg.inner_text("#console"))
        pg.evaluate("window.__store.offline(false)")
        pg.wait_for_function("() => !document.querySelector('#banners').innerText.includes('No connection')")
        h.tab(pg, "motions")
        pg.wait_for_function("() => !document.querySelector('#motion-list button[data-act=\"open\"]').disabled")

    def test_gate_opens_with_the_meetings_listener(self):
        """Steps 1 to 3 had no meetings listener; from step 4 meetings are in the gate."""
        pg = self.page
        h.load_admin(pg, self.base)
        h.seed_poll(pg, pid="pd", status="draft")
        pg.evaluate("window.__store.stall('meetings')")
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_timeout(300)
        h.tab(pg, "motions")
        self.assertTrue(pg.is_disabled('#motion-list button[data-act="open"]'))
        self.assertIn("meetings", pg.evaluate("window.__store.listenerPaths()"))
        pg.evaluate("window.__store.release('meetings')")
        pg.wait_for_function("() => !document.querySelector('#motion-list button[data-act=\"open\"]').disabled")


if __name__ == "__main__":
    unittest.main(verbosity=2)
