"""Meetings (voting upgrade step 4, V3) and agenda preparation (V6).

Motions belong to a meeting and are numbered 1, 2, 2a, 2a.1 on its agenda;
voters see the open (or last ended) meeting's title and results. Old motions
stay under "Earlier motions". A meeting can be exported (five sheets), and a
trashed meeting deleted permanently with a record kept in the change history.
"""
import io
import time
import unittest
import zipfile

import harness as h
from base import Base
from test_saved_results import seed_open, wait_result, NOW
from test_voter_board import seed_closed_saved, build_board

TODAY = time.strftime("%Y-%m-%d")


def seed_meeting(pg, mid="m1", title="ED department meeting", date="2026-11-20", status="planned", **extra):
    d = {"title": title, "date": date, "status": status, "chair": "", "notes": "", "checkIn": True,
         "archived": False, "deleted": False, "createdAt": h.ts(NOW - 99999)}
    d.update(extra)
    h.seed(pg, f"meetings/{mid}", d)


def seed_motion(pg, pid, text, order=0, meeting="m1", status="draft", **extra):
    d = {"text": text, "order": order, "status": status, "voteCount": 0, "archived": False, "deleted": False,
         "meetingId": meeting, "threshold": "majority", "createdAt": h.ts(NOW - 50000 + order)}
    d.update(extra)
    h.seed(pg, f"polls/{pid}", d)


class Console(Base):
    allowed_errors = ("permission-denied",)

    def console(self, seed=None, clock=False):
        pg = self.page
        if clock:
            pg.clock.install()
        h.load_admin(pg, self.base)
        if seed:
            seed(pg)
        h.unlock_admin(pg)
        pg.wait_for_selector("#console:not(.hide)")
        pg.wait_for_function("() => window.__store.get('config/live') !== null")
        pg.wait_for_timeout(300)
        return pg

    def logs(self, pg, action=None):
        return [v for k, v in h.store(pg).items() if k.startswith("log/") and (action is None or v["action"] == action)]


class TestMeetings(Console):
    def test_new_motion_without_a_meeting_creates_todays_meeting(self):
        pg = self.console()
        h.tab(pg, "motions")
        pg.fill("#new-motion", "Motion to approve the summer schedule.")
        pg.click("#add-motion")
        pg.wait_for_function("() => Object.keys(window.__store.dump()).some(k => k.startsWith('meetings/'))")
        mid, m = [(k.split("/")[1], v) for k, v in h.store(pg).items() if k.startswith("meetings/")][0]
        self.assertEqual((m["title"], m["date"], m["status"]), ("ED department meeting", TODAY, "planned"))
        pg.wait_for_function("() => Object.entries(window.__store.dump()).some(([k, v]) => k.startsWith('polls/') && v.meetingId)")
        p = [v for k, v in h.store(pg).items() if k.startswith("polls/")][0]
        self.assertEqual(p["meetingId"], mid)
        pg.wait_for_timeout(200)
        self.assertIn("Agenda: ED department meeting", pg.inner_text("#motion-list"))

    def test_start_and_end_meeting_record_times(self):
        pg = self.console(lambda pg: seed_meeting(pg))
        h.tab(pg, "meeting")
        pg.click("#meeting-start")
        pg.wait_for_function("() => window.__store.get('meetings/m1').status === 'open'")
        m = h.get(pg, "meetings/m1")
        self.assertIsNotNone(m["startedAt"])
        pg.wait_for_function("() => (window.__store.get('config/live').meeting || {}).id === 'm1'")
        pg.wait_for_selector("#meeting-end")
        pg.click("#meeting-end")
        pg.wait_for_function("() => window.__store.get('meetings/m1').status === 'closed'")
        self.assertIsNotNone(h.get(pg, "meetings/m1")["endedAt"])
        self.assertEqual(h.get(pg, "config/live")["meeting"]["status"], "closed")
        self.assertEqual([l["text"] for l in self.logs(pg, "meeting")][-2:], ["Meeting started: ED department meeting", "Meeting ended: ED department meeting"])

    def test_end_meeting_closes_and_saves_the_open_motion(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 600000))
            seed_open(pg, ballots=h.GROUP1[:30], meetingId="m1")
        pg = self.console(seed)
        h.tab(pg, "meeting")
        pg.click("#meeting-end")
        pg.wait_for_function("() => window.__store.get('meetings/m1').status === 'closed'")
        p = h.get(pg, "polls/p1")
        self.assertEqual(p["status"], "closed")
        self.assertEqual(p["result"]["outcome"], "pass")

    def test_history_failure_never_blocks_end_meeting(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 600000))
            seed_meeting(pg, "m0", title="Earlier meeting", date="2026-10-01", status="closed", endedAt=h.ts(NOW - 86400000 * 9))
            seed_closed_saved(pg, "c0", NOW - 86400000 * 9, meetingId="m0")
            seed_open(pg, ballots=h.GROUP1[:30], meetingId="m1")
        pg = self.console(seed)
        pg.evaluate("window.__store.fail('config/history', 'permission-denied', 'w')")
        h.tab(pg, "meeting")
        pg.click("#meeting-end")
        pg.wait_for_function("() => window.__store.get('meetings/m1').status === 'closed'")
        p = h.get(pg, "polls/p1")
        self.assertIsNotNone(p["closedAt"])
        self.assertIsNotNone(p["result"]["savedAt"])

    def test_mover_seconder_notes_editable_after_close(self):
        def seed(pg):
            seed_meeting(pg)
            seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1")
        pg = self.console(seed)
        h.tab(pg, "motions")
        pg.click("#motion-list .details-fold summary")
        pg.fill('#motion-list form[data-details="c1"] input[name=mover]', "Kyle Vojdani")
        pg.fill('#motion-list form[data-details="c1"] input[name=seconder]', "Meg Reynolds")
        pg.fill('#motion-list form[data-details="c1"] textarea[name=notes]', "Friendly amendment accepted.")
        pg.click('#motion-list form[data-details="c1"] button[type=submit]')
        pg.wait_for_function("() => window.__store.get('polls/c1').mover === 'Kyle Vojdani'")
        p = h.get(pg, "polls/c1")
        self.assertEqual((p["seconder"], p["notes"]), ("Meg Reynolds", "Friendly amendment accepted."))

    def test_old_motions_listed_under_earlier_motions(self):
        def seed(pg):
            seed_meeting(pg)
            h.seed_poll(pg, pid="old1", status="closed", text="An old motion")
            seed_motion(pg, "n1", "A motion on the agenda")
        pg = self.console(seed)
        h.tab(pg, "motions")
        text = pg.inner_text("#motion-list")
        self.assertIn("Earlier motions (before meetings)", text)
        self.assertNotIn("An old motion", text)                 # folded
        self.assertIn("A motion on the agenda", text)
        pg.click("#earlier-header")
        self.assertIn("An old motion", pg.inner_text("#motion-list"))
        pg.click('#motion-list button[data-act="move-to"][data-id="old1"]')
        pg.wait_for_function("() => window.__store.get('polls/old1').meetingId === 'm1'")

    def test_current_motion_auto_picks_latest_closed_by_time(self):
        def seed(pg):
            seed_closed_saved(pg, "late", NOW - 1000, text="Closed last", order=0)
            seed_closed_saved(pg, "early", NOW - 900000, text="Closed first", order=5)
        pg = self.console(seed)
        h.tab(pg, "results")
        self.assertIn("Closed last", pg.inner_text("#results-body"))

    def test_meeting_purge_removes_its_data_and_logs_it(self):
        def seed(pg):
            seed_meeting(pg, deleted=True, title="TEST, please ignore")
            seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1", ballots=3)
            seed_motion(pg, "d1", "A draft", order=1)
        pg = self.console(seed)
        h.tab(pg, "meeting")
        pg.evaluate("window.confirm = () => true")
        pg.click("#meeting-trash [data-m-purge]")
        pg.wait_for_function("() => window.__store.get('meetings/m1') === null")
        keys = list(h.store(pg).keys())
        self.assertFalse([k for k in keys if k.startswith("polls/")])
        purges = self.logs(pg, "purge")
        self.assertEqual(len(purges), 3)                       # two motions and the meeting
        self.assertTrue(any("TEST, please ignore" in p.get("text", "") for p in purges))

    def test_meeting_with_an_open_motion_cannot_be_trashed_or_deleted(self):
        def seed(pg):
            seed_meeting(pg, status="closed", endedAt=h.ts(NOW - 1000))
            seed_open(pg, ballots=[], meetingId="m1")
        pg = self.console(seed)
        h.tab(pg, "meeting")
        pg.evaluate("window.confirm = () => true")
        h.edit_meeting(pg)
        pg.click("#meeting-trash-btn")
        pg.wait_for_selector("text=Close the open motion first.")
        self.assertFalse(h.get(pg, "meetings/m1")["deleted"])
        r = pg.evaluate("async () => { const m = await import('./js/db.js?v=' + window.__V); try { await m.purgeMeeting('m1'); return 'deleted'; } catch (e) { return e.why; } }")
        self.assertEqual(r, "open")
        self.assertIsNotNone(h.get(pg, "polls/p1"))

    def test_meeting_purge_trashes_motions_with_board_and_log(self):
        def seed(pg):
            seed_meeting(pg, status="closed", endedAt=h.ts(NOW - 1000), deleted=True)
            seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1")
        pg = self.console(seed)
        h.tab(pg, "meeting")
        pg.evaluate("window.confirm = () => true")
        pg.click("#meeting-trash [data-m-purge]")
        pg.wait_for_function("() => window.__store.get('meetings/m1') === null")
        self.assertIn("trash", [l["action"] for l in self.logs(pg)])

    def test_meeting_export_has_five_sheets_and_saved_results(self):
        def seed(pg):
            seed_meeting(pg, chair="Kyle Vojdani")
            seed_closed_saved(pg, "c1", NOW - 60000, meetingId="m1", ballots=3, text="Approve the schedule", mover="Kyle Vojdani")
            h.seed(pg, "meetings/m1/attendance/alvin-yang", {"name": "Alvin Yang", "slug": "alvin-yang", "mode": "room", "by": "leadership", "at": h.ts(NOW)})
        pg = self.console(seed)
        h.tab(pg, "results")                                   # "Records of this meeting" is on Results
        with pg.expect_download() as dl:
            pg.click("#meeting-export")
        self.assertEqual(dl.value.suggested_filename, "motion-voting-2026-11-20-ed-department-meeting.xlsx")
        z = zipfile.ZipFile(io.BytesIO(dl.value.path().read_bytes()))
        wb = z.read("xl/workbook.xml").decode()
        for name in ("Meeting", "Motions", "Ballots", "Attendance", "Changes"):
            self.assertIn(f'name="{name}"', wb)
        everything = "".join(z.read(n).decode() for n in z.namelist() if n.endswith(".xml"))
        self.assertIn("Approve the schedule", everything)
        self.assertIn("Passed", everything)                      # the saved result's words
        self.assertIn("Kyle Vojdani", everything)
        self.assertIn("Voted, did not check in", everything)
        self.assertIn("In the room (added in the Admin console)", everything)   # stored as by: "leadership"
        self.assertNotIn("leadership", everything.lower())

    def test_opening_a_motion_starts_its_planned_meeting(self):
        """Planned meeting -> open -> close -> save: the board has the meeting and the entry."""
        def seed(pg):
            seed_meeting(pg)                              # planned
            seed_motion(pg, "n1", "Approve the schedule")
        pg = self.console(seed)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="n1"]')
        pg.wait_for_function("() => window.__store.get('polls/n1').status === 'open'")
        m = h.get(pg, "meetings/m1")
        self.assertEqual(m["status"], "open")
        self.assertIsNotNone(m["startedAt"])
        live = h.get(pg, "config/live")
        self.assertEqual((live["meeting"]["id"], live["open"]["id"]), ("m1", "n1"))
        self.assertIn("Meeting started: ED department meeting", [l.get("text") for l in self.logs(pg, "meeting")])
        h.tab(pg, "results")
        pg.click("#r-close")
        pg.wait_for_function("() => (window.__store.get('polls/n1') || {}).result")
        pg.wait_for_timeout(200)
        self.assertTrue(h.get(pg, "config/live")["results"]["n1"]["result"])

    def test_new_planned_meeting_after_last_months_ended_one(self):
        def seed(pg):
            seed_meeting(pg, "m0", title="Last month", date="2026-09-20", status="closed", endedAt=h.ts(NOW - 30 * 86400000))
            seed_closed_saved(pg, "c0", NOW - 30 * 86400000, meetingId="m0")
            seed_meeting(pg, "m1", title="This month", date="2026-10-20")
            seed_motion(pg, "n1", "A new motion")
        pg = self.console(seed)
        self.assertEqual(h.get(pg, "config/live")["meeting"]["id"], "m0")   # the last one ended, until this one starts
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="n1"]')
        pg.wait_for_function("() => (window.__store.get('config/live').meeting || {}).id === 'm1'")
        h.tab(pg, "results")
        pg.click("#r-close")
        pg.wait_for_function("() => ((window.__store.get('config/live').results || {}).n1 || {}).result")
        live = h.get(pg, "config/live")
        self.assertNotIn("c0", live["results"])
        pg.wait_for_function("() => (window.__store.get('config/history').entries || []).some(e => e.id === 'c0')")

    def test_opening_in_a_planned_meeting_ends_the_other_open_one_first(self):
        def seed(pg):
            seed_meeting(pg, "m0", title="Running", status="open", startedAt=h.ts(NOW - 600000))
            seed_meeting(pg, "m1", title="Next")
            seed_motion(pg, "n1", "In the next meeting")
        pg = self.console(seed)
        pg.evaluate("window.confirm = () => true")
        h.tab(pg, "meeting")
        pg.select_option("#meeting-pick", "m1")       # show the next meeting's agenda
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="n1"]')
        pg.wait_for_function("() => window.__store.get('meetings/m1').status === 'open'")
        self.assertEqual(h.get(pg, "meetings/m0")["status"], "closed")

    def test_board_meeting_ignores_trashed_meetings(self):
        pg = self.page
        h.load_admin(pg, self.base)
        r = pg.evaluate("""async () => { const b = await import('./js/board.js?v=' + window.__V); const ts = window.__store.ts;
            const ms = [{ id: 'a', title: 'A', date: '2026-11-01', status: 'closed', endedAt: ts(5000), deleted: true },
                        { id: 'b', title: 'B', date: '2026-10-01', status: 'closed', endedAt: ts(4000) },
                        { id: 'c', title: 'C', date: '2026-12-01', status: 'open', archived: true }];
            return b.buildBoard([], ms).meeting.id; }""")
        self.assertEqual(r, "b")

    def test_reorder_and_meeting_rename_never_show_the_banner(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 600000))
            seed_closed_saved(pg, "c1", NOW - 90000, meetingId="m1", order=0, text="First")
            seed_closed_saved(pg, "c2", NOW - 60000, meetingId="m1", order=1, text="Second")
        pg = self.console(seed, clock=True)
        writes = h.writes(pg, "config/live")
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="down"][data-id="c1"]')
        pg.wait_for_function("() => window.__store.get('config/live').results.c1.number === '2'")
        h.tab(pg, "meeting")
        h.edit_meeting(pg)
        pg.fill("#meeting-title", "ED meeting (renamed)")
        pg.click("#meeting-form button[type=submit]")
        pg.wait_for_function("() => window.__store.get('config/live').meeting.title === 'ED meeting (renamed)'")
        pg.clock.fast_forward(15000)
        pg.wait_for_timeout(300)
        self.assertNotIn("out of date", pg.inner_text("#banners"))
        self.assertEqual(h.writes(pg, "config/live") - writes, 2)     # two patches, no heal

    def test_page_on_rules_without_meetings_says_database_update(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.evaluate("window.__store.fail('meetings', 'permission-denied', 'r')")
        h.seed_poll(pg, pid="pd", status="draft")
        h.unlock_admin(pg)
        pg.wait_for_selector("#banners .banner")
        self.assertIn("needs a database update", pg.inner_text("#banners"))
        self.assertIn("Open and Close are off until it is", pg.inner_text("#banners"))
        h.tab(pg, "motions")
        self.assertTrue(pg.is_disabled('#motion-list button[data-act="open"]'))

    def test_revote_of_an_ended_meetings_motion_goes_to_the_open_meeting(self):
        def seed(pg):
            seed_meeting(pg, "m0", title="Last month", date="2026-10-01", status="closed", endedAt=h.ts(NOW - 86400000))
            seed_meeting(pg, "m1", status="open", startedAt=h.ts(NOW - 60000))
            seed_closed_saved(pg, "c0", NOW - 86400000 * 2, meetingId="m0")
        pg = self.console(seed)
        h.tab(pg, "results")
        pg.select_option("#results-selector select", "c0")
        pg.wait_for_timeout(200)
        pg.click("#r-revote")
        pg.fill("#revote-reason", "Quorum was disputed.")
        pg.click("#revote-go")
        pg.wait_for_function("() => window.__store.get('polls/c0').supersededBy")
        self.assertEqual(h.get(pg, "polls/" + h.get(pg, "polls/c0")["supersededBy"])["meetingId"], "m1")


class TestHistoryPurge(Console):
    def test_delete_history_older_than_7_years_keeps_newer_entries(self):
        def seed(pg):
            h.seed(pg, "log/old", {"at": h.ts(NOW - 8 * 366 * 86400000), "action": "close", "pollId": "x"})
            h.seed(pg, "log/new", {"at": h.ts(NOW - 6 * 365 * 86400000), "action": "close", "pollId": "x"})
        pg = self.console(seed)
        pg.click("#open-settings")
        self.assertEqual(pg.inner_text("#history-purge"), "Delete history older than 7 years")
        pg.evaluate("window.confirm = () => true")
        pg.click("#history-purge")
        pg.wait_for_function("() => window.__store.get('log/old') === null")
        self.assertIsNotNone(h.get(pg, "log/new"))
        purge = self.logs(pg, "history-purge")
        self.assertEqual(purge[0]["text"], "Deleted 1 change-history entry older than 7 years")


class TestAgenda(Console):
    def agenda_numbers(self, pg):
        return pg.eval_on_selector_all("#motion-list .agenda-num", "els => els.map(e => e.textContent)")

    def test_paste_agenda_previews_then_adds_in_order(self):
        pg = self.console(lambda pg: seed_meeting(pg))
        h.tab(pg, "motions")
        pg.click("#agenda-fold summary")
        pg.fill("#agenda-text", "1. Approve the minutes\n2) Approve the summer schedule\n\n- Adopt the new triage policy\n* ok")
        pg.click("#agenda-preview")
        out = pg.inner_text("#agenda-result")
        self.assertIn("Too short", out)
        self.assertIn("Add 3 motions to ED department meeting", out)
        pg.click("#agenda-add")
        pg.wait_for_function("() => Object.keys(window.__store.dump()).filter(k => /^polls\\/[^/]+$/.test(k)).length === 3")
        pg.wait_for_timeout(200)
        self.assertEqual(self.agenda_numbers(pg), ["1", "2", "3"])
        text = pg.inner_text("#motion-list")
        self.assertLess(text.index("Approve the minutes"), text.index("Approve the summer schedule"))
        self.assertLess(text.index("Approve the summer schedule"), text.index("Adopt the new triage policy"))

    def test_paste_links_amendments(self):
        pg = self.console(lambda pg: seed_meeting(pg))
        h.tab(pg, "motions")
        pg.click("#agenda-fold summary")
        pg.fill("#agenda-text", "Approve the schedule\nAmendment: add Dec 24\nAmendment to the amendment: and Dec 31\nAmendment: remove Jan 1\nAdopt the policy")
        pg.click("#agenda-preview")
        pg.click("#agenda-add")
        pg.wait_for_function("() => Object.keys(window.__store.dump()).filter(k => /^polls\\/[^/]+$/.test(k)).length === 5")
        pg.wait_for_timeout(200)
        self.assertEqual(self.agenda_numbers(pg), ["1", "1a", "1a.1", "1b", "2"])
        polls = {v["text"]: (k.split("/")[1], v) for k, v in h.store(pg).items() if k.count("/") == 1 and k.startswith("polls/")}
        main_id = polls["Approve the schedule"][0]
        a_id = polls["Amendment: add Dec 24"][0]
        self.assertEqual(polls["Amendment: add Dec 24"][1]["amends"], main_id)
        self.assertEqual(polls["Amendment to the amendment: and Dec 31"][1]["amends"], a_id)

    def test_amendment_of_amendment_cannot_be_amended(self):
        def seed(pg):
            seed_meeting(pg)
            seed_motion(pg, "m", "Main")
            seed_motion(pg, "a", "Amendment A", amends="m")
            seed_motion(pg, "aa", "Amendment to A", amends="a")
        pg = self.console(seed)
        h.tab(pg, "motions")
        self.assertEqual(self.agenda_numbers(pg), ["1", "1a", "1a.1"])
        self.assertEqual(pg.locator('#motion-list button[data-act="amend"][data-id="aa"]').count(), 0)
        self.assertEqual(pg.locator('#motion-list button[data-act="amend"][data-id="a"]').count(), 1)
        h.motion_act(pg, "amend", "m")
        pg.fill("#amend-m", "Amendment B: change the date")
        pg.click('#motion-list form[data-amend="m"] button[type=submit]')
        pg.wait_for_function("() => Object.values(window.__store.dump()).some(v => v.text === 'Amendment B: change the date' && v.amends === 'm')")

    def test_move_up_and_down_keeps_amendments_with_their_motion(self):
        def seed(pg):
            seed_meeting(pg)
            seed_motion(pg, "x", "Motion X", order=0)
            seed_motion(pg, "y", "Motion Y", order=1)
            seed_motion(pg, "ya", "Amendment to Y", amends="y")
        pg = self.console(seed)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="up"][data-id="y"]')
        pg.wait_for_function("() => window.__store.get('polls/y').order === 0")
        pg.wait_for_timeout(200)
        text = pg.inner_text("#motion-list")
        self.assertLess(text.index("Motion Y"), text.index("Amendment to Y"))
        self.assertLess(text.index("Amendment to Y"), text.index("Motion X"))
        self.assertEqual(self.agenda_numbers(pg), ["1", "1a", "2"])

    def test_move_keeps_keyboard_focus(self):
        def seed(pg):
            seed_meeting(pg)
            seed_motion(pg, "x", "Motion X", order=0)
            seed_motion(pg, "y", "Motion Y", order=1)
        pg = self.console(seed)
        h.tab(pg, "motions")
        self.assertEqual(pg.get_attribute('#motion-list button[data-act="down"][data-id="x"]', "aria-label"), "Move motion 1 down")
        pg.focus('#motion-list button[data-act="down"][data-id="x"]')
        pg.keyboard.press("Enter")
        pg.wait_for_function("() => window.__store.get('polls/x').order === 1")
        pg.wait_for_timeout(300)
        self.assertEqual(pg.evaluate("[document.activeElement.dataset.act, document.activeElement.dataset.id]"), ["down", "x"])
        self.assertEqual(pg.get_attribute('#motion-list button[data-act="down"][data-id="x"]', "aria-label"), "Move motion 2 down")

    def test_opening_main_motion_warns_about_unvoted_amendment(self):
        def seed(pg):
            seed_meeting(pg)
            seed_motion(pg, "m", "Main motion")
            seed_motion(pg, "a", "Amendment", amends="m")
        pg = self.console(seed)
        h.tab(pg, "motions")
        msgs = []
        pg.on("dialog", lambda d: (msgs.append(d.message), d.dismiss()))
        pg.click('#motion-list button[data-act="open"][data-id="m"]')
        pg.wait_for_timeout(300)
        self.assertEqual(msgs, ["Amendment 1a hasn't been voted yet. Open the main motion anyway?"])
        self.assertEqual(h.get(pg, "polls/m")["status"], "draft")

    def test_open_saves_the_agenda_number_and_voters_see_the_amendment(self):
        def seed(pg):
            seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
            seed_motion(pg, "m", "Approve the summer schedule as circulated.")
            seed_motion(pg, "a", "Amendment: add Dec 24 to the holiday list.", amends="m")
        pg = self.console(seed)
        h.tab(pg, "motions")
        pg.click('#motion-list button[data-act="open"][data-id="a"]')
        pg.wait_for_function("() => window.__store.get('polls/a').status === 'open'")
        self.assertEqual(h.get(pg, "polls/a")["number"], "1a")
        live = h.get(pg, "config/live")
        self.assertEqual((live["open"]["number"], live["open"]["amendsNumber"]), ("1a", "1"))
        self.assertEqual(live["open"]["amendsText"], "Approve the summer schedule as circulated.")

    def test_parse_agenda_unit(self):
        pg = self.console()
        r = pg.evaluate("""async () => { const c = await import('./js/count.js?v=' + window.__V);
            const p = c.parseAgenda('a. First\\nAmendment to the amendment: orphan\\nb) Second\\nAmendment: x');
            return p.rows.map((x) => [x.number, x.depth, x.problem]); }""")
        self.assertEqual(r, [["1", 0, None], ["", 2, "Amendment to an amendment with no amendment above it"], ["2", 0, None], ["2a", 1, "Too short"]])


class TestVoterMeeting(Base):
    def test_voter_sees_the_meeting_and_the_amendment(self):
        pg = self.voter()
        seed_meeting(pg, status="open", startedAt=h.ts(NOW - 60000))
        seed_motion(pg, "m", "Approve the summer schedule as circulated.", status="closed",
                    closedAt=h.ts(NOW - 30000), result=None)
        seed_motion(pg, "a", "Amendment: add Dec 24.", amends="m", status="open", openedAt=h.ts(NOW - 1000))
        build_board(pg)
        pg.evaluate("""async () => { const b = await import('./js/board.js?v=' + window.__V); const st = window.__store.dump();
            const polls = Object.entries(st).filter(([k]) => /^polls[/][^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
            const ms = Object.entries(st).filter(([k]) => /^meetings[/][^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
            window.__store.set('config/live', b.buildBoard(polls, ms)); }""")
        h.pick_voter(pg, h.GROUP1[0])
        pg.wait_for_selector('button[data-c="favour"]')
        text = pg.inner_text("#app")
        self.assertIn("ED department meeting, Fri, Nov 20", text)
        self.assertIn("Motion 1a", text)
        self.assertIn("Amendment to motion 1", text)
        pg.click("#app details.amend-fold summary")
        self.assertIn("Approve the summer schedule as circulated.", pg.inner_text("#app details.amend-fold"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
