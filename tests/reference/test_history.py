import copy
import json
from pathlib import Path
import unittest

from scryer_reference.history import heads_as_known
from scryer_reference.model import ModelError, load_case_json
from scryer_reference.projection import project_school_surplus

_FIXTURE = Path(__file__).parent / "fixtures" / "golden-case.json"


def raw_case():
    return json.loads(_FIXTURE.read_text())


def parsed(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


class HistoryTests(unittest.TestCase):
    def test_cutoff_before_any_review_has_empty_approved_history(self):
        selection = heads_as_known(parsed(raw_case()), "2026-09-01T12:00:00Z")
        self.assertEqual(selection.status, "EMPTY")
        self.assertEqual(selection.heads, ())

    def test_cutoff_selects_reviewed_school_state_not_later_correction(self):
        case = parsed(raw_case())
        selection = heads_as_known(case, "2026-09-02T10:02:00Z")
        self.assertEqual(selection.status, "UNIQUE")
        self.assertEqual(selection.heads, ("event-base-charge",))
        self.assertEqual(project_school_surplus(case, selection.heads, "2026-fall").amount_minor, 150000)

    def test_later_cutoff_selects_corrected_state(self):
        case = parsed(raw_case())
        selection = heads_as_known(case, "2026-09-04T10:00:00Z")
        self.assertEqual(selection.status, "UNIQUE")
        self.assertEqual(selection.heads, ("event-extra-charge",))
        self.assertEqual(project_school_surplus(case, selection.heads, "2026-fall").amount_minor, 90000)

    def test_event_enumeration_permutation_preserves_cutoff_result(self):
        raw = raw_case()
        first = heads_as_known(parsed(raw), "2026-09-04T10:00:00Z")
        raw["events"].reverse()
        second = heads_as_known(parsed(raw), "2026-09-04T10:00:00Z")
        self.assertEqual(first, second)

    def test_divergent_offline_corrections_have_ambiguous_heads(self):
        raw = raw_case()
        competing = copy.deepcopy(raw["events"][3])
        competing["eventId"] = "event-grant-correction-b"
        competing["recordedAt"] = "2026-09-03T11:00:00Z"
        competing["correction"]["replacementAmountMinor"] = "250000"
        competing["correction"]["reviewId"] = "review-grant-correction-b"
        raw["events"].append(competing)
        selection = heads_as_known(parsed(raw), "2026-09-03T12:00:00Z")
        self.assertEqual(selection.status, "AMBIGUOUS")
        self.assertEqual(selection.heads, ("event-grant-correction", "event-grant-correction-b"))
        self.assertIn("DIVERGENT_HEADS", selection.reason_codes)

    def test_different_review_times_can_have_different_as_known_results(self):
        raw_early = raw_case()
        raw_late = copy.deepcopy(raw_early)
        raw_late["events"][3]["recordedAt"] = "2026-09-03T11:00:00Z"
        cutoff = "2026-09-03T10:30:00Z"
        early = heads_as_known(parsed(raw_early), cutoff)
        late = heads_as_known(parsed(raw_late), cutoff)
        self.assertEqual(early.heads, ("event-grant-correction",))
        self.assertEqual(late.heads, ("event-base-charge",))

    def test_child_timestamp_before_parent_is_explicitly_ambiguous_at_cutoff(self):
        raw = raw_case()
        inverted = copy.deepcopy(raw["events"][4])
        inverted["eventId"] = "event-time-inverted"
        inverted["parents"] = ["event-base-charge"]
        inverted["recordedAt"] = "2026-09-01T12:00:00Z"
        inverted["fact"]["factId"] = "inverted-charge"
        inverted["fact"]["reviewId"] = "review-inverted-charge"
        raw["events"].append(inverted)
        selection = heads_as_known(parsed(raw), "2026-09-01T13:00:00Z")
        self.assertEqual(selection.status, "AMBIGUOUS")
        self.assertIn("CAUSAL_TIME_INVERSION", selection.reason_codes)

    def test_invalid_cutoff_has_typed_error(self):
        with self.assertRaises(ModelError) as raised:
            heads_as_known(parsed(raw_case()), "2026-09-02")
        self.assertEqual(raised.exception.code, "INVALID_INSTANT")


if __name__ == "__main__":
    unittest.main()
