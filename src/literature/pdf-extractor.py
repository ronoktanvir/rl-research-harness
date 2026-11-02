"""Bounded page-text extraction only. PDF actions, attachments and links are not run.

Text extraction cannot establish figure/table fidelity, reading completeness or
claim validity. The parent process supplies wall-time and combined output bounds.
"""
import hashlib
import io
import json
import logging
import math
import os
import platform
import resource
import stat
import sys

PIN = "6.10.0"
MAX_PDF = 16 * 1024 * 1024
MAX_STREAM = 8 * 1024 * 1024


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("invalid integer")


def limits(config):
    if platform.system() != "Linux":
        raise ValueError("bounded PDF worker requires Linux")
    if type(config) is not dict or set(config) != {"path", "sourceSha256", "maxPages", "maxTextBytes", "maxPageTextBytes", "timeoutMs", "pythonVersion"}:
        raise ValueError("invalid config")
    integer(config["maxPages"], 1, 200)
    integer(config["maxTextBytes"], 1, 512 * 1024)
    integer(config["maxPageTextBytes"], 1, 64 * 1024)
    integer(config["timeoutMs"], 1, 60_000)
    if config["pythonVersion"] != platform.python_version():
        raise ValueError("runtime changed")
    # Require actual process limits before importing a parser. A post-decompression
    # stream-size check alone cannot bound allocation during decompression.
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    seconds = max(1, math.ceil(config["timeoutMs"] / 1000))
    resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds + 1))


def read_pdf(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 1 <= before.st_size <= MAX_PDF:
            raise ValueError("invalid PDF file")
        data = bytearray()
        while len(data) <= MAX_PDF:
            part = os.read(descriptor, min(65536, MAX_PDF + 1 - len(data)))
            if not part:
                break
            data.extend(part)
        after = os.fstat(descriptor)
        if len(data) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("PDF changed during read")
        return bytes(data)
    finally:
        os.close(descriptor)


def extract(config):
    import pypdf
    if pypdf.__version__ != PIN:
        raise ValueError("parser version changed")
    data = read_pdf(config["path"])
    if hashlib.sha256(data).hexdigest() != config["sourceSha256"] or not data.startswith(b"%PDF-"):
        raise ValueError("source identity mismatch")
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        return {"schemaVersion": 1, "sourceSha256": config["sourceSha256"], "totalPages": None, "pages": [], "errorCode": "encrypted_pdf"}
    total = len(reader.pages)
    remaining = config["maxTextBytes"]
    pages = []
    for index in range(min(total, config["maxPages"])):
        if remaining == 0:
            break
        try:
            page = reader.pages[index]
            contents = page.get_contents()
            if contents is not None and len(contents.get_data()) > MAX_STREAM:
                pages.append({"pageNumber": index + 1, "text": "", "status": "failed", "errorCode": "page_stream_limit"})
                continue
            text = page.extract_text() or ""
            encoded = text.encode("utf-8")
            bound = min(remaining, config["maxPageTextBytes"])
            truncated = len(encoded) > bound
            kept = encoded[:bound].decode("utf-8", errors="ignore") if truncated else text
            if not truncated and not kept.strip():
                kept = ""
            remaining -= len(kept.encode("utf-8"))
            pages.append({"pageNumber": index + 1, "text": kept,
                          "status": "truncated" if truncated else "text" if kept.strip() else "empty",
                          "errorCode": "text_limit" if truncated else None})
        except MemoryError:
            raise
        except Exception:
            pages.append({"pageNumber": index + 1, "text": "", "status": "failed", "errorCode": "page_parse_failed"})
    return {"schemaVersion": 1, "sourceSha256": config["sourceSha256"], "totalPages": total, "pages": pages, "errorCode": None}


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError("config limit")
        config = json.loads(raw)
        limits(config)
        logging.disable(logging.CRITICAL)
        result = extract(config)
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > 2 * 1024 * 1024:
            raise ValueError("output limit")
        sys.stdout.buffer.write(encoded + b"\n")
        return 0
    except Exception:
        sys.stderr.write("PDF text extraction failed; no complete extraction result\n")
        return 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        # Exercise the same mandatory limits before importing the actual parser.
        # Version observation is not an attestation of installed package bytes.
        limits({"path": "/not-read", "sourceSha256": "0" * 64,
                "maxPages": 1, "maxTextBytes": 1, "maxPageTextBytes": 1,
                "timeoutMs": 5000, "pythonVersion": platform.python_version()})
        import pypdf
        print(json.dumps({"python": platform.python_version(), "pypdf": pypdf.__version__}))
    else:
        raise SystemExit(main())
