#!/usr/bin/env python3
"""Rehearse a committed clean snapshot using an isolated, disposable synthetic stack."""

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def assert_isolated(config: dict, project: str) -> None:
    if not re.fullmatch(r"scryer-verify-[0-9a-f]{12}", project) or config.get("name") != project:
        raise ValueError("Refusing a non-rehearsal Compose project")
    if set(config.get("services", {})) != {"postgres", "backend", "frontend"}:
        raise ValueError("Unexpected services in rehearsal")
    for service in config["services"].values():
        if service.get("container_name"):
            raise ValueError("Fixed container names would break project isolation")
    if set(config.get("volumes", {})) != {"postgres_data"}:
        raise ValueError("Unexpected rehearsal volumes")
    for name, volume in config["volumes"].items():
        if volume.get("external") or volume.get("name") != f"{project}_{name}":
            raise ValueError("Refusing an external or existing contributor volume")
    for name, network in config.get("networks", {}).items():
        if network.get("external") or network.get("name") != f"{project}_{name}":
            raise ValueError("Refusing an external or existing contributor network")


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default="HEAD", help="Commit to verify; uncommitted edits are excluded")
    args = parser.parse_args()
    revision = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{args.revision}^{{commit}}"],
        cwd=ROOT, text=True).strip()
    project = "scryer-verify-" + uuid4().hex[:12]
    artifacts = ROOT / ".backend-artifacts" / "foundation"
    artifacts.mkdir(parents=True, exist_ok=True, mode=0o700)
    log_path = artifacts / f"{project}.log"
    opener = build_opener(ProxyHandler({}))
    environment = os.environ.copy()
    for key in ("POSTGRES_PASSWORD", "API_PORT", "FRONTEND_PORT", "COMPOSE_FILE",
                "COMPOSE_PROFILES", "COMPOSE_ENV_FILES", "COMPOSE_PROJECT_NAME"):
        environment.pop(key, None)
    environment["COMPOSE_PROJECT_NAME"] = project
    api_port, frontend_port = free_port(), free_port()
    while frontend_port == api_port:
        frontend_port = free_port()
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    succeeded = False
    cleanup_failed = False
    with os.fdopen(log_fd, "w") as log, tempfile.TemporaryDirectory(prefix=project + "-") as temporary:
        checkout = Path(temporary) / "checkout"
        checkout.mkdir()

        def run(command: list[str], *, capture: bool = False, sensitive: bool = False) -> str:
            result = subprocess.run(command, cwd=checkout, env=environment, text=True,
                                    stdout=subprocess.PIPE if capture else log,
                                    stderr=log, timeout=900, check=True)
            output = result.stdout or ""
            if capture and not sensitive:
                log.write(output)
                log.flush()
            return output

        def wait_http(path: str, expected: int, timeout: int = 30) -> None:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    with opener.open(f"http://127.0.0.1:{api_port}{path}", timeout=4) as response:
                        code = response.status
                except HTTPError as error:
                    code = error.code
                except (OSError, URLError):
                    code = 0
                if code == expected:
                    return
                time.sleep(0.5)
            raise RuntimeError(f"API {path} did not return {expected}")

        compose = ["docker", "compose", "--project-directory", str(checkout), "--project-name", project]
        cleanup_safe = False
        try:
            run(["docker", "info"])
            archive = Path(temporary) / "snapshot.tar"
            subprocess.run(["git", "archive", "--format=tar", "--output", str(archive), revision],
                           cwd=ROOT, check=True)
            with tarfile.open(archive) as source:
                source.extractall(checkout, filter="data")
            (checkout / ".env").write_text(f"API_PORT={api_port}\nFRONTEND_PORT={frontend_port}\n")
            (checkout / ".env").chmod(0o600)
            # Resolve names before starting anything; the placeholder never starts a database.
            environment["POSTGRES_PASSWORD"] = "0" * 64
            config = json.loads(run(compose + ["config", "--format", "json"], capture=True, sensitive=True))
            del environment["POSTGRES_PASSWORD"]
            assert_isolated(config, project)
            cleanup_safe = True
            print(f"Verifying clean commit {revision[:12]} in disposable project {project}", flush=True)
            print("Building images and following setup.sh from the clean snapshot...", flush=True)
            run(["sh", "./setup.sh"])
            wait_http("/ready", 200)
            with opener.open(f"http://127.0.0.1:{frontend_port}/demo", timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError("The demo did not load")
            secret_file = (checkout / ".env").read_bytes()
            marker = uuid4().hex
            sql = ("CREATE TABLE scryer_rehearsal (marker text PRIMARY KEY); "
                   f"INSERT INTO scryer_rehearsal VALUES ('{marker}');")
            query = compose + ["exec", "-T", "postgres", "psql", "-U", "scryer", "-d", "scryer",
                               "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c"]
            run(query + [sql])
            print("Checking that database loss changes readiness without changing liveness...", flush=True)
            run(compose + ["stop", "postgres"])
            wait_http("/ready", 503)
            wait_http("/health", 200)
            print("Stopping and restarting the whole project while retaining its volume...", flush=True)
            run(compose + ["down"])
            run(compose + ["up", "-d", "--wait", "--wait-timeout", "120"])
            wait_http("/ready", 200)
            observed = run(query + ["SELECT marker FROM scryer_rehearsal"], capture=True).strip()
            if observed != marker:
                raise RuntimeError("The synthetic database record did not survive restart")
            run(["sh", "./setup.sh"])
            if (checkout / ".env").read_bytes() != secret_file:
                raise RuntimeError("Setup changed the secret for an existing database")
            print("PASS: clean setup, demo/API/database readiness, outage behavior, restart persistence, and repeat setup.", flush=True)
            succeeded = True
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            reason = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
            print(f"Rehearsal failed ({reason}); inspect the private log at {log_path}", file=sys.stderr)
        finally:
            if cleanup_safe:
                try:
                    run(compose + ["down", "--volumes", "--remove-orphans"])
                except (OSError, subprocess.SubprocessError):
                    print(f"Cleanup failed for disposable project {project}; see {log_path}", file=sys.stderr)
                    cleanup_failed = True
    if not succeeded or cleanup_failed:
        return 1
    print(f"Private rehearsal log: {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
