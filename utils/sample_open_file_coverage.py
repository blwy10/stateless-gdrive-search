#!/usr/bin/env python3
# Copyright (c) 2026 Benjamin Lau
# SPDX-License-Identifier: MIT
"""
Estimate how the open_file tool's 32,000-char (~8,000-token) cap compares to the
real size of files in your Google Drive.

The agent's `open_file` tool (lib/drive.ts -> openDriveFile) extracts *text* from
a file and then truncates it at MAX_FILE_CHARS = 32,000 characters (which the
project reasons about as ~8,000 tokens). So the question "is 8,000 tokens too big
or too small?" is really: for a typical file, does the extracted text fit inside
32,000 chars, or do we only return a small slice of it?

What this script does:
  1. Reuses the OAuth token already stored in the app's local Postgres
     (drive_connections), decrypting it with TOKEN_ENCRYPTION_KEY exactly like
     lib/crypto.ts, then refreshes it for a fresh access token.
  2. Enumerates the Drive (metadata only) to get the true file population and its
     byte-size distribution.
  3. Draws a uniform random sample (which is, by construction, distributed
     according to the population's size distribution).
  4. For each sampled file, extracts text the same way openDriveFile does
     (Google export for native docs/sheets/slides; pypdf for PDF; zip+XML for
     docx/xlsx/pptx; raw decode for text-like types), then measures the extracted
     length in characters and tokens and compares it to the 32,000-char cap.
  5. Reports the distribution and what fraction of each file the cap returns.

Usage:
  utils/.venv/bin/python utils/sample_open_file_coverage.py [options]

Options:
  --sample-size N   files to download+extract (default 150)
  --seed S          RNG seed for a reproducible sample (default 42)
  --max-files M     cap on how many files to enumerate (default 50000)
  --workers W       parallel extraction workers (default 8)
  --email EMAIL     which drive_connections row to use (default: first)
  --no-extract      only enumerate + show the size distribution (no downloads)
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as futures
import glob
import io
import json
import logging
import math
import os
import random
import re
import statistics
import subprocess
import sys
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# pypdf logs noisy "Ignoring wrong pointing object" warnings on slightly
# malformed (but readable) PDFs; they are harmless for a text-length probe.
logging.getLogger("pypdf").setLevel(logging.ERROR)

# --- Constants mirroring lib/drive.ts --------------------------------------

MAX_FILE_CHARS = 32_000  # openDriveFile truncates extracted text here.
NOMINAL_TOKEN_CAP = 8_000  # how the project frames MAX_FILE_CHARS (32k/4).
DRIVE_API = "https://www.googleapis.com/drive/v3/files"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
REQUEST_TIMEOUT = 60

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")

GOOGLE_DOC = "application/vnd.google-apps.document"
GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet"
GOOGLE_SLIDES = "application/vnd.google-apps.presentation"
PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
DOC = "application/msword"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
XLS = "application/vnd.ms-excel"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
PPT = "application/vnd.ms-powerpoint"

PLAINTEXT_MIMES = {"text/plain", "text/markdown", "text/csv", "application/json"}
# Types the openDriveFile `default` branch decodes as utf-8 and that are actually
# textual (so the decode is meaningful, not binary garbage).
TEXTUAL_PREFIXES = ("text/",)
TEXTUAL_EXTRA = {
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
    "application/x-ndjson",
    "application/xhtml+xml",
    "image/svg+xml",
}


# --- Token counting --------------------------------------------------------

def make_token_counter() -> tuple[Callable[[str], int], str]:
    try:
        import tiktoken

        enc = tiktoken.get_encoding("o200k_base")  # gpt-oss / gpt-4o family base

        def count(s: str) -> int:
            if not s:
                return 0
            return len(enc.encode(s, disallowed_special=()))

        return count, "tiktoken/o200k_base"
    except Exception:  # pragma: no cover - fallback path
        def count(s: str) -> int:
            return round(len(s) / 4)

        return count, "approx chars/4"


# --- Env + DB + crypto -----------------------------------------------------

def load_env(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    if not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip().strip('"').strip("'")
            env[key.strip()] = value
    return env


def client_credentials(env: dict[str, str]) -> tuple[str, str]:
    cid = env.get("GOOGLE_CLIENT_ID")
    secret = env.get("GOOGLE_CLIENT_SECRET")
    if cid and secret:
        return cid, secret
    # Fall back to the client_secret_*.json the user pointed at.
    for path in glob.glob(os.path.join(ROOT, "client_secret_*.json")):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh).get("web") or json.load(fh)
        cid = cid or data.get("client_id")
        secret = secret or data.get("client_secret")
        if cid and secret:
            return cid, secret
    raise SystemExit("Could not find GOOGLE_CLIENT_ID/SECRET in env or client_secret_*.json")


def decrypt_secret(value: str, key_b64: str) -> str:
    """Mirror lib/crypto.ts decryptSecret: aes-256-gcm, 'iv.tag.ciphertext' b64."""
    iv_raw, tag_raw, enc_raw = value.split(".")
    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise SystemExit("TOKEN_ENCRYPTION_KEY must decode to 32 bytes")
    nonce = base64.b64decode(iv_raw)
    tag = base64.b64decode(tag_raw)
    ciphertext = base64.b64decode(enc_raw)
    return AESGCM(key).decrypt(nonce, ciphertext + tag, None).decode("utf-8")


def fetch_connection(database_url: str, email: Optional[str]) -> dict[str, str]:
    sep = "\x1f"
    sql = (
        "select id, owner_sub, drive_email, "
        "coalesce(refresh_token_ciphertext,''), scope "
        "from drive_connections order by created_at asc"
    )
    out = subprocess.run(
        ["psql", database_url, "-tA", "-F", sep, "-c", sql],
        capture_output=True, text=True, check=True,
    ).stdout
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split(sep)
        if len(parts) < 5:
            continue
        rows.append({
            "id": parts[0], "owner_sub": parts[1], "drive_email": parts[2],
            "refresh_token_ciphertext": parts[3], "scope": parts[4],
        })
    if not rows:
        raise SystemExit("No rows in drive_connections; connect a Drive in the app first.")
    if email:
        for row in rows:
            if row["drive_email"] == email:
                return row
        raise SystemExit(f"No drive_connections row for {email}")
    return rows[0]


def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    resp = requests.post(
        TOKEN_ENDPOINT,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        raise SystemExit(f"Token refresh failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()["access_token"]


# --- Drive API -------------------------------------------------------------

class Drive:
    def __init__(self, access_token: str):
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {access_token}"

    def list_files(self, max_files: int) -> list[dict]:
        files: list[dict] = []
        page_token = None
        while len(files) < max_files:
            params = {
                "q": "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
                "pageSize": 1000,
                "fields": "nextPageToken, files(id,name,mimeType,size,modifiedTime)",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            resp = self.session.get(DRIVE_API, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
            batch = data.get("files", [])
            files.extend(batch)
            print(f"  enumerated {len(files)} files...", end="\r", flush=True)
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        print(" " * 60, end="\r")
        return files[:max_files]

    def export(self, file_id: str, mime: str) -> bytes:
        resp = self.session.get(
            f"{DRIVE_API}/{file_id}/export",
            params={"mimeType": mime}, timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.content

    def download(self, file_id: str) -> bytes:
        resp = self.session.get(
            f"{DRIVE_API}/{file_id}",
            params={"alt": "media", "supportsAllDrives": "true"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.content


# --- Text extraction (mirrors lib/drive.ts openDriveFile) ------------------

def _xml_unescape(s: str) -> str:
    return (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&apos;", "'"))


def extract_pdf(buf: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(buf))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def extract_docx(buf: bytes) -> str:
    # Approximate mammoth.extractRawText: paragraph text joined by newlines.
    with zipfile.ZipFile(io.BytesIO(buf)) as zf:
        if "word/document.xml" not in zf.namelist():
            return ""
        xml = zf.read("word/document.xml").decode("utf-8", "replace")
    paras = re.split(r"</w:p>", xml)
    out = []
    for para in paras:
        runs = re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, re.S)
        out.append(_xml_unescape("".join(runs)))
    return "\n".join(out)


def extract_pptx(buf: bytes) -> str:
    # Mirrors extractPptxText: per-slide <a:t> joined by spaces, slides by \n\n.
    with zipfile.ZipFile(io.BytesIO(buf)) as zf:
        slide_paths = sorted(
            (n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
            key=lambda n: int(re.search(r"(\d+)", n).group(1)),
        )
        chunks = []
        for path in slide_paths:
            xml = zf.read(path).decode("utf-8", "replace")
            text = " ".join(_xml_unescape(m) for m in re.findall(r"<a:t>(.*?)</a:t>", xml, re.S))
            if text.strip():
                chunks.append(text)
    return "\n\n".join(chunks)


def extract_xlsx(buf: bytes) -> str:
    # Mirrors extractXlsxText: "Sheet: name" + rows (cells comma-joined).
    with zipfile.ZipFile(io.BytesIO(buf)) as zf:
        names = set(zf.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            ss = zf.read("xl/sharedStrings.xml").decode("utf-8", "replace")
            for si in re.findall(r"<si>(.*?)</si>", ss, re.S):
                shared.append("".join(_xml_unescape(t) for t in re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
        sheet_names: dict[str, str] = {}
        if "xl/workbook.xml" in names:
            wb = zf.read("xl/workbook.xml").decode("utf-8", "replace")
            for m in re.finditer(r'<sheet[^>]*name="([^"]+)"[^>]*sheetId="([^"]+)"', wb):
                sheet_names[f"xl/worksheets/sheet{m.group(2)}.xml"] = _xml_unescape(m.group(1))
        sheet_paths = sorted(
            (n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
            key=lambda n: int(re.search(r"(\d+)", n).group(1)),
        )
        chunks = []
        for path in sheet_paths:
            xml = zf.read(path).decode("utf-8", "replace")
            rows = []
            for row in re.findall(r"<row[^>]*>(.*?)</row>", xml, re.S):
                cells = []
                for attrs, cell in re.findall(r"<c([^>]*)>(.*?)</c>", row, re.S):
                    inline = re.search(r"<t[^>]*>(.*?)</t>", cell, re.S)
                    if inline:
                        cells.append(_xml_unescape(inline.group(1)))
                        continue
                    raw = re.search(r"<v>(.*?)</v>", cell, re.S)
                    raw = raw.group(1) if raw else ""
                    if 't="s"' in attrs:
                        idx = int(raw) if raw.isdigit() else -1
                        cells.append(shared[idx] if 0 <= idx < len(shared) else "")
                    else:
                        cells.append(_xml_unescape(raw))
                if any(cells):
                    rows.append(",".join(cells))
            chunks.append(f"Sheet: {sheet_names.get(path, path)}\n" + "\n".join(rows))
    return "\n\n".join(chunks)


def is_textual(mime: str) -> bool:
    return (mime in PLAINTEXT_MIMES or mime in TEXTUAL_EXTRA
            or any(mime.startswith(p) for p in TEXTUAL_PREFIXES))


def category_of(mime: str) -> str:
    return {
        GOOGLE_DOC: "google-doc", GOOGLE_SHEET: "google-sheet",
        GOOGLE_SLIDES: "google-slides", PDF: "pdf", DOCX: "docx", DOC: "doc",
        XLSX: "xlsx", XLS: "xls", PPTX: "pptx", PPT: "ppt",
    }.get(mime) or ("text" if is_textual(mime) else (
        "other-google-apps" if mime.startswith("application/vnd.google-apps.") else "binary/other"
    ))


@dataclass
class Result:
    name: str
    mime: str
    category: str
    bytes_size: Optional[int]
    extracted_chars: int = 0
    total_tokens: int = 0
    returned_tokens: int = 0
    extractable: bool = True   # is this a text-bearing type at all?
    truncated: bool = False    # extracted text exceeded the 32k cap
    huge: bool = False         # known to exceed cap but exact size unknown
    skipped_large: bool = False  # text-type but too big to download for this probe
    note: str = ""
    error: str = ""


def extract_one(
    drive: Drive, f: dict, count_tokens: Callable[[str], int], max_download_bytes: int
) -> Result:
    mime = f.get("mimeType", "")
    cat = category_of(mime)
    bytes_size = int(f["size"]) if f.get("size") is not None else None
    res = Result(name=f.get("name", ""), mime=mime, category=cat, bytes_size=bytes_size)
    # Guard against pathological downloads (multi-GB PDFs etc). Native Google
    # files report no size and are bounded by Google's 10MB export limit instead.
    needs_download = mime in (PDF, DOCX, DOC, XLSX, PPTX, PPT) or is_textual(mime)
    if needs_download and bytes_size is not None and bytes_size > max_download_bytes:
        res.skipped_large = True
        res.note = f"skipped: {human_bytes(bytes_size)} exceeds download cap"
        return res
    try:
        if mime == GOOGLE_DOC:
            text = drive.export(f["id"], "text/plain").decode("utf-8", "replace")
        elif mime == GOOGLE_SHEET:
            text = drive.export(f["id"], "text/csv").decode("utf-8", "replace")
        elif mime == GOOGLE_SLIDES:
            text = drive.export(f["id"], "text/plain").decode("utf-8", "replace")
        elif mime == PDF:
            text = extract_pdf(drive.download(f["id"]))
        elif mime in (DOCX, DOC):
            text = extract_docx(drive.download(f["id"]))
        elif mime == XLSX:
            text = extract_xlsx(drive.download(f["id"]))
        elif mime == PPTX or mime == PPT:
            text = extract_pptx(drive.download(f["id"]))
        elif mime == XLS:
            res.extractable = False
            res.note = "legacy .xls not parsed by the app"
            return _finalize(res, "", count_tokens)
        elif is_textual(mime):
            text = drive.download(f["id"]).decode("utf-8", "replace")
        elif mime.startswith("application/vnd.google-apps."):
            res.extractable = False
            res.note = "unsupported google-apps type (app returns a stub note)"
            return _finalize(res, "", count_tokens)
        else:
            # Binary (image/video/audio/zip/...). openDriveFile would utf-8 decode
            # the bytes into garbage; that is not real readable content, so we
            # count it as non-extractable (0 useful chars) and skip the download.
            res.extractable = False
            res.note = "binary/non-text; little or no readable text"
            return _finalize(res, "", count_tokens)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 0
        body = exc.response.text[:200] if exc.response is not None else ""
        if status == 403 and "exportSizeLimitExceeded" in body:
            # Google refuses to export docs > 10 MB of text. That is *vastly*
            # larger than 32k chars, so it definitely gets truncated hard.
            res.huge = True
            res.truncated = True
            res.note = "export > 10MB limit (far exceeds 32k cap)"
            res.extracted_chars = -1
            return res
        res.error = f"http {status}"
        return res
    except Exception as exc:  # pragma: no cover - per-file resilience
        res.error = f"{type(exc).__name__}: {exc}"[:160]
        return res
    return _finalize(res, text, count_tokens)


def _finalize(res: Result, text: str, count_tokens: Callable[[str], int]) -> Result:
    # Mirror trimContent: strip nulls, trim, then cap at MAX_FILE_CHARS.
    normalized = text.replace("\x00", "").strip()
    res.extracted_chars = len(normalized)
    res.total_tokens = count_tokens(normalized)
    res.returned_tokens = count_tokens(normalized[:MAX_FILE_CHARS])
    res.truncated = res.extracted_chars > MAX_FILE_CHARS
    return res


# --- Reporting -------------------------------------------------------------

def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100)
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return s[int(k)]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def hist(values: list[float], edges: list[float], labels: list[str]) -> None:
    counts = [0] * (len(edges) + 1)
    for v in values:
        placed = False
        for i, e in enumerate(edges):
            if v <= e:
                counts[i] += 1
                placed = True
                break
        if not placed:
            counts[-1] += 1
    total = max(1, len(values))
    width = 40
    for label, c in zip(labels, counts):
        bar = "#" * round(width * c / total)
        print(f"    {label:>14}  {c:5d}  {c/total*100:5.1f}%  {bar}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sample-size", type=int, default=150)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-files", type=int, default=50_000)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--email", default=None)
    ap.add_argument("--max-download-mb", type=int, default=50,
                    help="skip downloading text-type files larger than this (default 50)")
    ap.add_argument("--no-extract", action="store_true")
    args = ap.parse_args()

    count_tokens, token_method = make_token_counter()
    env = load_env(os.path.join(ROOT, ".env.local"))
    database_url = env.get("DATABASE_URL") or os.environ.get("DATABASE_URL")
    key_b64 = env.get("TOKEN_ENCRYPTION_KEY")
    if not database_url or not key_b64:
        raise SystemExit("DATABASE_URL and TOKEN_ENCRYPTION_KEY must be set in .env.local")
    client_id, client_secret = client_credentials(env)

    print("== Auth ==")
    conn = fetch_connection(database_url, args.email)
    print(f"  using drive connection: {conn['drive_email']}")
    refresh_token = decrypt_secret(conn["refresh_token_ciphertext"], key_b64)
    access_token = refresh_access_token(client_id, client_secret, refresh_token)
    drive = Drive(access_token)
    print(f"  token refreshed OK   (token counter: {token_method})")

    print("\n== Enumerating Drive (metadata only) ==")
    files = drive.list_files(args.max_files)
    files = [f for f in files if f.get("mimeType") != "application/vnd.google-apps.shortcut"]
    print(f"  total files (excl. folders/shortcuts): {len(files)}")

    # Population composition + byte-size distribution.
    by_cat: dict[str, int] = {}
    sizes = []
    native = 0
    for f in files:
        by_cat[category_of(f.get("mimeType", ""))] = by_cat.get(category_of(f.get("mimeType", "")), 0) + 1
        if f.get("size") is not None:
            sizes.append(int(f["size"]))
        else:
            native += 1
    print("\n  composition by type:")
    for cat, c in sorted(by_cat.items(), key=lambda kv: -kv[1]):
        print(f"    {cat:>18}  {c:6d}  {c/len(files)*100:5.1f}%")
    print(f"\n  byte-size distribution (only the {len(sizes)} files Drive reports a size for;")
    print(f"  {native} native Google files report no size):")
    if sizes:
        for p in (50, 75, 90, 95, 99):
            print(f"    p{p:<2} = {human_bytes(pct([float(s) for s in sizes], p))}")
        print(f"    max = {human_bytes(max(sizes))}   mean = {human_bytes(statistics.mean(sizes))}")

    if args.no_extract:
        print("\n(--no-extract set; skipping content extraction)")
        return

    # Uniform random sample == sample distributed per the population size dist.
    rng = random.Random(args.seed)
    n = min(args.sample_size, len(files))
    sample = rng.sample(files, n)
    print(f"\n== Extracting text from a random sample of {n} files (seed={args.seed}, {args.workers} workers) ==")
    print("   (extraction mirrors lib/drive.ts openDriveFile; cap = 32,000 chars)\n")

    max_download_bytes = args.max_download_mb * 1024 * 1024
    results: list[Result] = []
    done = 0
    with futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        fut_map = {
            pool.submit(extract_one, drive, f, count_tokens, max_download_bytes): f
            for f in sample
        }
        for fut in futures.as_completed(fut_map):
            results.append(fut.result())
            done += 1
            print(f"  extracted {done}/{n}...", end="\r", flush=True)
    print(" " * 60, end="\r")

    ok = [r for r in results if not r.error]
    errored = [r for r in results if r.error]
    skipped = [r for r in ok if r.skipped_large]
    non_text = [r for r in ok if not r.extractable and not r.skipped_large]
    # "huge" = a Google export that blew past Google's 10MB text limit: definitely
    # way over the 32k cap, just not exactly measurable.
    huge = [r for r in ok if r.huge]
    measured = [r for r in ok if r.extractable and not r.huge and not r.skipped_large
                and r.extracted_chars > 0]
    empty_text = [r for r in ok if r.extractable and not r.huge and not r.skipped_large
                  and r.extracted_chars == 0]
    text_bearing = measured + huge  # files with real readable content

    print("== Results ==")
    print(f"  sampled:                  {len(results)}")
    print(f"  errored (skipped):        {len(errored)}")
    print(f"  too large to download:    {len(skipped)}  (text-type but > {args.max_download_mb}MB)")
    print(f"  non-text (img/av/bin):    {len(non_text)}  (open_file returns ~no readable text)")
    print(f"  text-type but empty:      {len(empty_text)}  (scanned PDFs, empty docs, parser gaps)")
    print(f"  text-bearing files:       {len(text_bearing)}   <-- the set the cap actually matters for\n")

    if text_bearing:
        chars = [float(r.extracted_chars) for r in measured]
        toks = [float(r.total_tokens) for r in measured]
        fit = [r for r in measured if not r.truncated]
        trunc = [r for r in measured if r.truncated]
        n_trunc = len(trunc) + len(huge)

        print(f"  Of {len(text_bearing)} text-bearing files vs the {MAX_FILE_CHARS:,}-char (~{NOMINAL_TOKEN_CAP:,}-token) cap:")
        print(f"    fit entirely (<= cap):  {len(fit):4d}  ({len(fit)/len(text_bearing)*100:5.1f}%)")
        print(f"    truncated (> cap):      {n_trunc:4d}  ({n_trunc/len(text_bearing)*100:5.1f}%)"
              f"{f'  [incl. {len(huge)} >10MB exports]' if huge else ''}\n")

        if measured:
            print("  Extracted size percentiles (measured text-bearing files):")
            print(f"    {'pct':>5} {'chars':>12} {'tokens':>10}  {'x of cap':>9}")
            for p in (50, 75, 90, 95, 99, 100):
                c = pct(chars, p)
                t = pct(toks, p)
                print(f"    {('p'+str(p)):>5} {c:12,.0f} {t:10,.0f}  {t/NOMINAL_TOKEN_CAP:8.2f}x")

            total_tok = sum(r.total_tokens for r in measured)
            returned_tok = sum(r.returned_tokens for r in measured)
            coverage = (returned_tok / total_tok * 100) if total_tok else 100.0
            median_frac = statistics.median(
                [min(1.0, MAX_FILE_CHARS / r.extracted_chars) for r in measured]
            )

            print(f"\n  Token histogram (measured text-bearing files; cap = 8,000 tok):")
            edges = [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000]
            labels = ["<=500", "500-1k", "1k-2k", "2k-4k", "4k-8k <=cap",
                      "8k-16k", "16k-32k", "32k-64k", ">64k"]
            hist(toks, edges, labels)

            print(f"\n  Aggregate coverage: the 8k cap returns {coverage:.1f}% of all readable")
            print(f"  tokens across the measured text-bearing sample.")
            print(f"  Median single file: cap returns {median_frac*100:.0f}% of its text.")

        biggest = sorted(text_bearing, key=lambda r: (r.huge, r.total_tokens), reverse=True)[:8]
        print("\n  Largest text-bearing files in the sample:")
        for r in biggest:
            tok = ">10MB" if r.huge else f"{r.total_tokens:,}"
            print(f"    {r.category:>13}  {tok:>10} tok  {(r.name[:48]):50s}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, "open_file_coverage.csv")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("name,category,mime,bytes_size,extracted_chars,total_tokens,returned_tokens,"
                 "truncated,huge,skipped_large,extractable,note,error\n")
        for r in results:
            name = '"' + r.name.replace('"', "'") + '"'
            fh.write(f"{name},{r.category},{r.mime},{r.bytes_size or ''},{r.extracted_chars},"
                     f"{r.total_tokens},{r.returned_tokens},{r.truncated},{r.huge},{r.skipped_large},"
                     f'{r.extractable},"{r.note}","{r.error}"\n')
    print(f"\n  Per-file detail written to {out_path}")


if __name__ == "__main__":
    main()
