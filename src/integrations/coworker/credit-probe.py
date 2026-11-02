"""Execute one of two reviewed extraction modules against a bounded case packet.

This is a source-hash allowlist, not a sandbox for arbitrary Python. The parent
must impose the process deadline/output limit and launch with a minimal
environment and -I -B -S. Only captured, verified source bytes are executed;
project imports, expected labels and source-registry overrides are unsupported.
"""

import errno
import hashlib
import itertools
import json
import os
import re
import stat
import sys
import types


SOURCE_HASHES = frozenset({
    "ce0d32352e386ee0cf4c5d1ad2da34fd70e17690851eda15fe495740cdc0785b",
    "4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101",
})
MAX_REQUEST_BYTES = 256 * 1024
MAX_SOURCE_BYTES = 128 * 1024
MAX_OUTPUT_BYTES = 128 * 1024
_MODULE_SEQUENCE = itertools.count()


class ProbeError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="invalid_request"):
    if not condition:
        raise ProbeError(code)


def object_pairs(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "invalid_json")
        value[key] = item
    return value


def parse_request(data):
    require(type(data) is bytes and len(data) <= MAX_REQUEST_BYTES, "request_limit")
    try:
        return json.loads(
            data.decode("utf-8"), object_pairs_hook=object_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ProbeError("invalid_json")),
        )
    except (UnicodeError, ValueError, RecursionError):
        raise ProbeError("invalid_json") from None


def fields(value, expected):
    require(type(value) is dict and set(value) == set(expected))


def string(value, maximum, *, empty=False, multiline=False):
    require(type(value) is str and (empty or bool(value.strip())) and len(value) <= maximum)
    require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value))
    require(not any(ord(c) == 127 or (ord(c) < 32 and (not multiline or c not in "\n\r\t")) for c in value))
    return value


def identifier(value):
    string(value, 96)
    require(re.fullmatch(r"[A-Za-z0-9_.:-]+", value) is not None)
    return value


def source_path(value):
    string(value, 4096)
    require(value.startswith("/") and value != "/" and "\\" not in value
            and all(part not in ("", ".", "..") for part in value.split("/")[1:]))
    return value


def encoded(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")


def validate_request(value):
    fields(value, ("schemaVersion", "kind", "source", "cases"))
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
            and value["kind"] == "coworker-credit-probe")
    source = value["source"]
    fields(source, ("path", "sha256"))
    source_path(source["path"])
    require(type(source["sha256"]) is str and source["sha256"] in SOURCE_HASHES, "unsupported_source")
    cases = value["cases"]
    require(type(cases) is list and 1 <= len(cases) <= 128)
    case_ids = set()
    for case in cases:
        fields(case, ("id", "text", "facts"))
        case_id = identifier(case["id"])
        require(case_id not in case_ids)
        case_ids.add(case_id)
        string(case["text"], 8192, empty=True, multiline=True)
        facts = case["facts"]
        require(type(facts) is list and 1 <= len(facts) <= 16)
        fact_ids = set()
        for fact in facts:
            fields(fact, ("id", "value", "unit", "aliases"))
            fact_id = identifier(fact["id"])
            require(fact_id not in fact_ids)
            fact_ids.add(fact_id)
            string(fact["value"], 256)
            string(fact["unit"], 32)
            aliases = fact["aliases"]
            require(type(aliases) is list and 1 <= len(aliases) <= 16)
            for alias in aliases:
                string(alias, 256)
                require(bool(alias.strip()))
            require(len(set(aliases)) == len(aliases))
    # A null verdict with the longest error is larger than either Boolean with
    # error:null. Refuse output overflow before loading any scorer source.
    require(len(encoded(result_shape(value, None, "scorer_exception"))) + 1 <= MAX_OUTPUT_BYTES,
            "output_limit")
    return value


def result_shape(request, default, error=None):
    input_digest = hashlib.sha256(json.dumps(
        request, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()
    return {
        "schemaVersion": 1, "kind": "coworker-credit-probe-result",
        "sourceSha256": request["source"]["sha256"], "probeInputDigest": input_digest,
        "cases": [{"id": case["id"], "facts": [
            {"id": fact["id"], "credited": default, "error": error} for fact in case["facts"]
        ]} for case in request["cases"]],
    }


def credit_fact(credited, text, fact):
    """A scorer exception is missing evidence, never a negative verdict."""
    try:
        value = credited(text, fact["value"], fact["unit"], tuple(fact["aliases"]))
    except Exception:
        return {"id": fact["id"], "credited": None, "error": "scorer_exception"}
    if type(value) is not bool:
        return {"id": fact["id"], "credited": None, "error": "invalid_verdict"}
    return {"id": fact["id"], "credited": value, "error": None}


def read_source(path, expected_hash):
    source_path(path)
    require(type(expected_hash) is str and expected_hash in SOURCE_HASHES, "unsupported_source")
    descriptors = []
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        directory = os.open("/", flags)
        descriptors.append(directory)
        parts = path.split("/")[1:]
        for part in parts[:-1]:
            directory = os.open(part, flags, dir_fd=directory)
            descriptors.append(directory)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=directory)
        descriptors.append(fd)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "unsafe_path")
        require(before.st_size <= MAX_SOURCE_BYTES, "source_too_large")
        chunks = []
        count = 0
        while True:
            chunk = os.read(fd, min(65536, MAX_SOURCE_BYTES + 1 - count))
            if not chunk:
                break
            count += len(chunk)
            require(count <= MAX_SOURCE_BYTES, "source_too_large")
            chunks.append(chunk)
        after = os.fstat(fd)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                                 info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(after) and count == after.st_size, "source_changed")
        data = b"".join(chunks)
        require(hashlib.sha256(data).hexdigest() == expected_hash, "source_mismatch")
        return data
    except OSError as error:
        code = ("source_missing" if error.errno == errno.ENOENT else "unsafe_path"
                if error.errno in (errno.ELOOP, errno.ENOTDIR) else "source_unreadable")
        raise ProbeError(code) from None
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def probe(request):
    request = validate_request(request)
    source = read_source(request["source"]["path"], request["source"]["sha256"])
    digest = request["source"]["sha256"]
    name = "_coworker_credit_" + digest + "_" + str(next(_MODULE_SEQUENCE))
    module = types.ModuleType(name)
    module.__file__ = "<reviewed-credit-source:" + digest + ">"
    # Dataclass resolves string annotations through sys.modules. Register this
    # private module only for its lifetime; never add an inspected import path.
    sys.modules[name] = module
    try:
        exec(compile(source, module.__file__, "exec", dont_inherit=True), module.__dict__)
        result = result_shape(request, False)
        for case, output in zip(request["cases"], result["cases"]):
            output["facts"] = [credit_fact(module.credited, case["text"], fact) for fact in case["facts"]]
        return result
    except Exception:
        raise ProbeError("scorer_failed") from None
    finally:
        sys.modules.pop(name, None)


def main():
    try:
        require(sys.version_info >= (3, 11) and os.name == "posix"
                and sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode
                and os.open in os.supports_dir_fd
                and all(hasattr(os, flag) for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC")),
                "runtime_unavailable")
        require(len(sys.argv) == 1, "invalid_request")
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        output = encoded(probe(parse_request(data))) + b"\n"
        require(len(output) <= MAX_OUTPUT_BYTES, "output_limit")
        sys.stdout.buffer.write(output)
        return 0
    except ProbeError as error:
        sys.stdout.buffer.write(encoded({"error": error.code}) + b"\n")
        return 2
    except (Exception, KeyboardInterrupt):
        sys.stdout.buffer.write(b'{"error":"probe_failed"}\n')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
