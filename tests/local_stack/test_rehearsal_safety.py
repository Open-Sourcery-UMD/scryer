"""Rehearsal cleanup must address only the newly allocated synthetic project."""

import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class RehearsalSafetyTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("rehearsal", ROOT / "scripts/verify-local-stack.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.project = "scryer-verify-0123456789ab"
        self.config = {
            "name": self.project,
            "services": {"postgres": {}, "backend": {}, "frontend": {}},
            "volumes": {"postgres_data": {"name": self.project + "_postgres_data"}},
            "networks": {"scryer_net": {"name": self.project + "_scryer_net"}},
        }

    def test_only_reserved_random_project_namespace_is_accepted(self):
        self.module.assert_isolated(self.config, self.project)
        with self.assertRaises(ValueError):
            self.module.assert_isolated(self.config, "scryer")

    def test_external_or_foreign_volume_is_rejected_before_start_or_cleanup(self):
        for change in ({"external": True}, {"name": "a-contributors-existing-data"}):
            config = copy.deepcopy(self.config)
            config["volumes"]["postgres_data"].update(change)
            with self.assertRaises(ValueError):
                self.module.assert_isolated(config, self.project)

    def test_external_network_or_fixed_container_name_is_rejected(self):
        config = copy.deepcopy(self.config)
        config["networks"]["scryer_net"]["external"] = True
        with self.assertRaises(ValueError):
            self.module.assert_isolated(config, self.project)
        self.config["services"]["postgres"]["container_name"] = "scryer-postgres"
        with self.assertRaises(ValueError):
            self.module.assert_isolated(self.config, self.project)


if __name__ == "__main__":
    unittest.main()
