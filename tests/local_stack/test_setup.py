"""Synthetic, isolated checks for setup.sh; no real Docker command runs."""

import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class SetupContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        shutil.copy(ROOT / "setup.sh", self.workspace / "setup.sh")
        shutil.copy(ROOT / ".env.example", self.workspace / ".env.example")
        self.log = self.workspace / "docker.log"
        commands = self.workspace / "bin"
        commands.mkdir()
        docker = commands / "docker"
        docker.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOCK_LOG\"\n"
                          "case \"$*\" in *'exec -T postgres'*) printf '1\\n';; esac\n")
        docker.chmod(0o755)
        shutil.copy(docker, commands / "docker-compose")
        curl = commands / "curl"
        curl.write_text("#!/bin/sh\nexit 0\n")
        curl.chmod(0o755)
        self.environment = os.environ.copy()
        self.environment["PATH"] = str(commands) + os.pathsep + self.environment["PATH"]
        self.environment["MOCK_LOG"] = str(self.log)
        self.environment.pop("POSTGRES_PASSWORD", None)
        self.environment.pop("API_PORT", None)

    def run_setup(self):
        return subprocess.run(["sh", str(self.workspace / "setup.sh")],
                              cwd=self.workspace, env=self.environment,
                              capture_output=True, text=True, check=False)

    def test_first_run_generates_private_random_password_and_checks_database(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.workspace / ".env").exists(), "setup did not create .env")
        contents = (self.workspace / ".env").read_text()
        match = re.search(r"^POSTGRES_PASSWORD=([0-9a-f]{64})$", contents, re.MULTILINE)
        self.assertIsNotNone(match, contents)
        self.assertEqual(stat.S_IMODE((self.workspace / ".env").stat().st_mode), 0o600)
        self.assertNotIn(match.group(1), result.stdout + result.stderr)
        commands = self.log.read_text()
        self.assertIn("config", commands)
        self.assertIn("build", commands)
        self.assertIn("up -d", commands)
        self.assertIn("exec -T postgres", commands)
        self.assertIn("-h 127.0.0.1", commands)

    def test_existing_weak_password_stops_before_containers(self):
        (self.workspace / ".env").write_text("POSTGRES_PASSWORD=scryer\n")
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("POSTGRES_PASSWORD", result.stderr)
        self.assertNotIn("up -d", self.log.read_text() if self.log.exists() else "")


if __name__ == "__main__":
    unittest.main()
