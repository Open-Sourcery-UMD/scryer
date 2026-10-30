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
        docker.write_text(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOCK_LOG\"\n"
            "case \"$*\" in\n"
            "  'compose config --format json') printf '%s\\n' '{\"volumes\":{\"postgres_data\":{\"name\":\"synthetic_postgres_data\"}}}' ;;\n"
            "  'info') [ \"$MOCK_DAEMON_DOWN\" != 1 ] ;;\n"
            "  'volume ls --format {{.Name}}') [ \"$MOCK_DAEMON_DOWN\" != 1 ] || exit 1; [ \"$MOCK_VOLUME_EXISTS\" = 1 ] && printf 'synthetic_postgres_data\\n'; exit 0 ;;\n"
            "  'volume inspect synthetic_postgres_data') [ \"$MOCK_VOLUME_EXISTS\" = 1 ] ;;\n"
            "  *'exec -T postgres'*) printf '1\\n' ;;\n"
            "esac\n"
        )
        docker.chmod(0o755)
        shutil.copy(docker, commands / "docker-compose")
        curl = commands / "curl"
        curl.write_text("#!/bin/sh\nexit 0\n")
        curl.chmod(0o755)
        self.environment = os.environ.copy()
        self.environment["PATH"] = str(commands) + os.pathsep + self.environment["PATH"]
        self.environment["MOCK_LOG"] = str(self.log)
        self.environment["MOCK_VOLUME_EXISTS"] = "0"
        self.environment["MOCK_DAEMON_DOWN"] = "0"
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
        self.assertIn("-h postgres", commands)

    def test_existing_weak_password_stops_before_containers(self):
        (self.workspace / ".env").write_text("POSTGRES_PASSWORD=scryer\n")
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("POSTGRES_PASSWORD", result.stderr)
        self.assertNotIn("up -d", self.log.read_text() if self.log.exists() else "")

    def test_existing_volume_without_secret_stops_before_writing_or_starting(self):
        self.environment["MOCK_VOLUME_EXISTS"] = "1"
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing", result.stderr.lower())
        self.assertFalse((self.workspace / ".env").exists())
        self.assertNotIn("up -d", self.log.read_text())

    def test_daemon_error_does_not_look_like_a_missing_volume(self):
        self.environment["MOCK_DAEMON_DOWN"] = "1"
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.workspace / ".env").exists())
        self.assertNotIn("up -d", self.log.read_text())

    def test_spaced_duplicate_secret_is_rejected_before_start(self):
        valid = "a" * 64
        (self.workspace / ".env").write_text(
            f"POSTGRES_PASSWORD={valid}\nPOSTGRES_PASSWORD = weak\n"
        )
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".env", result.stderr)
        self.assertNotIn("up -d", self.log.read_text() if self.log.exists() else "")

    def test_exported_duplicate_secret_is_rejected_before_start(self):
        valid = "a" * 64
        (self.workspace / ".env").write_text(
            f"POSTGRES_PASSWORD={valid}\nexport POSTGRES_PASSWORD=weak\n"
        )
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("up -d", self.log.read_text() if self.log.exists() else "")

    def test_environment_override_must_match_file_secret(self):
        (self.workspace / ".env").write_text("POSTGRES_PASSWORD=" + "a" * 64 + "\n")
        self.environment["POSTGRES_PASSWORD"] = "b" * 64
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("up -d", self.log.read_text() if self.log.exists() else "")

    def test_environment_secret_without_file_refuses_before_creating_one(self):
        self.environment["POSTGRES_PASSWORD"] = "b" * 64
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.workspace / ".env").exists())
        self.assertNotIn("up -d", self.log.read_text() if self.log.exists() else "")

    def test_appended_password_starts_on_new_line_without_final_newline(self):
        (self.workspace / ".env").write_text("API_PORT=8123")
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(
            (self.workspace / ".env").read_text(),
            r"^API_PORT=8123\nPOSTGRES_PASSWORD=[0-9a-f]{64}\n$",
        )

    def test_appended_password_starts_after_unterminated_comment(self):
        (self.workspace / ".env").write_text("# local configuration")
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(
            (self.workspace / ".env").read_text(),
            r"^# local configuration\nPOSTGRES_PASSWORD=[0-9a-f]{64}\n$",
        )


if __name__ == "__main__":
    unittest.main()
