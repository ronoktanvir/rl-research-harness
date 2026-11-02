"""Harmless subprocess/file-publication fixtures; never imports Gymnasium."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ENTRY = Path(__file__).resolve().parents[2] / "src/integrations/conventional/supervised_entry.py"
SPEC = importlib.util.spec_from_file_location("supervised_entry_target", ENTRY)
entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entry)


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def wire(envelope):
    payload = json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode()
    encoded = base64.b64encode(payload).decode()
    return ["envelope-v1", sha(payload), *[encoded[index:index + 8192] for index in range(0, len(encoded), 8192)]]


class SupervisedEntryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="conventional-entry-")
        self.root = Path(self.temporary.name).resolve()
        self.code = self.root / "code"
        self.outputs = self.root / "outputs"
        self.code.mkdir()
        self.outputs.mkdir()
        self.entry = self.code / "supervised_entry.py"
        self.entry.write_bytes(ENTRY.read_bytes())
        self.runner = self.code / "runner.py"
        self.requirements = self.code / "requirements.lock"
        self.requirements.write_text("synthetic fixture; no packages installed\n")
        self.marker = self.root / "module-invocations.txt"
        self.set_runner()

    def tearDown(self):
        self.temporary.cleanup()

    def set_runner(self, status=0, malformed=False):
        self.runner.write_text(
            "import json,sys\n"
            f"with open({str(self.marker)!r}, 'a') as marker: marker.write('module\\n')\n"
            "def parse_request(payload): return json.loads(payload)\n"
            "def main():\n"
            " request=json.load(sys.stdin)\n"
            " result={'schemaVersion':1,'kind':'frozenlake-q-learning-result','requestId':request['requestId'],"
            "'requestDigest':request['requestDigest'],'resumeSupported':False}\n"
            + (" sys.stdout.buffer.write(b'{incomplete')\n" if malformed else
               " sys.stdout.buffer.write((json.dumps(result,sort_keys=True,separators=(',',':'))+'\\n').encode())\n")
            + f" return {status}\n")

    def envelope(self):
        identity = json.dumps(["run-one", "launch", 1], separators=(",", ":")).encode()
        action = "action:" + sha(identity)
        request = {"requestId": "fixture", "requestDigest": "a" * 64, "replicates": [{"replicateId": "one"}]}
        request_json = json.dumps(request, separators=(",", ":"))
        reference = lambda path: {"path": str(path), "sha256": sha(path.read_bytes())}
        return {"schemaVersion": 1, "kind": "conventional-supervised-envelope",
                "binding": {"projectId": "study", "runId": "run-one", "replicaId": "one", "manifestDigest": "b" * 64,
                            "actionId": action, "backendKey": action, "backend": "conventional-systemd-v1", "operation": "launch", "operationRevision": 1},
                "requestJson": request_json, "requestBytesSha256": sha(request_json.encode()),
                "source": {"runner": reference(self.runner), "entry": reference(self.entry), "requirements": reference(self.requirements)},
                "output": {"root": str(self.outputs), "directoryName": "attempt-" + action[7:]},
                "pins": {"pythonMinor": "3.11", "gymnasium": "1.4.0", "numpy": "2.3.5"}}

    def invoke(self, envelope):
        return subprocess.run([sys.executable, "-I", "-B", str(self.entry), *wire(envelope)],
                              capture_output=True, env={}, timeout=3)

    def test_complete_result_is_published_before_bound_receipt_and_never_replayed(self):
        envelope = self.envelope()
        completed = self.invoke(envelope)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        directory = self.outputs / envelope["output"]["directoryName"]
        result = (directory / "result.json").read_bytes()
        receipt = json.loads((directory / "receipt.json").read_bytes())
        intent = json.loads((directory / "intent.json").read_bytes())
        self.assertEqual(receipt["resultSha256"], sha(result))
        self.assertEqual(receipt["resultBytes"], len(result))
        self.assertEqual(receipt["binding"], envelope["binding"])
        self.assertEqual(receipt["source"], envelope["source"])
        self.assertEqual(receipt["envelopeSha256"], wire(envelope)[1])
        self.assertEqual(intent["envelope"], envelope)
        self.assertFalse(intent["replaySupported"])
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ["intent.json", "receipt.json", "result.json"])
        self.assertEqual(self.marker.read_text(), "module\n")
        retried = self.invoke(envelope)
        self.assertEqual(retried.returncode, 1)
        self.assertEqual(self.marker.read_text(), "module\n", "duplicate attempt must fail before runner module execution")
        self.assertEqual((directory / "result.json").read_bytes(), result)
        self.assertEqual(retried.stdout, b"")

    def test_preexisting_attempt_directory_refuses_before_any_runner_execution(self):
        envelope = self.envelope()
        (self.outputs / envelope["output"]["directoryName"]).mkdir()
        result = self.invoke(envelope)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.marker.exists())

    def test_nonzero_or_incomplete_runner_output_leaves_intent_without_success_artifacts(self):
        for status, malformed in [(1, False), (0, True)]:
            with self.subTest(status=status, malformed=malformed):
                self.set_runner(status=status, malformed=malformed)
                envelope = self.envelope()
                # Use a separate output root while retaining exact action identity.
                output = self.root / f"output-{status}-{malformed}"
                output.mkdir(); envelope["output"]["root"] = str(output)
                result = self.invoke(envelope)
                self.assertEqual(result.returncode, 1)
                directory = output / envelope["output"]["directoryName"]
                self.assertEqual(sorted(path.name for path in directory.iterdir()), ["intent.json"])
                self.assertEqual(result.stdout, b"")

    def test_source_change_is_rejected_before_directory_or_module_effects(self):
        envelope = self.envelope()
        self.runner.write_text(self.runner.read_text() + "\n# changed\n")
        result = self.invoke(envelope)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.marker.exists())
        self.assertEqual(list(self.outputs.iterdir()), [])

    def test_output_ancestor_symlink_cannot_redirect_publication(self):
        outside = self.root / "outside"
        outside.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(outside, target_is_directory=True)
        envelope = self.envelope(); envelope["output"]["root"] = str(alias)
        result = self.invoke(envelope)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse(self.marker.exists())

    def test_complete_publication_never_replaces_an_existing_artifact(self):
        directory = entry.open_directory(str(self.outputs))
        try:
            (self.outputs / "result.json").write_bytes(b"original")
            with self.assertRaises(FileExistsError):
                entry.publish(directory, "result.json", b"replacement")
            self.assertEqual((self.outputs / "result.json").read_bytes(), b"original")
        finally:
            entry.os.close(directory)

    def test_envelope_identity_digest_size_and_duplicate_keys_are_strict(self):
        envelope = self.envelope()
        self.assertEqual(entry.parse_arguments(wire(envelope))[0], envelope)
        altered = wire(envelope); altered[1] = "0" * 64
        with self.assertRaises(entry.EntryError):
            entry.parse_arguments(altered)
        for mutate in [lambda item: item["binding"].update(operationRevision=True),
                       lambda item: item["binding"].update(actionId="action:" + "0" * 64),
                       lambda item: item["output"].update(directoryName="../escape"),
                       lambda item: item.update(requestBytesSha256="0" * 64),
                       lambda item: item["pins"].update(gymnasium="1.3.0")]:
            item = self.envelope(); mutate(item)
            with self.assertRaises(entry.EntryError):
                entry.parse_arguments(wire(item))
        with self.assertRaises(entry.EntryError):
            entry.parse_json('{"x":1,"x":2}')
        oversized = self.envelope(); oversized["requestJson"] = " " * 72_001
        with self.assertRaises(entry.EntryError):
            entry.parse_arguments(wire(oversized))


if __name__ == "__main__":
    unittest.main()
