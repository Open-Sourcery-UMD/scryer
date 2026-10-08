"""Synthetic wire examples pinned before the sync parser implementation."""

import base64
import hashlib
import json
import unittest

from sync.protocol import (
    ProtocolError,
    assemble_package,
    parse_chunk,
    parse_device_registration,
    parse_manifest,
    parse_precondition,
    request_digest,
)


ACCOUNT = "acct-demo"
CASE = "case-demo"
REVISION = "rev-demo"
PACKAGE = "EBESExQVFhcYGRobHB0eHw"
DEVICE = "AAECAwQFBgcICQoLDA0ODw"


def wire(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def b64(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def chunk(index=0, count=1, ciphertext=b"x"):
    return {
        "schemaVersion": "1", "kind": "chunk", "accountId": ACCOUNT,
        "caseId": CASE, "revisionId": REVISION, "packageId": PACKAGE,
        "index": index, "chunkCount": count, "nonce": b64(bytes([index]) * 12),
        "ciphertext": b64(ciphertext), "tag": b64(bytes([index]) * 16),
    }


def manifest(parts):
    package = {
        "schemaVersion": "1", "format": "scryer-case-v1",
        "algorithm": "AES-256-GCM+HKDF-SHA-256", "accountId": ACCOUNT,
        "caseId": CASE, "revisionId": REVISION, "deviceId": DEVICE,
        "keyGeneration": 1, "packageId": PACKAGE,
        "chunks": [
            {key: part[key] for key in ("index", "nonce", "ciphertext", "tag")}
            for part in parts
        ],
    }
    request = {
        "schemaVersion": "1", "kind": "manifest", "format": "scryer-case-v1",
        "algorithm": "AES-256-GCM+HKDF-SHA-256", "accountId": ACCOUNT,
        "caseId": CASE, "revisionId": REVISION, "deviceId": DEVICE,
        "keyGeneration": 1, "packageId": PACKAGE, "chunkCount": len(parts),
        "chunkDigests": [hashlib.sha256(wire(part)).hexdigest() for part in parts],
        "packageDigest": hashlib.sha256(wire(package)).hexdigest(),
    }
    return request, wire(package)


class ProtocolTests(unittest.TestCase):
    def assert_code(self, code, fn, *args):
        with self.assertRaises(ProtocolError) as caught:
            fn(*args)
        self.assertEqual(caught.exception.code, code)

    def test_exact_browser_chunk_round_trip(self):
        raw = wire(chunk())
        parsed = parse_chunk(raw, ACCOUNT)
        self.assertEqual(parsed.body, raw)
        self.assertEqual(parsed.digest, hashlib.sha256(raw).hexdigest())
        self.assertEqual(parsed.cipher_bytes, 1)

    def test_device_registration_requires_exact_bounded_canonical_id(self):
        body = wire({"schemaVersion": "1", "deviceId": DEVICE})
        self.assertEqual(parse_device_registration(body), DEVICE)
        self.assert_code("INVALID_WIRE", parse_device_registration, b" " + body)
        self.assert_code("INVALID_WIRE", parse_device_registration,
                         wire({"deviceId": DEVICE, "schemaVersion": "1"}))
        self.assert_code("INVALID_WIRE", parse_device_registration,
                         body[:-1] + b',"deviceId":"' + DEVICE.encode() + b'"}')
        self.assert_code("INVALID_WIRE", parse_device_registration,
                         wire({"schemaVersion": "1", "deviceId": DEVICE + "="}))
        self.assert_code("INVALID_WIRE", parse_device_registration,
                         wire({"schemaVersion": "2", "deviceId": DEVICE}))
        self.assert_code("CASE_TOO_LARGE", parse_device_registration, body + b" " * 256)

    def test_random_package_id_may_start_with_base64url_punctuation(self):
        value = chunk()
        value["packageId"] = b64(b"\xfb" + bytes(15))
        self.assertTrue(value["packageId"].startswith("-"))
        self.assertEqual(parse_chunk(wire(value), ACCOUNT).package_id, value["packageId"])

    def test_noncanonical_and_duplicate_json_are_rejected(self):
        original = wire(chunk())
        self.assert_code("INVALID_WIRE", parse_chunk, b" " + original, ACCOUNT)
        self.assert_code("INVALID_WIRE", parse_chunk,
                         original[:-1] + b',"accountId":"acct-other"}', ACCOUNT)
        altered = chunk()
        altered["nonce"] += "="
        self.assert_code("INVALID_WIRE", parse_chunk, wire(altered), ACCOUNT)
        reordered = {"kind": "chunk", **chunk()}
        self.assert_code("INVALID_WIRE", parse_chunk, wire(reordered), ACCOUNT)

    def test_wrong_account_and_oversized_ciphertext_are_rejected(self):
        self.assert_code("WRONG_ACCOUNT", parse_chunk, wire(chunk()), "acct-other")
        self.assert_code("CASE_TOO_LARGE", parse_chunk,
                         wire(chunk(ciphertext=b"x" * (4 * 1024 * 1024 + 1))), ACCOUNT)

    def test_manifest_assembles_exact_package_and_rejects_missing_or_changed_chunk(self):
        parts = [chunk(0, 2, b"alpha"), chunk(1, 2, b"beta")]
        request, expected = manifest(parts)
        parsed_manifest = parse_manifest(wire(request), ACCOUNT)
        parsed_chunks = [parse_chunk(wire(part), ACCOUNT) for part in parts]
        self.assertEqual(assemble_package(parsed_manifest, list(reversed(parsed_chunks))), expected)
        self.assert_code("MISSING_CHUNK", assemble_package, parsed_manifest, parsed_chunks[:1])
        changed = [parts[0], chunk(1, 2, b"gamma")]
        self.assert_code("CHUNK_MISMATCH", assemble_package, parsed_manifest,
                         [parse_chunk(wire(part), ACCOUNT) for part in changed])

    def test_cross_package_chunk_and_forged_digest_are_rejected(self):
        part = chunk()
        request, _ = manifest([part])
        parsed_manifest = parse_manifest(wire(request), ACCOUNT)
        other = dict(part, packageId="MDEyMzQ1Njc4OUFCQ0RFRg")
        self.assert_code("CHUNK_MISMATCH", assemble_package, parsed_manifest,
                         [parse_chunk(wire(other), ACCOUNT)])
        request["packageDigest"] = "0" * 64
        self.assert_code("PACKAGE_MISMATCH", assemble_package,
                         parse_manifest(wire(request), ACCOUNT), [parse_chunk(wire(part), ACCOUNT)])

    def test_preconditions_and_request_digest(self):
        self.assertIsNone(parse_precondition("*", creating=True))
        self.assertEqual(parse_precondition('"rev-demo"', creating=False), REVISION)
        self.assert_code("PRECONDITION_REQUIRED", parse_precondition, None, True)
        self.assert_code("PRECONDITION_REQUIRED", parse_precondition, None, False)
        self.assert_code("INVALID_PRECONDITION", parse_precondition, "*", False)
        self.assert_code("INVALID_PRECONDITION", parse_precondition, 'W/"rev-demo"', False)
        one = request_digest("PUT", "/v1/cases/case-demo", b"abc", '"rev-one"')
        two = request_digest("PUT", "/v1/cases/case-demo", b"abc", '"rev-two"')
        self.assertNotEqual(one, two)
        self.assertEqual(len(one), 64)


if __name__ == "__main__":
    unittest.main()
