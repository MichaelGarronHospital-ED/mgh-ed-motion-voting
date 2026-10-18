"""Test harness for the Motion Voting tool.

Serves the repo over localhost and swaps the Firebase CDN modules for the
in-memory stubs in `stubs/`, so the real app code in `js/` runs unmodified
against a fake Firestore. No Firebase project, no credentials, no network.

Why localhost rather than file://: ES modules and the stubbed CDN imports need
a real http origin; 127.0.0.1 is one.
"""
import contextlib
import functools
import http.server
import os
import pathlib
import re
import socketserver
import threading

HERE = pathlib.Path(__file__).parent
TOOL = HERE.parent
REPO = TOOL
STUBS = HERE / "stubs"

# The two shared accounts. The pages recognise them by uid (js/config.js
# LEADER_UID, ED_UID, the same as firestore.rules; test_accounts.py checks all
# copies agree). The emails are only what the page signs in with.
LEADER_UID = "3eigCLaK0RQ5PmVhxfDgI0qoYzQ2"
ED_UID = "CXyo7yciWpc78J1TQYRzrPpu77C3"
LEADER_EMAIL = "leadership@mgh-ed-voting.invalid"   # must match LEADER_EMAIL_NEW in js/config.js
ED_EMAIL = "ed@mgh-ed-voting.invalid"               # must match ED_EMAIL_NEW in js/config.js
# Some other email on the right account (as after any email change): the pages
# and the rules go by uid, so the person stays in.
OTHER_LEADER_EMAIL = "leadership@another-address.invalid"
OTHER_ED_EMAIL = "ed@another-address.invalid"


def uid_for(email):
    return LEADER_UID if email and email.startswith("leadership") else ED_UID


def auth_init(email, uid=None):
    """Init script: the page starts already signed in (another tab, or a reload)."""
    return ("window.__authInitial = { uid: '%s', isAnonymous: false, email: '%s' };"
            % (uid or uid_for(email), email))


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    # A page loads many module files at once; one thread per request so none
    # is dropped.
    daemon_threads = True
    request_queue_size = 64


# Set MV_BASE_URL to run the tests against another copy of the site, for
# example the LIVE one after a deploy:
#   MV_BASE_URL=https://michaelgarronhospital-ed.github.io/mgh-ed-motion-voting
# Firebase is still routed to the stubs (see wire), so no real data is touched.
BASE_URL = os.environ.get("MV_BASE_URL", "").rstrip("/")


@contextlib.contextmanager
def serve():
    """Serve the repo root on an ephemeral localhost port (or use MV_BASE_URL)."""
    if BASE_URL:
        yield BASE_URL
        return
    handler = functools.partial(_Quiet, directory=str(REPO))
    with _Server(("127.0.0.1", 0), handler) as httpd:
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            yield f"http://127.0.0.1:{httpd.server_address[1]}"
        finally:
            httpd.shutdown()


def version():
    """The site version (js/version.js); every module URL carries ?v=<it>."""
    return re.search(r'export const VERSION = "([^"]+)";', (REPO / "js/version.js").read_text()).group(1)


def wire(page, errors):
    """Route the Firebase CDN to the stubs; collect console/page errors.

    Anything under gstatic that is NOT stubbed is aborted rather than fetched,
    so a new Firebase import shows up as a test failure instead of silently
    reaching the network.
    """
    def route(r):
        name = r.request.url.rsplit("/", 1)[-1]
        stub = STUBS / name
        if stub.is_file():
            r.fulfill(status=200, content_type="application/javascript",
                      body=stub.read_text())
        else:
            errors.append(f"unstubbed firebase import: {name}")
            r.abort()

    page.route("https://www.gstatic.com/firebasejs/**", route)
    # Tests import page modules with the same ?v= as the page, so they share its
    # module instances (a different URL is a separate copy with its own state).
    page.add_init_script("window.__V = '%s';" % version())
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))


def open_voter(page, base):
    """Load the voter page and get past the ED-password screen (the stub accepts
    any non-empty password; the real check is Firebase's, enforced by the rules)."""
    page.goto(f"{base}/index.html")
    page.wait_for_function("() => window.__store !== undefined")
    page.wait_for_selector("#app .card")
    if page.query_selector("#edpw"):
        page.fill("#edpw", "test-ed-password")
        page.click("#edgo")
        page.wait_for_selector("#search, #app .tabs")


def open_screen(page, base):
    """Load the projector screen (meeting screen)."""
    page.goto(f"{base}/screen.html")
    page.wait_for_function("() => window.__store !== undefined")


def load_admin(page, base):
    """Load the admin page but leave it locked, so the store can be seeded
    before the console boots and subscribes."""
    page.goto(f"{base}/admin-9f4k2x7q.html")
    page.wait_for_function("() => window.__auth !== undefined")


def unlock_admin(page, read=None, then=None):
    """Unlock the console and, in the SAME tick, read a selector's text (or run
    `then`), i.e. observe the very first paint, before any snapshot arrives.

    The Admin password screen is bypassed via the auth watcher rather than
    by typing a password: the password is not in the repo (it lives only in
    Firebase Auth), and these tests are about behaviour, not the gate.
    """
    body = then or (f"return document.querySelector('{read}').innerText;"
                    if read else "return null;")
    return page.evaluate(
        "() => { window.__auth.force({ uid: '%s', isAnonymous: false, email: '%s' });"
        " %s }" % (LEADER_UID, LEADER_EMAIL, body))


def open_admin(page, base):
    """Load and unlock the Admin console, settled and ready to drive."""
    load_admin(page, base)
    unlock_admin(page)
    page.wait_for_selector("#console:not(.hide)")


def tab(page, name):
    page.click(f'.tab[data-tab="{name}"]')
    page.wait_for_timeout(50)


# ---- roster helpers --------------------------------------------------------
# Read straight from js/roster.js so the tests can never drift from the roster
# the app actually ships.

def _names(group):
    src = (TOOL / "js" / "roster.js").read_text()
    body = re.search(group + r"\s*=\s*\[(.*?)\]", src, re.S).group(1)
    return re.findall(r'"([^"]+)"', body)


def slugify(name):
    """Mirror of slugify() in js/roster.js."""
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", name.strip().lower()))


GROUP1 = _names("GROUP1")
GROUP2 = _names("GROUP2")
COURTESY = _names("COURTESY")
ELIGIBLE = len(GROUP1) + len(GROUP2)
QUORUM = -(-ELIGIBLE // 2)          # ceil(eligible / 2)


# ---- seeding --------------------------------------------------------------
# Each browser page owns its own in-memory store, so cross-page state is seeded
# directly rather than driven through a second page.

def seed_poll(page, pid="p1", text="Test motion", status="open",
              vote_count=0, archived=False, deleted=False, order=0):
    page.evaluate(
        "([p, d]) => window.__store.set('polls/' + p, d)",
        [pid, {"text": text, "order": order, "status": status,
               "voteCount": vote_count, "archived": archived, "deleted": deleted}],
    )


def seed_ballots(page, pid, names, choice="favour", group="1", weight=1):
    rows = [{"name": n, "slug": slugify(n), "choice": choice, "group": group,
             "weight": weight, "flagged": False, "submissionCount": 1}
            for n in names]
    page.evaluate(
        "([p, rows]) => rows.forEach(r => window.__store.set('polls/' + p + '/votes/' + r.slug, r))",
        [pid, rows],
    )


def seed(page, path, data):
    """Write one document straight into the stub's server copy."""
    page.evaluate("([p, d]) => window.__store.set(p, d)", [path, data])


def ts(ms):
    """A stored server time as the stub makes them (milliseconds since 1970)."""
    ms = int(ms)
    return {"__ts": ms, "seconds": ms // 1000, "nanoseconds": (ms % 1000) * 1000000}


def seed_roster(page, groups=None, added=None, removed=None, **extra):
    data = {"groups": groups or {}, "added": added or {}, "removed": removed or {}}
    data.update(extra)
    seed(page, "config/roster", data)


def reads(page, prefix=""):
    """Documents the page has read so far under a path (snapshots and reads)."""
    return page.evaluate("p => window.__store.reads(p)", prefix)


def writes(page, prefix=""):
    """Documents the page has written so far under a path."""
    return page.evaluate("p => window.__store.writes(p)", prefix)


def build_board(page):
    """Write config/live and config/history as the console builds them (the
    voter page and the projector read only these, never the motions)."""
    page.evaluate("""async () => {
        const b = await import('./js/board.js?v=' + window.__V);
        const st = window.__store.dump();
        const list = (re) => Object.entries(st).filter(([k]) => re.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
        const polls = list(/^polls[/][^/]+$/), ms = list(/^meetings[/][^/]+$/);
        const bd = b.buildBoard(polls, ms);
        window.__store.set('config/live', bd);
        window.__store.set('config/history', b.buildHistory(polls, ms, bd));
    }""")


def store(page):
    return page.evaluate("window.__store.dump()")


def get(page, path):
    return page.evaluate("p => window.__store.get(p)", path)


def pick_voter(page, name):
    """Choose a name in the voter picker."""
    page.fill("#search", name.split()[0])
    page.click(f'#namelist li[data-slug="{slugify(name)}"]')


# Every verdict line either results view can show (voter: past tense; leadership:
# present tense). Icons are SVG, so the visible line is the words alone.
OUTCOMES = ("Passed", "Did not pass", "Passes", "Does not pass",
            "No quorum", "No quorum: cannot pass", "Tie")


def outcomes(text):
    """The verdict lines present in a rendered results view."""
    return [l.strip() for l in text.split("\n") if l.strip() in OUTCOMES]


def fmt(n):
    """Mirror of fmt() in js/util.js: whole numbers bare, else one decimal."""
    return str(int(n)) if float(n).is_integer() else f"{n:.1f}"
