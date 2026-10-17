"""Check-in, remote and vote receipts (voting upgrade step 7, V11; no proxies).

A check-in is one optional tap ("In the room" or "Remote") while the meeting is
open; it never blocks voting. Leadership sees attendance, can add or remove
someone, and sees "Remote" and each ballot's receipt code. The phone keeps its
receipt and can check what is recorded under its name.
"""
import unittest

import harness as h
from base import Base
from test_saved_results import seed_open, wait_result, NOW
from test_meetings import seed_meeting


def board(pg):
    pg.evaluate("""async () => { const b = await import('./js/board.js?v=' + window.__V); const st = window.__store.dump();
        const polls = Object.entries(st).filter(([k]) => /^polls[/][^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
        const ms = Object.entries(st).filter(([k]) => /^meetings[/][^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
        window.__store.set('config/live', b.buildBoard(polls, ms)); }""")


def reload_phone(pg, snapshot):
    """Reload the phone page. The test database and sign-in start empty again,
    so the data is put back and the ED password typed again; what the phone
    kept (localStorage) stays, as on a real phone."""
    pg.reload()
    pg.wait_for_function("() => window.__store !== undefined")
    for k, v in snapshot.items():
        h.seed(pg, k, v)
    pg.wait_for_selector("#edpw")
    pg.fill("#edpw", "test-ed-password")
    pg.click("#edgo")


class TestCheckIn(Base):
    allowed_errors = ("permission-denied",)

    def setup_voter(self, check_in=True, status="open"):
        pg = self.voter()
        seed_meeting(pg, status=status, startedAt=h.ts(NOW - 60000), checkIn=check_in)
        seed_open(pg, ballots=[], meetingId="m1")
        board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector('button[data-c="favour"]')
        return pg

    def test_check_in_is_offered_once_and_never_required(self):
        pg = self.setup_voter()
        self.assertIn("Checking in to ED department meeting.", pg.inner_text("#app"))
        pg.click('button[data-c="favour"]')                 # voting works without checking in
        pg.wait_for_function(f"() => window.__store.get('polls/p1/votes/{h.slugify(h.GROUP1[0])}')")
        pg.click('button[data-ci="room"]')
        pg.wait_for_function(f"() => window.__store.get('meetings/m1/attendance/{h.slugify(h.GROUP1[0])}')")
        a = h.get(pg, f"meetings/m1/attendance/{h.slugify(h.GROUP1[0])}")
        self.assertEqual((a["mode"], a["name"]), ("room", h.GROUP1[0]))
        pg.wait_for_selector("text=Checked in: in the room.")
        self.assertNotIn("Checking in to", pg.inner_text("#app"))
        snapshot = h.store(pg)
        reload_phone(pg, snapshot)
        pg.wait_for_selector('button[data-c="favour"]')
        self.assertNotIn("Checking in to", pg.inner_text("#app"))   # once per meeting on this phone
        pg.click("#ci-change")
        pg.click('button[data-ci="remote"]')
        pg.wait_for_function(f"() => window.__store.get('meetings/m1/attendance/{h.slugify(h.GROUP1[0])}').mode === 'remote'")

    def test_skip_hides_the_card(self):
        pg = self.setup_voter()
        pg.click('button[data-ci="skip"]')
        self.assertNotIn("Checking in to", pg.inner_text("#app"))
        self.assertIsNone(h.get(pg, f"meetings/m1/attendance/{h.slugify(h.GROUP1[0])}"))

    def test_no_card_when_check_in_is_off(self):
        pg = self.setup_voter(check_in=False)
        self.assertNotIn("Checking in to", pg.inner_text("#app"))

    def test_check_in_on_rules_without_it_says_not_available_yet(self):
        pg = self.setup_voter()
        pg.evaluate("window.__store.fail('meetings/m1/attendance', 'permission-denied', 'w')")
        pg.click('button[data-ci="room"]')
        pg.wait_for_selector("text=Check-in is not available yet.")

    def test_check_in_offline_says_not_sent(self):
        pg = self.setup_voter()
        pg.evaluate("window.__store.fail('meetings/m1/attendance', 'unavailable', 'w')")
        pg.click('button[data-ci="remote"]')
        pg.wait_for_selector("text=Not sent: no connection. Try again.")


class TestReceipts(Base):
    def test_receipt_matches_leadership_view(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        board(pg)
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('button[data-c="against"]')
        pg.wait_for_selector(".receipt-line")
        code = pg.inner_text(".receipt-line .receipt-code")
        self.assertRegex(code, r"^[2-9A-HJ-NP-Z]{5}$")
        self.assertIn("Recorded: Against. Receipt", pg.inner_text(".receipt-line"))
        ballot = h.get(pg, f"polls/p1/votes/{h.slugify(h.GROUP1[0])}")
        # what the console computes from the stored ballot
        console = pg.evaluate("async (v) => (await import('./js/count.js?v=' + window.__V)).ballotReceipt('p1', v)", ballot)
        self.assertEqual(console, code)
        pg.click('button[data-c="favour"]')                 # a change: a new receipt
        pg.wait_for_function(f"() => document.querySelector('.receipt-line').textContent.includes('In favour')")
        self.assertNotEqual(pg.inner_text(".receipt-line .receipt-code"), code)

    def test_vote_that_times_out_but_landed_is_shown_as_recorded(self):
        pg = self.page
        pg.clock.install()
        h.open_voter(pg, self.base)
        seed_open(pg, ballots=[])
        board(pg)
        slug = h.slugify(h.GROUP1[0])
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector('button[data-c="favour"]')
        # the vote reaches the server but the answer never comes back in time
        pg.evaluate(f"window.__store.stall('polls/p1/votes/{slug}')")
        pg.click('button[data-c="favour"]')
        sid = pg.evaluate("localStorage.getItem('ed_session_id')")
        h.seed(pg, f"polls/p1/votes/{slug}", {"name": h.GROUP1[0], "slug": slug, "group": "1", "weight": 1, "isWriteIn": False,
            "choice": "favour", "sessionIds": [sid], "submissionCount": 1, "flagged": False})
        pg.clock.run_for(16000)
        pg.evaluate(f"window.__store.release('polls/p1/votes/{slug}')")
        pg.wait_for_selector(".receipt-line")
        self.assertNotIn("not sent", pg.inner_text("#app"))
        self.assertEqual(pg.evaluate("localStorage.getItem('ed_bound')"), slug)
        expected = pg.evaluate("async (v) => (await import('./js/count.js?v=' + window.__V)).ballotReceipt('p1', v)", h.get(pg, f"polls/p1/votes/{slug}"))
        self.assertEqual(pg.inner_text(".receipt-line .receipt-code"), expected)

    def test_check_my_vote_detects_a_change(self):
        pg = self.voter()
        seed_open(pg, ballots=[])
        board(pg)
        slug = h.slugify(h.GROUP1[0])
        h.pick_voter(pg, h.GROUP1[0])
        pg.click('button[data-c="favour"]')
        pg.wait_for_selector(".receipt-line")
        # closed with a saved result; then someone changes the stored ballot
        p = h.get(pg, "polls/p1")
        h.seed(pg, "polls/p1", {**p, "status": "closed", "closedAt": h.ts(NOW), "result": {"v": 1, "kind": "motion", "outcome": "noq",
            "weight": {"favour": 1, "against": 0, "abstain": 0}, "count": {"favour": 1, "against": 0, "abstain": 0}, "totalVotes": 1,
            "quorumCount": 1, "quorumNeeded": 24, "eligible": 48, "rule": p["rule"], "savedAt": h.ts(NOW)}})
        board(pg)
        pg.click('[data-vtab="results"]')
        pg.click("button[data-check='p1']")
        pg.wait_for_selector("text=It matches this phone's receipt.")
        self.assertIn("Recorded under your name: In favour.", pg.inner_text("#app"))
        b = h.get(pg, f"polls/p1/votes/{slug}")
        h.seed(pg, f"polls/p1/votes/{slug}", {**b, "choice": "against", "submissionCount": 2})
        snapshot = h.store(pg)
        reload_phone(pg, snapshot)
        pg.wait_for_selector('[data-vtab="results"]')
        pg.click('[data-vtab="results"]')
        pg.click("button[data-check='p1']")
        pg.wait_for_selector("text=It does not match this phone's receipt. Please tell leadership.")


class TestLeadershipAttendance(Base):
    def console(self, seed):
        pg = self.page
        h.load_admin(pg, self.base)
        seed(pg)
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_timeout(300)
        return pg

    def test_attendance_card_add_and_remove(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            h.seed(pg, "meetings/m1/attendance/alvin-yang", {"name": "Alvin Yang", "slug": "alvin-yang", "mode": "room", "sessionId": "d", "at": h.ts(NOW)})
            h.seed(pg, "meetings/m1/attendance/david-ng", {"name": "David Ng", "slug": "david-ng", "mode": "remote", "sessionId": "e", "at": h.ts(NOW)})
        pg = self.console(seed)
        self.assertIn("Checked in: 2 (in the room 1, remote 1)", pg.inner_text("#attendance-card"))
        pg.click("#att-add")
        pg.fill("#att-name", "Kyle Vojdani")
        pg.fill("#att-note", "Present, did not use a phone")
        pg.click("#att-form button[type=submit]")
        pg.wait_for_function("() => window.__store.get('meetings/m1/attendance/kyle-vojdani')")
        a = h.get(pg, "meetings/m1/attendance/kyle-vojdani")
        self.assertEqual((a["by"], a["note"], a["mode"]), ("leadership", "Present, did not use a phone", "room"))
        pg.evaluate("window.confirm = () => true")
        pg.click('#attendance-card [data-att-remove="david-ng"]')
        pg.wait_for_function("() => window.__store.get('meetings/m1/attendance/david-ng') === null")
        acts = [v["text"] for k, v in h.store(pg).items() if k.startswith("log/") and v["action"] == "attendance"]
        self.assertEqual(sorted(acts), ["Added to attendance: Kyle Vojdani (in the room)", "Removed from attendance: David Ng"])

    def test_remote_shows_in_voters_tab(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_open(pg, ballots=h.GROUP1[:2], meetingId="m1")
            h.seed(pg, f"meetings/m1/attendance/{h.slugify(h.GROUP1[1])}", {"name": h.GROUP1[1], "slug": h.slugify(h.GROUP1[1]), "mode": "remote", "sessionId": "d", "at": h.ts(NOW)})
        pg = self.console(seed)
        h.tab(pg, "voters")
        pg.wait_for_selector("#voters-table .ed-pill:has-text('Remote')")
        rows = pg.inner_text("#voters-table")
        self.assertEqual(rows.count("Remote"), 1)
        self.assertIn("Receipt", rows)

    def test_check_in_setting_and_meeting_switch(self):
        pg = self.console(lambda pg: seed_meeting(pg))
        pg.click("#open-settings")
        self.assertTrue(pg.is_checked("#check-in"))
        pg.uncheck("#check-in")
        pg.click("#settings-save")
        pg.wait_for_function("() => (window.__store.get('config/settings') || {}).checkIn === false")
        h.tab(pg, "meeting")
        pg.uncheck("#meeting-checkin")
        pg.click("#meeting-form button[type=submit]")
        pg.wait_for_function("() => window.__store.get('meetings/m1').checkIn === false")


class TestProjectorCheckIns(Base):
    def test_screen_shows_check_in_counts_while_waiting(self):
        pg = self.page
        pg.add_init_script(h.auth_init(h.ED_EMAIL))
        h.open_screen(pg, self.base)
        seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
        for i, mode in enumerate(["room", "room", "remote"]):
            s = h.slugify(h.GROUP1[i])
            h.seed(pg, f"meetings/m1/attendance/{s}", {"name": h.GROUP1[i], "slug": s, "mode": mode, "sessionId": "d", "at": h.ts(NOW)})
        board(pg)
        pg.wait_for_selector("text=Checked in: 3 (in the room 2, remote 1)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
