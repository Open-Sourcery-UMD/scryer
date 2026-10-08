"""Cross-runtime fixture check for actual synthetic browser outbox bytes."""

import hashlib
import json
import sys

from sync.protocol import assemble_package, parse_chunk, parse_manifest


def main():
    value = json.load(sys.stdin)
    account = value["accountId"]
    chunks = [parse_chunk(step["body"].encode("utf-8"), account)
              for step in value["steps"] if step["kind"] == "chunk"]
    manifests = [parse_manifest(step["body"].encode("utf-8"), account)
                 for step in value["steps"] if step["kind"] == "manifest"]
    if len(manifests) != 1:
        raise ValueError("Expected exactly one manifest")
    assembled = assemble_package(manifests[0], chunks)
    if hashlib.sha256(assembled).hexdigest() != value["expectedPackageDigest"]:
        raise ValueError("Browser package mismatch")


if __name__ == "__main__":
    main()
