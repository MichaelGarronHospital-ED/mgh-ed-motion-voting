"""The two shared accounts are recognised by uid, never by email (voting step 9).

The account emails move from *.app to *.invalid (design passwords.md, Phase A).
A uid never changes, so a page that knows the uids keeps a signed-in person in
whatever the email is: a page loaded before the change, a cached old page after
it, or a reload after the server changed the email. The emails are only what the
pages sign in with.
"""
import re
import unittest

import harness as h
from base import Base

ROOT = h.REPO


def config_value(name):
    m = re.search(r'export const %s = "([^"]+)";' % name, (ROOT / "js/config.js").read_text())
    return m.group(1) if m else None


class TestUidsAgree(unittest.TestCase):
    def test_config_uids_equal_the_rules_uids(self):
        rules = (ROOT / "firestore.rules").read_text()
        leader = re.search(r"function isLeader\(\) \{ return isAccount\('([^']+)'\)", rules)
        member = re.search(r"function signedIn\(\) \{ return isAccount\('([^']+)'\) \|\| isLeader\(\)", rules)
        self.assertIsNotNone(leader, "isLeader() by uid not found in firestore.rules")
        self.assertIsNotNone(member, "signedIn() by uid not found in firestore.rules")
        self.assertEqual(config_value("LEADER_UID"), leader.group(1))
        self.assertEqual(config_value("ED_UID"), member.group(1))
        # the rules never decide a role by email
        self.assertNotIn("token.email", rules)

    def test_test_copies_of_the_uids_agree(self):
        lu, eu = config_value("LEADER_UID"), config_value("ED_UID")
        self.assertEqual((h.LEADER_UID, h.ED_UID), (lu, eu))
        for f in ("tests/stubs/firebase-auth.js", "tests/rules/helpers.mjs", "tests/rules/rules.core.test.mjs"):
            text = (ROOT / f).read_text()
            self.assertIn(lu, text, f)
            self.assertIn(eu, text, f)

    def test_sign_in_emails_are_the_harness_ones(self):
        self.assertEqual(config_value("LEADER_EMAIL"), h.LEADER_EMAIL)
        self.assertEqual(config_value("ED_EMAIL"), h.ED_EMAIL)

    def test_no_role_is_decided_by_email_in_page_code(self):
        for f in sorted((ROOT / "js").glob("*.js")) + sorted(ROOT.glob("*.html")):
            text = f.read_text()
            self.assertIsNone(re.search(r"\.email\s*[!=]==?|[!=]==?\s*\w*\.email\b", text), f.name)
            if f.name not in ("config.js", "db.js"):
                self.assertNotRegex(text, r"\b(LEADER|ED)_EMAIL", f.name)
        db = (ROOT / "js/db.js").read_text()
        # in db.js the emails appear only in the import, the sign-in table, and
        # the re-export kept for cached older pages
        uses = [l.strip() for l in db.splitlines() if re.search(r"\b(LEADER|ED)_EMAIL", l)]
        self.assertTrue(uses)
        for l in uses:
            self.assertTrue(l.startswith(("import ", "ed: { uid: ED_UID", "leader: { uid: LEADER_UID", "export { LEADER_EMAIL, ED_EMAIL }")), l)


class TestEmailChange(Base):
    """Signed in, the email changed on the server, reload: still in."""

    def fresh(self, email, uid=None):
        pg = self.browser.new_page()
        errs = []
        h.wire(pg, errs)
        pg.add_init_script(h.auth_init(email, uid))
        self.addCleanup(pg.close)
        self.addCleanup(lambda: self.assertEqual(errs, []))
        return pg

    def test_voter_signed_in_email_changed_reload_still_in(self):
        pg = self.voter()                                         # types the ED password
        self.assertEqual(pg.evaluate("window.__lastEmail"), h.ED_EMAIL)
        # the server changes the email; the SDK reloads the user with the new one
        pg.evaluate("window.__auth.force({ uid: '%s', isAnonymous: false, email: '%s' })" % (h.ED_UID, h.NEW_ED_EMAIL))
        pg.wait_for_timeout(200)
        self.assertIsNone(pg.query_selector("#edpw"))
        self.assertIsNotNone(pg.query_selector("#search, #app .tabs"))
        # reload: the page starts with the user as the server now has it
        p2 = self.fresh(h.NEW_ED_EMAIL)
        p2.goto(f"{self.base}/index.html")
        p2.wait_for_selector("#search, #app .tabs")
        self.assertIsNone(p2.query_selector("#edpw"))

    def test_console_signed_in_email_changed_reload_still_in(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.fill("#pass", "the-leadership-password")
        pg.click("#enter")
        pg.wait_for_selector("#console:not(.hide)")
        self.assertEqual(pg.evaluate("window.__lastEmail"), h.LEADER_EMAIL)
        pg.evaluate("window.__auth.force({ uid: '%s', isAnonymous: false, email: '%s' })" % (h.LEADER_UID, h.NEW_LEADER_EMAIL))
        pg.wait_for_timeout(200)
        self.assertFalse(pg.evaluate("document.getElementById('console').classList.contains('hide')"))
        p2 = self.fresh(h.NEW_LEADER_EMAIL)
        h.load_admin(p2, self.base)
        p2.wait_for_selector("#console:not(.hide)")

    def test_old_or_new_page_with_either_email_still_in(self):
        """An old cached page after the change (or a new page before it): the
        page's emails and the server's disagree, and the person is still in."""
        for email, uid in ((h.ED_EMAIL, h.ED_UID), (h.NEW_ED_EMAIL, h.ED_UID)):
            with self.subTest(page="voter", email=email):
                p = self.fresh(email, uid)
                p.goto(f"{self.base}/index.html")
                p.wait_for_selector("#search, #app .tabs")
                self.assertIsNone(p.query_selector("#edpw"))
            with self.subTest(page="screen", email=email):
                p = self.fresh(email, uid)
                h.open_screen(p, self.base)
                p.wait_for_selector(".screen-head")
                self.assertIsNone(p.query_selector("#edpw"))
        for email in (h.LEADER_EMAIL, h.NEW_LEADER_EMAIL):
            with self.subTest(page="console", email=email):
                p = self.fresh(email, h.LEADER_UID)
                h.load_admin(p, self.base)
                p.wait_for_selector("#console:not(.hide)")

    def test_the_right_email_with_another_uid_gets_nothing(self):
        for email in (h.ED_EMAIL, h.NEW_ED_EMAIL):
            with self.subTest(page="voter", email=email):
                p = self.fresh(email, "someone-else")
                p.goto(f"{self.base}/index.html")
                p.wait_for_selector("#edpw")
                self.assertIsNone(p.query_selector("#search"))
        for email in (h.LEADER_EMAIL, h.NEW_LEADER_EMAIL):
            with self.subTest(page="console", email=email):
                p = self.fresh(email, "someone-else")
                h.load_admin(p, self.base)
                p.wait_for_timeout(300)
                self.assertTrue(p.evaluate("document.getElementById('console').classList.contains('hide')"))
        with self.subTest(page="console", who="ED account"):
            p = self.fresh(h.LEADER_EMAIL, h.ED_UID)               # the ED account cannot open the console
            h.load_admin(p, self.base)
            p.wait_for_timeout(300)
            self.assertTrue(p.evaluate("document.getElementById('console').classList.contains('hide')"))


OLD = {"ed": h.ED_EMAIL, "leader": h.LEADER_EMAIL}
NEW = {"ed": h.NEW_ED_EMAIL, "leader": h.NEW_LEADER_EMAIL}
BEFORE = {h.ED_EMAIL: h.ED_UID, h.LEADER_EMAIL: h.LEADER_UID}            # before the move (and after an undo)
AFTER = {h.NEW_ED_EMAIL: h.ED_UID, h.NEW_LEADER_EMAIL: h.LEADER_UID}     # after migrate-emails.py --apply


class TestSignInDuringTheMove(Base):
    """Each gate tries the email that last worked on this device (else the old
    one) and, only on a refusal, the other once, at the moment it is tapped.
    Only the account's own uid is accepted. One tap is one message."""

    def accounts(self, pg, table):
        pg.evaluate("t => { window.__accounts = t; }", table)

    def tries(self, pg):
        return pg.evaluate("window.__signIns")

    def remembered(self, pg):
        return pg.evaluate("localStorage.getItem('mv_signin_email')")

    def voter_gate(self, table, remembered=None, page="index.html"):
        pg = self.page
        if remembered:
            pg.add_init_script("localStorage.setItem('mv_signin_email', '%s');" % remembered)
        pg.add_init_script("window.__accounts = %s;" % __import__("json").dumps(table))
        pg.goto(f"{self.base}/{page}")
        pg.wait_for_selector("#edpw")
        return pg

    def tap_voter(self, pg, password="the-ed-password"):
        pg.evaluate("window.__signIns.length = 0")
        pg.fill("#edpw", password)
        pg.click("#edgo")

    def test_before_the_move_one_try_with_the_old_email(self):
        pg = self.voter_gate(BEFORE)
        self.tap_voter(pg)
        pg.wait_for_selector("#search, #app .tabs")
        self.assertEqual(self.tries(pg), [OLD["ed"]])
        self.assertEqual(self.remembered(pg), "old")

    def test_after_the_move_a_new_device_finds_the_new_email_and_remembers_it(self):
        pg = self.voter_gate(AFTER)
        self.tap_voter(pg)
        pg.wait_for_selector("#search, #app .tabs")
        self.assertEqual(self.tries(pg), [OLD["ed"], NEW["ed"]])
        self.assertEqual(self.remembered(pg), "new")
        self.assertEqual(pg.evaluate("window.__auth.current().uid"), h.ED_UID)
        # next time it goes straight to the new one
        pg.evaluate("window.__auth.force(null)")
        pg.wait_for_selector("#edpw")
        self.tap_voter(pg)
        pg.wait_for_selector("#search, #app .tabs")
        self.assertEqual(self.tries(pg), [NEW["ed"]])

    def test_after_an_undo_a_device_that_knew_the_new_email_finds_the_old(self):
        pg = self.voter_gate(BEFORE, remembered="new")
        self.tap_voter(pg)
        pg.wait_for_selector("#search, #app .tabs")
        self.assertEqual(self.tries(pg), [NEW["ed"], OLD["ed"]])
        self.assertEqual(self.remembered(pg), "old")

    def test_a_page_left_open_across_the_move_signs_in_without_a_reload(self):
        pg = self.voter_gate(BEFORE)
        self.accounts(pg, AFTER)                  # the move happens while the page is open
        self.tap_voter(pg)
        pg.wait_for_selector("#search, #app .tabs")
        self.assertEqual(self.tries(pg), [OLD["ed"], NEW["ed"]])

    def test_a_wrong_password_is_one_message_after_trying_both(self):
        pg = self.voter_gate(AFTER)
        pg.evaluate("window.__authReject = true")
        self.tap_voter(pg, "nope")
        pg.wait_for_selector("#ederr:not(.hide)")
        self.assertIn("not the ED password", pg.inner_text("#ederr"))
        self.assertEqual(self.tries(pg), [OLD["ed"], NEW["ed"]])   # one tap, both emails, one message
        self.assertIsNone(self.remembered(pg))
        self.assertIsNone(pg.query_selector("#search"))

    def test_offline_never_tries_the_other_email(self):
        pg = self.voter_gate(AFTER)
        pg.evaluate("window.__authOffline = true")
        self.tap_voter(pg)
        pg.wait_for_selector("#ederr:not(.hide)")
        self.assertNotIn("not the ED password", pg.inner_text("#ederr"))
        self.assertEqual(self.tries(pg), [OLD["ed"]])

    def test_another_account_under_the_old_email_is_never_accepted(self):
        squat = {h.ED_EMAIL: "a-strangers-uid", h.NEW_ED_EMAIL: h.ED_UID}
        pg = self.voter_gate(squat)
        self.tap_voter(pg)
        pg.wait_for_selector("#search, #app .tabs")
        self.assertEqual(self.tries(pg), [OLD["ed"], NEW["ed"]])
        self.assertEqual(pg.evaluate("window.__auth.current().uid"), h.ED_UID)
        # and with no right account at all, nothing opens and nobody stays signed in
        p2 = self.browser.new_page()
        errs = []
        h.wire(p2, errs)
        p2.add_init_script("window.__accounts = %s;" % __import__("json").dumps({h.ED_EMAIL: "a-strangers-uid"}))
        p2.goto(f"{self.base}/index.html")
        p2.wait_for_selector("#edpw")
        p2.fill("#edpw", "the-ed-password")
        p2.click("#edgo")
        p2.wait_for_selector("#ederr:not(.hide)")
        self.assertIsNone(p2.evaluate("window.__auth.current()"))
        self.assertIsNone(p2.query_selector("#search"))
        self.assertEqual(errs, [])
        p2.close()

    def test_projector_after_the_move(self):
        pg = self.page
        pg.add_init_script("window.__accounts = %s;" % __import__("json").dumps(AFTER))
        h.open_screen(pg, self.base)
        pg.wait_for_selector("#edpw")
        pg.fill("#edpw", "the-ed-password")
        pg.click("#edgo")
        pg.wait_for_selector(".screen-head")
        self.assertEqual(self.tries(pg), [OLD["ed"], NEW["ed"]])

    def test_console_before_after_and_left_open_across_the_move(self):
        for table, remembered, expect in ((BEFORE, None, [OLD["leader"]]),
                                          (AFTER, None, [OLD["leader"], NEW["leader"]]),
                                          (AFTER, "new", [NEW["leader"]]),
                                          (BEFORE, "new", [NEW["leader"], OLD["leader"]])):
            with self.subTest(after=table is AFTER, remembered=remembered):
                p = self.browser.new_page()
                errs = []
                h.wire(p, errs)
                if remembered:
                    p.add_init_script("localStorage.setItem('mv_signin_email', '%s');" % remembered)
                h.load_admin(p, self.base)
                self.accounts(p, table)            # set after the page loaded: an open gate
                p.fill("#pass", "the-leadership-password")
                p.click("#enter")
                p.wait_for_selector("#console:not(.hide)")
                self.assertEqual(self.tries(p), expect)
                self.assertEqual(p.evaluate("window.__auth.current().uid"), h.LEADER_UID)
                self.assertEqual(errs, [])
                p.close()

    def test_console_wrong_password_says_so_once(self):
        pg = self.page
        h.load_admin(pg, self.base)
        self.accounts(pg, AFTER)
        pg.evaluate("window.__authReject = true")
        pg.fill("#pass", "nope")
        pg.click("#enter")
        pg.wait_for_selector("#gate-err:not(.hide)")
        self.assertEqual(pg.inner_text("#gate-err"), "Incorrect password.")
        self.assertEqual(self.tries(pg), [OLD["leader"], NEW["leader"]])
        self.assertTrue(pg.evaluate("document.getElementById('console').classList.contains('hide')"))


if __name__ == "__main__":
    unittest.main()
