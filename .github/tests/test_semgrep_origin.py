"""Run with python3 .github/tests/test_semgrep_origin.py (Semgrep on PATH).

Fixtures are materialized in a temporary tree so intentionally vulnerable code
never enters the application's TypeScript build or production security scan.
Set SEMGREP to use a specific executable, such as the CI-pinned version.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

RULE = "openexam-mutation-missing-origin-check"
# The rule matches on a handler's shape, not on where it lives, so every
# fixture uses one path inside its own case directory.
FIXTURE_PATH = "app/api/example/route.ts"
# Case name -> (handler source, whether the rule must flag it).
CASES = {
    "assigned_header": (
        "export async function POST(request: Request) { const origin = "
        'request.headers.get("origin"); await mutate() }',
        True,
    ),
    "checked_guard": (
        "export async function POST(request: Request) { const error = "
        "verifyOrigin(request); if (error) return error; await mutate() }",
        False,
    ),
    "discarded_guard": (
        "export async function POST(request: Request) { "
        "verifyOrigin(request); await mutate() }",
        True,
    ),
    "logged_header": (
        "export async function POST(request: Request) { "
        'console.log(request.headers.get("origin")); await mutate() }',
        True,
    ),
    "missing": (
        "export async function POST(request: Request) { await mutate() }",
        True,
    ),
}


def main():
    repo = Path(__file__).resolve().parents[2]
    rules = (repo / ".github/semgrep.yml").read_text()
    blocks = re.split(r"(?=^  - id: )", rules, flags=re.MULTILINE)
    block = next(
        (candidate for candidate in blocks
         if candidate.startswith(f"  - id: {RULE}\n")),
        None,
    )
    assert block is not None, f"rule {RULE} missing from .github/semgrep.yml"
    with tempfile.TemporaryDirectory(prefix="semgrep-origin-") as directory:
        root = Path(directory)
        config = root / "rule.yml"
        config.write_text("rules:\n" + block)
        sources = root / "sources"
        for name, (code, _) in CASES.items():
            target = sources / name / FIXTURE_PATH
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(code + "\n")
        result = subprocess.run(
            [os.environ.get("SEMGREP", "semgrep"), "scan", "--config", str(config),
             "--metrics", "off", "--disable-version-check", "--no-git-ignore",
             "--json", str(sources)],
            capture_output=True, text=True, check=True,
        )
        report = json.loads(result.stdout)
        assert not report.get("errors"), report.get("errors")
        flagged = {Path(item["path"]).relative_to(sources).parts[0]
                   for item in report["results"]}
        for name, (_, expected) in CASES.items():
            assert (name in flagged) == expected, (name, expected, flagged)
        print(f"Passed {len(CASES)} origin-rule regression cases")


if __name__ == "__main__":
    main()
