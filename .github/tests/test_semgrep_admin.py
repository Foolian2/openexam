"""Run with python3 .github/tests/test_semgrep_admin.py (Semgrep on PATH).

Fixtures are materialized in a temporary tree so intentionally vulnerable code
never enters the application's TypeScript build or production security scan.
Set SEMGREP to use a specific executable, such as the CI-pinned version.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import NamedTuple

RULE = "openexam-admin-route-missing-role-check"


class Case(NamedTuple):
    path: str
    code: str
    expect_finding: bool


CASES = {
    "braced_redirect_guard": Case(
        "app/dashboard/admin/page.tsx",
        'export default async function Page() { if (session.user.role !== '
        '"ADMIN") { redirect("/unauthorized"); } return <h1>admin</h1> }',
        False,
    ),
    "checked_guard": Case(
        "app/api/admin/users/route.ts",
        'export async function PATCH(request: Request, context: unknown) { '
        'const auth = await requireAdmin(request); if (auth instanceof '
        'NextResponse) return auth; return new Response("ok") }',
        False,
    ),
    "default_export_require_admin": Case(
        "app/dashboard/admin/export/page.tsx",
        'export default async function Page(request: Request) { const auth = '
        'await requireAdmin(request); if (auth instanceof NextResponse) '
        'return auth; return new Response("ok") }',
        False,
    ),
    "const_arrow_checked_guard": Case(
        "app/api/admin/users/route.ts",
        'export const PATCH = async (request: Request) => { const auth = '
        'await requireAdmin(request); if (auth instanceof NextResponse) '
        'return auth; return new Response("ok") }',
        False,
    ),
    "const_arrow_discarded_guard": Case(
        "app/api/admin/users/route.ts",
        'export const PATCH = async (request: Request) => { '
        'await requireAdmin(request); return new Response("ok") }',
        True,
    ),
    "const_arrow_missing_guard": Case(
        "app/api/admin/users/route.ts",
        'export const PATCH = async (request: Request) => { '
        'return new Response("ok") }',
        True,
    ),
    "const_sync_arrow_missing_guard": Case(
        "app/api/admin/users/route.ts",
        'export const GET = (request: Request) => { '
        'return new Response("ok") }',
        True,
    ),
    "discarded_guard": Case(
        "app/api/admin/users/route.ts",
        'export async function PATCH(request: Request, context: unknown) '
        '{ await requireAdmin(request); return new Response("ok") }',
        True,
    ),
    "heading_only": Case(
        "app/dashboard/admin/page.tsx",
        'export default async function Page() { const heading = "ADMIN"; '
        'return <h1>{heading}</h1> }',
        True,
    ),
    "loading": Case(
        "app/dashboard/admin/loading.tsx",
        "export default function Loading() { return <h1>loading</h1> }",
        False,
    ),
    "logged_role": Case(
        "app/dashboard/admin/page.tsx",
        'export default async function Page() { if (session.user.role !== '
        '"ADMIN") console.log("unauthorized"); return <h1>admin</h1> }',
        True,
    ),
    "nested_missing_guard": Case(
        "packages/site/app/dashboard/admin/settings/page.tsx",
        "export default async function Page() { return "
        "<h1>admin</h1> }",
        True,
    ),
    "redirect_guard": Case(
        "app/dashboard/admin/page.tsx",
        'export default async function Page() { if (session.user.role !== '
        '"ADMIN") redirect("/unauthorized"); return <h1>admin</h1> }',
        False,
    ),
    "sync_missing_guard": Case(
        "app/dashboard/admin/page.tsx",
        "export default function Page() { return <h1>admin</h1> }",
        True,
    ),
    "sync_redirect_guard": Case(
        "app/dashboard/admin/page.tsx",
        'export default function Page() { if (session.user.role !== '
        '"ADMIN") redirect("/unauthorized"); return <h1>admin</h1> }',
        False,
    ),
}


def load_yaml(text):
    # The pinned semgrep/semgrep CI image ships ruamel.yaml (semgrep's own
    # dependency) but not PyYAML; local environments usually have PyYAML.
    # Both are used in safe mode — no custom tag construction.
    try:
        import yaml
    except ModuleNotFoundError:
        from ruamel.yaml import YAML

        return YAML(typ="safe").load(text)
    return yaml.safe_load(text)


def dump_yaml(data, path):
    try:
        import yaml
    except ModuleNotFoundError:
        from ruamel.yaml import YAML

        with open(path, "w") as handle:
            YAML(typ="safe").dump(data, handle)
        return
    path.write_text(yaml.safe_dump(data, sort_keys=False))


def main():
    repo = Path(__file__).resolve().parents[2]
    rules = load_yaml((repo / ".github/semgrep.yml").read_text())
    rule = next((r for r in rules["rules"] if r.get("id") == RULE), None)
    assert rule is not None, f"rule {RULE!r} missing from .github/semgrep.yml"
    with tempfile.TemporaryDirectory(prefix="semgrep-admin-") as directory:
        root = Path(directory)
        config = root / "rule.yml"
        dump_yaml({"rules": [rule]}, config)
        sources = root / "sources"
        for name, case in CASES.items():
            target = sources / name / case.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(case.code + "\n")
        result = subprocess.run(
            [os.environ.get("SEMGREP", "semgrep"), "scan", "--config", str(config),
             "--metrics", "off", "--disable-version-check", "--no-git-ignore",
             "--json", str(sources)],
            capture_output=True, text=True, check=True,
        )
        report = json.loads(result.stdout)
        assert not report.get("errors"), report.get("errors")
        found = {Path(item["path"]).relative_to(sources).parts[0]
                 for item in report["results"]}
        for name, case in CASES.items():
            assert (name in found) == case.expect_finding, (
                f"case {name!r}: expected finding={case.expect_finding}, "
                f"flagged cases: {sorted(found)}")
        print(f"Passed {len(CASES)} admin-rule regression cases")


if __name__ == "__main__":
    main()
