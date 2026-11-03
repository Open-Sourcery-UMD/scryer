"""The contributor API must distinguish liveness from database readiness."""

from contextlib import contextmanager
from unittest.mock import patch
import unittest

from fastapi.testclient import TestClient
import psycopg

import main


class ReadinessTests(unittest.TestCase):
    def test_liveness_does_not_claim_database_readiness(self):
        with patch.dict("os.environ", {}, clear=True), TestClient(main.app) as client:
            self.assertEqual(client.get("/health").status_code, 200)
            self.assertEqual(client.get("/ready").status_code, 503)

    def test_readiness_requires_a_successful_query(self):
        class Connection:
            def execute(self, query):
                self.query = query
                return self

            def fetchone(self):
                return (1,)

        connection = Connection()

        @contextmanager
        def connect(*args, **kwargs):
            self.assertEqual(kwargs.get("connect_timeout"), 2)
            yield connection

        with patch.dict("os.environ", {"DATABASE_URL": "postgresql://synthetic.invalid/test"}), \
                patch.object(main.psycopg, "connect", connect), TestClient(main.app) as client:
            response = client.get("/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(connection.query, "SELECT 1")

    def test_database_errors_are_unready_without_leaking_credentials(self):
        synthetic_secret = "synthetic-password-not-a-real-credential"
        with patch.dict("os.environ", {"DATABASE_URL": "postgresql://synthetic.invalid/test"}), \
                patch.object(main.psycopg, "connect", side_effect=psycopg.OperationalError(synthetic_secret)), \
                TestClient(main.app) as client:
            response = client.get("/ready")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(synthetic_secret, response.text)


if __name__ == "__main__":
    unittest.main()
