"""A known public crypto fixture exemption must never hide a new credential."""

import json
import os
from pathlib import Path
import secrets
import string
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SecretScannerTests(unittest.TestCase):
    def test_public_fixture_passes_but_new_canary_in_same_file_fails_and_is_redacted(self):
        binary = os.environ.get("GITLEAKS_BIN", str(ROOT / ".backend-artifacts/tools/gitleaks"))
        self.assertTrue(Path(binary).is_file(), "Install the pinned Gitleaks binary before the security gate")
        with tempfile.TemporaryDirectory() as temporary:
            candidate = Path(temporary) / "tests/crypto/vectors.json"
            candidate.parent.mkdir(parents=True)
            fixture = json.loads((ROOT / "tests/crypto/vectors.json").read_text())
            candidate.write_text(json.dumps(fixture, indent=2))
            command = [binary, "dir", temporary, "--config", str(ROOT / ".gitleaks.toml"),
                       "--redact=100", "--no-banner"]
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            canary = "ghp_" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
            fixture["unexpectedCredential"] = canary
            candidate.write_text(json.dumps(fixture, indent=2))
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1, "New synthetic canary was not detected")
            self.assertNotIn(canary, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
