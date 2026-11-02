"""Fixed supervised entry. No work is replayed into an existing attempt directory.

Trust prerequisites: operator-owned immutable code/interpreter/dependencies and a
qualified OS profile. File hashes observe bytes; they do not establish that trust.
Only the supervised process creates outputs; preparation stays read-only.
"""
import base64
import hashlib
import io
import json
import os
import re
import stat
import sys
import types

MAX_ENVELOPE = 72_000
MAX_SOURCE = 128_000
MAX_RESULT = 4 * 1024 * 1024
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\Z")


class EntryError(ValueError):
    pass


def fields(value, names):
    if type(value) is not dict or set(value) != set(names):
        raise EntryError("unexpected_fields")


def digest(value):
    if type(value) is not str or not DIGEST.fullmatch(value):
        raise EntryError("invalid_digest")


def path(value):
    if (type(value) is not str or len(value) > 2048 or not re.fullmatch(r"/[A-Za-z0-9_./-]+", value)
            or value == "/" or value.endswith("/") or os.path.normpath(value) != value):
        raise EntryError("invalid_path")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise EntryError("duplicate_key")
        result[key] = value
    return result


def parse_json(payload):
    def nonfinite(_value):
        raise EntryError("nonfinite_json")
    return json.loads(payload, object_pairs_hook=unique_object, parse_constant=nonfinite)


def parse_arguments(arguments):
    if not 3 <= len(arguments) <= 14 or arguments[0] != "envelope-v1":
        raise EntryError("invalid_arguments")
    digest(arguments[1])
    if any(not item or len(item) > 8192 or not re.fullmatch(r"[A-Za-z0-9+/=]+", item) for item in arguments[2:]):
        raise EntryError("invalid_envelope_encoding")
    encoded = "".join(arguments[2:])
    payload = base64.b64decode(encoded, validate=True)
    if len(payload) > MAX_ENVELOPE or base64.b64encode(payload).decode("ascii") != encoded:
        raise EntryError("invalid_envelope_bound")
    if hashlib.sha256(payload).hexdigest() != arguments[1]:
        raise EntryError("envelope_digest_mismatch")
    envelope = parse_json(payload.decode("utf-8"))
    fields(envelope, ("schemaVersion", "kind", "binding", "requestJson", "requestBytesSha256", "source", "output", "pins"))
    if type(envelope["schemaVersion"]) is not int or envelope["schemaVersion"] != 1 or envelope["kind"] != "conventional-supervised-envelope":
        raise EntryError("unsupported_protocol")
    binding = envelope["binding"]
    fields(binding, ("projectId", "runId", "replicaId", "manifestDigest", "actionId", "backendKey", "backend", "operation", "operationRevision"))
    for key in ("projectId", "runId", "replicaId", "actionId", "backendKey"):
        if type(binding[key]) is not str or not IDENTIFIER.fullmatch(binding[key]):
            raise EntryError("invalid_identity")
    digest(binding["manifestDigest"])
    if (binding["backend"] != "conventional-systemd-v1" or binding["operation"] != "launch"
            or type(binding["operationRevision"]) is not int or not 1 <= binding["operationRevision"] <= 2**53 - 1
            or not re.fullmatch(r"action:[a-f0-9]{64}", binding["actionId"]) or binding["backendKey"] != binding["actionId"]):
        raise EntryError("invalid_launch_binding")
    identity_json = json.dumps([binding["runId"], "launch", binding["operationRevision"]], separators=(",", ":"))
    if "action:" + hashlib.sha256(identity_json.encode("ascii")).hexdigest() != binding["actionId"]:
        raise EntryError("action_identity_mismatch")
    if type(envelope["requestJson"]) is not str:
        raise EntryError("request_json_required")
    request_bytes = envelope["requestJson"].encode("utf-8")
    digest(envelope["requestBytesSha256"])
    if len(request_bytes) > 131_072 or hashlib.sha256(request_bytes).hexdigest() != envelope["requestBytesSha256"]:
        raise EntryError("request_bytes_mismatch")
    request = parse_json(envelope["requestJson"])
    if type(request) is not dict or type(request.get("replicates")) is not list or len(request["replicates"]) != 1:
        raise EntryError("one_replica_required")
    if type(request["replicates"][0]) is not dict or request["replicates"][0].get("replicateId") != binding["replicaId"]:
        raise EntryError("replica_identity_mismatch")
    digest(request.get("requestDigest"))
    fields(envelope["source"], ("runner", "entry", "requirements"))
    for reference in envelope["source"].values():
        fields(reference, ("path", "sha256")); path(reference["path"]); digest(reference["sha256"])
    fields(envelope["output"], ("root", "directoryName")); path(envelope["output"]["root"])
    if envelope["output"]["directoryName"] != "attempt-" + binding["actionId"][7:]:
        raise EntryError("output_identity_mismatch")
    if envelope["pins"] != {"pythonMinor": "3.11", "gymnasium": "1.4.0", "numpy": "2.3.5"}:
        raise EntryError("dependency_pin_mismatch")
    return envelope, arguments[1]


def open_directory(absolute):
    path(absolute)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.open("/", flags)
    try:
        for component in absolute.split("/")[1:]:
            child = os.open(component, flags, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def read_bound_source(reference):
    parent, name = os.path.split(reference["path"])
    directory = open_directory(parent)
    descriptor = None
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_SOURCE:
            raise EntryError("invalid_source_file")
        pieces, remaining = [], MAX_SOURCE + 1
        while remaining:
            piece = os.read(descriptor, remaining)
            if not piece:
                break
            pieces.append(piece)
            remaining -= len(piece)
        payload = b"".join(pieces)
        after = os.fstat(descriptor)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        attributes = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")
        if (len(payload) > MAX_SOURCE or any(getattr(before, key) != getattr(after, key) for key in attributes)
                or not stat.S_ISREG(named.st_mode) or (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino)
                or hashlib.sha256(payload).hexdigest() != reference["sha256"]):
            raise EntryError("source_observation_mismatch")
        return payload
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


def publish(directory, name, payload):
    """Publish complete fsynced bytes without replacing any existing artifact."""
    temporary = "." + name + ".partial"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise EntryError("output_write_failed")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    # link() is an atomic no-replace publication. A crash can leave the temporary
    # link too; collection still requires receipt.json and matching byte hashes.
    os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
    os.unlink(temporary, dir_fd=directory)
    os.fsync(directory)


def json_bytes(value):
    return json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def execute(envelope, envelope_sha256):
    """Only call with validated envelope. This is the supervised effect boundary."""
    source = envelope["source"]
    if os.path.abspath(__file__) != source["entry"]["path"]:
        raise EntryError("entry_path_mismatch")
    read_bound_source(source["entry"])
    read_bound_source(source["requirements"])
    runner_bytes = read_bound_source(source["runner"])
    # Compilation has no module execution. A duplicate attempt must fail before
    # even trusted runner module code is invoked again.
    runner_code = compile(runner_bytes, source["runner"]["path"], "exec")
    root = open_directory(envelope["output"]["root"])
    attempt = None
    try:
        os.mkdir(envelope["output"]["directoryName"], 0o700, dir_fd=root)
        os.fsync(root)
        attempt = os.open(envelope["output"]["directoryName"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        publish(attempt, "intent.json", json_bytes({"schemaVersion": 1, "kind": "conventional-supervised-intent", "envelope": envelope,
                "envelopeSha256": envelope_sha256, "replaySupported": False}))
        runner = types.ModuleType("bound_conventional_runner")
        runner.__file__ = source["runner"]["path"]
        exec(runner_code, runner.__dict__)
        request = runner.parse_request(envelope["requestJson"].encode("utf-8"))
        original_in, original_out = sys.stdin, sys.stdout
        captured = io.BytesIO()
        child_in = io.TextIOWrapper(io.BytesIO(envelope["requestJson"].encode("utf-8")), encoding="utf-8")
        child_out = io.TextIOWrapper(captured, encoding="utf-8")
        try:
            sys.stdin, sys.stdout = child_in, child_out
            status = runner.main()
            child_out.flush()
            result_bytes = captured.getvalue()
        finally:
            sys.stdin, sys.stdout = original_in, original_out
            child_in.close()
            child_out.close()
        if status != 0 or not result_bytes or len(result_bytes) > MAX_RESULT:
            raise EntryError("runner_incomplete")
        result = parse_json(result_bytes.decode("utf-8"))
        if (type(result) is not dict or result.get("schemaVersion") != 1 or result.get("kind") != "frozenlake-q-learning-result"
                or result.get("requestId") != request["requestId"] or result.get("requestDigest") != request["requestDigest"]
                or result.get("resumeSupported") is not False):
            raise EntryError("runner_result_identity_mismatch")
        result_digest = hashlib.sha256(result_bytes).hexdigest()
        publish(attempt, "result.json", result_bytes)
        receipt = {"schemaVersion": 1, "kind": "conventional-supervised-receipt", "binding": envelope["binding"],
                   "requestDigest": request["requestDigest"], "requestBytesSha256": envelope["requestBytesSha256"],
                   "envelopeSha256": envelope_sha256, "source": source, "resultSha256": result_digest,
                   "resultBytes": len(result_bytes), "runnerExitCode": 0,
                   "meaning": "worker_output_receipt_requires_owned_terminal_supervisor_observation"}
        publish(attempt, "receipt.json", json_bytes(receipt))
        sys.stdout.buffer.write(json_bytes({"schemaVersion": 1, "kind": "conventional-supervised-output",
                                          "actionId": envelope["binding"]["actionId"], "resultSha256": result_digest}))
    finally:
        if attempt is not None:
            os.close(attempt)
        os.close(root)


def main():
    try:
        envelope, digest_value = parse_arguments(sys.argv[1:])
        execute(envelope, digest_value)
        return 0
    except Exception:
        sys.stderr.write("conventional supervised entry: incomplete; inspect bound intent and supervisor\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
