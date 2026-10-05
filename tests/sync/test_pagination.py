"""Stable opaque cursor bounds for tenant-scoped ciphertext case listing."""

from datetime import datetime, timezone
import unittest

from sync.pagination import CaseCursorCodec, CursorError


class CursorTests(unittest.TestCase):
    def test_round_trip_microseconds_and_tenant_binding(self):
        codec = CaseCursorCodec(b"c" * 32)
        timestamp = datetime(2026, 10, 5, 1, 2, 3, 987654, tzinfo=timezone.utc)
        token = codec.encode("acct-one", timestamp, "case-one", now=1000)
        self.assertEqual(codec.decode(token, "acct-one", now=1001),
                         (timestamp, "case-one"))
        for wrong_token, account, now in (
            (token, "acct-two", 1001),
            (token[:-1] + ("A" if token[-1] != "A" else "B"), "acct-one", 1001),
            (token, "acct-one", 1901),
            (token + "=", "acct-one", 1001),
        ):
            with self.subTest(account=account, now=now, token=wrong_token[-8:]):
                with self.assertRaises(CursorError):
                    codec.decode(wrong_token, account, now=now)


if __name__ == "__main__":
    unittest.main()
