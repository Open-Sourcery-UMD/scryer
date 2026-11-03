#!/usr/bin/env python3
"""Scan candidate Git files locally, excluding ignored personal state and dependencies."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    binary = os.environ.get("GITLEAKS_BIN", str(ROOT / ".backend-artifacts/tools/gitleaks"))
    if not Path(binary).is_file() and not shutil.which(binary):
        print("Gitleaks is required. Run: python3 scripts/install_gitleaks.py")
        return 2
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT).split(b"\0")
    with tempfile.TemporaryDirectory(prefix="scryer-secret-scan-") as temporary:
        snapshot = Path(temporary) / "candidate"
        snapshot.mkdir()
        count = 0
        for encoded in set(paths):
            if not encoded:
                continue
            path = Path(os.fsdecode(encoded))
            source = ROOT / path
            if path.is_absolute() or ".." in path.parts or source.is_symlink():
                raise ValueError("Secret scan refuses a path outside ordinary repository files")
            if not source.is_file():
                continue  # A tracked deletion is absent from the candidate tree.
            target = snapshot / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            count += 1
        report = Path(temporary) / "redacted-findings.json"
        result = subprocess.run([binary, "dir", str(snapshot), "--no-banner", "--redact=100",
                                 "--config", str(ROOT / ".gitleaks.toml"),
                                 "--report-format", "json", "--report-path", str(report)],
                                cwd=ROOT, check=False)
        if result.returncode == 1 and report.is_file():
            for finding in json.loads(report.read_text()):
                print(f"Secret scan finding: {finding['File']}:{finding['StartLine']} ({finding['RuleID']})")
        print(f"Scanned {count} candidate files; ignored local state was excluded.")
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
