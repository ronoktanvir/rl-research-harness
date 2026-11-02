"""Required Type=notify pre-exec gate. Only Python standard library is imported.

The public CLI has no endpoint, clock or executable-search override. Functions
accept injected boundaries for offline tests; main always uses fixed native ones.
This protocol assumes a trusted system manager and the deployment in the docs.
"""

import array
import datetime
import json
import os
import re
import select
import socket
import stat
import sys
import time

NOTIFY_ADDRESS = "/run/systemd/notify"
BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id"
MAX_BYTES = 128_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
NS_PER_MS = 1_000_000
REFUSAL_EXIT = 78


class GateError(Exception):
    """Fixed reason only: never include a command, environment or input value."""


def fail(reason):
    raise GateError(reason)


def literal(value, maximum):
    if not isinstance(value, str) or "\0" in value:
        fail("invalid_argument")
    try:
        if len(value.encode("utf-8")) > maximum:
            fail("argument_bound")
    except UnicodeError:
        fail("invalid_utf8")
    return value


def path(value):
    literal(value, 2048)
    if (not re.fullmatch(r"/[A-Za-z0-9_./-]+", value)
            or value.endswith("/") or os.path.normpath(value) != value):
        fail("invalid_path")
    return value


def number(value, minimum, maximum):
    if not re.fullmatch(r"0|[1-9][0-9]{0,15}", value):
        fail("invalid_integer")
    result = int(value)
    if not minimum <= result <= maximum:
        fail("integer_bound")
    return result


def valid_boot_id(value):
    return (isinstance(value, str)
            and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value)
            and value.replace("-", "") != "0" * 32)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate_environment_key")
        result[key] = value
    return result


def parse_arguments(arguments):
    if not isinstance(arguments, list) or not 12 <= len(arguments) <= 524:
        fail("argument_count")
    for index, value in enumerate(arguments):
        literal(value, 64_000 if index == 9 else 16_384)
    if sum(len(value.encode("utf-8")) + 1 for value in arguments) > MAX_BYTES:
        fail("argument_bound")
    if arguments[0] != "notify-v1" or arguments[10] != "--":
        fail("invalid_protocol")
    date = arguments[1]
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", date):
        fail("invalid_deadline")
    try:
        parsed = datetime.datetime.fromisoformat(date.replace("Z", "+00:00"))
        delta = parsed - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        deadline_ns = ((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds) * 1000
    except ValueError:
        fail("invalid_deadline")
    if deadline_ns < 0:
        fail("invalid_deadline")
    if not valid_boot_id(arguments[8]):
        fail("invalid_boot_id")
    try:
        environment = json.loads(arguments[9], object_pairs_hook=unique_object)
    except (ValueError, RecursionError):
        fail("invalid_environment")
    if not isinstance(environment, dict) or len(environment) > 128:
        fail("invalid_environment")
    for key, value in environment.items():
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", key) or key == "NOTIFY_SOCKET":
            fail("invalid_environment")
        literal(value, 8192)
    return {
        "deadline_ns": deadline_ns,
        "runtime_ms": number(arguments[2], 1, 31_536_000_000),
        "stop_ms": number(arguments[3], 1, 300_000),
        "margin_ms": number(arguments[4], 1, 300_000),
        "barrier_ms": number(arguments[5], 1, 300_000),
        "anchor_utc_ms": number(arguments[6], 0, 253_402_300_799_999),
        "anchor_boot_ms": number(arguments[7], 0, MAX_SAFE_INTEGER),
        "boot_id": arguments[8],
        "environment": environment,
        "executable": path(arguments[11]),
        "argv": arguments[11:],
    }


def read_boot_id():
    descriptor = os.open(BOOT_ID_PATH, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            fail("invalid_boot_source")
        raw = os.read(descriptor, 65)
        if len(raw) > 64:
            fail("invalid_boot_source")
        boot_id = raw.decode("ascii").strip()
        if not valid_boot_id(boot_id):
            fail("invalid_boot_source")
        return boot_id
    finally:
        os.close(descriptor)


def boot_time_ns():
    if not hasattr(time, "CLOCK_BOOTTIME"):
        fail("boottime_unavailable")
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME)


def eligibility(config, utc_ns, boot_ns, boot_id):
    if type(utc_ns) is not int or type(boot_ns) is not int or min(utc_ns, boot_ns) < 0:
        fail("invalid_clock")
    elapsed = boot_ns - config["anchor_boot_ms"] * NS_PER_MS
    if boot_id != config["boot_id"] or elapsed < 0:
        fail("boot_changed")
    # UTC rollback after admission cannot enlarge the remaining allowance.
    effective_utc = max(utc_ns, config["anchor_utc_ms"] * NS_PER_MS + elapsed)
    required = (config["runtime_ms"] + config["stop_ms"] + config["margin_ms"]) * NS_PER_MS
    remaining = config["deadline_ns"] - effective_utc
    if remaining < required:
        fail("deadline_insufficient")
    return remaining - required


def notify_barrier(timeout_ms, address=NOTIFY_ADDRESS):
    """Wait for manager closure of the transferred pipe, never a reply datagram.

    The barrier is processed before service NotifyAccess filtering in systemd.
    Keep it separate from READY, as required by sd_notify_barrier's protocol.
    """
    limit = time.monotonic_ns() + timeout_ms * NS_PER_MS

    def remaining():
        value = (limit - time.monotonic_ns()) / 1_000_000_000
        if value <= 0:
            fail("notify_timeout")
        return value

    read_fd, write_fd = os.pipe()
    try:
        os.set_inheritable(read_fd, False)
        os.set_inheritable(write_fd, False)
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as peer:
            peer.settimeout(remaining())
            ready = b"READY=1\nNOTIFYACCESS=none"
            if peer.sendto(ready, address) != len(ready):
                fail("notify_send_failed")
            peer.settimeout(remaining())
            fds = array.array("i", [write_fd])
            if peer.sendmsg([b"BARRIER=1"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, fds)], 0, address) != 9:
                fail("notify_send_failed")
        os.close(write_fd)
        write_fd = -1
        if not select.select([read_fd], [], [], remaining())[0]:
            fail("notify_timeout")
        if os.read(read_fd, 1) != b"":
            fail("invalid_barrier_ack")
    except TimeoutError:
        fail("notify_timeout")
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        os.close(read_fd)


def execute_gate(config, *, address=NOTIFY_ADDRESS, read_boot=read_boot_id,
                 utc_clock=time.time_ns, boot_clock=boot_time_ns, execve=os.execve):
    # Early refusal avoids declaring readiness for work already known to be late.
    eligibility(config, utc_clock(), boot_clock(), read_boot())
    notify_barrier(config["barrier_ms"], address)
    # READY has been processed and NotifyAccess disabled before this final check.
    # Full RuntimeMaxSec is conservative: some of it has already elapsed.
    eligibility(config, utc_clock(), boot_clock(), read_boot())
    execve(config["executable"], config["argv"], config["environment"])
    fail("exec_returned")


def main():
    try:
        if sys.platform != "linux":
            fail("linux_required")
        execute_gate(parse_arguments(sys.argv[1:]))
    except GateError as error:
        print("deadline-gate:" + str(error), file=sys.stderr)
    except (OSError, ValueError, UnicodeError):
        print("deadline-gate:system_error", file=sys.stderr)
    return REFUSAL_EXIT


if __name__ == "__main__":
    sys.exit(main())
