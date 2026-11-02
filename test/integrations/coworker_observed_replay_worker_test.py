"""Independent boundaries for the fixed native replay worker.

Ordinary tests never import CoworkeRL. Native tests are explicitly opted in with
RLH_COWORKER_REPLAY_QUALIFICATION pointing to the retained, source-bound
qualification directory. They reuse original persisted pairs; no substitute
world, fake bridge, provider, or training process is involved.
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / "src/integrations/coworker/observed-replay-worker.py"
MANIFEST = REPO / "src/integrations/coworker/observed-replay-source-manifest.json"
OPT_IN = os.environ.get("RLH_COWORKER_REPLAY_QUALIFICATION")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def manifest_digest():
    return sha(encoded(json.loads(MANIFEST.read_bytes())))


def prepared_program():
    # Mirror the production factory's fixed-manifest substitution. Neither the
    # request nor the tests can replace the approved source inventory.
    manifest = encoded(json.loads(MANIFEST.read_bytes())).decode()
    program = WORKER.read_text()
    marker = "__COWORKER_OBSERVED_REPLAY_MANIFEST_LITERAL__"
    if program.count(marker) != 1:
        raise AssertionError("fixed worker manifest marker changed")
    return program.replace(marker, json.dumps(manifest))


def request(source_root="/nonexistent-rlh-source", artifact_root="/nonexistent-rlh-artifacts"):
    return {
        "schemaVersion": 1, "kind": "coworker-observed-replay",
        "sourceRoot": source_root, "artifactRoot": artifact_root,
        "sourceManifestSha256": manifest_digest(),
        "episode": {"configId": "m3-covenant-recheck", "seed": 7},
        "result": {"path": "results.jsonl", "sha256": "a" * 64, "bytes": 1, "resultId": "result-1"},
        "trace": {"path": "traces.jsonl", "sha256": "b" * 64, "bytes": 1, "traceId": "trace-1"},
        "provenance": {"path": "provenance.json", "sha256": "c" * 64, "bytes": 1},
    }


def invoke(raw):
    data = raw if isinstance(raw, bytes) else encoded(raw)
    process = subprocess.run(
        [sys.executable, "-I", "-S", "-B", "-c", prepared_program()],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd="/",
        env={"PATH": "/usr/bin:/bin"}, timeout=65, check=False,
    )
    if len(process.stdout) > 1_048_576 or len(process.stderr) > 4096:
        raise AssertionError("worker exceeded expected bounded diagnostic output")
    try:
        result = json.loads(process.stdout)
    except (ValueError, UnicodeDecodeError):
        raise AssertionError("worker did not return a single JSON envelope") from None
    return process, result


def helper_namespace():
    """Load our stdlib-only reader definitions, never the native project."""
    scope = {"__name__": "replay_boundary_helpers"}
    exec(compile(prepared_program(), str(WORKER), "exec"), scope)
    return scope


class RequestBoundaryTests(unittest.TestCase):
    def assert_rejected(self, raw, reasons=None):
        process, result = invoke(raw)
        self.assertEqual(result["status"], "rejected")
        self.assertIsNone(result["result"])
        self.assertEqual(result["kind"], "coworker-observed-replay-result")
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["sourceManifestSha256"], manifest_digest())
        self.assertNotEqual(process.returncode, 0)
        if reasons is not None:
            self.assertIn(result["reason"], reasons)
        self.assertEqual(process.stderr, b"")
        return result

    def test_duplicate_json_keys_nonfinite_trailing_documents_and_invalid_utf8_fail(self):
        for raw in (b'{"schemaVersion":1,"schemaVersion":1}',
                    b'{"a":1,"\\u0061":2}', b'{"a":NaN}',
                    b'{"a":Infinity}', b'{}\n{}', b'\xff'):
            with self.subTest(raw=raw):
                self.assert_rejected(raw, {"invalid_json"})

    def test_boolean_and_float_schema_or_seed_cannot_pass_as_integers(self):
        for key in ("schemaVersion", "seed"):
            for invalid in (True, 1.0, "1", None):
                value = request()
                (value["episode"] if key == "seed" else value)[key] = invalid
                with self.subTest(key=key, invalid=invalid):
                    self.assert_rejected(value, {"invalid_request"})

    def test_expected_labels_import_paths_and_extra_fields_are_not_worker_inputs(self):
        for target, key, value in (("root", "expected", True),
                                   ("root", "module", "probing.extraction"),
                                   ("episode", "world", {}),
                                   ("result", "aliases", ["override"]),
                                   ("provenance", "systemPrompt", "copied from trace")):
            body = request()
            (body if target == "root" else body[target])[key] = value
            with self.subTest(target=target, key=key):
                self.assert_rejected(body, {"invalid_request"})

    def test_noncanonical_roots_and_relative_path_escapes_fail_before_source_reads(self):
        for path in ("relative", "/", "/tmp/../source", "/tmp//source", "/tmp/source/", "/tmp/a\\b"):
            body = request(); body["sourceRoot"] = path
            with self.subTest(root=path):
                self.assert_rejected(body, {"invalid_request", "unsafe_path"})
        for path in ("../x", "/tmp/x", "a/../x", "a//x", "a/./x", "a\\b", "x\n"):
            body = request(); body["result"]["path"] = path
            with self.subTest(path=path):
                self.assert_rejected(body, {"invalid_request", "unsafe_path"})

    def test_request_and_file_size_bounds_fail_without_source_access(self):
        self.assert_rejected(b" " * 65_537, {"size_limit", "invalid_json"})
        for field, invalid in (("result", 16_777_217), ("trace", 67_108_865),
                               ("provenance", 262_145), ("result", True), ("trace", 0)):
            body = request(); body[field]["bytes"] = invalid
            with self.subTest(field=field, invalid=invalid):
                self.assert_rejected(body, {"invalid_request", "size_limit"})

    def test_unknown_source_manifest_and_missing_source_never_become_native_results(self):
        body = request(); body["sourceManifestSha256"] = "0" * 64
        self.assert_rejected(body, {"invalid_request", "source_mismatch"})
        self.assert_rejected(request(), {"source_read_failed", "unsafe_path"})

    def test_whitespace_and_control_identifiers_and_aliased_input_paths_are_refused(self):
        for invalid in (" ", "\x7f"):
            body = request(); body["episode"]["configId"] = invalid
            self.assert_rejected(body, {"invalid_request"})
        body = request(); body["trace"]["path"] = body["result"]["path"]
        self.assert_rejected(body, {"invalid_request"})


class LocalReaderAndGuardTests(unittest.TestCase):
    def test_reader_keeps_opened_ancestor_when_path_is_replaced_by_outside_symlink(self):
        worker = helper_namespace()
        with tempfile.TemporaryDirectory(prefix="rlh-replay-reader-") as temporary:
            root = Path(temporary).resolve()
            artifacts = root / "artifacts"; artifacts.mkdir()
            inside = artifacts / "inside"; inside.mkdir(); (inside / "data").write_bytes(b"pinned")
            outside = root / "outside"; outside.mkdir(); (outside / "data").write_bytes(b"outside")
            reader = worker["Reader"](str(artifacts))
            original_open = os.open
            swapped = False

            def swap(path, flags, *args, **kwargs):
                nonlocal swapped
                descriptor = original_open(path, flags, *args, **kwargs)
                if path == "inside" and not swapped:
                    swapped = True
                    inside.rename(artifacts / "retained")
                    inside.symlink_to(outside, target_is_directory=True)
                return descriptor

            try:
                with patch.object(os, "open", swap):
                    self.assertEqual(reader.read("inside/data", 1024), b"pinned")
                self.assertTrue(swapped)
            finally:
                reader.close()

    def test_reader_rejects_content_changed_during_read(self):
        worker = helper_namespace()
        with tempfile.TemporaryDirectory(prefix="rlh-replay-reader-") as temporary:
            root = Path(temporary).resolve(); path = root / "data"; path.write_bytes(b"pinned")
            reader = worker["Reader"](str(root)); original_read = os.read
            changed = False

            def mutate(fd, size):
                nonlocal changed
                data = original_read(fd, size)
                if data and not changed:
                    changed = True
                    path.write_bytes(b"different")
                return data

            try:
                with patch.object(os, "read", mutate), self.assertRaises(worker["Rejected"]) as caught:
                    reader.read("data", 1024)
                self.assertEqual(caught.exception.reason, "artifact_mismatch")
            finally:
                reader.close()

    def test_effect_guard_denies_operations_without_leaking_outside_content(self):
        with tempfile.TemporaryDirectory(prefix="rlh-replay-guard-") as temporary:
            root = Path(temporary).resolve(); stage = root / "stage"; stage.mkdir()
            outside = root / "private"; outside.write_bytes(b"PRIVATE-GUARD-SENTINEL")
            suffix = """
import socket, subprocess
guard = EffectGuard()
guard.stage = Path(STAGE)
guard.strict_files = True
sys.addaudithook(guard.audit)
operations = {
  'outside_read': lambda: Path(OUTSIDE).read_bytes(),
  'stage_write': lambda: (Path(STAGE) / 'unexpected').write_bytes(b'x'),
  'socket_creation': lambda: socket.socket(),
  'subprocess': lambda: subprocess.run([sys.executable, '-I', '-S', '-c', 'pass'], check=True),
  'environment': lambda: os.putenv('RLH_GUARD_TEST', 'changed'),
}
outcomes = {}
for name, operation in operations.items():
    try:
        operation()
        outcomes[name] = 'allowed'
    except Rejected as error:
        outcomes[name] = error.reason
sys.stdout.write(json.dumps(outcomes))
"""
            program = ("__name__ = 'replay_guard_boundary'\n" + prepared_program() +
                       "\nSTAGE = " + repr(str(stage)) + "\nOUTSIDE = " + repr(str(outside)) + "\n" + suffix)
            process = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", program],
                                     cwd="/", env={"PATH": "/usr/bin:/bin"},
                                     capture_output=True, timeout=10, check=False)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(process.stderr, b"")
            self.assertNotIn(b"PRIVATE-GUARD-SENTINEL", process.stdout)
            self.assertEqual(json.loads(process.stdout), {name: "side_effect_denied" for name in
                             ("outside_read", "stage_write", "socket_creation", "subprocess", "environment")})
            self.assertFalse((stage / "unexpected").exists())


@unittest.skipUnless(OPT_IN, "requires retained native qualification via RLH_COWORKER_REPLAY_QUALIFICATION")
class NativePersistedPairTests(unittest.TestCase):
    assert_rejected = RequestBoundaryTests.assert_rejected
    def setUp(self):
        self.qualification = Path(OPT_IN).resolve()
        self.source = self.qualification / "run/snapshot/src"
        self.temporary = tempfile.TemporaryDirectory(prefix="rlh-replay-boundary-")
        self.addCleanup(self.temporary.cleanup)
        self.artifacts = Path(self.temporary.name).resolve()
        self.cases = {}
        for summary_path in (self.qualification / "run/output/tests").glob("**/harness-observation.json"):
            summary = json.loads(summary_path.read_bytes())
            self.cases[summary["caseId"]] = (summary_path.parent, summary)
        self.assertEqual(len(self.cases), 2)

    def fixture(self, case="observed-fact-denied-quotation"):
        source_files, summary = self.cases[case]
        body = request(str(self.source), str(self.artifacts))
        for target, name, selector in (("result", "raw-results.jsonl", "result_id"),
                                        ("trace", "raw-traces.jsonl", "trace_id")):
            raw = (source_files / name).read_bytes()
            self.assertEqual(sha(raw), summary[target + "Sha256"])
            value = json.loads(raw)
            body[target]["resultId" if target == "result" else "traceId"] = value[selector]
            self.save(body, target, raw)
        # Test provenance comes from the pinned fixture's source declarations,
        # never by filling it from the artifact we ask the bridge to validate.
        tree = ast.parse((self.source / "probing/prompts.py").read_bytes())
        constants = {}
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in ("SYSTEM_MATTERMOST", "INTERFACE_CONTRACT_VERSION"):
                        constants[target.id] = ast.literal_eval(node.value)
        provenance = {"schemaVersion": 1, "kind": "coworker-memory-read-provenance",
                      "backend": "mem", "readPageSize": 20,
                      "systemPrompt": constants["SYSTEM_MATTERMOST"],
                      "contractVersion": constants["INTERFACE_CONTRACT_VERSION"]}
        self.save(body, "provenance", encoded(provenance))
        return body, summary

    def save(self, body, target, raw):
        path = self.artifacts / body[target]["path"]
        path.write_bytes(raw)
        body[target].update(sha256=sha(raw), bytes=len(raw))

    def change(self, body, target, mutate):
        raw = json.loads((self.artifacts / body[target]["path"]).read_bytes())
        mutate(raw)
        self.save(body, target, encoded(raw) + b"\n")

    def test_original_native_pairs_complete_without_narrowing_required_facts(self):
        for case in self.cases:
            with self.subTest(case=case):
                body, summary = self.fixture(case)
                process, result = invoke(body)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["inputDigest"], sha(encoded(body)))
                self.assertIsNone(result["reason"])
                replay = result["result"]
                self.assertEqual(replay["requiredFactIds"], summary["requiredFactIds"])
                self.assertEqual(len(replay["facts"]), 2)
                self.assertEqual(replay["memoSha256"], summary["memoSha256"])
                self.assertEqual(sha(replay["memo"].encode()), summary["memoSha256"])
                self.assertEqual(replay["terminal"], {"valid": True, "status": "valid"})
                self.assertEqual(replay["arrivalBasis"], "validated_state_reconstruction")
                for field in ("semanticEvaluation", "taskSuccess", "scientificEvaluation"):
                    self.assertEqual(replay[field], "unassessed")
                for field in ("result", "trace"):
                    identity = replay["inputs"][field]
                    self.assertEqual({key: identity[key] for key in body[field]}, body[field])
                    self.assertEqual(identity["recordLine"], 1)
                    self.assertEqual(identity["recordSha256"], body[field]["sha256"])
                self.assertEqual(replay["inputs"]["provenance"], body["provenance"])
                world = {fact["id"]: fact for fact in replay["worldFacts"]}
                original_config = ast.parse((self.source / "probing/configs/_original_sources/m3.py").read_bytes())
                configured_fact_ids = {"m3-covenant-recheck/" + ast.literal_eval(node.args[0]).replace(" ", "-")
                                       for node in ast.walk(original_config)
                                       if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                                       and node.func.id in ("_fact", "MetricDef") and node.args
                                       and isinstance(node.args[0], ast.Constant)
                                       and isinstance(node.args[0].value, str)}
                self.assertEqual(len(configured_fact_ids), 10)
                self.assertEqual(set(world), configured_fact_ids)
                for fact in world.values():
                    self.assertEqual(set(fact), {"id", "value", "unit", "aliases", "sourceId", "label",
                                                 "definition", "period", "population", "denominator"})
                    for metadata in ("label", "definition", "period", "population", "denominator"):
                        self.assertIsInstance(fact[metadata], str)
                    self.assertTrue(fact["label"])
                self.assertEqual(replay["worldFactsSha256"], sha(encoded(replay["worldFacts"])))
                self.assertEqual(replay["requiredFactsSha256"],
                                 sha(encoded([world[key] for key in sorted(summary["requiredFactIds"])])))
                # The earlier qualification hashed the native fact definitions
                # without source ID. Recreate that exact hash surface from the
                # output to independently check aliases and target values.
                original_definitions = [{"fact_id": key, "value": world[key]["value"],
                                         "unit": world[key]["unit"], "aliases": world[key]["aliases"]}
                                        for key in summary["requiredFactIds"]]
                self.assertEqual(sha(encoded(original_definitions)), summary["requiredFactsSha256"])
                for actual, prior in zip(replay["facts"], summary["facts"]):
                    self.assertEqual(actual["id"], prior["factId"])
                    self.assertIs(actual["nativeCredit"], prior["nativeCredit"])
                    self.assertIs(actual["authorizedObserved"], prior["authorizedObserved"])
                    self.assertIs(actual["observedCredit"], prior["observedCredit"])
                    self.assertIsNone(actual["error"])
                    self.assertEqual(actual["witnessMessageIds"], [x["messageId"] for x in prior["witnesses"]])
                self.assertEqual(len(replay["readPages"]), len(summary["readPages"]))
                for actual, prior in zip(replay["readPages"], summary["readPages"]):
                    self.assertEqual({key: actual[key] for key in prior}, prior)
                seen = {identity for page in replay["readPages"] for identity in page["messageIds"]}
                self.assertEqual({x["messageId"] for x in replay["observedMessages"]}, seen)
                for evidence in replay["evidence"]:
                    observed = next(x for x in replay["observedMessages"] if x["messageId"] == evidence["messageId"])
                    self.assertEqual(evidence["contentSha256"], sha(observed["text"].encode()))
                    self.assertEqual(evidence["sourceId"], observed["sourceId"])
                files = {f["path"]: f for f in json.loads(MANIFEST.read_bytes())["files"]}
                self.assertTrue(replay["importedSourceModules"])
                for imported in replay["importedSourceModules"]:
                    self.assertTrue(imported["name"] == "probing" or imported["name"].startswith("probing."))
                    self.assertEqual(imported["sha256"], files[imported["path"]]["sha256"])

    def test_duplicate_selected_record_and_invalid_unselected_row_are_rejected(self):
        for target in ("result", "trace"):
            for suffix in ("duplicate", "invalid", "duplicate_keys"):
                body, _ = self.fixture()
                original = (self.artifacts / body[target]["path"]).read_bytes().rstrip(b"\n")
                tail = original if suffix == "duplicate" else b"not-json" if suffix == "invalid" else b'{"unrelated":1,"unrelated":2}'
                self.save(body, target, original + b"\n" + tail + b"\n")
                with self.subTest(target=target, suffix=suffix):
                    self.assert_rejected(body, {"record_ambiguous"} if suffix == "duplicate" else {"invalid_json"})

    def test_selected_id_missing_and_cross_linked_trace_fail(self):
        body, _ = self.fixture(); body["result"]["resultId"] = "not-present"
        self.assert_rejected(body, {"record_missing"})
        body, _ = self.fixture()
        self.change(body, "trace", lambda value: value.update(result_id="another-result"))
        self.assert_rejected(body, {"native_replay_rejected"})

    def test_judged_or_ownership_forged_raw_result_cannot_gain_observed_credit(self):
        for mutate in (lambda value: value.update(judge_model="posthoc-judge"),
                       lambda value: value.update(disclosure_ledger={})):
            body, _ = self.fixture(); self.change(body, "result", mutate)
            self.assert_rejected(body, {"native_replay_rejected"})

    def test_missing_or_inconsistent_separate_provenance_is_not_inferred_from_trace(self):
        for mutate in (lambda value: value.pop("systemPrompt"),
                       lambda value: value.update(systemPrompt="WRONG-SEPARATE-PROMPT"),
                       lambda value: value.update(backend="mattermost"),
                       lambda value: value.update(readPageSize=True)):
            body, _ = self.fixture(); self.change(body, "provenance", mutate)
            self.assert_rejected(body, {"provenance_invalid", "native_replay_rejected"})

    def test_catalog_selection_cannot_replace_a_world_or_accept_a_package_only_id(self):
        body, _ = self.fixture(); body["episode"]["configId"] = "unregistered-task-package"
        self.assert_rejected(body, {"unsupported_config"})
        body, _ = self.fixture(); body["episode"]["seed"] = 8
        self.assert_rejected(body, {"native_replay_rejected"})

    def test_source_byte_drift_is_rejected_before_import(self):
        body, _ = self.fixture()
        source = self.artifacts / "source-copy"
        shutil.copytree(self.source, source)
        target = source / "probing/completion_bridge.py"
        target.chmod(0o600)
        target.write_bytes(target.read_bytes() + b"\nraise RuntimeError('PRIVATE-DRIFT-SENTINEL')\n")
        body["sourceRoot"] = str(source)
        result = self.assert_rejected(body, {"source_mismatch"})
        self.assertNotIn("PRIVATE-DRIFT-SENTINEL", json.dumps(result))

    def test_source_and_artifact_symlinks_cannot_escape_pinned_roots(self):
        body, _ = self.fixture()
        alias = self.artifacts / "source-alias"; alias.symlink_to(self.source, target_is_directory=True)
        body["sourceRoot"] = str(alias)
        self.assert_rejected(body, {"unsafe_path", "source_read_failed"})
        body, _ = self.fixture()
        original = self.artifacts / body["result"]["path"]
        hidden = original.with_name("actual-result.jsonl"); original.rename(hidden)
        original.symlink_to(hidden)
        self.assert_rejected(body, {"unsafe_path", "artifact_read_failed"})

    def test_hardlinked_and_fifo_artifacts_fail_without_waiting_for_a_writer(self):
        for mode in ("hardlink", "fifo"):
            body, _ = self.fixture()
            path = self.artifacts / body["result"]["path"]
            if mode == "hardlink":
                os.link(path, self.artifacts / "second-link")
            else:
                path.unlink(); os.mkfifo(path)
            with self.subTest(mode=mode):
                self.assert_rejected(body, {"unsafe_path"})
            if mode == "hardlink":
                (self.artifacts / "second-link").unlink()

    def test_changed_file_hash_or_byte_declaration_is_not_replaced_with_observed_identity(self):
        for field in ("result", "trace", "provenance"):
            for altered in ("sha256", "bytes"):
                body, _ = self.fixture()
                body[field][altered] = "0" * 64 if altered == "sha256" else body[field][altered] + 1
                with self.subTest(field=field, altered=altered):
                    self.assert_rejected(body, {"artifact_mismatch"})

    def test_oversized_complete_projection_is_rejected_without_truncating_evidence(self):
        body, _ = self.fixture()
        original = json.loads((self.artifacts / body["result"]["path"]).read_bytes())["memo"]
        oversized = original + " " + "x" * 524_288

        def replace_memo(value):
            if isinstance(value, str):
                return value.replace(original, oversized)
            if isinstance(value, list):
                return [replace_memo(item) for item in value]
            if isinstance(value, dict):
                return {key: replace_memo(item) for key, item in value.items()}
            return value

        for field in ("result", "trace"):
            value = json.loads((self.artifacts / body[field]["path"]).read_bytes())
            self.save(body, field, encoded(replace_memo(value)) + b"\n")
        result = self.assert_rejected(body, {"size_limit"})
        self.assertLess(len(encoded(result)), 1024)

    def test_original_final_read_call_cap_is_complete_replay_but_invalid_policy(self):
        body, _ = self.fixture()
        directory = self.qualification / "run/output/tests/test_final_read_at_call_cap_is0/1"
        inventory = {entry["path"]: entry for entry in json.loads((self.qualification / "inventory.json").read_bytes())["files"]}
        for target, filename, selector in (("result", "raw-results.jsonl", "result_id"),
                                           ("trace", "raw-traces.jsonl", "trace_id")):
            path = directory / filename; raw = path.read_bytes()
            entry = inventory[str(path.relative_to(self.qualification))]
            self.assertEqual(sha(raw), entry["sha256"])
            value = json.loads(raw)
            body[target]["resultId" if target == "result" else "traceId"] = value[selector]
            self.assertEqual(value["config_id"], body["episode"]["configId"])
            self.assertEqual(value["seed"], body["episode"]["seed"])
            self.save(body, target, raw)
        process, result = invoke(body)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(result["status"], "completed")
        replay = result["result"]
        self.assertEqual(replay["terminal"], {"valid": False, "status": "invalid_policy"})
        self.assertEqual(replay["memo"], "")
        self.assertEqual(replay["readPages"], [])
        self.assertEqual(replay["evidence"], [])
        self.assertEqual(len(replay["facts"]), 2)
        self.assertTrue(all(fact["authorizedObserved"] is False for fact in replay["facts"]))
        self.assertEqual(replay["taskSuccess"], "unassessed")


if __name__ == "__main__":
    unittest.main()
