"""Test harness for the Motion Voting tool.

Serves the repo over localhost and swaps the Firebase CDN modules for the
in-memory stubs in `stubs/`, so the real app code in `js/` runs unmodified
against a fake Firestore. No Firebase project, no credentials, no network.

Why localhost rather than file://  — the app uses crypto.subtle (the admin
passcode hash), which only exists in a secure context; 127.0.0.1 counts as one.
"""
import contextlib
import functools
import http.server
import pathlib
import re
import socketserver
import threading

HERE = pathlib.Path(__file__).parent
TOOL = HERE.parent
REPO = TOOL.parent.parent
STUBS = HERE / "stubs"

# Must match LEADER_EMAIL in js/config.js.
LEADER_EMAIL = "leadership@ed-motion-voting.app"


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


@contextlib.contextmanager
def serve():
    """Serve the repo root on an ephemeral localhost port."""
    handler = functools.partial(_Quiet, directory=str(REPO))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            yield f"http://127.0.0.1:{httpd.server_address[1]}"
        finally:
            httpd.shutdown()


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
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))


def open_voter(page, base):
    page.goto(f"{base}/tools/motion-voting/index.html")
    page.wait_for_function("() => window.__store !== undefined")
    page.wait_for_selector("#app .card")


def load_admin(page, base):
    """Load the admin page but leave it locked, so the store can be seeded
    before the console boots and subscribes."""
    page.goto(f"{base}/tools/motion-voting/admin-9f4k2x7q.html")
    page.wait_for_function("() => window.__auth !== undefined")


def unlock_admin(page, read=None, then=None):
    """Unlock the console and, in the SAME tick, read a selector's text (or run
    `then`) — i.e. observe the very first paint, before any snapshot arrives.

    The passcode gate is bypassed via the auth watcher rather than by typing a
    code: the plaintext passcode is deliberately not in the repo (config.js
    stores only its hash), and these tests are about behaviour, not the gate.
    """
    body = then or (f"return document.querySelector('{read}').innerText;"
                    if read else "return null;")
    return page.evaluate(
        "() => { window.__auth.force({ uid: 'leader-uid', email: '%s' });"
        " %s }" % (LEADER_EMAIL, body))


def open_admin(page, base):
    """Load and unlock the leadership console, settled and ready to drive."""
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


def store(page):
    return page.evaluate("window.__store.dump()")


def get(page, path):
    return page.evaluate("p => window.__store.get(p)", path)


def pick_voter(page, name):
    """Choose a name in the voter picker."""
    page.fill("#search", name.split()[0])
    page.click(f'#namelist li[data-slug="{slugify(name)}"]')


OUTCOMES = ("PASSED ✅", "DID NOT PASS ❌", "PASSES ✅", "DOES NOT PASS ❌",
            "NO QUORUM", "NO QUORUM — cannot pass", "TIE 🤝")


def outcomes(text):
    """The verdict lines present in a rendered results view."""
    return [l.strip() for l in text.split("\n") if l.strip() in OUTCOMES]


def fmt(n):
    """Mirror of fmt() in js/util.js — whole numbers bare, else one decimal."""
    return str(int(n)) if float(n).is_integer() else f"{n:.1f}"
