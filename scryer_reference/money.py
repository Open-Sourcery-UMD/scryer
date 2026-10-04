"""Exact USD-cent parsing and checked signed 64-bit arithmetic."""

import re

MIN_MINOR = -(1 << 63)
MAX_MINOR = (1 << 63) - 1

_CANONICAL_MINOR = re.compile(r"(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z")
_US_DECIMAL = re.compile(
    r"(?P<whole>(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+))"
    r"(?:\.(?P<fraction>[0-9]+))?\Z"
)


class MoneyError(ValueError):
    """A stable money validation error without the untrusted input value."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _checked(value: int) -> int:
    if type(value) is not int:
        raise MoneyError("INVALID_MONEY")
    if value < MIN_MINOR or value > MAX_MINOR:
        raise MoneyError("MONEY_OVERFLOW")
    return value


def parse_minor_units(text: str) -> int:
    """Parse a canonical JSON-boundary minor-unit string."""

    if not isinstance(text, str) or not _CANONICAL_MINOR.fullmatch(text):
        raise MoneyError("INVALID_MONEY")
    if len(text) > 20:
        raise MoneyError("MONEY_OVERFLOW")
    return _checked(int(text))


def parse_us_decimal(text: str) -> int:
    """Parse explicit US-style source decimal text without a float conversion."""

    if not isinstance(text, str) or len(text) > 64 or not text:
        raise MoneyError("INVALID_MONEY")

    negative = False
    value = text
    if value.startswith("(") and value.endswith(")"):
        negative = True
        value = value[1:-1]
    elif value.startswith("-"):
        negative = True
        value = value[1:]
        if value.startswith("$"):
            raise MoneyError("INVALID_MONEY")

    if value.startswith("$"):
        value = value[1:]
    match = _US_DECIMAL.fullmatch(value)
    if match is None:
        raise MoneyError("INVALID_MONEY")

    fraction = match.group("fraction") or ""
    if len(fraction) > 2:
        raise MoneyError("UNSUPPORTED_PRECISION")

    whole = int(match.group("whole").replace(",", ""))
    cents = whole * 100 + int(fraction.ljust(2, "0") or "0")
    return _checked(-cents if negative else cents)


def checked_add(left: int, right: int) -> int:
    """Add two valid minor-unit values, raising on overflow."""

    return _checked(_checked(left) + _checked(right))


def checked_negate(value: int) -> int:
    """Negate a valid minor-unit value, raising on minimum-int overflow."""

    return _checked(-_checked(value))
