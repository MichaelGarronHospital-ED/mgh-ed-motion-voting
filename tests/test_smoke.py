"""Smoke checks for a deployed copy of the site.

Run against the LIVE site after a deploy, with Firebase routed to the stubs so
no real data is read or written:

    MV_BASE_URL=https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting \\
      ~/.venvs/mgh-ed-tools/bin/python -m unittest discover -s tests -p "test_smoke.py" -v

Without MV_BASE_URL they run against this folder, like every other test.
"""
import unittest

import harness as h
from base import Base


class TestSmoke(Base):
    def test_voter_page_reaches_the_ballot_and_votes(self):
        pg = self.voter()
        h.seed_poll(pg)
        h.pick_voter(pg, h.GROUP1[1])
        pg.click('button[data-c="favour"]')
        pg.wait_for_function("() => window.__store.get('polls/p1').voteCount === 1")

    def test_console_shows_the_password_screen_then_closes_a_motion(self):
        h.load_admin(self.page, self.base)
        self.assertTrue(self.page.is_visible("#pass"))
        h.unlock_admin(self.page)
        self.page.wait_for_selector("#console:not(.hide)")
        h.seed_poll(self.page)
        h.tab(self.page, "motions")
        self.page.click('#motion-list button[data-act="close"]')
        self.page.wait_for_function("() => window.__store.get('polls/p1').status === 'closed'")


if __name__ == "__main__":
    unittest.main(verbosity=2)
