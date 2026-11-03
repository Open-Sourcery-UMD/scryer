"""Review metadata is untrusted data; missing or skipped evidence must fail closed."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VALID_BODY = """## Summary
Reject a source row when it declares two competing amounts.
## User impact
The reviewer sees a mapping warning and can correct the row without losing it.
## Validation
Ran the bank CSV regression suite with the conflicting-column fixture.
## Risks and recovery
Existing saved cases are unchanged; revert this parser-only change if needed.
"""


class PrDescriptionTests(unittest.TestCase):
    def test_substantive_sections_pass(self):
        self.assertEqual(load_script("check_pr_description").validate_description(VALID_BODY), [])

    def test_missing_and_comment_only_sections_fail(self):
        module = load_script("check_pr_description")
        self.assertTrue(module.validate_description(""))
        self.assertTrue(module.validate_description(VALID_BODY.replace(
            "Ran the bank CSV regression suite with the conflicting-column fixture.",
            "<!-- Say what you tested -->")))

    def test_template_placeholders_and_duplicate_sections_fail(self):
        module = load_script("check_pr_description")
        self.assertTrue(module.validate_description(VALID_BODY.replace(
            "Ran the bank CSV regression suite with the conflicting-column fixture.", "TODO")))
        self.assertTrue(module.validate_description(VALID_BODY + "\n## Validation\nPassed.\n"))

    def test_cli_treats_shell_looking_pr_text_as_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "must-not-exist"
            event = Path(temporary) / "event.json"
            body = VALID_BODY.replace("Reject a source row", f"$(touch {marker}) Reject a source row")
            event.write_text(json.dumps({"pull_request": {"body": body}}))
            result = subprocess.run([sys.executable, str(ROOT / "scripts/check_pr_description.py"),
                                     "--event", str(event)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())
            self.assertNotIn(body, result.stdout + result.stderr)


class RequiredCheckTests(unittest.TestCase):
    def test_every_expected_job_must_succeed(self):
        module = load_script("check_ci_results")
        results = {name: {"result": "success"} for name in module.REQUIRED_JOBS}
        self.assertEqual(module.check_results(results), [])
        for state in ("failure", "cancelled", "skipped", "timed_out", ""):
            results["python"] = {"result": state}
            self.assertTrue(module.check_results(results), state)
        del results["python"]
        self.assertTrue(module.check_results(results))

    def test_malformed_result_cannot_count_as_success(self):
        module = load_script("check_ci_results")
        self.assertTrue(module.check_results({}))
        self.assertTrue(module.check_results([]))
        results = {name: {"result": "success"} for name in module.REQUIRED_JOBS}
        results["python"] = "success"
        self.assertTrue(module.check_results(results))


if __name__ == "__main__":
    unittest.main()
