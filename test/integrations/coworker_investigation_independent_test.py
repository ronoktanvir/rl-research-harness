"""Adversarial supported-format fixtures; no project imports or real trace data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("independent_investigator", HERE.parents[1] / "src/integrations/coworker/investigation-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
fixture_spec = importlib.util.spec_from_file_location("independent_investigation_fixtures", HERE / "coworker_investigation_fixtures.py")
fixtures = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixtures)


class IndependentHistoricalInvestigation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="historical-evidence-independent-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def inspect(self, request):
        result = worker.investigate(request)
        self.assertNotIn("SENTINEL", json.dumps(result))
        return result

    def replace_rows(self, request, cell, filename, transform):
        directory = request["localArtifacts"][cell + "EvaluationDirectory"]
        relative = directory + "/" + filename
        if filename == "step0-trace.jsonl":
            relative = ".local-artifacts/" + relative
        path = self.root / relative
        rows = [json.loads(line) for line in path.read_bytes().splitlines()]
        transform(rows)
        raw = b"".join(fixtures.encode(row) + b"\n" for row in rows)
        path.write_bytes(raw)
        checksum_path = self.root / Path(directory).parent / "SHA256SUMS"
        suffix = "./" + Path(directory).name + "/" + filename
        checksum_path.write_text("\n".join(
            hashlib.sha256(raw).hexdigest() + "  " + suffix if line.split()[1] == suffix else line
            for line in checksum_path.read_text().splitlines()) + "\n")

    def assert_incomplete(self, request):
        result = self.inspect(request)
        self.assertEqual(result["status"], "incomplete")
        self.assertIsNone(result["result"])
        return result

    def test_two_independent_synthetic_captures_use_real_parser_without_identity_patches(self):
        results = []
        for label, rows in (("first-review", 3), ("second-review", 5)):
            directory = self.root / label
            request = fixtures.create_fixture(directory, label, rows)
            result = self.inspect(request)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(len(result["observations"]), 6)
            self.assertEqual(result["result"]["cells"]["trained"]["rows"], rows)
            self.assertEqual(result["result"]["scientificReplicationCount"], 1)
            self.assertEqual(result["result"]["scientificEvaluation"], "unassessed")
            self.assertEqual(result["result"]["historicalExecution"], "unverified")
            results.append(result["result"])
        self.assertNotEqual(results[0]["report"]["sha256"], results[1]["report"]["sha256"])
        self.assertNotEqual(results[0]["adapter"]["sha256"], results[1]["adapter"]["sha256"])
        self.assertNotEqual(results[0]["source"]["pythonSourceSha256"], results[1]["source"]["pythonSourceSha256"])

    def test_duplicate_rows_cannot_hide_behind_set_equality(self):
        for cell, filename in (("trained", "step0-judged-results.jsonl"), ("baseline", "step0-trace.jsonl")):
            with self.subTest(cell=cell):
                request = fixtures.create_fixture(self.root, cell)
                self.replace_rows(request, cell, filename, lambda rows: rows.append(dict(rows[0])))
                self.assert_incomplete(request)

    def test_coercible_numeric_and_boolean_values_fail_at_actual_file_boundary(self):
        for field, value in (("seed", True), ("slot", False), ("seed", 1000.0)):
            with self.subTest(field=field, value=value):
                request = fixtures.create_fixture(self.root, field + str(value))
                self.replace_rows(request, "trained", "step0-judged-results.jsonl", lambda rows: rows[0].__setitem__(field, value))
                self.assert_incomplete(request)
        for field, value in (("targets_credited", True), ("targets_credited", 1.0), ("clean_success", 1)):
            with self.subTest(field=field, value=value):
                request = fixtures.create_fixture(self.root, field + str(value))
                self.replace_rows(request, "trained", "step0-judged-results.jsonl", lambda rows: rows[0]["diagnostics"].__setitem__(field, value))
                self.assert_incomplete(request)
        request = fixtures.create_fixture(self.root, "complete")
        self.replace_rows(request, "trained", "step0-trace.jsonl", lambda rows: rows[0].__setitem__("complete", 1))
        self.assert_incomplete(request)

    def test_missing_or_different_trace_identity_cannot_satisfy_judged_join(self):
        for transformation in (lambda rows: rows.pop(), lambda rows: rows[0].__setitem__("result_id", "other-result")):
            request = fixtures.create_fixture(self.root, "trace-join")
            self.replace_rows(request, "trained", "step0-trace.jsonl", transformation)
            self.assert_incomplete(request)

    def test_selected_baseline_must_share_base_revision_tokenizer_and_evaluator(self):
        for field, value in (("base_model_revision", "0" * 8), ("runtime_source_sha", "0" * 40), ("tokenizer_sha256", "0" * 64)):
            with self.subTest(field=field):
                request = fixtures.create_fixture(self.root, field)
                self.replace_rows(request, "baseline", "step0-trace.jsonl", lambda rows: [row["policy"].__setitem__(field, value) for row in rows])
                self.assert_incomplete(request)
        request = fixtures.create_fixture(self.root, "schema")
        self.replace_rows(request, "baseline", "step0-trace.jsonl", lambda rows: [row.__setitem__("schema_contract_hash", "0" * 64) for row in rows])
        self.assert_incomplete(request)

    def test_jointly_changed_trace_base_cannot_substitute_the_captured_training_base(self):
        request = fixtures.create_fixture(self.root, "wrong-base")
        for cell in ("trained", "baseline"):
            self.replace_rows(request, cell, "step0-trace.jsonl", lambda rows: [row["policy"].__setitem__("base_model_revision", "0" * 8) for row in rows])
        self.assert_incomplete(request)

    def test_duplicate_decoded_json_keys_never_become_last_value_wins(self):
        with self.assertRaises(worker.EvidenceError):
            worker.parse_json(b'{"status":"error","sta\\u0074us":"ok"}')

    def test_false_completion_and_saved_errors_are_counted_not_promoted_to_health(self):
        request = fixtures.create_fixture(self.root, "observed-failure")
        self.replace_rows(request, "trained", "step0-trace.jsonl", lambda rows: rows[0].__setitem__("complete", False))
        self.replace_rows(request, "trained", "step0-judged-results.jsonl", lambda rows: rows[0].update(status="failed", error="SENTINEL PRIVATE ERROR"))
        result = self.inspect(request)
        self.assertEqual(result["status"], "completed")
        cell = result["result"]["cells"]["trained"]
        self.assertEqual(cell["producerCompleteCount"], 2)
        self.assertEqual(cell["producerStatusOtherCount"], 1)
        self.assertEqual(cell["producerErrorCount"], 1)
        self.assertEqual(result["result"]["scientificEvaluation"], "unassessed")


if __name__ == "__main__":
    unittest.main()
