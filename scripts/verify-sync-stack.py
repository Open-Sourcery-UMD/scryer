#!/usr/bin/env python3
"""Run SQL/API/browser integration against disposable synthetic local services."""

import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

import psycopg

ROOT = Path(__file__).resolve().parents[1]
POSTGRES = "postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab"
KEYCLOAK = "quay.io/keycloak/keycloak:26.7.3@sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4"


def main() -> int:
    name = "scryer-sql-verify-" + uuid4().hex[:12]
    state = ROOT / ".backend-artifacts/foundation"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    pg_started = False
    oidc_attempted = False
    run_id = uuid4().hex
    result = 1
    with tempfile.TemporaryDirectory(dir=state, prefix="sql-test-") as temporary:
        secret_file = Path(temporary) / "postgres.env"
        password = secrets.token_hex(32)
        secret_file.write_text(f"POSTGRES_PASSWORD={password}\n")
        secret_file.chmod(0o600)
        try:
            subprocess.run(["docker", "info"], stdout=subprocess.DEVNULL, check=True)
            existing = subprocess.run(["docker", "container", "inspect", "scryer-keycloak-auth-test"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if existing.returncode == 0:
                raise RuntimeError("An identity-provider test is already running; it was left untouched")
            for image in (POSTGRES, KEYCLOAK):
                cached = subprocess.run(["docker", "image", "inspect", image],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if cached.returncode:
                    subprocess.run(["docker", "pull", image], check=True)
            subprocess.run(["docker", "run", "--rm", "-d", "--name", name,
                            "--label", "org.opencontainers.image.title=scryer-local-sql-test",
                            "--publish", "127.0.0.1::5432", "--env-file", str(secret_file), POSTGRES],
                           stdout=subprocess.DEVNULL, check=True)
            pg_started = True
            endpoint = subprocess.check_output(["docker", "port", name, "5432/tcp"], text=True).strip()
            if not endpoint.startswith("127.0.0.1:") or "\n" in endpoint:
                raise RuntimeError("PostgreSQL did not bind to one loopback endpoint")
            port = int(endpoint.split(":")[1])
            ready = False
            for _ in range(60):
                try:
                    with psycopg.connect(host="127.0.0.1", port=port, user="postgres", dbname="postgres",
                                         password=password, connect_timeout=2) as connection:
                        ready = connection.execute("SELECT 1").fetchone() == (1,)
                    if ready:
                        break
                except psycopg.Error:
                    pass
                time.sleep(0.5)
            if not ready:
                raise RuntimeError("The disposable PostgreSQL server did not become ready")
            provider_environment = os.environ.copy()
            provider_environment["SCRYER_TEST_RUN_ID"] = run_id
            oidc_attempted = True
            subprocess.run(["sh", "scripts/start-local-keycloak-test.sh"], cwd=ROOT,
                           env=provider_environment, check=True)
            environment = os.environ.copy()
            environment.update({
                "SCRYER_TEST_PG_SOCKET": "127.0.0.1", "SCRYER_TEST_PG_ADMIN": "postgres",
                "PGPORT": str(port), "PGPASSWORD": password,
                "SCRYER_TEST_PG_APP_PASSWORD": secrets.token_hex(32),
                "SCRYER_LOCAL_OIDC": "1", "SCRYER_PYTHON": sys.executable,
            })
            print("Running synthetic PostgreSQL, API, identity-provider, and browser integration checks...", flush=True)
            result = subprocess.run(["sh", "scripts/check.sh", "sync"], cwd=ROOT, env=environment).returncode
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            print(f"Synthetic integration setup failed: {reason}", file=sys.stderr)
        finally:
            if oidc_attempted:
                owned = subprocess.run(["docker", "inspect", "--format",
                                        '{{ index .Config.Labels "org.scryer.test-run-id" }}',
                                        "scryer-keycloak-auth-test"], text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                if owned.returncode == 0 and owned.stdout.strip() == run_id:
                    cleanup = subprocess.run(["sh", "scripts/stop-local-keycloak-test.sh"], cwd=ROOT)
                    if cleanup.returncode:
                        result = 1
                elif owned.returncode == 0:
                    print("Identity container ownership changed; it was left untouched.", file=sys.stderr)
                    result = 1
            if pg_started:
                cleanup = subprocess.run(["docker", "rm", "-f", "-v", name], stdout=subprocess.DEVNULL)
                if cleanup.returncode:
                    result = 1
    return result


if __name__ == "__main__":
    raise SystemExit(main())
