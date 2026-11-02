"""Trusted, bounded descriptor-relative reader. Never imports the inspected project."""

import base64
import errno
import json
import os
import stat
import sys

MAX_READ_BYTES = 16 * 1024 * 1024


def read_file(root, relative_path, max_bytes):
    """Pin all directories before descending; a renamed ancestor cannot redirect us."""
    if (not isinstance(root, str) or not os.path.isabs(root) or "\0" in root
            or os.path.normpath(root) != root
            or not isinstance(relative_path, str) or "\0" in relative_path
            or "\\" in relative_path or os.path.isabs(relative_path)):
        return {"ok": False, "problem": "unsafe_path"}
    parts = relative_path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return {"ok": False, "problem": "unsafe_path"}
    if type(max_bytes) is not int or not 0 <= max_bytes <= MAX_READ_BYTES:
        return {"ok": False, "problem": "unreadable"}
    if (sys.version_info < (3, 11) or os.name != "posix"
            or os.open not in os.supports_dir_fd
            or not all(hasattr(os, flag) for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC"))):
        return {"ok": False, "problem": "reader_unavailable"}
    descriptors = []
    try:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        directory = os.open("/", directory_flags)
        descriptors.append(directory)
        # Root ancestors are pinned too: O_NOFOLLOW on only the leaf is insufficient.
        for part in [part for part in root.split("/") if part] + parts[:-1]:
            directory = os.open(part, directory_flags, dir_fd=directory)
            descriptors.append(directory)
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        descriptors.append(file)
        before = os.fstat(file)
        if not stat.S_ISREG(before.st_mode):
            return {"ok": False, "problem": "unsafe_path"}
        if before.st_size > max_bytes:
            return {"ok": False, "problem": "too_large"}
        chunks = []
        count = 0
        while count <= max_bytes:
            chunk = os.read(file, min(64 * 1024, max_bytes + 1 - count))
            if not chunk:
                break
            count += len(chunk)
            chunks.append(chunk)
        if count > max_bytes:
            return {"ok": False, "problem": "too_large"}
        after = os.fstat(file)
        if (before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns or count != after.st_size):
            return {"ok": False, "problem": "changed_during_read"}
        return {"ok": True, "data": base64.b64encode(b"".join(chunks)).decode("ascii"),
                "mtimeMs": after.st_mtime_ns // 1_000_000}
    except OSError as error:
        problem = ("missing" if error.errno == errno.ENOENT else "unsafe_path"
                   if error.errno in (errno.ELOOP, errno.ENOTDIR) else "unreadable")
        return {"ok": False, "problem": problem}
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def main():
    if len(sys.argv) != 4:
        return {"ok": False, "problem": "unreadable"}
    try:
        max_bytes = int(sys.argv[3])
    except ValueError:
        return {"ok": False, "problem": "unreadable"}
    return read_file(sys.argv[1], sys.argv[2], max_bytes)


if __name__ == "__main__":
    print(json.dumps(main(), separators=(",", ":")))
