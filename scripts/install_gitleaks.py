#!/usr/bin/env python3
"""Install the pinned public Gitleaks release after verifying its SHA-256."""

import hashlib
import os
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
from urllib.request import urlopen

VERSION = "8.30.1"
DIGESTS = {
    ("Darwin", "arm64"): "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    ("Darwin", "x86_64"): "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    ("Linux", "x86_64"): "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    ("Linux", "aarch64"): "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
}


def main() -> None:
    system, machine = platform.system(), platform.machine()
    expected = DIGESTS.get((system, machine))
    if expected is None:
        raise SystemExit("Unsupported Gitleaks release platform; install a verified release manually.")
    architecture = "arm64" if machine in ("arm64", "aarch64") else "x64"
    filename = f"gitleaks_{VERSION}_{system.lower()}_{architecture}.tar.gz"
    tools = Path(__file__).resolve().parents[1] / ".backend-artifacts" / "tools"
    tools.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = tools / "gitleaks"
    with tempfile.TemporaryDirectory(dir=tools) as temporary:
        archive = Path(temporary) / filename
        with urlopen(f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{filename}",
                     timeout=60) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        with archive.open("rb") as downloaded:
            digest = hashlib.file_digest(downloaded, "sha256").hexdigest()
        if digest != expected:
            raise SystemExit("Gitleaks archive digest mismatch; refusing to install.")
        with tarfile.open(archive, "r:gz") as source:
            member = source.getmember("gitleaks")
            if not member.isfile():
                raise SystemExit("Gitleaks archive member is not a regular file.")
            executable = source.extractfile(member)
            if executable is None:
                raise SystemExit("Gitleaks executable is missing.")
            candidate = Path(temporary) / "gitleaks"
            with candidate.open("wb") as output:
                shutil.copyfileobj(executable, output)
            candidate.chmod(0o700)
            os.replace(candidate, target)
    print(f"Installed SHA-256 verified Gitleaks {VERSION}: {target}")


if __name__ == "__main__":
    main()
