"""Exact encrypted recovery-wrapper wire contract; no secret is parsed here."""

import base64
import json
import unittest

from sync.protocol import ProtocolError
from sync.recovery import parse_generation_precondition, parse_recovery_wrapper


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def wrapper(account_id: str = "acct-a", nonce_seed: int = 0) -> bytes:
    return json.dumps({
        "schemaVersion": "1", "format": "scryer-recovery-wrap-v1",
        "algorithm": "AES-256-GCM+HKDF-SHA-256", "accountId": account_id,
        "salt": b64(bytes(range(16))),
        "nonce": b64(bytes(range(nonce_seed, nonce_seed + 12))),
        "ciphertext": b64(bytes(range(32))), "tag": b64(bytes(range(16))),
    }, separators=(",", ":")).encode("ascii")


class RecoveryWireTests(unittest.TestCase):
    def test_exact_wrapper_and_account_binding(self):
        raw = wrapper()
        parsed = parse_recovery_wrapper(raw, "acct-a")
        self.assertEqual(parsed.body, raw)
        self.assertEqual(parsed.account_id, "acct-a")
        self.assertEqual(len(parsed.digest), 64)
        with self.assertRaisesRegex(ProtocolError, "WRONG_ACCOUNT"):
            parse_recovery_wrapper(raw, "acct-b")

    def test_duplicate_order_version_encoding_and_size_are_rejected(self):
        raw = wrapper()
        values = [
            raw.replace(b'"schemaVersion":"1",', b'"schemaVersion":"1","schemaVersion":"1",'),
            raw.replace(b'"salt":', b'"unexpected":0,"salt":'),
            raw.replace(b'"schemaVersion":"1","format":"scryer-recovery-wrap-v1",',
                        b'"format":"scryer-recovery-wrap-v1","schemaVersion":"1",'),
            raw.replace(b'"schemaVersion":"1"', b'"schemaVersion":"2"'),
            raw.replace(b'"salt":"AAECAwQFBgcICQoLDA0ODw"', b'"salt":"AAECAwQFBgcICQoLDA0ODw=="'),
            raw.replace(b'"nonce":"AAECAwQFBgcICQoL"', b'"nonce":"AA"'),
            raw + b" ",
        ]
        for changed in values:
            with self.subTest(changed=changed[:90]):
                with self.assertRaises(ProtocolError):
                    parse_recovery_wrapper(changed, "acct-a")
        with self.assertRaisesRegex(ProtocolError, "CASE_TOO_LARGE"):
            parse_recovery_wrapper(raw + b" " * 4096, "acct-a")

    def test_generation_preconditions_are_strong_and_bounded(self):
        self.assertIsNone(parse_generation_precondition("*", True))
        self.assertEqual(parse_generation_precondition('"1"', False), 1)
        for value, creating in ((None, True), (None, False), ('"1"', True),
                                ("*", False), ('W/"1"', False), ('"01"', False),
                                ('"2147483648"', False), ('"-1"', False)):
            with self.subTest(value=value, creating=creating):
                with self.assertRaises(ProtocolError):
                    parse_generation_precondition(value, creating)


if __name__ == "__main__":
    unittest.main()
