"""The two shared accounts are recognised by uid, never by email (voting step 9;
the pages sign in with the .invalid emails only since step 10).

A uid never changes, so a page that knows the uids keeps a signed-in person in
whatever the email is: a page loaded before an email change, a cached page after
it, or a reload after the server changed the email. The emails are only what the
pages sign in with.
"""
import json
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
        self.assertEqual(config_value("LEADER_EMAIL_NEW"), h.LEADER_EMAIL)
        self.assertEqual(config_value("ED_EMAIL_NEW"), h.ED_EMAIL)
        self.assertTrue(h.LEADER_EMAIL.endswith(".invalid") and h.ED_EMAIL.endswith(".invalid"))

    def test_no_role_is_decided_by_email_in_page_code(self):
        for f in sorted((ROOT / "js").glob("*.js")) + sorted(ROOT.glob("*.html")):
            text = f.read_text()
            self.assertIsNone(re.search(r"\.email\s*[!=]==?|[!=]==?\s*\w*\.email\b", text), f.name)
            if f.name not in ("config.js", "db.js"):
                self.assertNotRegex(text, r"\b(LEADER|ED)_EMAIL", f.name)
        db = (ROOT / "js/db.js").read_text()
        # in db.js the emails appear only in the import and the sign-in table
        uses = [l.strip() for l in db.splitlines() if re.search(r"\b(LEADER|ED)_EMAIL", l)]
        self.assertTrue(uses)
        for l in uses:
            self.assertTrue(l.startswith(("import ", "ed: { uid: ED_UID", "leader: { uid: LEADER_UID")), l)


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
        # a phone signed in before an email change still has the other email
        pg = self.fresh(h.OTHER_ED_EMAIL)
        pg.goto(f"{self.base}/index.html")
        pg.wait_for_selector("#search, #app .tabs")
        # the server changes the email; the SDK reloads the user with the new one
        pg.evaluate("window.__auth.force({ uid: '%s', isAnonymous: false, email: '%s' })" % (h.ED_UID, h.ED_EMAIL))
        pg.wait_for_timeout(200)
        self.assertIsNone(pg.query_selector("#edpw"))
        self.assertIsNotNone(pg.query_selector("#search, #app .tabs"))
        p2 = self.fresh(h.ED_EMAIL)
        p2.goto(f"{self.base}/index.html")
        p2.wait_for_selector("#search, #app .tabs")
        self.assertIsNone(p2.query_selector("#edpw"))

    def test_console_signed_in_email_changed_reload_still_in(self):
        pg = self.fresh(h.OTHER_LEADER_EMAIL)
        h.load_admin(pg, self.base)
        pg.wait_for_selector("#console:not(.hide)")
        pg.evaluate("window.__auth.force({ uid: '%s', isAnonymous: false, email: '%s' })" % (h.LEADER_UID, h.LEADER_EMAIL))
        pg.wait_for_timeout(200)
        self.assertFalse(pg.evaluate("document.getElementById('console').classList.contains('hide')"))
        p2 = self.fresh(h.LEADER_EMAIL)
        h.load_admin(p2, self.base)
        p2.wait_for_selector("#console:not(.hide)")

    def test_old_or_new_page_with_either_email_still_in(self):
        """An old cached page after the change (or a new page before it): the
        page's emails and the server's disagree, and the person is still in."""
        for email, uid in ((h.ED_EMAIL, h.ED_UID), (h.OTHER_ED_EMAIL, h.ED_UID)):
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
        for email in (h.LEADER_EMAIL, h.OTHER_LEADER_EMAIL):
            with self.subTest(page="console", email=email):
                p = self.fresh(email, h.LEADER_UID)
                h.load_admin(p, self.base)
                p.wait_for_selector("#console:not(.hide)")

    def test_the_right_email_with_another_uid_gets_nothing(self):
        for email in (h.ED_EMAIL, h.OTHER_ED_EMAIL):
            with self.subTest(page="voter", email=email):
                p = self.fresh(email, "someone-else")
                p.goto(f"{self.base}/index.html")
                p.wait_for_selector("#edpw")
                self.assertIsNone(p.query_selector("#search"))
        for email in (h.LEADER_EMAIL, h.OTHER_LEADER_EMAIL):
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


AFTER = {h.ED_EMAIL: h.ED_UID, h.LEADER_EMAIL: h.LEADER_UID}       # the accounts since the move


class TestSignInAfterTheMove(Base):
    """Step 10: one try with the new email, whatever this device remembered
    from step 9. Only the account's own uid is accepted."""

    def gate(self, table, remembered=None):
        pg = self.page
        if remembered:
            pg.add_init_script("localStorage.setItem('mv_signin_email', '%s');" % remembered)
        pg.add_init_script("window.__accounts = %s;" % json.dumps(table))
        pg.goto(f"{self.base}/index.html")
        pg.wait_for_selector("#edpw")
        pg.fill("#edpw", "the-ed-password")
        pg.click("#edgo")
        return pg

    def test_voter_signs_in_with_the_new_email_only(self):
        for remembered in (None, "old", "new"):
            with self.subTest(remembered=remembered):
                p = self.browser.new_page()
                errs = []
                h.wire(p, errs)
                if remembered:
                    p.add_init_script("localStorage.setItem('mv_signin_email', '%s');" % remembered)
                p.add_init_script("window.__accounts = %s;" % json.dumps(AFTER))
                p.goto(f"{self.base}/index.html")
                p.wait_for_selector("#edpw")
                p.fill("#edpw", "the-ed-password")
                p.click("#edgo")
                p.wait_for_selector("#search, #app .tabs")
                self.assertEqual(p.evaluate("window.__signIns"), [h.ED_EMAIL])
                self.assertEqual(errs, [])
                p.close()

    def test_console_signs_in_with_the_new_email_only(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.evaluate("t => { window.__accounts = t; }", AFTER)
        pg.fill("#pass", "the-leadership-password")
        pg.click("#enter")
        pg.wait_for_selector("#console:not(.hide)")
        self.assertEqual(pg.evaluate("window.__signIns"), [h.LEADER_EMAIL])

    def test_wrong_password_says_so_once(self):
        pg = self.page
        pg.add_init_script("window.__authReject = true;")
        self.gate(AFTER)
        pg.wait_for_selector("#ederr:not(.hide)")
        self.assertIn("not the ED password", pg.inner_text("#ederr"))
        self.assertEqual(pg.evaluate("window.__signIns"), [h.ED_EMAIL])

    def test_another_account_under_the_new_email_is_never_accepted(self):
        pg = self.gate({h.ED_EMAIL: "a-strangers-uid"})
        pg.wait_for_selector("#ederr:not(.hide)")
        self.assertIn("not the ED password", pg.inner_text("#ederr"))
        self.assertIsNone(pg.evaluate("window.__auth.current()"))
        self.assertIsNone(pg.query_selector("#search"))


if __name__ == "__main__":
    unittest.main()
