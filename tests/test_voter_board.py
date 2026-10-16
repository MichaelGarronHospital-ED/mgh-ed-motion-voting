"""The voters' board (voting upgrade step 2, V2) and contested results (V4).

Phones listen to config/live and config/roster only, never to ballots; past
results are one read of config/history on a tap. The console patches the
board inside each action, never rewrites it on its own, and offers "Fix it"
when it is out of date. Re-vote keeps the original result and links both.
"""
import time
import unittest

import harness as h
from base import Base
from test_saved_results import seed_open, wait_result, roster_locked, NOW

RULE = {"v": 1, "weights": {"1": 1, "2": 0.5, "courtesy": 0}, "quorumPercent": 50,
        "threshold": "majority", "tieRule": "tie"}


def saved_result(favour=30, against=0, outcome="pass", ms=None):
    ms = ms or NOW - 3600000
    return {"v": 1, "kind": "motion", "outcome": outcome,
            "weight": {"favour": favour, "against": against, "abstain": 0},
            "count": {"favour": favour, "against": against, "abstain": 0},
            "totalVotes": favour + against, "quorumCount": favour + against, "quorumNeeded": 24, "eligible": 48,
            "writeIns": 0, "flags": 0, "rule": RULE, "closedAt": h.ts(ms), "savedAt": h.ts(ms + 1000), "savedBy": "close"}


def seed_closed_saved(pg, pid, ms, text=None, order=0, ballots=0, **extra):
    if ballots:
        h.seed_ballots(pg, pid, h.GROUP1[:ballots])
    d = {"text": text or f"Motion {pid}", "order": order, "status": "closed", "voteCount": ballots, "archived": False,
         "deleted": False, "closedAt": h.ts(ms), "openedAt": h.ts(ms - 60000), "createdAt": h.ts(ms - 99999),
         "lockedGroups": roster_locked(), "rule": RULE, "result": saved_result(ballots or 30, ms=ms)}
    d.update(extra)
    h.seed(pg, f"polls/{pid}", d)


def build_board(pg):
    """Write config/live and config/history as the console would build them."""
    pg.evaluate("""async () => {
        const b = await import('./js/board.js');
        const st = window.__store.dump();
        const polls = Object.entries(st).filter(([k]) => /^polls\\/[^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
        const bd = b.buildBoard(polls, []);
        window.__store.set('config/live', bd);
        window.__store.set('config/history', b.buildHistory(polls, [], bd));
    }""")


class TestVoterBoard(Base):
    allowed_errors = ("permission-denied", "unavailable")

    def test_voter_page_never_reads_ballots_of_closed_motions(self):
        pg = self.voter()
        day = 86400000
        for i in range(10):
            seed_closed_saved(pg, f"c{i}", NOW - (10 - i) * day if i < 7 else NOW - 3600000 + i * 1000, order=i, ballots=40)
        build_board(pg)
        pg.wait_for_timeout(200)
        h.pick_voter(pg, h.GROUP1[0])
        pg.evaluate("window.__store.resetCounts()")
        pg.click('[data-vtab="results"]')
        pg.click("#earlier-load")
        pg.wait_for_selector("text=Earlier results")
        pg.wait_for_timeout(300)
        self.assertEqual(len([p for p in pg.evaluate("window.__store.readPaths('polls/')") if "/votes/" in p]), 0)
        self.assertEqual(h.reads(pg, "config/history"), 1)
        self.assertEqual(h.outcomes(pg.inner_text("#app")).count("Passed"), 10)

    def test_voter_page_only_listens_to_two_docs(self):
        pg = self.voter()
        seed_open(pg, ballots=h.GROUP1[:3])
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector('button[data-c="favour"]')
        pg.click('button[data-c="favour"]')
        pg.wait_for_timeout(300)
        self.assertEqual(sorted(pg.evaluate("window.__store.listenerPaths()")), ["config/live", "config/roster"])

    def test_results_tab_shows_saved_totals_from_the_board(self):
        pg = self.voter()
        seed_closed_saved(pg, "c1", NOW - 60000, text="Approve the schedule", ballots=0)
        h.seed(pg, "polls/c1", {**h.get(pg, "polls/c1"), "result": saved_result(20, 5)})
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.wait_for_timeout(200)
        text = pg.inner_text("#app")
        self.assertIn("Approve the schedule", text)
        self.assertEqual(h.outcomes(text), ["Passed"])
        self.assertEqual(pg.evaluate("window.__store.readPaths('polls/c1')"), [])

    def test_stale_unsaved_entry_is_counted_once(self):
        """The phone counts a late result itself 30 s after IT received the entry,
        whatever its clock says, with the motion's frozen categories and rule."""
        pg = self.page
        pg.clock.install(time=NOW + 600000)          # the phone's clock is 10 minutes off
        h.open_voter(pg, self.base)
        h.seed_ballots(pg, "c1", h.GROUP2[:4], group="2", weight=0.5)
        locked = roster_locked()
        locked[h.slugify(h.GROUP2[0])] = "1"         # frozen at close as a full vote
        h.seed(pg, "polls/c1", {"text": "Late result", "order": 0, "status": "closed", "voteCount": 4, "archived": False,
                                "deleted": False, "closedAt": h.ts(NOW - 5000), "openedAt": h.ts(NOW - 60000),
                                "lockedGroups": locked, "rule": RULE})
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.wait_for_selector("text=Counting votes")
        pg.clock.run_for(25000)
        self.assertIn("Counting votes", pg.inner_text("#app"))
        self.assertEqual(h.reads(pg, "polls/c1/votes"), 0)
        pg.clock.run_for(6000)
        pg.wait_for_selector("text=Count from the ballots")
        self.assertEqual(h.reads(pg, "polls/c1/votes"), 4)
        # 1 + 0.5 + 0.5 + 0.5 points in favour: the frozen category counted
        self.assertEqual(pg.evaluate("window.__store.reads('polls/c1')"), 5)
        pg.clock.run_for(60000)
        self.assertEqual(h.reads(pg, "polls/c1/votes"), 4)            # once only

    def test_voter_falls_back_without_a_board(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        h.pick_voter(pg, h.GROUP1[1])
        pg.wait_for_selector('button[data-c="favour"]')
        self.assertIn("polls", pg.evaluate("window.__store.listenerPaths()"))
        build_board(pg)
        pg.wait_for_timeout(200)
        self.assertNotIn("polls", pg.evaluate("window.__store.listenerPaths()"))
        self.assertEqual(pg.locator('button[data-c="favour"]').count(), 1)

    def test_voter_sees_replaced_and_reopened_wording(self):
        pg = self.voter()
        seed_closed_saved(pg, "c1", NOW - 120000, text="Original", supersededBy="c2")
        prior = saved_result(21.5, 6)
        seed_closed_saved(pg, "c2", NOW - 60000, text="The re-vote", order=1, revoteOf="c1",
                          revoteReason="Two ballots were cast under the wrong name.", reopenCount=1, priorResults=[prior])
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        pg.wait_for_timeout(200)
        text = pg.inner_text("#app")
        self.assertIn("Replaced by a re-vote", text)
        self.assertIn("See the re-vote result.", text)
        self.assertIn("Re-vote", text)
        self.assertIn("Reason for the re-vote: Two ballots were cast under the wrong name.", text)
        self.assertIn("Re-opened once. Earlier count: Passed (21.5 to 6 points).", text)

    def test_vote_offline_is_not_shown_as_chosen(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[1])
        pg.wait_for_selector('button[data-c="favour"]')
        pg.evaluate("window.__store.offline(true)")
        pg.click('button[data-c="favour"]')
        pg.wait_for_selector("text=No connection. Your vote was not sent. Try again.")
        self.assertEqual(pg.get_attribute('button[data-c="favour"]', "aria-pressed"), "false")
        self.assertIsNone(h.get(pg, f"polls/p1/votes/{h.slugify(h.GROUP1[1])}"))

    def test_vote_refused_after_close_says_closed(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        build_board(pg)
        slug = h.slugify(h.GROUP1[1])
        h.pick_voter(pg, h.GROUP1[1])
        pg.wait_for_selector('button[data-c="favour"]')
        pg.evaluate(f"window.__store.stall('polls/p1/votes/{slug}')")
        pg.click('button[data-c="favour"]')
        # meanwhile leadership closed it: the board no longer shows it, and the rules refuse the ballot
        live = h.get(pg, "config/live")
        live["open"] = None
        pg.evaluate("window.__store.fail('polls/p1', 'permission-denied', 'w')")
        h.seed(pg, "config/live", live)
        pg.evaluate(f"window.__store.release('polls/p1/votes/{slug}')")
        pg.wait_for_function("() => document.querySelector('#toast').textContent.includes('Voting on this motion has closed.')")

    def test_vote_refused_while_open_says_tell_leadership(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[1])
        pg.wait_for_selector('button[data-c="favour"]')
        pg.evaluate("window.__store.fail('polls/p1', 'permission-denied', 'w')")
        pg.click('button[data-c="favour"]')
        pg.wait_for_selector("text=Your vote could not be recorded. Please tell leadership.")

    def test_voter_listener_refused_shows_ed_card(self):
        pg = self.voter()
        pg.evaluate("window.__store.fail('config/live', 'permission-denied', 'r')")
        pg.wait_for_selector("#edpw")
        self.assertIn("Please enter the ED password again.", pg.inner_text("#app"))

    def test_earlier_results_offline_offers_try_again(self):
        pg = self.voter()
        seed_closed_saved(pg, "c1", NOW - 86400000 * 3)
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('[data-vtab="results"]')
        # no connection (the phone has no copy of the history to fall back on)
        pg.evaluate("window.__store.fail('config/history', 'unavailable', 'r')")
        pg.click("#earlier-load")
        pg.wait_for_selector("text=Could not load earlier results. Check your connection.")
        pg.evaluate("window.__store.unfail('config/history')")
        pg.click("#earlier-load")
        pg.wait_for_selector("text=Earlier results")

    def test_voter_page_offline_keeps_the_screen_and_says_so(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        build_board(pg)
        h.pick_voter(pg, h.GROUP1[1])
        pg.wait_for_selector('button[data-c="favour"]')
        pg.evaluate("window.__store.offline(true)")
        pg.wait_for_selector("text=No connection. Voting will work again when it reconnects.")
        self.assertIn("may be out of date", pg.inner_text("#app"))
        self.assertEqual(pg.locator('button[data-c="favour"]').count(), 1)


class TestConsoleBoard(Base):
    allowed_errors = ("permission-denied", "unavailable")

    def live(self, pg):
        return h.get(pg, "config/live")

    def console(self, seed, clock=False):
        """Seed first (data exists before the console signs in), then unlock."""
        pg = self.page
        if clock:
            pg.clock.install()
        h.load_admin(pg, self.base)
        seed(pg)
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_function("() => window.__store.get('config/live') !== null && window.__store.get('config/history') !== null")
        pg.wait_for_timeout(300)
        return pg

    def test_console_creates_the_board_when_missing_before_enabling_open(self):
        pg = self.admin()
        h.seed_poll(pg, pid="pd", status="draft", text="A draft")
        pg.wait_for_function("() => window.__store.get('config/live') !== null")
        h.tab(pg, "motions")
        # a forced not-found: the board vanished after load; Open heals and tries once more
        pg.evaluate("window.__store.del('config/live')")
        pg.click('#motion-list button[data-act="open"][data-id="pd"]')
        pg.wait_for_function("() => (window.__store.get('config/live') || {}).open")
        self.assertEqual(self.live(pg)["open"]["id"], "pd")
        self.assertEqual(h.get(pg, "polls/pd")["status"], "open")

    def test_save_result_patches_only_its_own_board_entry(self):
        pg = self.console(lambda pg: (seed_closed_saved(pg, "c0", NOW - 120000, order=0), seed_open(pg, "p1", ballots=h.GROUP1[:30], order=1)))
        before = self.live(pg)["results"]["c0"]
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        pg.wait_for_timeout(200)
        live = self.live(pg)
        self.assertEqual(live["results"]["c0"], before)
        self.assertEqual(live["results"]["p1"]["result"]["outcome"], "pass")
        self.assertIsNotNone(live["results"]["p1"]["closedAt"])
        self.assertIsNone(live["open"])
        self.assertEqual(live["lastClosedId"], "p1")

    def test_normal_close_never_shows_the_out_of_date_banner(self):
        pg = self.console(lambda pg: seed_open(pg, ballots=h.GROUP1[:30]), clock=True)
        writes = h.writes(pg, "config/live")
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        pg.clock.fast_forward(15000)
        pg.wait_for_timeout(300)
        self.assertNotIn("out of date", pg.inner_text("#banners"))
        self.assertEqual(h.writes(pg, "config/live") - writes, 2)    # the close and the save, no heal

    def test_stale_board_from_another_laptop_shows_fix_it_banner_and_never_writes_by_itself(self):
        pg = self.console(lambda pg: seed_closed_saved(pg, "c0", NOW - 120000), clock=True)
        live = self.live(pg)
        live["results"]["c0"]["text"] = "Old wording from a laptop a second behind"
        h.seed(pg, "config/live", live)
        writes = h.writes(pg, "config/live")
        pg.clock.fast_forward(11000)
        pg.wait_for_selector("text=The voters' screen is out of date.")
        self.assertEqual(h.writes(pg, "config/live"), writes)
        pg.clock.fast_forward(31000)          # the 30-second cap since the load heal
        pg.click('#banners [data-fix="board"]')
        pg.wait_for_function("() => window.__store.get('config/live').results.c0.text === 'Motion c0'")
        pg.wait_for_function("() => !document.querySelector('#banners').innerText.includes('out of date')")

    def test_board_compare_uses_content_not_a_stored_hash(self):
        pg = self.console(lambda pg: seed_closed_saved(pg, "c0", NOW - 120000), clock=True)
        live = self.live(pg)
        live["changedAt"] = h.ts(1)
        live["results"]["c0"]["closedAt"] = h.ts(2)     # times are left out of the compare
        self.assertNotIn("hash", live)
        h.seed(pg, "config/live", live)
        pg.clock.fast_forward(11000)
        pg.wait_for_timeout(200)
        self.assertNotIn("out of date", pg.inner_text("#banners"))

    def test_board_is_repaired_on_console_load(self):
        pg = self.page
        h.load_admin(pg, self.base)
        seed_closed_saved(pg, "c0", NOW - 120000)
        h.seed(pg, "config/live", {"v": 2, "meeting": None, "open": None, "results": {}, "lastClosedId": None})
        h.unlock_admin(pg)
        pg.wait_for_function("() => (window.__store.get('config/live').results || {}).c0")
        pg.wait_for_function("() => window.__store.get('config/history') !== null")

    def test_board_is_not_rewritten_on_ordinary_snapshots(self):
        pg = self.console(lambda pg: seed_open(pg, ballots=h.GROUP1[:3]))
        writes = h.writes(pg, "config/live")
        for i in range(5):     # votes arriving: the motion's count changes, the board does not
            h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "voteCount": 4 + i})
            pg.wait_for_timeout(50)
        pg.wait_for_timeout(300)
        self.assertEqual(h.writes(pg, "config/live"), writes)

    def test_two_consoles_with_different_roster_names_write_the_board_at_most_once_each(self):
        pg = self.page
        h.load_admin(pg, self.base)
        seed_closed_saved(pg, "c0", NOW - 120000)
        h.unlock_admin(pg)
        pg.wait_for_function("() => window.__store.get('config/live') !== null")
        pg.wait_for_timeout(300)
        first = h.writes(pg, "config/live")
        self.assertLessEqual(first, 1)
        snapshot = h.store(pg)
        # the second laptop: same motions and board, a different list of names
        pg2 = self.browser.new_page()
        errs = []
        h.wire(pg2, errs)
        h.load_admin(pg2, self.base)
        for k, v in snapshot.items():
            h.seed(pg2, k, v)
        h.seed_roster(pg2, added={"zed-other": {"name": "Zed Other"}}, groups={"zed-other": "1"})
        h.unlock_admin(pg2)
        pg2.wait_for_selector("#console:not(.hide)")
        pg2.wait_for_timeout(600)
        self.assertEqual(h.writes(pg2, "config/live"), 0)
        self.assertEqual(errs, [])
        pg2.close()

    def test_close_then_open_quickly_keeps_the_closed_time_on_the_board(self):
        pg = self.console(lambda pg: (seed_open(pg, "p1", ballots=h.GROUP1[:3]), h.seed_poll(pg, pid="p2", status="draft", text="Next", order=1)))
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="close"][data-id="p1"]')
        pg.click('#motion-list button[data-act="open"][data-id="p2"]')
        pg.wait_for_function("() => (window.__store.get('config/live').open || {}).id === 'p2'")
        wait_result(pg)
        pg.wait_for_timeout(200)
        entry = self.live(pg)["results"]["p1"]
        self.assertIsNotNone(entry["closedAt"])
        self.assertIsNotNone(entry["result"])

    def test_late_close_never_clears_another_motions_open(self):
        pg = self.console(lambda pg: seed_open(pg, "x1", ballots=h.GROUP1[:3]))
        live = self.live(pg)
        live["open"] = {**live["open"], "id": "y1", "text": "Opened on laptop B"}
        h.seed(pg, "config/live", live)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg, "x1")
        self.assertEqual(self.live(pg)["open"]["id"], "y1")

    def test_offline_close_is_not_queued_so_it_cannot_land_after_a_reopen(self):
        """A close tapped offline fails at once (a transaction, never queued), so
        it cannot land later on a motion re-opened meanwhile. The rules case (a
        close naming an older opening is refused) is in rules.results.test.mjs."""
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        pg.evaluate("window.__store.offline(true)")
        h.tab(pg, "results")
        pg.click("#r-close")
        pg.wait_for_selector("text=Not closed: no connection")
        self.assertEqual(pg.evaluate("window.__store.pending()"), 0)
        # another laptop closes and re-opens it meanwhile
        h.seed(pg, "polls/p1", {**h.get(pg, "polls/p1"), "openedAt": h.ts(NOW + 5000)})
        pg.evaluate("window.__store.offline(false)")
        pg.wait_for_timeout(300)
        self.assertEqual(h.get(pg, "polls/p1")["status"], "open")

    def test_history_write_failure_never_blocks_the_action(self):
        # an earlier day's motion is on the board; closing today's moves it to history
        pg = self.console(lambda pg: (seed_closed_saved(pg, "c0", NOW - 3 * 86400000), seed_open(pg, ballots=h.GROUP1[:30], order=1)))
        self.assertIn("c0", self.live(pg)["results"])
        pg.evaluate("window.__store.fail('config/history', 'permission-denied', 'w')")
        h.tab(pg, "results")
        pg.click("#r-close")
        p = wait_result(pg)
        self.assertIsNotNone(p["closedAt"])
        self.assertIsNotNone(p["result"]["savedAt"])
        pg.wait_for_selector("text=Past results for voters are out of date.")
        self.assertNotIn("c0", self.live(pg)["results"])
        pg.evaluate("window.__store.unfail('config/history')")
        pg.click('#banners [data-fix="history"]')
        pg.wait_for_function("() => window.__store.get('config/history').entries.some(e => e.id === 'c0')")

    def test_history_is_capped_by_size(self):
        pg = self.admin()
        r = pg.evaluate("""async () => {
            const b = await import('./js/board.js');
            const opts = Array.from({ length: 20 }, (_, i) => ({ id: 'o' + i, label: 'Candidate ' + 'x'.repeat(110) + i, weight: i, count: i }));
            const polls = Array.from({ length: 300 }, (_, i) => ({ id: 'e' + i, text: 'Election ' + 'y'.repeat(480), status: 'closed',
                archived: false, deleted: false, order: i, closedAt: window.__store.ts(1000000 + i * 1000),
                result: { v: 1, kind: 'choice', outcome: 'decided', options: opts, savedAt: window.__store.ts(1) } }));
            const h = b.buildHistory(polls, [], { results: {} });
            return [JSON.stringify(h).length, h.truncated, h.entries.length, h.entries[0].id]; }""")
        size, truncated, n, first = r
        self.assertLess(size, 600000)
        self.assertTrue(truncated)
        self.assertLess(n, 300)
        self.assertEqual(first, "e299")            # newest first


class TestRevote(Base):
    allowed_errors = ("permission-denied",)
    def test_revote_keeps_the_original_result_and_links_both(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:30])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        first = wait_result(pg)["result"]
        pg.wait_for_timeout(200)
        pg.click("#r-revote")
        pg.fill("#revote-reason", "Two ballots were cast under the wrong name.")
        pg.click("#revote-go")
        pg.wait_for_function("() => window.__store.get('polls/p1').supersededBy")
        orig = h.get(pg, "polls/p1")
        new_id = orig["supersededBy"]
        copy = h.get(pg, f"polls/{new_id}")
        self.assertEqual(orig["result"], first)                 # kept on record
        self.assertEqual(copy["revoteOf"], "p1")
        self.assertEqual(copy["status"], "draft")
        self.assertEqual(copy["text"], orig["text"])
        self.assertEqual(copy["revoteReason"], "Two ballots were cast under the wrong name.")
        log = h.get(pg, "log/" + orig["lastLog"])
        self.assertEqual(log["action"], "revote")
        pg.wait_for_timeout(200)
        self.assertIn("Replaced by a re-vote", pg.inner_text("#results-body"))
        self.assertEqual(pg.locator("#r-open").count(), 0)      # re-open the re-vote instead
        pg.click("#revote-open")
        pg.wait_for_function(f"() => window.__store.get('polls/{new_id}').status === 'open'")
        self.assertEqual(h.get(pg, "config/live")["open"]["revoteOf"], "p1")

    def test_revote_on_rules_without_it_says_database_update(self):
        """Step-2 page on the step-1 rules (R1): the re-vote link is refused."""
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:30])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        pg.wait_for_timeout(200)
        pg.evaluate("window.__store.fail('polls/p1', 'permission-denied', 'w')")
        pg.click("#r-revote")
        pg.fill("#revote-reason", "Wrong names.")
        pg.click("#revote-go")
        pg.wait_for_function("() => document.querySelector('#toast').textContent.includes('needs a database update')")
        self.assertNotIn("supersededBy", h.get(pg, "polls/p1"))

    def test_history_lists_entries_for_a_motion(self):
        pg = self.admin()
        seed_open(pg, ballots=h.GROUP1[:30])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        pg.click("#r-open")
        pg.fill("#reopen-reason", "Closed early by mistake.")
        pg.click("#reopen-go")
        pg.wait_for_function("() => window.__store.get('polls/p1').status === 'open'")
        pg.wait_for_timeout(200)
        pg.click("#motion-history summary")
        pg.wait_for_selector("#motion-history-list li:not(.ed-muted)")
        text = pg.inner_text("#motion-history-list")
        self.assertIn("Re-opened", text)
        self.assertIn("Reason: Closed early by mistake.", text)
        self.assertIn("Earlier count: Passed, 30 to 0 points, quorum 30 of 24", text)
        self.assertIn("Closed", text)

    def test_change_history_in_settings_with_the_typed_name(self):
        pg = self.admin()
        pg.fill("#ask-name", "Kyle")
        pg.click("#ask-form button[type=submit]")
        seed_open(pg, ballots=h.GROUP1[:3])
        pg.wait_for_timeout(300)
        h.tab(pg, "results")
        pg.click("#r-close")
        wait_result(pg)
        pg.click("#open-settings")
        pg.click("#history-load")
        pg.wait_for_selector("#history-list li:not(.ed-muted)")
        self.assertIn("Closed by Kyle.", pg.inner_text("#history-list"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
