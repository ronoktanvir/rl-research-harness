"""Trusted byte inventory only. Isolated Python; never imports inspected source.

Descriptor-relative reads and a second metadata walk detect ordinary concurrent
changes. They cannot freeze a deployment or exclude privileged timestamp forgery.
"""
import errno
import hashlib
import json
import os
import stat
import sys

CAPS = {"maxFiles": 4096, "maxDirectories": 2048, "maxDepth": 32,
        "maxFileBytes": 64 * 1024 * 1024, "maxTotalBytes": 256 * 1024 * 1024}
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Rejected(Exception):
    def __init__(self, problem):
        self.problem = problem


def require(condition, problem="unsafe_path"):
    if not condition:
        raise Rejected(problem)


def component(name):
    require(isinstance(name, str) and name not in ("", ".", "..")
            and len(name.encode("utf-8", "strict")) <= 255
            and not any(ord(c) < 32 or ord(c) == 127 or c in "/\\" for c in name))


def relative(path):
    require(isinstance(path, str) and len(path.encode("utf-8", "strict")) <= 1024)
    parts = path.split("/")
    for part in parts:
        component(part)
    return parts


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode)


def signature(info):
    return (*identity(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Root:
    def __init__(self, path):
        require(isinstance(path, str) and path.startswith("/") and path != "/"
                and len(path.encode("utf-8", "strict")) <= 2048
                and os.path.normpath(path) == path and not path.endswith("/"))
        parts = relative(path[1:]) if len(path[1:].encode("utf-8")) <= 1024 else path[1:].split("/")
        for part in parts:
            component(part)
        self.fds = []
        self.bindings = []
        try:
            fd = os.open("/", FLAGS)
            self.fds.append(fd)
            for part in parts:
                child = os.open(part, FLAGS, dir_fd=fd)
                self.fds.append(child)
                self.bindings.append((fd, part, identity(os.fstat(child))))
                fd = child
            self.fd = fd
        except BaseException:
            self.close()
            raise

    def stable(self):
        for parent, name, expected in self.bindings:
            require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected,
                    "changed_during_read")

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []


def run(request):
    require(type(request) is dict and set(request) == {"sourceRoot", "inputRoot", "inputs", "limits"}, "invalid_request")
    limits = request["limits"]
    require(type(limits) is dict and set(limits) == set(CAPS), "invalid_request")
    for key, cap in CAPS.items():
        require(type(limits[key]) is int and 1 <= limits[key] <= cap, "invalid_request")
    require(type(request["inputs"]) is list and len(request["inputs"]) <= 4, "invalid_request")
    require((request["inputRoot"] is None) == (not request["inputs"]), "invalid_request")
    ids = set()
    for item in request["inputs"]:
        require(type(item) is dict and set(item) == {"id", "path"}
                and item["id"] in {"experimentManifest", "numericalQualificationReceipt", "resumeCheckpoint", "originRunEvidence"}
                and item["id"] not in ids, "invalid_request")
        ids.add(item["id"])
        relative(item["path"])
    require(sys.version_info >= (3, 11) and os.name == "posix" and os.open in os.supports_dir_fd,
            "reader_unavailable")
    roots = []
    total = 0
    files = 0
    directories = 0
    metadata_bytes = 0
    first = {}
    entries = []

    def count_metadata(path):
        nonlocal metadata_bytes
        metadata_bytes += len(path.encode("utf-8")) + 200
        require(metadata_bytes <= 1024 * 1024, "limit_exceeded")

    def read_file(parent, name):
        nonlocal total, files
        # NONBLOCK prevents a substituted FIFO from hanging before type checks.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1)
            require(before.st_size <= limits["maxFileBytes"], "limit_exceeded")
            files += 1
            require(files <= limits["maxFiles"], "limit_exceeded")
            count = 0
            digest = hashlib.sha256()
            while True:
                chunk = os.read(fd, min(65536, limits["maxFileBytes"] + 1 - count))
                if not chunk:
                    break
                count += len(chunk)
                total += len(chunk)
                require(count <= limits["maxFileBytes"] and total <= limits["maxTotalBytes"], "limit_exceeded")
                digest.update(chunk)
            after = os.fstat(fd)
            require(signature(before) == signature(after) and count == after.st_size,
                    "changed_during_read")
            require(signature(os.stat(name, dir_fd=parent, follow_symlinks=False)) == signature(after),
                    "changed_during_read")
            return after, {"kind": "file", "bytes": count, "sha256": digest.hexdigest(),
                           "executableBits": after.st_mode & 0o111}
        finally:
            os.close(fd)

    def walk(fd, path, depth, checking=False):
        nonlocal directories
        require(depth <= limits["maxDepth"], "limit_exceeded")
        before = os.fstat(fd)
        require(stat.S_ISDIR(before.st_mode))
        if not checking:
            directories += 1
            require(directories <= limits["maxDirectories"], "limit_exceeded")
            first[path] = signature(before)
            if path:
                count_metadata(path)
                entries.append({"path": path, "kind": "directory", "executableBits": before.st_mode & 0o111})
        else:
            require(first.get(path) == signature(before), "changed_during_read")
        # scandir permits the count bound to stop enumeration before an unbounded list.
        names = []
        with os.scandir(fd) as scan:
            for item in scan:
                component(item.name)
                names.append(item.name)
                require(len(names) <= limits["maxFiles"] + limits["maxDirectories"], "limit_exceeded")
        for name in sorted(names, key=lambda value: value.encode("utf-8")):
            child_path = f"{path}/{name}" if path else name
            relative(child_path)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, FLAGS, dir_fd=fd)
                try:
                    require(identity(info) == identity(os.fstat(child)), "changed_during_read")
                    walk(child, child_path, depth + 1, checking)
                finally:
                    os.close(child)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                if checking:
                    require(first.get(child_path) == signature(info), "changed_during_read")
                else:
                    count_metadata(child_path)
                    after, record = read_file(fd, name)
                    first[child_path] = signature(after)
                    entries.append({"path": child_path, **record})
        require(signature(before) == signature(os.fstat(fd)), "changed_during_read")

    def input_file(root, path, checking=None):
        parts = relative(path)
        require(len(parts) - 1 <= limits["maxDepth"], "limit_exceeded")
        fd = root.fd
        held = []
        bindings = []
        try:
            for name in parts[:-1]:
                child = os.open(name, FLAGS, dir_fd=fd)
                held.append(child)
                bindings.append((fd, name, identity(os.fstat(child))))
                fd = child
            if checking is None:
                info, record = read_file(fd, parts[-1])
                output = ((signature(info), [expected for _, _, expected in bindings]), record)
            else:
                info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                require(signature(info) == checking[0]
                        and [expected for _, _, expected in bindings] == checking[1], "changed_during_read")
                output = None
            for parent, name, expected in bindings:
                require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected,
                        "changed_during_read")
            return output
        finally:
            for fd in reversed(held):
                os.close(fd)

    try:
        source = Root(request["sourceRoot"])
        roots.append(source)
        walk(source.fd, "", 0)
        input_results = []
        input_signatures = []
        if request["inputRoot"] is not None:
            inputs_root = Root(request["inputRoot"])
            roots.append(inputs_root)
            for item in request["inputs"]:
                signature_value, record = input_file(inputs_root, item["path"])
                input_signatures.append(signature_value)
                input_results.append({"id": item["id"], "path": item["path"], **record})
        walk(source.fd, "", 0, checking=True)
        if request["inputRoot"] is not None:
            for item, expected in zip(request["inputs"], input_signatures):
                input_file(inputs_root, item["path"], checking=expected)
        for root in roots:
            root.stable()
        entries.sort(key=lambda record: record["path"].encode("utf-8"))
        return {"ok": True, "entries": entries, "inputs": input_results,
                "sourceRootExecutableBits": first[""][2] & 0o111}
    finally:
        for root in reversed(roots):
            root.close()


def main():
    try:
        raw = sys.stdin.buffer.read(16385)
        require(len(raw) <= 16384, "invalid_request")
        return run(json.loads(raw))
    except Rejected as error:
        return {"ok": False, "problem": error.problem}
    except OSError as error:
        return {"ok": False, "problem": "missing" if error.errno == errno.ENOENT else "unsafe_path"
                if error.errno in (errno.ELOOP, errno.ENOTDIR) else "unreadable"}
    except (ValueError, TypeError, UnicodeError, KeyError):
        return {"ok": False, "problem": "invalid_request"}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=True, separators=(",", ":")))
