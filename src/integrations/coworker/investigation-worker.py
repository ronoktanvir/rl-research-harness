"""Fixed, read-only historical evidence parser. No inspected code is imported or executed.

The archive commit->tree relationship is a saved declaration, not Git commit
signature verification. File hashes establish current byte correspondence only.
"""
import collections
import errno
import hashlib
import json
import math
import os
import re
import stat
import sys

BASE = "artifacts/probing-helper-artifacts/"
SOURCE_PREFIX = "experiments/probing/src/probing/"
SUPPORTED_SOURCE = "ccfd25df63f55e408b67e984710eb6d3dd9e609f"
SMALL = 4 * 1024 * 1024
LINE = 8 * 1024 * 1024
TRACE = 800 * 1024 * 1024
ADAPTER = 400 * 1024 * 1024
MAX_RECORDS = 1000
SUCCESS = "verified_byte_correspondence_and_producer_counts"
CHECKS = ("report", "source", "adapter", "trained_evaluation", "baseline_evaluation", "comparison")


class EvidenceError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="evidence_mismatch"):
    if not condition:
        raise EvidenceError(code)


def exact_int(value, minimum=0, maximum=2**53 - 1):
    require(type(value) is int and minimum <= value <= maximum, "invalid_json")
    return value


def text(value, maximum=256):
    require(type(value) is str and 0 < len(value) <= maximum and not any(ord(c) < 32 for c in value), "invalid_json")
    return value


def hex_value(value, length=64):
    require(type(value) is str and re.fullmatch(r"[a-f0-9]{%d}" % length, value) is not None, "invalid_json")
    return value


def relative(path):
    require(type(path) is str and len(path) <= 4096 and not path.startswith("/")
            and not any(c in path for c in "\0\r\n\\")
            and all(p not in ("", ".", "..") for p in path.split("/")), "unsafe_path")
    return path


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "invalid_json")
        result[key] = value
    return result


def parse_json(data):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=object_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(EvidenceError("invalid_json")))
    except (UnicodeError, ValueError, RecursionError):
        raise EvidenceError("invalid_json") from None


def canonical(value):
    # Used only for selected metadata equality; not the TypeScript request digest.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def ref(path, data):
    return {"path": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class Reader:
    """Pin root once and descend from descriptors; never follow a selected symlink."""
    def __init__(self, root):
        require(os.name == "posix" and sys.version_info >= (3, 11)
                and os.open in os.supports_dir_fd and all(hasattr(os, flag) for flag in
                    ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC")), "reader_unavailable")
        require(type(root) is str and root.startswith("/") and root != "/"
                and os.path.normpath(root) == root and len(root) <= 4096
                and not any(c in root for c in "\0\r\n\\"), "unsafe_path")
        self.root = None
        self.observed = []
        self.files = 0
        self.total_bytes = 0
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open("/", flags)
        try:
            for part in root.split("/")[1:]:
                next_fd = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            self.root = fd
        except BaseException:
            os.close(fd)
            raise

    def close(self):
        if self.root is not None:
            os.close(self.root)
            self.root = None

    def open(self, path, maximum):
        relative(path)
        self.files += 1
        require(self.files <= 1100, "size_limit")
        fd = os.dup(self.root)
        try:
            parts = path.split("/")
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd)
                fd = child
            leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        finally:
            os.close(fd)
        before = os.fstat(leaf)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            os.close(leaf)
            raise EvidenceError("unsafe_path")
        if before.st_size > maximum:
            os.close(leaf)
            raise EvidenceError("size_limit")
        return leaf, before

    def finish(self, fd, before, count):
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink)
                and count == after.st_size, "file_changed")
        self.total_bytes += count
        require(self.total_bytes <= 2 * 1024 * 1024 * 1024, "size_limit")

    def note(self, identity):
        if not identity["path"].startswith("history/halluminate/blobs/"):
            require(len(self.observed) < 8, "size_limit")
            self.observed.append(identity)
        return identity

    def small(self, path, maximum=SMALL):
        fd, before = self.open(path, maximum)
        try:
            chunks = []
            count = 0
            while True:
                data = os.read(fd, min(65536, maximum + 1 - count))
                if not data:
                    break
                count += len(data)
                require(count <= maximum, "size_limit")
                chunks.append(data)
            self.finish(fd, before, count)
            data = b"".join(chunks)
            return self.note(ref(path, data)), data
        finally:
            os.close(fd)

    def json(self, path):
        identity, data = self.small(path)
        return identity, parse_json(data)

    def stream(self, path, maximum, consume=None):
        fd, before = self.open(path, maximum)
        digest = hashlib.sha256()
        count = records = 0
        try:
            with os.fdopen(fd, "rb", closefd=False) as stream:
                while True:
                    data = stream.readline(LINE + 1) if consume else stream.read(1024 * 1024)
                    if not data:
                        break
                    count += len(data)
                    require(count <= maximum, "size_limit")
                    digest.update(data)
                    if consume:
                        require(len(data) <= LINE, "size_limit")
                        records += 1
                        require(records <= MAX_RECORDS, "size_limit")
                        consume(parse_json(data))
                self.finish(fd, before, count)
            return self.note({"path": path, "bytes": count, "sha256": digest.hexdigest()})
        finally:
            os.close(fd)


def validate_request(request):
    require(type(request) is dict and set(request) == {"schemaVersion", "kind", "root", "report", "localArtifacts", "requestDigest"}, "invalid_input")
    require(type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["kind"] == "coworker-run1-investigation", "invalid_input")
    report = request["report"]
    require(type(report) is dict and set(report) == {"path", "sha256", "bytes"}, "invalid_input")
    path = relative(report["path"])
    require(path.startswith(BASE) and path.endswith("/report.json"), "invalid_input")
    hex_value(report["sha256"])
    exact_int(report["bytes"], 1, SMALL)
    hex_value(request["requestDigest"])
    selected = request["localArtifacts"]
    require(type(selected) is dict and set(selected) == {"adapterPath", "trainedTracePath", "baselineTracePath", "trainedEvaluationDirectory", "baselineEvaluationDirectory"}, "invalid_input")
    for path in selected.values():
        relative(path)
    a, b = selected["trainedEvaluationDirectory"], selected["baselineEvaluationDirectory"]
    require(a.startswith(BASE) and b.startswith(BASE) and a != b and a.rsplit("/", 1)[0] == b.rsplit("/", 1)[0], "invalid_input")
    for name, directory in (("trained", a), ("baseline", b)):
        require(selected[name + "TracePath"] == ".local-artifacts/" + directory + "/step0-trace.jsonl", "invalid_input")
    prefix = ".local-artifacts/" + request["report"]["path"].rsplit("/", 1)[0] + "/"
    require(selected["adapterPath"].startswith(prefix)
            and re.fullmatch(r"adapter-step-(0|[1-9][0-9]*)/adapter_model\.safetensors", selected["adapterPath"][len(prefix):]), "invalid_input")
    body = {key: value for key, value in request.items() if key != "requestDigest"}
    require(hashlib.sha256(canonical(body).encode("utf-8")).hexdigest() == request["requestDigest"], "invalid_input")
    return request


def validate_plan(plan):
    require(type(plan) is dict and type(plan.get("plan")) is list and 0 < len(plan["plan"]) <= MAX_RECORDS, "invalid_json")
    hex_value(plan.get("set_fingerprint"))
    worlds, indices = set(), set()
    for item in plan["plan"]:
        require(type(item) is dict, "invalid_json")
        index = exact_int(item.get("index"), 0, MAX_RECORDS - 1)
        seed = exact_int(item.get("seed"))
        require(exact_int(item.get("g"), 1, 1) == 1)
        world = (text(item.get("config_id")), seed)
        require(world not in worlds and index not in indices)
        worlds.add(world)
        indices.add(index)
    require(indices == set(range(len(worlds))))
    return worlds


def row_identity(row):
    require(type(row) is dict, "invalid_json")
    world = (text(row.get("config_id")), exact_int(row.get("seed")))
    trace = text(row.get("trace_id"))
    result = text(row.get("result_id"))
    require(exact_int(row.get("slot"), 0, 0) == 0)
    return world, trace, result


class Judged:
    def __init__(self):
        self.joins = set()
        self.worlds = set()
        self.traces = set()
        self.results = set()
        self.credits = [0, 0, 0]
        self.clean = self.ok = self.other = self.errors = 0

    def add(self, row):
        world, trace, result = row_identity(row)
        require(world not in self.worlds and trace not in self.traces and result not in self.results)
        self.worlds.add(world); self.traces.add(trace); self.results.add(result)
        self.joins.add((world, trace, result))
        require(type(row.get("diagnostics")) is dict and "error" in row, "invalid_json")
        d = row["diagnostics"]
        credit = exact_int(d.get("targets_credited"), 0, 2)
        require(type(d.get("clean_success")) is bool, "invalid_json")
        self.credits[credit] += 1
        self.clean += int(d["clean_success"])
        status = text(row.get("status"), 64)
        self.ok += int(status == "ok"); self.other += int(status != "ok")
        self.errors += int(row["error"] is not None)


def selected_policy(policy):
    require(type(policy) is dict, "invalid_json")
    # Only hash this bounded projection; no endpoint, prompt, response or transcript escapes.
    selected = {key: policy[key] for key in ("decoding", "thinking", "vllm_version", "chat_template_sha256", "tokenizer_sha256")}
    require(type(selected["thinking"]) is bool, "invalid_json")
    text(selected["vllm_version"], 64)
    hex_value(selected["chat_template_sha256"]); hex_value(selected["tokenizer_sha256"])
    encoded = canonical(selected)
    require(len(encoded.encode()) <= 8192, "size_limit")
    return encoded


class Traces:
    def __init__(self, expected_adapter):
        self.joins = set(); self.worlds = set(); self.traces = set(); self.results = set()
        self.complete = 0
        self.metadata = None
        self.settings = None
        self.expected_adapter = expected_adapter

    def add(self, row):
        world, trace, result = row_identity(row)
        require(world not in self.worlds and trace not in self.traces and result not in self.results)
        self.worlds.add(world); self.traces.add(trace); self.results.add(result)
        self.joins.add((world, trace, result))
        require(type(row.get("complete")) is bool and type(row.get("policy")) is dict, "invalid_json")
        self.complete += int(row["complete"])
        p = row["policy"]
        require(hex_value(p.get("adapter_sha256")) == self.expected_adapter)
        base_revision = text(p.get("base_model_revision"), 40)
        require(re.fullmatch(r"[a-f0-9]{8,40}", base_revision), "invalid_json")
        metadata = {"adapterSha256": self.expected_adapter, "runtimeSourceSha": hex_value(p.get("runtime_source_sha"), 40),
                    "baseModelRevision": base_revision, "tokenizerSha256": hex_value(p.get("tokenizer_sha256")),
                    "schemaContractHash": hex_value(row.get("schema_contract_hash"))}
        settings = selected_policy(p)
        if self.metadata is None:
            self.metadata, self.settings = metadata, settings
        require(self.metadata == metadata and self.settings == settings)


def checksums_from(data):
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeError:
        raise EvidenceError("invalid_json") from None
    require(len(lines) <= 1000, "size_limit")
    result = {}
    for line in lines:
        parts = line.split()
        require(len(parts) == 2, "invalid_json")
        digest = hex_value(parts[0]); path = relative(parts[1].removeprefix("./"))
        require(path not in result, "invalid_json")
        result[path] = digest
    return result


def verify_source(reader, report):
    require(report.get("runtime_source_sha") == SUPPORTED_SOURCE, "unsupported_source")
    declared_digest = hex_value(report.get("source_tree_digest"))
    revisions_ref, revisions = reader.json("history/halluminate/revisions.json")
    require(type(revisions) is dict and type(revisions.get("revisions")) is list, "invalid_json")
    matches = [r for r in revisions["revisions"] if type(r) is dict and r.get("commit") == SUPPORTED_SOURCE]
    require(len(matches) == 1)
    tree_id = hex_value(matches[0].get("snapshot"))
    tree_ref, tree = reader.json("history/halluminate/trees/" + tree_id + ".json")
    require(tree_ref["sha256"] == tree_id)
    require(type(tree) is list and len(tree) <= 10_000, "invalid_json")
    entries, paths = [], set()
    for entry in tree:
        require(type(entry) is list and len(entry) == 3, "invalid_json")
        path, mode, oid = entry
        relative(path)
        require(path not in paths, "invalid_json"); paths.add(path)
        if path.startswith(SOURCE_PREFIX) and path.endswith(".py"):
            require(mode == "100644", "unsupported_source")
            entries.append((path, hex_value(oid, 40)))
    require(0 < len(entries) <= 1000, "size_limit")
    digest = hashlib.sha256(); size = 0
    for path, oid in sorted(entries):
        _, data = reader.small("history/halluminate/blobs/" + oid, 1_000_000)
        require(hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == oid)
        size += len(data); require(size <= 64 * 1024 * 1024, "size_limit")
        digest.update(path.removeprefix(SOURCE_PREFIX).encode()); digest.update(data)
    require(digest.hexdigest() == declared_digest)
    return revisions_ref, tree_ref, {"commit": SUPPORTED_SOURCE, "archiveTreeId": tree_id,
        "pythonFiles": len(entries), "pythonBytes": size, "pythonSourceSha256": digest.hexdigest(), "gitBlobIdsVerified": True}


def verify_cell(reader, directory, trace_path, adapter_sha, checksums, funnel):
    name = directory.rsplit("/", 1)[1]
    plan_ref, plan = reader.json(directory + "/cell-plan.json")
    worlds = validate_plan(plan)
    summary_ref, summary = reader.json(directory + "/cell-summary.json")
    require(type(summary) is dict and summary.get("cell") == name and summary.get("rehearsal") is False, "invalid_json")
    require(summary.get("set_fingerprint") == plan["set_fingerprint"])
    ran = exact_int(summary.get("ran"), 0, MAX_RECORDS)
    resumed = exact_int(summary.get("resumed_from"), 0, MAX_RECORDS)
    scored = exact_int(summary.get("scored_total"), 1, MAX_RECORDS)
    require(ran + resumed == scored == len(worlds))
    judged = Judged()
    judged_ref = reader.stream(directory + "/step0-judged-results.jsonl", SMALL, judged.add)
    require(judged.worlds == worlds and len(judged.joins) == len(worlds))
    traces = Traces(adapter_sha)
    traces_ref = reader.stream(trace_path, TRACE, traces.add)
    require(traces.joins == judged.joins and traces.worlds == worlds)
    require(checksums.get(name + "/step0-trace.jsonl") == traces_ref["sha256"]
            and checksums.get(name + "/step0-judged-results.jsonl") == judged_ref["sha256"])
    primary = funnel["cells"][name]["primary"]
    require(type(primary) is dict, "invalid_json")
    credited = judged.credits[1] + 2 * judged.credits[2]
    require(exact_int(primary.get("acquired_and_credited"), 0, 2 * scored) == credited)
    denominator = exact_int(primary.get("denominator_all_required_facts"), 1, 2 * MAX_RECORDS)
    require(denominator == 2 * scored)
    rate = primary.get("rate")
    require(type(rate) in (int, float) and math.isfinite(rate) and abs(rate - round(credited / denominator, 4)) < 1e-12, "invalid_json")
    return {"plan": plan_ref, "summary": summary_ref, "judgedResults": judged_ref, "traces": traces_ref,
        "rows": scored, "uniqueWorlds": len(worlds), "uniqueTraceIds": len(traces.traces), "uniqueResultIds": len(traces.results),
        "exactJudgedTraceJoin": True, "producerCompleteCount": traces.complete,
        "producerStatusOkCount": judged.ok, "producerStatusOtherCount": judged.other, "producerErrorCount": judged.errors,
        "producerTargetsCredited": credited, "producerCleanSuccessCount": judged.clean, "producerCreditHistogram": judged.credits,
        "summaryRan": ran, "summaryResumedFrom": resumed, "summaryScoredTotal": scored,
        "storedFunnelDenominator": denominator, "storedFunnelRate": rate,
        "setFingerprint": plan["set_fingerprint"], "selectedPolicySettingsSha256": hashlib.sha256(traces.settings.encode()).hexdigest(),
        **traces.metadata}, worlds


def investigate(request):
    observations = []
    reader = None
    def completed(files):
        observations.append({"check": CHECKS[len(observations)], "status": "verified", "reason": SUCCESS, "files": files})
        if reader:
            reader.observed = []
    try:
        request = validate_request(request)
        reader = Reader(request["root"])
        report_ref, report = reader.json(request["report"]["path"])
        require(report_ref == request["report"])
        require(type(report) is dict, "invalid_json")
        manifest_ref, manifest = reader.json(request["report"]["path"].removesuffix("report.json") + "run-manifest.json")
        shared = ("adapter_weight_dtypes", "base_revision", "init", "initial_adapter_sha256", "runtime_source_sha", "source_tree_digest", "tokenizer_json_sha256")
        require(type(manifest) is dict and all(k in report and k in manifest and report[k] == manifest[k] for k in shared))
        steps = report.get("steps")
        require(type(steps) is list and 0 < len(steps) <= MAX_RECORDS, "invalid_json")
        require([exact_int(step.get("step_index"), 0, MAX_RECORDS - 1) for step in steps] == list(range(len(steps))))
        final_digest = hex_value(steps[-1]["checkpoint"]["adapter_sha256"])
        selected = request["localArtifacts"]
        require(selected["adapterPath"] == ".local-artifacts/" + request["report"]["path"].removesuffix("report.json")
                + "adapter-step-" + str(len(steps) - 1) + "/adapter_model.safetensors")
        completed([report_ref, manifest_ref])
        revisions_ref, tree_ref, source = verify_source(reader, report)
        completed([revisions_ref, tree_ref])
        adapter_ref = reader.stream(selected["adapterPath"], ADAPTER)
        require(adapter_ref["sha256"] == final_digest)
        completed([adapter_ref])
        parent = selected["trainedEvaluationDirectory"].rsplit("/", 1)[0]
        checksums_ref, checksum_data = reader.small(parent + "/SHA256SUMS")
        checksums = checksums_from(checksum_data)
        funnel_ref, funnel = reader.json(parent + "/funnel.json")
        require(type(funnel) is dict and type(funnel.get("cells")) is dict, "invalid_json")
        trained, trained_worlds = verify_cell(reader, selected["trainedEvaluationDirectory"], selected["trainedTracePath"], final_digest, checksums, funnel)
        completed([checksums_ref, funnel_ref] + [trained[k] for k in ("plan", "summary", "judgedResults", "traces")])
        baseline, baseline_worlds = verify_cell(reader, selected["baselineEvaluationDirectory"], selected["baselineTracePath"], hashlib.sha256(b"").hexdigest(), checksums, funnel)
        completed([baseline[k] for k in ("plan", "summary", "judgedResults", "traces")])
        base_revision = hex_value(report.get("base_revision"), 40)
        tokenizer = hex_value(report.get("tokenizer_json_sha256"))
        require(all(base_revision.startswith(cell["baseModelRevision"]) and cell["tokenizerSha256"] == tokenizer for cell in (trained, baseline)))
        require(trained["runtimeSourceSha"] == baseline["runtimeSourceSha"] and trained["schemaContractHash"] == baseline["schemaContractHash"]
                and trained["baseModelRevision"] == baseline["baseModelRevision"])
        require(trained_worlds == baseline_worlds and trained["setFingerprint"] == baseline["setFingerprint"]
                and trained["selectedPolicySettingsSha256"] == baseline["selectedPolicySettingsSha256"])
        configs = report["config"]["config_ids"]
        require(type(configs) is list and 0 < len(configs) <= 1000, "invalid_json")
        training_configs = {text(c) for c in configs}
        require(len(training_configs) == len(configs))
        eval_configs = {world[0] for world in trained_worlds}
        require(training_configs.isdisjoint(eval_configs))
        completed([])
        result = {"schemaVersion": 1, "kind": "coworker-run1-investigation-result", "requestDigest": request["requestDigest"],
            "report": report_ref, "runManifest": manifest_ref, "revisions": revisions_ref, "archiveTree": tree_ref,
            "adapter": adapter_ref, "checksums": checksums_ref, "funnel": funnel_ref, "source": source,
            "cells": {"trained": trained, "baseline": baseline}, "trainingConfigCount": len(training_configs),
            "evaluationConfigCount": len(eval_configs), "configOverlapCount": 0, "sameEvaluationWorlds": True,
            "sameSelectedPolicySettings": True, "producerCreditedDifference": trained["producerTargetsCredited"] - baseline["producerTargetsCredited"],
            "scientificReplicationCount": 1, "comparator": "bare_base", "scientificEvaluation": "unassessed", "historicalExecution": "unverified"}
        return {"status": "completed", "reason": SUCCESS, "observations": observations, "result": result}
    except EvidenceError as error:
        reason = error.code
    except OSError as error:
        reason = "missing_file" if error.errno == errno.ENOENT else "unsafe_path" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "unreadable"
    except (KeyError, TypeError, ValueError, AttributeError, RecursionError, OverflowError):
        reason = "invalid_json"
    finally:
        if reader:
            reader.close()
    observations.append({"check": CHECKS[len(observations)], "status": "failed", "reason": reason, "files": reader.observed if reader else []})
    return {"status": "incomplete", "reason": reason, "observations": observations, "result": None}


def main():
    try:
        data = sys.stdin.buffer.read(16385)
        require(len(data) <= 16384, "size_limit")
        result = investigate(parse_json(data))
        output = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        require(len(output.encode()) <= 65536, "size_limit")
    except EvidenceError as error:
        output = json.dumps({"status": "incomplete", "reason": error.code, "observations": [], "result": None})
    except Exception:
        # Never print a path, source data or exception traceback on this protocol.
        output = json.dumps({"status": "incomplete", "reason": "unreadable", "observations": [], "result": None})
    print(output)


if __name__ == "__main__":
    main()
