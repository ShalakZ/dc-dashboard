"""CSV output that Excel opens cleanly and that cannot run as a formula (spec 10.6)."""
import csv
import io
import math
from collections.abc import Iterable, Sequence
from datetime import date, datetime
from decimal import Decimal

FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")


def _number(value: int | float | Decimal) -> str:
    if isinstance(value, int):
        return str(value)
    number = float(value)
    if not math.isfinite(number):
        return ""
    text = f"{round(number, 6):.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def safe_cell(value: object) -> str:
    """One CSV cell as text.

    Text starting with = + - @ tab or CR gets a leading apostrophe, so a spreadsheet shows it instead of
    running it (asset names are typed by users). Typed numbers are never prefixed: -5.5 is a number, not
    text, and cannot carry a formula (the string "-5" is text and is prefixed). Numbers keep at most 6
    decimals; None, NaN and infinity are empty; booleans are true/false; datetimes and dates are ISO 8601
    (callers pass datetimes already converted to the site zone, so the offset is the site's).
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, Decimal)):
        return _number(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    text = str(value)
    return "'" + text if text.startswith(FORMULA_STARTS) else text


def write_csv(header: Sequence[str], rows: Iterable[Sequence[object]]) -> bytes:
    """UTF-8 with a byte-order mark (so Excel opens it cleanly) and CRLF row ends; every cell, header
    included, goes through safe_cell."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([safe_cell(cell) for cell in header])
    for row in rows:
        writer.writerow([safe_cell(cell) for cell in row])
    return buffer.getvalue().encode("utf-8-sig")
