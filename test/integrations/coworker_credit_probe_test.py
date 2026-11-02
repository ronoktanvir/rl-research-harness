import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
PROBE_PATH = ROOT / "src/integrations/coworker/credit-probe.py"
SPEC = importlib.util.spec_from_file_location("credit_probe", PROBE_PATH)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
LEGACY_HASH = "ce0d32352e386ee0cf4c5d1ad2da34fd70e17690851eda15fe495740cdc0785b"
V2_HASH = "4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101"


def request(path="/missing-reviewed-source.py", digest=LEGACY_HASH):
    return {
        "schemaVersion": 1, "kind": "coworker-credit-probe",
        "source": {"path": str(path), "sha256": digest},
        "cases": [{"id": "case1", "text": "FCF is $12.50M.", "facts": [
            {"id": "fcf", "value": "$12.50M", "unit": "money", "aliases": ["FCF"]},
        ]}],
    }


def invoke(raw, *, flags=("-I", "-B", "-S")):
    data = raw if type(raw) is bytes else json.dumps(raw).encode()
    return subprocess.run([sys.executable, *flags, str(PROBE_PATH)], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env={}, timeout=30, check=False)


class CreditProbeTests(unittest.TestCase):
    def assert_rejected(self, value, reason="invalid_request"):
        with self.assertRaises(probe.ProbeError) as caught:
            probe.validate_request(value)
        self.assertEqual(caught.exception.code, reason)

    def test_complete_request_is_checked_before_any_source_read(self):
        value = request()
        value["cases"][0]["facts"][0]["expected"] = True
        with patch.object(probe.os, "open", side_effect=AssertionError("must not open")):
            with self.assertRaises(probe.ProbeError) as caught:
                probe.probe(value)
        self.assertEqual(caught.exception.code, "invalid_request")

    def test_only_fixed_source_hashes_are_accepted_before_file_access(self):
        self.assertEqual(probe.SOURCE_HASHES, frozenset({LEGACY_HASH, V2_HASH}))
        value = request(digest="0" * 64)
        with patch.object(probe.os, "open", side_effect=AssertionError("must not open")):
            with self.assertRaises(probe.ProbeError) as caught:
                probe.probe(value)
        self.assertEqual(caught.exception.code, "unsupported_source")

    def test_duplicate_keys_nonfinite_and_malformed_json_are_refused(self):
        for raw in (b'{"a":1,"\\u0061":2}', b'{"a":NaN}', b'{"a":Infinity}',
                    b'{"a":-Infinity}', b'{}\n{}', b'\xff', b'[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[['):
            with self.subTest(raw=raw), self.assertRaises(probe.ProbeError) as caught:
                probe.parse_request(raw)
            self.assertEqual(caught.exception.code, "invalid_json")

    def test_boolean_float_string_schema_and_wrong_shapes_are_refused(self):
        for invalid in (True, 1.0, "1", None):
            value = request(); value["schemaVersion"] = invalid
            self.assert_rejected(value)
        for location, invalid in (("cases", {}), ("source", []), ("kind", True)):
            value = request(); value[location] = invalid
            self.assert_rejected(value)
        value = request(); value["unexpected"] = None
        self.assert_rejected(value)
        value = request(); value["source"]["module"] = "probing.extraction"
        self.assert_rejected(value)

    def test_duplicate_case_and_fact_ids_are_refused(self):
        value = request(); value["cases"].append(copy.deepcopy(value["cases"][0]))
        self.assert_rejected(value)
        value = request(); facts = value["cases"][0]["facts"]; facts.append(copy.deepcopy(facts[0]))
        self.assert_rejected(value)
        value = request(); value["cases"][0]["facts"][0]["aliases"] = ["FCF", "FCF"]
        self.assert_rejected(value)

    def test_result_digest_binds_unicode_text_values_and_aliases_not_only_ids(self):
        value = request()
        value["cases"][0]["text"] = "Δ FCF is $12.50M. 🧪"
        expected = hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                            separators=(",", ":")).encode("utf-8")).hexdigest()
        self.assertEqual(probe.result_shape(value, False)["probeInputDigest"], expected)
        for target, field, replacement in (("case", "text", "different"), ("fact", "value", "$11.00M"),
                                            ("fact", "aliases", ["free cash flow"])):
            altered = copy.deepcopy(value)
            item = altered["cases"][0] if target == "case" else altered["cases"][0]["facts"][0]
            item[field] = replacement
            self.assertNotEqual(probe.result_shape(altered, False)["probeInputDigest"], expected)

    def test_false_exception_and_invalid_verdict_remain_distinct(self):
        fact = request()["cases"][0]["facts"][0]
        negative = probe.credit_fact(lambda *_: False, "memo", fact)
        self.assertEqual(negative, {"id": "fcf", "credited": False, "error": None})
        def fail(*_):
            raise ValueError("PRIVATE-SCORER-EXCEPTION")
        failed = probe.credit_fact(fail, "memo", fact)
        self.assertEqual(failed, {"id": "fcf", "credited": None, "error": "scorer_exception"})
        self.assertNotIn("PRIVATE", json.dumps(failed))
        for invalid in (1, "true", None, []):
            answer = probe.credit_fact(lambda *_, value=invalid: value, "memo", fact)
            self.assertEqual(answer, {"id": "fcf", "credited": None, "error": "invalid_verdict"})
        def interrupt(*_):
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            probe.credit_fact(interrupt, "memo", fact)

    def test_bounds_and_unsafe_unicode_are_rejected(self):
        for key, invalid in (("id", "x" * 97), ("id", "bad id"), ("text", "x" * 8193),
                             ("text", "\ud800"), ("text", "\0"), ("text", "\x7f")):
            value = request(); value["cases"][0][key] = invalid
            self.assert_rejected(value)
        for key, invalid in (("value", "x" * 257), ("unit", "x" * 33),
                             ("value", " "), ("aliases", []), ("aliases", [" "]), ("aliases", [True])):
            value = request(); value["cases"][0]["facts"][0][key] = invalid
            self.assert_rejected(value)
        for key in ("cases",):
            value = request(); value[key] = []
            self.assert_rejected(value)
        value = request(); value["cases"][0]["text"] = "\n\t\r"
        self.assertIs(probe.validate_request(value), value)
        with self.assertRaises(probe.ProbeError) as caught:
            probe.parse_request(b" " * (probe.MAX_REQUEST_BYTES + 1))
        self.assertEqual(caught.exception.code, "request_limit")

    def test_case_fact_and_alias_cardinality_limits(self):
        value = request()
        case = value["cases"][0]
        value["cases"] = [{**copy.deepcopy(case), "id": str(i)} for i in range(129)]
        self.assert_rejected(value)
        value = request(); fact = value["cases"][0]["facts"][0]
        value["cases"][0]["facts"] = [{**fact, "id": str(i)} for i in range(17)]
        self.assert_rejected(value)
        value = request(); value["cases"][0]["facts"][0]["aliases"] = [str(i) for i in range(17)]
        self.assert_rejected(value)

    def test_output_capacity_checked_before_source_execution(self):
        value = request()
        value["cases"] = [
            {"id": "case" + str(i), "text": "", "facts": [
                {"id": str(j) + "x" * 94, "value": "1", "unit": "x", "aliases": ["x"]}
                for j in range(16)
            ]} for i in range(128)
        ]
        self.assert_rejected(value, "output_limit")

    def test_output_capacity_accounts_for_errors_even_when_all_booleans_would_fit(self):
        value = request()
        value["cases"] = [
            {"id": "case" + str(i), "text": "", "facts": [
                {"id": str(j) + "x" * 70, "value": "1", "unit": "x", "aliases": ["x"]}
                for j in range(16)
            ]} for i in range(65)
        ]
        self.assertLess(len(probe.encoded(value)), probe.MAX_REQUEST_BYTES)
        self.assertLess(len(probe.encoded(probe.result_shape(value, False))) + 1, probe.MAX_OUTPUT_BYTES)
        self.assertGreater(len(probe.encoded(probe.result_shape(value, None, "scorer_exception"))) + 1,
                           probe.MAX_OUTPUT_BYTES)
        with patch.object(probe.os, "open", side_effect=AssertionError("must not open")):
            with self.assertRaises(probe.ProbeError) as caught:
                probe.probe(value)
        self.assertEqual(caught.exception.code, "output_limit")

    def test_noncanonical_and_relative_source_paths_are_rejected(self):
        for path in ("relative.py", "/", "//source.py", "/tmp/../source.py", "/tmp/./source.py",
                     "/tmp//source.py", "/tmp/source.py/", "/tmp/evil\n.py", "/tmp/a\\b.py"):
            self.assert_rejected(request(path))

    def test_symlink_ancestors_leaf_hardlinks_and_special_files_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            original = root / "source.py"; original.write_text("raise RuntimeError('not allowed')")
            leaf = root / "leaf.py"; leaf.symlink_to(original)
            real = root / "real"; real.mkdir(); (real / "source.py").write_text("pass")
            ancestor = root / "alias"; ancestor.symlink_to(real, target_is_directory=True)
            hard = root / "hard.py"; os.link(original, hard)
            fifo = root / "pipe"; os.mkfifo(fifo)
            for path in (leaf, ancestor / "source.py", hard, fifo, real):
                with self.subTest(path=path), self.assertRaises(probe.ProbeError) as caught:
                    probe.read_source(str(path), LEGACY_HASH)
                self.assertEqual(caught.exception.code, "unsafe_path")

    def test_source_size_hash_and_mid_read_change_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "source.py"
            path.write_bytes(b"x" * (probe.MAX_SOURCE_BYTES + 1))
            with self.assertRaises(probe.ProbeError) as caught:
                probe.read_source(str(path), LEGACY_HASH)
            self.assertEqual(caught.exception.code, "source_too_large")
            path.write_bytes(b"raise RuntimeError('PRIVATE-SENTINEL')\n")
            with self.assertRaises(probe.ProbeError) as caught:
                probe.read_source(str(path), LEGACY_HASH)
            self.assertEqual(caught.exception.code, "source_mismatch")
            read = os.read
            changed = False
            def mutate(fd, length):
                nonlocal changed
                data = read(fd, length)
                if data and not changed:
                    changed = True
                    path.write_bytes(b"different bytes\n")
                return data
            with patch.object(probe.os, "read", mutate), self.assertRaises(probe.ProbeError) as caught:
                probe.read_source(str(path), LEGACY_HASH)
            self.assertEqual(caught.exception.code, "source_changed")

    def test_real_process_refuses_unreviewed_bytes_without_executing_or_leaking_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "unreviewed.py"
            marker = root / "marker"
            path.write_text(f"open({str(marker)!r}, 'w').write('PRIVATE-SENTINEL')")
            result = invoke(request(path))
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {"error": "source_mismatch"})
            self.assertEqual(result.stderr, b"")
            self.assertFalse(marker.exists())
            self.assertNotIn(b"PRIVATE-SENTINEL", result.stdout)

    def test_real_process_rejects_missing_isolation_and_large_request(self):
        result = invoke(request(), flags=("-I", "-B"))
        self.assertEqual((result.returncode, json.loads(result.stdout)), (2, {"error": "runtime_unavailable"}))
        result = invoke(b" " * (probe.MAX_REQUEST_BYTES + 1))
        self.assertEqual((result.returncode, json.loads(result.stdout)), (2, {"error": "request_limit"}))
        self.assertEqual(result.stderr, b"")


class NativePinnedSourceTests(unittest.TestCase):
    """Opt-in local source checks. No source bytes are vendored or hash bypassed."""

    def check_native(self, env_name, digest, expected, negative_expected):
        path = os.environ.get(env_name)
        if not path:
            self.skipTest(env_name + " is not configured")
        value = request(path, digest)
        fact = value["cases"][0]["facts"][0]
        value["cases"] = [
            {"id": "affirmative", "text": "FCF is $12.50M.", "facts": [fact]},
            {"id": "hypothetical", "text": "If FCF were $12.50M, liquidity would improve.", "facts": [fact]},
            {"id": "wrong-sign", "text": "FCF is -$12.50M.", "facts": [fact]},
            {"id": "scaled", "text": "FCF is $12,500,000.", "facts": [fact]},
            {"id": "negative-canonical", "text": "FCF is -$17.50M. Debt is $25.00M.", "facts": [
                {"id": "negative-fcf", "value": "-$17.50M", "unit": "money", "aliases": ["FCF"]},
                {"id": "debt", "value": "$25.00M", "unit": "money", "aliases": ["debt"]},
            ]},
        ]
        result = invoke(value)
        self.assertEqual(result.returncode, 0, result.stdout.decode())
        self.assertEqual(result.stderr, b"")
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {"schemaVersion", "kind", "sourceSha256", "probeInputDigest", "cases"})
        self.assertEqual(output["sourceSha256"], digest)
        self.assertEqual(output["probeInputDigest"], probe.result_shape(value, False)["probeInputDigest"])
        self.assertEqual([row["facts"][0]["credited"] for row in output["cases"][:4]], expected)
        self.assertTrue(all(row["facts"][0]["error"] is None for row in output["cases"][:4]))
        self.assertEqual(output["cases"][4]["facts"], [
            {"id": "negative-fcf", "credited": negative_expected,
             "error": "scorer_exception" if negative_expected is None else None},
            {"id": "debt", "credited": True, "error": None},
        ])
        self.assertNotIn("text", json.dumps(output))
        self.assertNotIn("$12", json.dumps(output))

    def test_native_legacy_exact_source(self):
        self.check_native("COWORKER_CREDIT_LEGACY_SOURCE", LEGACY_HASH, [True, True, True, False], None)

    def test_native_v2_exact_source(self):
        self.check_native("COWORKER_CREDIT_V2_SOURCE", V2_HASH, [True, False, False, True], True)


if __name__ == "__main__":
    unittest.main()
