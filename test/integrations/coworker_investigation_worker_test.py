import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from coworker_investigation_fixtures import create_fixture
SPEC = importlib.util.spec_from_file_location("investigation_worker", HERE.parents[1] / "src/integrations/coworker/investigation-worker.py")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class InvestigationWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.request = create_fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_positive_and_redaction(self):
        value = worker.investigate(self.request)
        self.assertEqual(value["status"], "completed")
        self.assertNotIn("SENTINEL", json.dumps(value))
        self.assertEqual(value["result"]["source"]["pythonFiles"], 1)
        self.assertEqual(value["result"]["cells"]["trained"]["producerTargetsCredited"], 1)

    def test_descriptor_ancestor_swap_cannot_redirect_pinned_root(self):
        reader = worker.Reader(str(self.root))
        moved = self.root.with_name(self.root.name + "-moved")
        try:
            self.root.rename(moved)
            self.root.symlink_to("/", target_is_directory=True)
            identity, _ = reader.small(self.request["report"]["path"])
            self.assertEqual(identity["sha256"], self.request["report"]["sha256"])
        finally:
            reader.close()
            self.root.unlink()
            moved.rename(self.root)

    def test_symlinks_hardlinks_and_special_files_refused(self):
        adapter = self.root / self.request["localArtifacts"]["adapterPath"]
        outside = self.root / "other"
        adapter.rename(outside)
        adapter.symlink_to(outside)
        self.assertEqual(worker.investigate(self.request)["reason"], "unsafe_path")
        adapter.unlink(); os.link(outside, adapter)
        self.assertEqual(worker.investigate(self.request)["reason"], "unsafe_path")
        adapter.unlink(); os.mkfifo(adapter)
        self.assertEqual(worker.investigate(self.request)["reason"], "unsafe_path")

    def test_mutation_during_stream_rejected(self):
        path = "mutable.bin"
        target = self.root / path
        target.write_bytes(b"before\n")
        reader = worker.Reader(str(self.root))
        try:
            def change(_):
                target.write_bytes(b"[]\n")
            with self.assertRaises(worker.EvidenceError) as error:
                reader.stream(path, 100, change)
            # Not JSON, so use a valid line to reach mutation callback next.
            self.assertEqual(error.exception.code, "invalid_json")
            target.write_bytes(b"{}\n")
            with self.assertRaises(worker.EvidenceError) as error:
                reader.stream(path, 100, change)
            self.assertEqual(error.exception.code, "file_changed")
        finally:
            reader.close()

    def test_json_duplicates_nonfinite_and_primitive_types_rejected(self):
        for data in (b'{"a":1,"\\u0061":2}', b'{"a":NaN}'):
            with self.assertRaises(worker.EvidenceError): worker.parse_json(data)
        for value in (True, 1.0, "1"):
            with self.assertRaises(worker.EvidenceError): worker.exact_int(value)

    def test_file_and_line_bounds_enforced_without_large_allocation(self):
        reader = worker.Reader(str(self.root))
        try:
            (self.root / "large").write_bytes(b"{}\n" * 10)
            with self.assertRaises(worker.EvidenceError) as error: reader.small("large", 5)
            self.assertEqual(error.exception.code, "size_limit")
            with patch.object(worker, "LINE", 1):
                with self.assertRaises(worker.EvidenceError) as error: reader.stream("large", 100, lambda _: None)
                self.assertEqual(error.exception.code, "size_limit")
        finally:
            reader.close()

    def test_corrupt_git_blob_does_not_verify_source(self):
        blob = next((self.root / "history/halluminate/blobs").iterdir())
        blob.write_bytes(b"corrupt")
        value = worker.investigate(self.request)
        self.assertEqual(value["reason"], "evidence_mismatch")
        self.assertEqual([x["status"] for x in value["observations"]], ["verified", "failed"])


if __name__ == "__main__": unittest.main()
