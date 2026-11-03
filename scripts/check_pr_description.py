#!/usr/bin/env python3
"""Validate review evidence without evaluating or echoing untrusted PR text."""

import argparse
import json
from pathlib import Path
import re
import sys

REQUIRED_SECTIONS = ("summary", "user impact", "validation", "risks and recovery")


def validate_description(body: str) -> list[str]:
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    headings = list(re.finditer(r"^##[ \t]+([^\n]+?)[ \t]*$", body, flags=re.MULTILINE))
    sections: dict[str, list[str]] = {}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(body)
        sections.setdefault(heading[1].strip().lower(), []).append(body[heading.end():end].strip())
    errors = []
    for name in REQUIRED_SECTIONS:
        content = sections.get(name, [])
        if len(content) != 1:
            errors.append(f"Exactly one '## {name.title()}' section is required.")
            continue
        meaningful = re.sub(r"^[ \t]*[-*][ \t]*(?:\[[ xX]\][ \t]*)?", "", content[0], flags=re.MULTILINE)
        if not meaningful.strip() or re.fullmatch(r"(?is)\s*(todo|tbd|n/?a|none|passed|describe[^\n]*)[.!]?\s*", meaningful):
            errors.append(f"The '{name.title()}' section needs concrete review evidence.")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--event", type=Path, help="GitHub event JSON path")
    source.add_argument("--body", type=Path, help="Local UTF-8 PR description file")
    args = parser.parse_args()
    try:
        if args.event:
            event = json.loads(args.event.read_text())
            body = event["pull_request"]["body"] or ""
        else:
            body = args.body.read_text()
        if not isinstance(body, str):
            raise ValueError("Expected a string description")
    except (OSError, KeyError, TypeError, ValueError):
        print("Could not read a valid PR description; no input content was printed.", file=sys.stderr)
        return 2
    errors = validate_description(body)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("PR description contains the required review evidence.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
