"""Offline protocol peer; never starts a systemd service or reads host boot state."""

import array
import json
import os
import runpy
import socket
import sys
import threading
import time

gate = runpy.run_path(sys.argv[1])
mode, root, toy_executable = sys.argv[2:5]
address = os.path.join(root, "notify.sock")
boot = "11111111-1111-1111-1111-111111111111"
utc = 1_793_620_800_000
payload = ["notify-v1", "2026-11-02T12:01:00.000Z", "1000", "1000", "50", "1000",
           str(utc), "50000", boot, '{"FIXTURE":"literal $HOME %n ; value"}', "--", toy_executable]
config = gate["parse_arguments"](payload)
transcript = []
parent_pid = os.getpid()
errors = []


def manager(server):
    descriptor = None
    try:
        data, ancillary, flags, _ = server.recvmsg(1024, socket.CMSG_SPACE(4))
        transcript.append({"data": data.decode(), "fds": len(ancillary)})
        data, ancillary, flags, _ = server.recvmsg(1024, socket.CMSG_SPACE(4))
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise RuntimeError("truncated barrier")
        received = array.array("i")
        for level, kind, raw in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                received.frombytes(raw[:len(raw) - len(raw) % received.itemsize])
        transcript.append({"data": data.decode(), "fds": len(received)})
        if len(received) != 1:
            raise RuntimeError("expected one barrier descriptor")
        descriptor = received[0]
        if mode == "timeout":
            time.sleep(0.15)
        if mode == "invalid-ack":
            os.write(descriptor, b"x")
        if mode == "exec":
            with open(os.path.join(root, "manager.json"), "w") as output:
                json.dump({"transcript": transcript, "pid": parent_pid}, output)
    except Exception as error:
        errors.append(type(error).__name__)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        server.close()


if mode == "eligibility":
    cases = []
    for name, wall, elapsed, observed_boot in [
        ("eligible", utc, 0, boot),
        ("wall-forward", utc + 60_000, 0, boot),
        ("wall-backward", utc - 60_000, 60_000, boot),
        ("boot-backward", utc, -1, boot),
        ("different-boot", utc, 0, "22222222-2222-2222-2222-222222222222"),
        ("exact-boundary", utc + 57_950, 0, boot),
        ("one-ms-late", utc + 57_951, 0, boot),
    ]:
        try:
            gate["eligibility"](config, wall * 1_000_000, (50_000 + elapsed) * 1_000_000, observed_boot)
            result = "eligible"
        except gate["GateError"] as error:
            result = str(error)
        cases.append({"name": name, "result": result})
    print(json.dumps(cases))
elif mode == "parse":
    mutations = [
        ("nan", 2, "NaN"), ("negative", 6, "-1"), ("oversize", 12, "x" * 16_385),
        ("env-injection", 9, '{"NOTIFY_SOCKET":"/tmp/injected"}'),
        ("duplicate-env", 9, '{"A":"first","A":"second"}'),
        ("nested-env", 9, '{"A":{}}'), ("invalid-date", 1, "2026-02-30T12:00:00.000Z"),
        ("relative-executable", 11, "python"), ("delimiter", 10, "--bad"),
        ("missing-boot", 8, ""), ("nul-argument", 12, "a\0b"),
    ]
    results = []
    for name, index, value in mutations:
        changed = payload + ["literal"]
        changed[index] = value
        try:
            gate["parse_arguments"](changed)
            result = "accepted"
        except gate["GateError"] as error:
            result = str(error)
        results.append({"name": name, "result": result})
    print(json.dumps(results))
else:
    if mode == "timeout":
        config["barrier_ms"] = 40
    if mode == "early-expiry":
        config["deadline_ns"] = utc * 1_000_000
    if mode == "exec":
        # This is a real same-PID exec. Exact execve environment is checked by the
        # injected capture case because the toy Python can augment its own map.
        toy = "import os,json,sys; print(json.dumps({'pid':os.getpid(),'args':sys.argv[1:],'value':os.environ.get('FIXTURE'),'notify':os.environ.get('NOTIFY_SOCKET')}))"
        config["argv"] = [toy_executable, "-I", "-S", "-c", toy, "$HOME", "semi;colon", "literal %n", ""]
    server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    server.bind(address)
    server.settimeout(2)
    thread = threading.Thread(target=manager, args=(server,), daemon=True)
    if mode != "early-expiry":
        thread.start()
    wall_values = iter([utc, utc + 60_000] if mode == "late-expiry" else [utc, utc])
    executions = []
    started = time.monotonic()
    try:
        gate["execute_gate"](config, address=address, read_boot=lambda: boot,
                             utc_clock=lambda: next(wall_values) * 1_000_000,
                             boot_clock=lambda: 50_000_000_000,
                             **({} if mode == "exec" else {"execve": lambda *args: executions.append(args)}))
        result = "returned"
    except gate["GateError"] as error:
        result = str(error)
    elapsed_ms = (time.monotonic() - started) * 1000
    if mode != "early-expiry":
        thread.join(2)
    else:
        server.close()
    print(json.dumps({"result": result, "transcript": transcript, "executions": executions,
                      "elapsedMs": elapsed_ms, "errors": errors}))
