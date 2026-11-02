"""Bounded Linux fixture: the post-gate main PID attempts timeout extension.

Only the fixed local notify socket is contacted. No subprocess is created, so
NotifyAccess=main alone would allow these messages; the gate must disable it.
"""

import json
import os
import signal
import socket
import stat
import sys
import time


def main():
    if sys.platform != "linux" or os.getuid() == 0:
        raise RuntimeError("Fixture requires a non-root Linux identity")
    if not 3 <= len(sys.argv) <= 4 or sys.argv[1] != "extend":
        raise RuntimeError("Invalid fixture arguments")
    mode, marker = sys.argv[1:3]
    literal = sys.argv[3] if len(sys.argv) == 4 else ""
    if len(literal.encode("utf-8")) > 512 or not os.path.isabs(marker) or os.path.basename(marker) != "events.jsonl":
        raise RuntimeError("Invalid fixture marker or literal")
    directory = os.path.dirname(marker)
    directory_stat = os.lstat(directory)
    if (not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_uid != os.getuid()
            or directory_stat.st_mode & 0o077
            or os.path.dirname(os.path.realpath(directory)) != os.path.realpath("/tmp")
            or not os.path.basename(directory).startswith("rlh-systemd-fixture-")):
        raise RuntimeError("Fixture directory must be private, owned, and temporary")
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != (directory_stat.st_dev, directory_stat.st_ino):
            raise RuntimeError("Fixture directory changed")
        marker_fd = os.open("events.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                            0o600, dir_fd=directory_fd)
    finally:
        os.close(directory_fd)
    marker_stat = os.fstat(marker_fd)
    if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_uid != os.getuid() or marker_stat.st_mode & 0o077:
        os.close(marker_fd)
        raise RuntimeError("Fixture marker must be a private owned file")
    with open("/proc/self/stat", encoding="ascii") as source:
        process_stat = source.read(4097)
    if len(process_stat) > 4096:
        raise RuntimeError("Process identity exceeds fixture bound")
    ticks = process_stat[process_stat.rfind(")") + 2:].split()[19]
    if not ticks.isdigit():
        raise RuntimeError("Missing process identity")
    base = {"pid": os.getpid(), "parentPid": os.getppid(), "uid": os.getuid(), "processStartTicks": ticks, "mode": mode}
    recorded_bytes = marker_stat.st_size

    def record(event, **detail):
        nonlocal recorded_bytes
        payload = (json.dumps({"event": event, **base, **detail}, separators=(",", ":")) + "\n").encode("utf-8")
        recorded_bytes += len(payload)
        if recorded_bytes > 16_384 or os.write(marker_fd, payload) != len(payload):
            os._exit(24)

    def fallback(_signal, _frame):
        try:
            record("fallback_exit")
        finally:
            os._exit(99)

    signal.signal(signal.SIGALRM, fallback)
    signal.setitimer(signal.ITIMER_REAL, 12)
    ignored_terms = 0

    def ignore_term(_signal, _frame):
        nonlocal ignored_terms
        ignored_terms += 1
        if ignored_terms <= 2:
            record("ignored_sigterm")

    signal.signal(signal.SIGTERM, ignore_term)
    try:
        os.stat("/run/systemd/private")
    except (FileNotFoundError, PermissionError):
        pass
    else:
        for permission in (os.R_OK, os.W_OK):
            if os.access("/run/systemd/private", permission):
                raise RuntimeError("Fixture can access the private manager endpoint")
    with open("/proc/self/cgroup", encoding="ascii") as source:
        cgroup = source.read(4097)
    if len(cgroup) > 4096:
        raise RuntimeError("Cgroup identity exceeds fixture bound")
    record("started", literal=literal, privateEndpointDenied=True, cgroup=cgroup)
    payload = b"EXTEND_TIMEOUT_USEC=10000000"
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as peer:
        peer.settimeout(0.15)
        for attempt in range(1, 61):
            try:
                if peer.sendto(payload, "/run/systemd/notify") != len(payload):
                    raise RuntimeError("Incomplete notification send")
            except (OSError, RuntimeError):
                record("notify_error")
                return 24
            record("notify_attempt", attempt=attempt)
            time.sleep(0.2)
    # The independent alarm should fire first even if the supervisor is broken.
    fallback(None, None)
    return 99


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("deadline-fixture:failed", file=sys.stderr)
        sys.exit(24)
