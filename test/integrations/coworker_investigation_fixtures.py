"""Synthetic supported-format evidence. No copied project code or real trace content."""
import hashlib
import json
from pathlib import Path

COMMIT = "ccfd25df63f55e408b67e984710eb6d3dd9e609f"
BASE = "artifacts/probing-helper-artifacts/"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def create_fixture(root, label="first", rows=3):
    root = Path(root)
    def write(path, data):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return hashlib.sha256(data).hexdigest()
    def jwrite(path, value):
        return write(path, encode(value))
    run_dir = BASE + "training-" + label + "/main"
    eval_parent = BASE + "evaluation-" + label
    adapter_path = ".local-artifacts/" + run_dir + "/adapter-step-0/adapter_model.safetensors"
    adapter_sha = write(adapter_path, ("synthetic-weight-bytes-" + label).encode())
    source_data = ("# inert source fixture " + label + "\n").encode()
    oid = hashlib.sha1(b"blob " + str(len(source_data)).encode() + b"\0" + source_data).hexdigest()
    write("history/halluminate/blobs/" + oid, source_data)
    tree_data = encode([["experiments/probing/src/probing/fixture.py", "100644", oid]])
    tree_sha = hashlib.sha256(tree_data).hexdigest()
    write("history/halluminate/trees/" + tree_sha + ".json", tree_data)
    jwrite("history/halluminate/revisions.json", {"revisions": [{"commit": COMMIT, "snapshot": tree_sha}]})
    shared = {"adapter_weight_dtypes": {"float32": 1}, "base_revision": "b" * 40, "init": "test",
              "initial_adapter_sha256": "a" * 64, "runtime_source_sha": COMMIT,
              "source_tree_digest": hashlib.sha256(b"fixture.py" + source_data).hexdigest(), "tokenizer_json_sha256": "e" * 64}
    report = {**shared, "steps": [{"step_index": 0, "checkpoint": {"adapter_sha256": adapter_sha}}], "config": {"config_ids": ["train-" + label]}}
    report_data = encode(report)
    report_path = run_dir + "/report.json"
    write(report_path, report_data); jwrite(run_dir + "/run-manifest.json", shared)
    checksums = []
    funnel = {"cells": {}}
    for name in ("trained", "baseline"):
        directory = eval_parent + "/" + name
        plan = {"set_fingerprint": "f" * 64, "plan": [{"index": i, "config_id": "eval-" + label, "seed": 1000 + i, "g": 1} for i in range(rows)]}
        jwrite(directory + "/cell-plan.json", plan)
        jwrite(directory + "/cell-summary.json", {"cell": name, "rehearsal": False, "set_fingerprint": "f" * 64,
            "ran": rows - 1, "resumed_from": 1, "scored_total": rows})
        judged, traces = [], []
        for i in range(rows):
            identity = {"config_id": "eval-" + label, "seed": 1000 + i, "trace_id": name + "-trace-" + str(i), "result_id": name + "-result-" + str(i), "slot": 0}
            judged.append({**identity, "diagnostics": {"targets_credited": int(name == "trained" and i == 0), "clean_success": False}, "status": "ok", "error": None, "transcript": ["SENTINEL PRIVATE PROMPT"]})
            traces.append({**identity, "complete": True, "schema_contract_hash": "c" * 64,
                "policy": {"adapter_sha256": adapter_sha if name == "trained" else hashlib.sha256(b"").hexdigest(),
                    "runtime_source_sha": "d" * 40, "base_model_revision": "b" * 8, "tokenizer_sha256": "e" * 64,
                    "decoding": {"temperature": 0.6}, "thinking": True, "vllm_version": "0.25.1", "chat_template_sha256": "a" * 64,
                    "endpoint_base_url": "SENTINEL PRIVATE ENDPOINT"}, "turns": ["SENTINEL PRIVATE TRACE"]})
        for filename, data in (("step0-judged-results.jsonl", judged), ("step0-trace.jsonl", traces)):
            raw = b"".join(encode(row) + b"\n" for row in data)
            path = directory + "/" + filename
            if filename == "step0-trace.jsonl":
                path = ".local-artifacts/" + path
            checksum = write(path, raw)
            checksums.append(checksum + "  ./" + name + "/" + filename)
        credit = int(name == "trained")
        funnel["cells"][name] = {"primary": {"acquired_and_credited": credit, "denominator_all_required_facts": rows * 2, "rate": round(credit / (rows * 2), 4)}}
    write(eval_parent + "/SHA256SUMS", ("\n".join(checksums) + "\n").encode())
    jwrite(eval_parent + "/funnel.json", funnel)
    request = {"schemaVersion": 1, "kind": "coworker-run1-investigation", "root": str(root.resolve()),
        "report": {"path": report_path, "bytes": len(report_data), "sha256": hashlib.sha256(report_data).hexdigest()},
        "localArtifacts": {"adapterPath": adapter_path,
            "trainedEvaluationDirectory": eval_parent + "/trained", "baselineEvaluationDirectory": eval_parent + "/baseline",
            "trainedTracePath": ".local-artifacts/" + eval_parent + "/trained/step0-trace.jsonl",
            "baselineTracePath": ".local-artifacts/" + eval_parent + "/baseline/step0-trace.jsonl"}}
    request["requestDigest"] = hashlib.sha256(encode(request)).hexdigest()
    return request

if __name__ == "__main__":
    import sys
    print(json.dumps(create_fixture(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "first")))
