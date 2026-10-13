"""The permission list lives on the server (dcdash.core.permissions) and in the front end (src/lib/permissions.ts).
This test fails when the ids, their order or the labels drift apart."""

import re
from pathlib import Path

from dcdash.core.permissions import CATALOGUE

PERMISSIONS_TS = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "permissions.ts").read_text(encoding="utf-8")


def ids() -> list[str]:
    match = re.search(r"export const PERMISSIONS = \[(.*?)\n\] as const;", PERMISSIONS_TS, re.S)
    assert match, "PERMISSIONS array not found in permissions.ts"
    return re.findall(r'"([^"]+)"', match.group(1))


def labels() -> dict[str, str]:
    match = re.search(r"export const PERMISSION_LABELS: Record<PermissionId, string> = \{(.*?)\n\};", PERMISSIONS_TS, re.S)
    assert match, "PERMISSION_LABELS not found in permissions.ts"
    return dict(re.findall(r'^  "([^"]+)": "(.*)",$', match.group(1), re.M))


def test_the_ids_and_their_order_match():
    assert ids() == [p.id for p in CATALOGUE]


def test_every_label_matches():
    assert labels() == {p.id: p.label for p in CATALOGUE}
