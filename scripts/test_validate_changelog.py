from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


VALIDATOR = Path(__file__).with_name("validate_changelog.py")
VALID_CHANGELOG = """# Changelog

## [Unreleased]

### Added
- Added a check ([#1](https://github.com/example/project/pull/1)).
### Changed
- _No changes yet._
### Deprecated
- _Nothing deprecated._
### Removed
- _Nothing removed._
### Fixed
- _No fixes yet._
### Security
- _No security changes yet._

## [1.0.0] - 2026-06-06
### Added
- Initial release.

[Unreleased]: https://github.com/example/project/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/example/project/releases/tag/v1.0.0
"""


class ChangelogValidatorTest(unittest.TestCase):
    def run_validator(self, content: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            changelog = Path(directory, "CHANGELOG.md")
            changelog.write_text(content, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(VALIDATOR), str(changelog)],
                capture_output=True,
                check=False,
                text=True,
            )

    def test_accepts_valid_changelog(self) -> None:
        result = self.run_validator(VALID_CHANGELOG)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_unreleased_section(self) -> None:
        result = self.run_validator(VALID_CHANGELOG.replace("## [Unreleased]", "## Pending"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unreleased", result.stderr)

    def test_rejects_invalid_release_date(self) -> None:
        result = self.run_validator(VALID_CHANGELOG.replace("2026-06-06", "2026-13-40"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid date", result.stderr)

    def test_rejects_missing_required_category(self) -> None:
        result = self.run_validator(VALID_CHANGELOG.replace("### Security", "### Other"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("### Security", result.stderr)


if __name__ == "__main__":
    unittest.main()
