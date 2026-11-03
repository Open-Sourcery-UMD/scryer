"""Contracts for the target design, not evidence that a production flow exists."""

import copy
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = ROOT / "docs" / "foundation"


def reachable(screens, start, allowed=None):
    seen = set()
    pending = [start]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        pending.extend(
            action["to"]
            for action in screens[current]["actions"]
            if allowed is None or action["kind"] in allowed
        )
    return seen


def validate_graph(document):
    screens = {screen["id"]: screen for screen in document["screens"]}
    assert len(screens) == len(document["screens"]), "duplicate screen ID"
    anchors = set(document["safeAnchors"])
    assert anchors <= screens.keys(), "undefined safe anchor"
    for screen in screens.values():
        assert screen["actions"], f"stranded screen: {screen['id']}"
        ids = [action["id"] for action in screen["actions"]]
        assert len(ids) == len(set(ids)), f"duplicate action: {screen['id']}"
        for action in screen["actions"]:
            assert action["to"] in screens, f"undefined target: {action['to']}"
        if screen.get("requiresRecovery"):
            recovery = [action for action in screen["actions"] if action["kind"] in {"retry", "recovery"}]
            assert recovery, f"missing recovery: {screen['id']}"
            assert any(action["kind"] in {"back", "cancel", "exit"} for action in screen["actions"]), (
                f"missing safe exit: {screen['id']}"
            )
            assert any(reachable(screens, action["to"]) & anchors for action in recovery), (
                f"recovery cannot reach safety: {screen['id']}"
            )
    assert reachable(screens, document["entryScreen"]) == screens.keys(), "unreachable screen"
    for screen_id in screens:
        assert reachable(screens, screen_id) & anchors, f"no safe destination: {screen_id}"
    return screens


class JourneyContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = json.loads((FOUNDATION / "journeys.json").read_text())
        cls.sessions = json.loads((FOUNDATION / "usability-sessions.json").read_text())

    def test_target_scope_is_distinct_from_current_ui(self):
        self.assertEqual(self.document["status"], "target-design-not-production")
        self.assertEqual(self.document["issue"], 34)
        self.assertEqual(self.document["execution"], "synthetic-in-memory-only")
        self.assertEqual(set(self.document["currentSurfaces"]), {"/demo", "/workspace"})
        self.assertFalse(self.document["productionAccountActions"])
        budget = self.document["supersededRequirements"]["budgets"]
        self.assertEqual(budget["decision"], "out-of-scope")
        self.assertIn("student-aid", budget["reason"])

    def test_all_screens_are_reachable_and_recoverable(self):
        screens = validate_graph(self.document)
        journeys = {journey["id"]: journey for journey in self.document["journeys"]}
        self.assertEqual(len(journeys), len(self.document["journeys"]))
        for screen in screens.values():
            self.assertIn(screen["journey"], journeys)
            self.assertTrue(screen["title"])
            self.assertTrue(screen["summary"])
        for journey in journeys.values():
            self.assertIn(journey["start"], screens)
            self.assertTrue(journey["successCriteria"])
            for outcome in ("success", "failureRecovery"):
                path = journey["paths"][outcome]
                self.assertGreaterEqual(len(path), 2)
                self.assertEqual(path[0], journey["start"])
                for source, target in zip(path, path[1:]):
                    self.assertIn(target, {action["to"] for action in screens[source]["actions"]}, (
                        journey["id"], outcome, source, target
                    ))
            failure_path = journey["paths"]["failureRecovery"]
            self.assertTrue(any(screens[screen_id].get("requiresRecovery") for screen_id in failure_path))
            self.assertIn(failure_path[-1], self.document["safeAnchors"])

    def test_graph_validator_catches_broken_recovery_and_unreachable_design(self):
        missing_retry = copy.deepcopy(self.document)
        error = next(screen for screen in missing_retry["screens"] if screen.get("requiresRecovery"))
        error["actions"] = [action for action in error["actions"] if action["kind"] not in {"retry", "recovery"}]
        with self.assertRaisesRegex(AssertionError, "missing recovery"):
            validate_graph(missing_retry)
        unreachable = copy.deepcopy(self.document)
        unreachable["screens"].append({
            "id": "stranded-fixture", "actions": [{"id": "leave", "to": "welcome", "kind": "exit"}]
        })
        with self.assertRaisesRegex(AssertionError, "unreachable screen"):
            validate_graph(unreachable)

    def test_required_risky_states_have_concrete_designs(self):
        screens = {screen["id"]: screen for screen in self.document["screens"]}
        required = {
            "welcome", "signup", "login", "signed-out", "local-setup", "unlock", "recovery",
            "unrecoverable", "import", "import-empty", "import-unsupported", "manual-entry",
            "mapping", "mapping-error", "duplicate-review", "approval", "approval-stale",
            "insight", "source-detail", "source-missing", "reattach", "source-mismatch",
            "correction", "correction-confirm", "corrected", "coverage-unknown",
            "sync-offline", "sync-stale", "sync-conflict", "sync-review", "synced",
            "export", "export-error", "export-ready", "restore", "restore-error",
            "restore-preview", "restored", "local-delete", "local-deleted",
            "account-delete", "account-delete-pending", "account-delete-error", "account-deleted",
        }
        self.assertLessEqual(required, screens.keys())
        for screen_id in ("mapping", "duplicate-review", "approval", "source-detail", "sync-review", "restore-preview"):
            self.assertGreater(len(screens[screen_id]["table"]["rows"]), 0)
        self.assertIn("review-confirmed", screens["approval"]["actions"][0]["requires"])
        for screen_id in ("local-delete", "account-delete", "correction-confirm", "sync-review", "restore-preview"):
            self.assertTrue(any(action.get("requires") for action in screens[screen_id]["actions"]))

    def test_exact_insight_uses_the_checked_synthetic_fixture(self):
        fixture = json.loads((ROOT / "frontend/data/demo-result.json").read_text())["result"]
        sample = self.document["sampleCase"]
        self.assertEqual(sample["caseId"], fixture["caseId"])
        self.assertEqual(sample["beforeMinor"], fixture["before"]["amountMinor"])
        self.assertEqual(sample["afterMinor"], fixture["after"]["amountMinor"])
        self.assertEqual(sample["deltaMinor"], fixture["comparison"]["deltaMinor"])
        self.assertEqual(sum(int(row["deltaMinor"]) for row in sample["contributions"]), int(sample["deltaMinor"]))
        self.assertEqual(int(sample["afterMinor"]) - int(sample["beforeMinor"]), int(sample["deltaMinor"]))
        for contribution in sample["contributions"]:
            fact = next(fact for fact in fixture["receipt"]["facts"] if fact["factId"] == contribution["factId"])
            self.assertEqual(contribution["source"], fact["sourceRef"])
            self.assertEqual(contribution["reviewId"], fact["correctionReviewId"] or fact["approvalReviewId"])

    def test_remote_case_deletion_preserves_scope_and_requires_an_acknowledged_receipt(self):
        screens = {screen["id"]: screen for screen in self.document["screens"]}
        required = {
            "synced-delete", "synced-delete-pending", "synced-delete-offline",
            "synced-delete-stale", "synced-delete-unknown", "synced-deleted",
        }
        self.assertLessEqual(required, screens.keys())
        menu = screens["deletion"]
        self.assertIn("synced-delete", {action["to"] for action in menu["actions"]})
        confirmation = screens["synced-delete"]
        request = next(action for action in confirmation["actions"] if action["to"] == "synced-delete-pending")
        self.assertTrue(request["requires"], "destructive request must require a fresh acknowledgement")
        for screen_id in ("synced-delete-offline", "synced-delete-stale", "synced-delete-unknown"):
            self.assertTrue(screens[screen_id]["requiresRecovery"])
            self.assertNotIn("synced-deleted", {action["to"] for action in screens[screen_id]["actions"]})
        self.assertEqual(
            {screen["id"] for screen in screens.values() for action in screen["actions"] if action["to"] == "synced-deleted"},
            {"synced-delete-pending"},
            "only the simulated server receipt can establish remote deletion",
        )
        self.assertIn("synced-delete", {action["to"] for action in screens["synced-delete-stale"]["actions"]})
        retry_text = " ".join(screens["synced-delete-unknown"]["summary"]).lower()
        self.assertIn("same idempotency key", retry_text)
        self.assertIn("same head precondition", retry_text)
        success_text = " ".join(screens["synced-deleted"]["summary"]).lower()
        for boundary in ("account", "other cases", "local", "archives", "tombstone"):
            self.assertIn(boundary, success_text)
        task = next(task for task in self.sessions["protocol"]["tasks"] if task["id"] == "T08")
        self.assertIn("synced-case-only", task["scenarios"])
        self.assertTrue(any("response" in item.lower() for item in task["scenarios"]))

    def test_embedded_catalog_is_exact_and_prototype_has_no_external_dependencies(self):
        html = (FOUNDATION / "prototype.html").read_text()
        match = re.search(r'<script id="journey-data" type="application/json">\s*(.*?)\s*</script>', html, re.S)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match.group(1)), self.document)
        self.assertIn("connect-src 'none'", html)
        self.assertIn("form-action 'none'", html)
        self.assertNotRegex(html, r'<(?:script|link|img)[^>]+(?:src|href)=')
        self.assertNotIn("innerHTML", html)
        executable_scripts = "\n".join(
            body for attributes, body in re.findall(r"<script([^>]*)>(.*?)</script>", html, re.S)
            if 'type="application/json"' not in attributes
        )
        self.assertNotRegex(executable_scripts, r"\b(?:localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket)\b")
        self.assertIn('aria-live="polite"', html)

    def test_external_sessions_remain_honestly_unrun_with_a_usable_protocol(self):
        self.assertEqual(self.sessions["status"], "not-run")
        self.assertEqual(self.sessions["requiredOutsideParticipants"], 2)
        self.assertEqual(self.sessions["sessions"], [])
        self.assertEqual(self.sessions["gate"], "pending-two-outside-human-sessions")
        self.assertIsNone(self.sessions["sessionTemplate"]["startedAt"])
        self.assertIsNone(self.sessions["sessionTemplate"]["consent"]["granted"])
        self.assertIn("nonSensitiveNotes", self.sessions["sessionTemplate"])
        self.assertGreaterEqual(len(self.sessions["protocol"]["tasks"]), 6)
        journey_ids = {journey["id"] for journey in self.document["journeys"]}
        covered = {journey for task in self.sessions["protocol"]["tasks"] for journey in task["journeyIds"]}
        self.assertEqual(covered, journey_ids)
        for task in self.sessions["protocol"]["tasks"]:
            self.assertTrue(task["successCriteria"])
            self.assertTrue(task["observe"])


if __name__ == "__main__":
    unittest.main()
