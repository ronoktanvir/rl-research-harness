"""Pinned native v2 memory replay. Reviewed code boundary, not a general sandbox.

The launcher replaces the manifest literal before hashing and executing this
file. No project code is imported until every declared source byte is staged.
Native replay receives the original records and an actual catalog episode.
"""
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

SOURCE_MANIFEST_JSON = __COWORKER_OBSERVED_REPLAY_MANIFEST_LITERAL__
SOURCE_MANIFEST_SHA256 = "39de34e0600e0df12aff786ea298bf71d36c84e28f4be2860bf243832943a895"
REQUEST_BYTES = 64 * 1024
SOURCE_BYTES = 2 * 1024 * 1024
SOURCE_TOTAL_BYTES = 32 * 1024 * 1024
RESULT_BYTES = 16 * 1024 * 1024
TRACE_BYTES = 64 * 1024 * 1024
LINE_BYTES = 8 * 1024 * 1024
PROVENANCE_BYTES = 256 * 1024
OUTPUT_BYTES = 512 * 1024
SAFE_INTEGER = 2**53 - 1


class Rejected(Exception):
    def __init__(self, reason):
        self.reason = reason


def require(condition, reason="invalid_request"):
    if not condition:
        raise Rejected(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pairs(values):
    result = {}
    for key, value in values:
        require(key not in result, "invalid_json")
        result[key] = value
    return result


def parse_json(data):
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(Rejected("invalid_json")))
        stack = [(value, 0)]
        nodes = 0
        while stack:
            item, depth = stack.pop()
            nodes += 1
            require(depth <= 64 and nodes <= 1_000_000, "size_limit")
            if type(item) is dict:
                stack.extend((key, depth + 1) for key in item)
                stack.extend((child, depth + 1) for child in item.values())
            elif type(item) is list:
                stack.extend((child, depth + 1) for child in item)
            elif type(item) is str:
                item.encode("utf-8")
            elif type(item) is int:
                require(abs(item) <= SAFE_INTEGER, "invalid_json")
            elif type(item) is float:
                require(math.isfinite(item), "invalid_json")
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected("invalid_json") from None


def exact_object(value, keys, reason="invalid_request"):
    require(type(value) is dict and set(value) == set(keys), reason)
    return value


def integer(value, minimum, maximum, reason="invalid_request"):
    require(type(value) is int and minimum <= value <= maximum, reason)
    return value


def text(value, maximum, reason="invalid_request", empty=False):
    require(type(value) is str and (empty or bool(value.strip())) and len(value) <= maximum
            and not any(ord(char) < 32 or ord(char) == 127 for char in value), reason)
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise Rejected(reason) from None
    return value


def digest(value, reason="invalid_request"):
    require(type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value) is not None, reason)
    return value


def relative(value):
    text(value, 2048, "unsafe_path")
    require(not value.startswith("/") and "\\" not in value
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe_path")
    return value


def absolute(value):
    text(value, 4096, "unsafe_path")
    require(value.startswith("/") and value != "/" and "\\" not in value
            and os.path.normpath(value) == value
            and all(part not in ("", ".", "..") for part in value.split("/")[1:]), "unsafe_path")
    return value


def validate_ref(value, maximum, identity=None):
    exact_object(value, ("path", "sha256", "bytes") + ((identity,) if identity else ()))
    relative(value["path"])
    digest(value["sha256"])
    integer(value["bytes"], 1, maximum)
    if identity:
        text(value[identity], 512)


def validate_request(value):
    exact_object(value, ("schemaVersion", "kind", "sourceRoot", "artifactRoot",
                         "sourceManifestSha256", "episode", "result", "trace", "provenance"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
            and value["kind"] == "coworker-observed-replay")
    absolute(value["sourceRoot"])
    absolute(value["artifactRoot"])
    require(value["sourceManifestSha256"] == SOURCE_MANIFEST_SHA256, "source_mismatch")
    exact_object(value["episode"], ("configId", "seed"))
    text(value["episode"]["configId"], 256)
    integer(value["episode"]["seed"], 0, 2147483647)
    validate_ref(value["result"], RESULT_BYTES, "resultId")
    validate_ref(value["trace"], TRACE_BYTES, "traceId")
    validate_ref(value["provenance"], PROVENANCE_BYTES)
    require(len({value[name]["path"] for name in ("result", "trace", "provenance")}) == 3)
    return value


class Reader:
    """Descriptor-relative reads pin every ancestor and reject links/devices."""
    def __init__(self, root):
        absolute(root)
        require(os.name == "posix" and os.open in os.supports_dir_fd and all(
            hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC", "O_NONBLOCK")),
            "reader_unavailable")
        self.flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open("/", self.flags)
        try:
            for part in root.split("/")[1:]:
                following = os.open(part, self.flags, dir_fd=fd)
                os.close(fd)
                fd = following
            self.fd = fd
        except BaseException:
            os.close(fd)
            raise

    def close(self):
        os.close(self.fd)

    @contextlib.contextmanager
    def opened(self, path, maximum):
        relative(path)
        fd = os.dup(self.fd)
        try:
            parts = path.split("/")
            for part in parts[:-1]:
                following = os.open(part, self.flags, dir_fd=fd)
                os.close(fd)
                fd = following
            opened = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                             dir_fd=fd)
        finally:
            os.close(fd)
        try:
            before = os.fstat(opened)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "unsafe_path")
            require(0 < before.st_size <= maximum, "size_limit")
            yield opened, before
            after = os.fstat(opened)
            require(tuple(getattr(before, name) for name in
                          ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")) ==
                    tuple(getattr(after, name) for name in
                          ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")),
                    "artifact_mismatch")
        finally:
            os.close(opened)

    def read(self, path, maximum):
        with self.opened(path, maximum) as (fd, before):
            chunks = []
            count = 0
            while True:
                block = os.read(fd, min(65536, maximum + 1 - count))
                if not block:
                    break
                chunks.append(block)
                count += len(block)
                require(count <= maximum, "size_limit")
            require(count == before.st_size, "artifact_mismatch")
            return b"".join(chunks)

    def select_record(self, reference, maximum, key, requested):
        selected = None
        selected_identity = None
        ids = set()
        count = 0
        total = 0
        hasher = hashlib.sha256()
        with self.opened(reference["path"], maximum) as (fd, before):
            require(before.st_size == reference["bytes"], "artifact_mismatch")
            with os.fdopen(os.dup(fd), "rb") as handle:
                while True:
                    line = handle.readline(LINE_BYTES + 1)
                    if not line:
                        break
                    count += 1
                    total += len(line)
                    require(count <= 1000 and len(line) <= LINE_BYTES and total <= maximum, "size_limit")
                    hasher.update(line)
                    record = parse_json(line)
                    require(type(record) is dict and key in record, "invalid_json")
                    identity = text(record[key], 512, "invalid_json")
                    require(identity not in ids, "record_ambiguous")
                    ids.add(identity)
                    if identity == requested:
                        selected = record
                        selected_identity = {**reference, "recordLine": count, "recordSha256": sha(line)}
            require(total == reference["bytes"] and hasher.hexdigest() == reference["sha256"],
                    "artifact_mismatch")
        require(selected is not None, "record_missing")
        return selected, selected_identity


class EffectGuard:
    """Defense for reviewed pinned Python, not a hostile native-code sandbox."""
    def __init__(self):
        self.stage = None
        self.strict_files = False
        self.cleanup = False
        self.denied = False
        self.runtime = Path(sys.base_prefix).resolve()

    def reject(self):
        self.denied = True
        raise Rejected("side_effect_denied")

    def path(self, raw, write=False):
        if type(raw) is int:
            # The worker opens source/artifact descriptors before native imports.
            # Native code has no supported need to read arbitrary open descriptors.
            self.reject()
        if not isinstance(raw, (str, bytes, os.PathLike)):
            self.reject()
        value = Path(os.fsdecode(raw)).resolve()
        in_stage = value == self.stage or self.stage in value.parents
        if write:
            if not (self.cleanup and in_stage):
                self.reject()
        elif not (in_stage or value == self.runtime or self.runtime in value.parents):
            self.reject()

    def audit(self, event, args):
        if event.startswith("socket.") or event in {
            "subprocess.Popen", "os.system", "os.posix_spawn", "os.exec", "os.fork", "os.forkpty",
            "ctypes.dlopen", "os.putenv", "os.unsetenv",
        }:
            self.reject()
        if not self.strict_files:
            return
        if event == "open":
            _, _, flags = args
            self.path(args[0], bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC)))
        elif event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.truncate", "os.utime"}:
            self.path(args[0], True)
        elif event in {"os.rename", "os.link", "os.symlink"}:
            self.reject()
        elif event in {"os.listdir", "os.scandir"} and not self.cleanup:
            self.path(args[0])


def manifest():
    require(type(SOURCE_MANIFEST_JSON) is str, "source_mismatch")
    value = parse_json(SOURCE_MANIFEST_JSON.encode("utf-8"))
    require(sha(canonical(value)) == SOURCE_MANIFEST_SHA256, "source_mismatch")
    exact_object(value, ("schemaVersion", "kind", "profile", "projectHead", "files"), "source_mismatch")
    require(type(value["files"]) is list and len(value["files"]) == 150, "source_mismatch")
    return value


def stage_source(source_root, stage, source_manifest):
    reader = None
    total = 0
    try:
        reader = Reader(source_root)
        for item in source_manifest["files"]:
            relative(item["path"])
            require(item["path"].startswith("probing/"), "source_mismatch")
            raw = reader.read(item["path"], SOURCE_BYTES)
            require(len(raw) == item["bytes"] and sha(raw) == item["sha256"], "source_mismatch")
            total += len(raw)
            require(total <= SOURCE_TOTAL_BYTES, "size_limit")
            target = stage / item["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            target.chmod(0o444)
    except OSError:
        raise Rejected("source_read_failed") from None
    finally:
        if reader is not None:
            reader.close()


def load_artifacts(request):
    reader = None
    try:
        reader = Reader(request["artifactRoot"])
        result, result_identity = reader.select_record(request["result"], RESULT_BYTES,
                                                       "result_id", request["result"]["resultId"])
        trace, trace_identity = reader.select_record(request["trace"], TRACE_BYTES,
                                                     "trace_id", request["trace"]["traceId"])
        raw = reader.read(request["provenance"]["path"], PROVENANCE_BYTES)
        require(len(raw) == request["provenance"]["bytes"] and sha(raw) == request["provenance"]["sha256"],
                "artifact_mismatch")
        provenance = parse_json(raw)
        exact_object(provenance, ("schemaVersion", "kind", "backend", "readPageSize", "systemPrompt",
                                  "contractVersion"), "provenance_invalid")
        require(type(provenance["schemaVersion"]) is int and provenance["schemaVersion"] == 1
                and provenance["kind"] == "coworker-memory-read-provenance"
                and provenance["backend"] == "mem", "provenance_invalid")
        integer(provenance["readPageSize"], 1, 1000, "provenance_invalid")
        text(provenance["contractVersion"], 256, "provenance_invalid")
        require(type(provenance["systemPrompt"]) is str and bool(provenance["systemPrompt"].strip())
                and len(provenance["systemPrompt"]) <= 131072, "provenance_invalid")
        require(type(trace.get("turns")) is list and 1 <= len(trace["turns"]) <= 128
                and type(result.get("transcript")) is list and len(result["transcript"]) <= 2048,
                "size_limit")
        return result, trace, provenance, {"result": result_identity, "trace": trace_identity,
                                           "provenance": request["provenance"]}
    except OSError:
        raise Rejected("artifact_read_failed") from None
    finally:
        if reader is not None:
            reader.close()


def project(request, result, trace, provenance, inputs, stage, source_manifest):
    require(not any(name == "probing" or name.startswith("probing.") for name in sys.modules),
            "native_import_failed")
    # -I -S supplies only the interpreter's own standard library search path.
    sys.path.insert(0, str(stage))
    try:
        from probing.catalog import POOL_BY_ID
        from probing.world import instantiate, fingerprint
        from probing.completion_bridge import build_observed_replay, MemoryReadProvenance, CompletionBridgeError
        from probing.extraction import credited
    except Rejected:
        raise
    except Exception:
        raise Rejected("native_import_failed") from None
    require(request["episode"]["configId"] in POOL_BY_ID, "unsupported_config")
    try:
        episode = instantiate(POOL_BY_ID[request["episode"]["configId"]], request["episode"]["seed"])
        replay = build_observed_replay(episode=episode, result=result, trace=trace,
                                      provenance=MemoryReadProvenance(provenance["backend"],
                                          provenance["readPageSize"], provenance["systemPrompt"],
                                          provenance["contractVersion"]))
    except CompletionBridgeError:
        raise Rejected("native_replay_rejected") from None
    except Rejected:
        raise
    except Exception:
        raise Rejected("native_replay_rejected") from None

    by_id = {}
    source_for_owner = {owner: source for source, owner in replay.source_bindings.items()}
    for helper in episode.helpers:
        for fact in helper.facts:
            require(fact.fact_id not in by_id and helper.name in source_for_owner, "native_replay_rejected")
            by_id[fact.fact_id] = {"id": fact.fact_id, "value": fact.value, "unit": fact.unit,
                                  "aliases": list(fact.aliases), "sourceId": source_for_owner[helper.name],
                                  "label": fact.label, "definition": fact.definition, "period": fact.period,
                                  "population": fact.population, "denominator": fact.denominator}
    world_facts = [by_id[key] for key in sorted(by_id)]
    require(0 < len(world_facts) <= 256, "size_limit")
    require(len(replay.world_facts) == len(world_facts)
            and {fact.fact_id for fact in replay.world_facts} == set(by_id), "native_replay_rejected")
    for fact in replay.world_facts:
        require((fact.value, fact.unit, fact.source_id) ==
                (by_id[fact.fact_id]["value"], by_id[fact.fact_id]["unit"], by_id[fact.fact_id]["sourceId"]),
                "native_replay_rejected")
        require(all(getattr(fact, field) == by_id[fact.fact_id][field]
                    for field in ("label", "definition", "period", "population", "denominator")),
                "native_replay_rejected")
    required_ids = list(replay.required_fact_ids)
    require(0 < len(required_ids) <= 64 and len(set(required_ids)) == len(required_ids)
            and set(required_ids) <= set(by_id)
            and set(required_ids) == {fact.fact_id for fact in episode.targets}, "native_replay_rejected")
    facts = []
    for identity in required_ids:
        fact = by_id[identity]
        verdict = None
        error = None
        try:
            verdict = credited(replay.memo, fact["value"], fact["unit"], tuple(fact["aliases"]))
        except Exception:
            error = "scorer_exception"
        if error is None and type(verdict) is not bool:
            verdict = None
            error = "invalid_verdict"
        witnesses = [item.message_id for item in replay.evidence
                     if identity in item.fact_ids and item.authorized and item.policy_observed]
        facts.append({"id": identity, "nativeCredit": verdict, "error": error,
                      "authorizedObserved": bool(witnesses), "witnessMessageIds": witnesses,
                      "observedCredit": None if error else bool(witnesses) and verdict})
    evidence = [{"messageId": item.message_id, "sourceId": item.source_id,
                 "factIds": list(item.fact_ids), "contentSha256": sha(item.text.encode("utf-8"))}
                for item in replay.evidence]
    pages = []
    for page in replay.observed_context.read_pages:
        index = page.turn_index
        call = trace["turns"][index]["normalized_executed_call"]
        pages.append({"turnIndex": index, "channelKind": page.channel_kind, "coworker": page.coworker,
                      "page": page.page, "hasOlder": page.has_older, "messageIds": list(page.message_ids),
                      "callId": call["call_id"], "subsequentInferenceIndex": index + 1,
                      "subsequentRequestSha256": sha(canonical(
                          trace["turns"][index + 1]["model_visible_request"]))})
    expected = {item["path"]: item["sha256"] for item in source_manifest["files"]}
    imported = []
    for name, module in sorted(sys.modules.items()):
        if name == "probing" or name.startswith("probing."):
            filename = getattr(module, "__file__", None)
            require(type(filename) is str, "native_import_failed")
            path = Path(filename).resolve()
            require(stage in path.parents, "native_import_failed")
            relative_path = str(path.relative_to(stage))
            require(relative_path in expected and sha(path.read_bytes()) == expected[relative_path], "source_changed")
            imported.append({"name": name, "path": relative_path, "sha256": expected[relative_path]})
    # Catalog data and dynamically loaded original modules also remain pinned.
    for item in source_manifest["files"]:
        require(sha((stage / item["path"]).read_bytes()) == item["sha256"], "source_changed")
    return {"inputs": inputs,
            "episode": {**request["episode"], "worldFingerprint": fingerprint(episode)},
            "brief": replay.brief,
            "publicTask": replay.observed_context.public_task,
            "memo": replay.memo, "memoSha256": sha(replay.memo.encode("utf-8")),
            "worldFacts": world_facts, "worldFactsSha256": sha(canonical(world_facts)),
            "requiredFactIds": required_ids,
            "requiredFactsSha256": sha(canonical([by_id[key] for key in sorted(required_ids)])),
            "sourceBindings": dict(replay.source_bindings), "facts": facts, "evidence": evidence,
            "observedMessages": [{"messageId": item.message_id, "sourceId": item.source_id,
                                  "sender": item.sender, "text": item.text, "channelKind": item.channel_kind,
                                  "isPolicyMessage": item.is_policy_message}
                                 for item in replay.observed_context.messages],
            "readPages": pages, "terminal": {"valid": replay.terminal_valid, "status": replay.terminal_status},
            "arrivalBasis": "validated_state_reconstruction", "semanticEvaluation": "unassessed",
            "taskSuccess": "unassessed", "scientificEvaluation": "unassessed", "importedSourceModules": imported}


def run(request):
    source_manifest = manifest()
    guard = EffectGuard()
    sys.addaudithook(guard.audit)
    stage = Path(tempfile.mkdtemp(prefix="rlh-observed-replay-")).resolve()
    guard.stage = stage
    try:
        stage_source(request["sourceRoot"], stage, source_manifest)
        result, trace, provenance, inputs = load_artifacts(request)
        guard.strict_files = True
        value = project(request, result, trace, provenance, inputs, stage, source_manifest)
        require(not guard.denied, "side_effect_denied")
        return value
    finally:
        # Absolute cleanup paths keep the guard active; no arbitrary dir-fd
        # exception is needed for the recursive remover.
        guard.cleanup = True
        for directory, directories, files in os.walk(stage, topdown=False, followlinks=False):
            for filename in files:
                os.unlink(Path(directory) / filename)
            for name in directories:
                os.rmdir(Path(directory) / name)
        os.rmdir(stage)


def main():
    input_digest = None
    output = {"schemaVersion": 1, "kind": "coworker-observed-replay-result", "status": "rejected",
              "inputDigest": None, "sourceManifestSha256": SOURCE_MANIFEST_SHA256,
              "pythonVersion": sys.version.split()[0], "reason": None, "result": None}
    try:
        require(sys.version_info >= (3, 11) and sys.flags.isolated and sys.flags.no_site
                and sys.dont_write_bytecode, "runtime_unavailable")
        raw = sys.stdin.buffer.read(REQUEST_BYTES + 1)
        require(len(raw) <= REQUEST_BYTES, "size_limit")
        request = parse_json(raw)
        input_digest = sha(canonical(request))
        validate_request(request)
        value = run(request)
        output.update(status="completed", inputDigest=input_digest, result=value)
        require(len(canonical(output)) + 1 <= OUTPUT_BYTES, "size_limit")
    except Rejected as error:
        output.update(status="rejected", inputDigest=input_digest, reason=error.reason, result=None)
    except Exception:
        output.update(status="rejected", inputDigest=input_digest, reason="worker_failed", result=None)
    sys.stdout.buffer.write(canonical(output) + b"\n")
    return 0 if output["status"] == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
