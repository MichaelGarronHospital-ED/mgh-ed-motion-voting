"""The Leadership password can never be sent by the browser itself.

Before js/admin.js has taken over the sign-in form (slow network, or a mix of
old and new cached files after an update), the form's fields are disabled and
it posts nowhere, so the password never lands in the address bar, the history
or server logs. The voter page and the meeting screen build their password
forms in JavaScript, with the handler attached at once.
"""
import unittest

import harness as h
from base import Base


class TestGateSafety(Base):
    allowed_errors = ("Failed to load resource", "net::ERR_FAILED")

    def test_console_form_is_disabled_until_its_code_runs(self):
        pg = self.page
        pg.route("**/js/admin.js", lambda r: r.abort())      # the code never arrives
        pg.goto(f"{self.base}/admin-9f4k2x7q.html")
        pg.wait_for_selector("#gate-form")
        self.assertTrue(pg.is_disabled("#pass"))
        self.assertTrue(pg.is_disabled("#enter"))
        self.assertEqual(pg.get_attribute("#gate-form", "method"), "post")
        pg.evaluate("document.querySelector('#pass').value = 'secret'; document.querySelector('#enter').click();")
        pg.wait_for_timeout(300)
        self.assertNotIn("password", pg.url)
        self.assertNotIn("secret", pg.url)

    def test_console_form_works_once_the_code_runs(self):
        pg = self.page
        h.load_admin(pg, self.base)
        pg.wait_for_function("() => !document.querySelector('#gate-fields').disabled")
        pg.fill("#pass", "a-password")
        pg.click("#enter")
        pg.wait_for_selector("#console:not(.hide)")
        self.assertNotIn("password", pg.url)
        self.assertEqual(pg.input_value("#gate-form input[autocomplete=username]"), "Leadership password")

    def test_voter_password_form_is_built_by_its_code(self):
        html = (h.REPO / "index.html").read_text()
        self.assertNotIn("<form", html)
        self.assertNotIn('type="password"', html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
