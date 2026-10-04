import base64, json, pathlib, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
ROOT = pathlib.Path(__file__).resolve().parents[1]
ALLOWED = {"SlopLobster.html", "SlopLobster-companion.py", "README.md", "scripts/build.mjs", "scripts/verify-html.mjs", "scripts/feature-work.py", ".gitignore"}
def target(name):
    path = (ROOT / name).resolve()
    if not path.is_relative_to(ROOT) or (name not in ALLOWED and not name.startswith(("src/", "tests/"))):
        raise ValueError("Edit outside feature source paths rejected")
    return path
if sys.argv[1] == "apply":
    for change in (json.loads(base64.b64decode(sys.argv[2])) if len(sys.argv)>2 else json.load(sys.stdin)):
        path = target(change["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        if "append" in change: text = path.read_text(encoding="utf-8") + change["append"]
        elif "content" in change: text = change["content"]
        else:
            text = path.read_text(encoding="utf-8")
            for replacement in change["replace"]:
                old, new = replacement["old"], replacement["new"]
                if old not in text: raise ValueError("Missing anchor: " + old[:100])
                text = text.replace(old, new, replacement.get("count", 1))
        path.write_bytes(text.encode("utf-8"))
        print("Updated", change["path"])
elif sys.argv[1] == "inspect":
    for request in (json.loads(base64.b64decode(sys.argv[2])) if len(sys.argv)>2 else json.load(sys.stdin)):
        lines = target(request["path"]).read_text(encoding="utf-8").splitlines()
        print("FILE", request["path"])
        ranges = request.get("ranges", [])
        if request.get("find"):
            for index, line in enumerate(lines):
                if request["find"] in line: ranges.append([max(1,index-3), index+12])
        for lo, hi in ranges:
            for index in range(lo - 1, min(hi, len(lines))): print(str(index+1) + ": " + lines[index])
elif sys.argv[1] == "check":
    commands = [["node", "scripts/build.mjs"], ["node", "scripts/verify-html.mjs"], ["node", "scripts/build.mjs", "--check"], ["node", "--test", "tests/harness.test.cjs", "tests/features.test.cjs", "tests/conversations.test.cjs"], [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test*.py", "-v"]]
    for command in commands:
        result = subprocess.run(command, cwd=ROOT)
        if result.returncode: sys.exit(result.returncode)
elif sys.argv[1] == "browser":
    sys.exit(subprocess.run(["node", "tests/browser-smoke.mjs"], cwd=ROOT).returncode)
elif sys.argv[1] == "review":
    for command in (["node", "tests/review-repro.cjs"], [sys.executable, "tests/review_repro.py"]):
        result = subprocess.run(command, cwd=ROOT)
        if result.returncode: sys.exit(result.returncode)
elif sys.argv[1] == "audit":
    for command in (["git", "status", "--short"], ["git", "diff", "--stat"], ["git", "-c", "core.whitespace=cr-at-eol", "diff", "--check"]):
        result = subprocess.run(command, cwd=ROOT)
        if result.returncode: sys.exit(result.returncode)
else: raise ValueError("Unknown operation")
