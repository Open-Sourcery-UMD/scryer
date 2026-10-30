"""Daemon-free checks for the synthetic local Compose configuration."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "docker-compose.yml"


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI is required")
class ComposeContractTests(unittest.TestCase):
    def render(self, variables):
        with tempfile.TemporaryDirectory() as temporary:
            env_file = Path(temporary) / "stack.env"
            env_file.write_text("".join(f"{key}={value}\n" for key, value in variables.items()))
            environment = os.environ.copy()
            for key in ("POSTGRES_PASSWORD", "API_PORT", "DATABASE_URL", "SECRET_KEY"):
                environment.pop(key, None)
            return subprocess.run(
                ["docker", "compose", "--env-file", str(env_file), "-f", str(COMPOSE),
                 "config", "--format", "json"],
                cwd=temporary, env=environment, capture_output=True, text=True, check=False,
            )

    def test_missing_database_secret_fails_config_render(self):
        result = self.render({})
        self.assertNotEqual(result.returncode, 0, "Missing password was accepted")
        self.assertIn("POSTGRES_PASSWORD", result.stderr)

    def test_services_are_local_and_database_health_runs_a_query(self):
        result = self.render({"POSTGRES_PASSWORD": "a" * 64, "API_PORT": "8123"})
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)["services"]
        database = services["postgres"]
        self.assertFalse(database.get("ports"), "PostgreSQL must not publish a host port")
        self.assertEqual(database["volumes"][0]["source"], "postgres_data")
        health = " ".join(database["healthcheck"]["test"])
        self.assertIn("psql", health)
        self.assertIn("SELECT 1", health)
        self.assertIn("-h postgres", health, "database probe must use the service network address")
        self.assertIn("pg_hba_file_rules", health, "database probe must refuse trust host rules")
        self.assertEqual(database["environment"]["POSTGRES_INITDB_ARGS"], "--auth-host=scram-sha-256")
        self.assertEqual(services["backend"]["depends_on"]["postgres"]["condition"], "service_healthy")
        self.assertEqual(services["backend"]["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(services["backend"]["ports"][0]["published"], "8123")
        self.assertEqual(services["backend"]["ports"][0]["target"], 8000)
        self.assertEqual(services["frontend"]["ports"][0]["host_ip"], "127.0.0.1")

    def test_images_build_frontend_for_release_and_fix_container_api_port(self):
        frontend = (ROOT / "frontend/Dockerfile").read_text()
        backend = (ROOT / "Dockerfile.backend").read_text()
        self.assertIn("RUN npm run build", frontend)
        self.assertIn('CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]', frontend)
        self.assertLess(frontend.index("RUN npm run build"), frontend.index('CMD ["npm", "run", "start"'))
        self.assertNotIn('CMD ["npm", "run", "dev"', frontend)
        self.assertIn('CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]', backend)

    def test_build_contexts_exclude_local_environment_files(self):
        root_ignore = (ROOT / ".dockerignore").read_text().splitlines()
        frontend_ignore = (ROOT / "frontend/.dockerignore").read_text().splitlines()
        self.assertIn(".env*", root_ignore)
        self.assertIn("**/.env*", root_ignore)
        self.assertIn(".env*", frontend_ignore)


if __name__ == "__main__":
    unittest.main()
