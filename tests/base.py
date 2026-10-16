"""Shared test base: one browser for a test class, a fresh page (and store) per test.

A console error on the page is a failure even when the assertions pass.
"""
import unittest

from playwright.sync_api import sync_playwright

import harness as h

FIRESTORE = "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"


class Base(unittest.TestCase):
    allowed_errors = ()   # substrings of console errors a test expects

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
        errors = [e for e in self.errors if not any(a in e for a in self.allowed_errors)]
        self.assertEqual(errors, [], f"page errors: {errors}")
        self.page.close()

    def voter(self):
        h.open_voter(self.page, self.base)
        return self.page

    def admin(self):
        h.open_admin(self.page, self.base)
        return self.page

    def fs(self, body, arg=None):
        """Run `body` (an async JS function body) with the Firestore stub module as `fs`."""
        # Built as one function string: the page's CSP blocks eval inside it.
        return self.page.evaluate(
            "async (arg) => { const fs = await import('%s');\n%s\n}" % (FIRESTORE, body), arg)
