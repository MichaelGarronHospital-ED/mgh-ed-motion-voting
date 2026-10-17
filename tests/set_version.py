"""Set the site version everywhere in one go (dev tool, never shipped).

    python3 tests/set_version.py voting-10
    python3 tests/set_version.py --snapshot      # once per release, before changing js/
    python3 tests/set_version.py --snapshot voting-step-9   # the release before, if not live yet

Writes version.txt and js/version.js, and puts ?v=<version> on every relative
module import in js/ and on each page's script and stylesheet tags. A browser
then loads a whole new set of files or a whole old set, never a mix (a cached
old module next to a new one can stop a page loading). test_versions.py checks.

--snapshot records, from what is live (origin/main), every name each page module
imports from each other module, in tests/previous-imports.json. test_versions.py
then checks this release still exports all of them, so a page whose files are a
mix of the live release and this one still loads (removing an export is safe
only one release after the last module that used it is gone).
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ("index.html", "screen.html", "admin-9f4k2x7q.html")


def main(version):
    if not re.fullmatch(r"voting-\d+", version):
        sys.exit("version must look like voting-10")
    (ROOT / "version.txt").write_text(version + "\n")
    vjs = ROOT / "js/version.js"
    vjs.write_text(re.sub(r'export const VERSION = "[^"]*";', f'export const VERSION = "{version}";', vjs.read_text(), count=1))
    spec = re.compile(r'''((?:from|import)\s*\(?\s*["'])(\./[a-z0-9-]+\.js)(?:\?v=[^"']*)?(["'])''')
    for f in sorted((ROOT / "js").glob("*.js")):
        f.write_text(spec.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", f.read_text()))
    tag = re.compile(r'''((?:src|href)=")((?:js/[a-z0-9-]+\.js)|(?:css/[a-z0-9-]+\.css))(?:\?v=[^"]*)?(")''')
    for p in PAGES:
        f = ROOT / p
        f.write_text(tag.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", f.read_text()))
    print("version set to", version)


def snapshot(ref="origin/main"):
    git = lambda *a: subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True, check=True).stdout
    need = {}
    for f in git("ls-tree", "--name-only", ref, "js/").split():
        src = git("show", f"{ref}:{f}")
        for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*["\']\./([a-z0-9-]+\.js)(?:\?v=[^"\']*)?["\']', src):
            names = [n.strip().split(" as ")[0] for n in m.group(1).split(",") if n.strip()]
            need.setdefault(m.group(2), set()).update(names)
    out = {"from": git("show", f"{ref}:version.txt").strip(), "imports": {k: sorted(v) for k, v in sorted(need.items())}}
    (ROOT / "tests/previous-imports.json").write_text(json.dumps(out, indent=1) + "\n")
    print("recorded the imports of", out["from"])


if __name__ == "__main__":
    if sys.argv[1:2] == ["--snapshot"]:
        snapshot(*sys.argv[2:3])       # optional: another ref than origin/main
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else "")
