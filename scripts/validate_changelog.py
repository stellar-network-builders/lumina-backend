#!/usr/bin/env python3
"""Validate the repository changelog's required Keep a Changelog structure."""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path


REQUIRED_UNRELEASED_SECTIONS = (
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
)
VERSION_HEADING = re.compile(
    r"^## \[(?P<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - "
    r"(?P<date>\d{4}-\d{2}-\d{2})$",
    re.MULTILINE,
)
ISSUE_OR_PR_LINK = re.compile(
    r"\(https://github\.com/[^/\s]+/[^/\s]+/(?:issues|pull)/\d+\)"
)


def validate_changelog(path: Path) -> list[str]:
    """Return human-readable validation errors for *path*."""
    if not path.is_file():
        return [f"{path} does not exist"]

    text = path.read_text(encoding="utf-8-sig")
    errors: list[str] = []

    if not text.startswith("# Changelog\n"):
        errors.append("the file must start with '# Changelog'")

    unreleased_heading = "## [Unreleased]"
    unreleased_index = text.find(unreleased_heading)
    version_matches = list(VERSION_HEADING.finditer(text))

    if unreleased_index < 0:
        errors.append("missing '## [Unreleased]' heading")
    elif version_matches and unreleased_index > version_matches[0].start():
        errors.append("the Unreleased section must appear before released versions")

    if not version_matches:
        errors.append("missing a version heading in '## [x.y.z] - YYYY-MM-DD' format")
    else:
        for match in version_matches:
            try:
                date.fromisoformat(match.group("date"))
            except ValueError:
                errors.append(
                    f"version {match.group('version')} has invalid date "
                    f"{match.group('date')}"
                )

    if unreleased_index >= 0:
        first_version_index = version_matches[0].start() if version_matches else len(text)
        unreleased_body = text[unreleased_index:first_version_index]
        for section in REQUIRED_UNRELEASED_SECTIONS:
            if f"### {section}" not in unreleased_body:
                errors.append(f"Unreleased section is missing '### {section}'")

    if not ISSUE_OR_PR_LINK.search(text):
        errors.append("at least one entry must link to a GitHub issue or pull request")

    if "[Unreleased]:" not in text:
        errors.append("missing the '[Unreleased]:' comparison link")

    for match in version_matches:
        version = match.group("version")
        if f"[{version}]:" not in text:
            errors.append(f"missing link definition for version [{version}]")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=Path("CHANGELOG.md"),
        help="changelog to validate (default: CHANGELOG.md)",
    )
    args = parser.parse_args()
    errors = validate_changelog(args.path)

    if errors:
        for error in errors:
            print(f"changelog error: {error}", file=sys.stderr)
        return 1

    print(f"{args.path} is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
