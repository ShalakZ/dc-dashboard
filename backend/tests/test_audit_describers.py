"""Parity: every audit action the backend writes has a description in the frontend's table (lib/auditText.ts).

The actions are collected from the source by AST, so a new `audit(db, user, "thing.happened", ...)` call fails this test
until the frontend table gets a `"thing.happened"` entry (otherwise the audit screen would show only a humanised code).
One direction only: a table key the backend never writes is allowed.
"""
import ast
import re
from pathlib import Path

BACKEND_PACKAGE = Path(__file__).resolve().parents[1] / "dcdash"
AUDIT_TEXT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "auditText.ts"
SECURITY_EVENTS = BACKEND_PACKAGE / "api" / "security_events.py"

AUDIT_FUNCTIONS = {"audit", "audit_change", "audit_pool"}  # audit(db, user_id, action, ...): the action is argument 3
ACTION_SHAPE = re.compile(r"^[a-z_]+\.[a-z_]+$")


def _call_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    return func.attr if isinstance(func, ast.Attribute) else None


def written_actions() -> set[str]:
    actions: set[str] = set()
    for path in BACKEND_PACKAGE.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and _call_name(node) in AUDIT_FUNCTIONS and len(node.args) >= 3:
                action = node.args[2]
                if isinstance(action, ast.Constant) and isinstance(action.value, str):
                    actions.add(action.value)
    # The sign-in events choose the action in a variable, so their strings are read as a whole.
    for node in ast.walk(ast.parse(SECURITY_EVENTS.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and ACTION_SHAPE.match(node.value):
            actions.add(node.value)
    return actions


def described_actions(source: str) -> set[str]:
    """The actions that are a quoted key in the table: "asset.created": ..."""
    return set(re.findall(r"""["']([a-z_]+\.[a-z_]+)["']\s*:""", source))


def test_the_collector_finds_the_actions_the_backend_writes():
    actions = written_actions()
    assert "login.locked" in actions  # chosen in a variable: found through security_events.py
    assert "storage.changed" in actions  # audit_change
    assert "scan.finished" in actions  # audit_pool
    assert "asset.created" in actions  # audit
    assert len(actions) >= 36, f"the collector found only {len(actions)} actions: {sorted(actions)}"


def test_every_action_the_backend_writes_has_a_description_in_the_frontend():
    described = described_actions(AUDIT_TEXT.read_text(encoding="utf-8"))
    missing = sorted(written_actions() - described)
    assert not missing, (
        f"{len(missing)} audit action(s) have no entry in frontend/src/lib/auditText.ts (add a quoted key for each): "
        + ", ".join(missing)
    )


def test_the_matcher_reads_a_quoted_key_and_nothing_else():
    source = '"asset.created": made(), \'asset.updated\': x, // "asset.deleted" in a comment\nfoo("user.created")'
    assert described_actions(source) == {"asset.created", "asset.updated"}
