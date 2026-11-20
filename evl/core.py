"""Core of the Evidence Validation Layer.

Failure classes (paper, Table I):
  F1 missing/unreadable   F2 truncated/pre-render  F3 unstable geometry
  F4 file-size anomaly    F5 pair mismatch          F6 colliding filenames
  F7 missing membership   F8 impossible record      F9 abnormal metadata
Extra (paper, guidance 5): F8H record describes different files (hash mismatch).
"""
from __future__ import annotations

import collections
import hashlib
import json
import os
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

import numpy as np
from PIL import Image

# Query parameters that differ between sessions without changing the page.
SESSION_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
                  "gclid", "fbclid", "_ga", "sessionid", "sid", "ts", "cachebust"}


@dataclass(frozen=True)
class Thresholds:
    """Validation thresholds. Defaults are the fixed values used in the paper."""
    tau_h: float = 2.0            # height-ratio geometry signal (H)
    tau_s: float = 5.0            # file-size-ratio signal (S)
    tau_b_bytes: int = 50 * 1024  # blank floor (B)
    min_signals: int = 2          # pair is INVALID when >= this many of H,S,B,T fire
    tukey_k: float = 1.5          # timing fence: Q3 + k*IQR
    min_loads_for_fence: int = 4


def normalize_url(url: str) -> str:
    """Page identity used for pairing: drop fragment and session-specific query
    parameters, drop a trailing slash (except the root), lowercase scheme/host."""
    parts = urlsplit(url.strip())
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                             if k.lower() not in SESSION_PARAMS))
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def raw_pixel_inequality(path_a: str, path_b: str) -> Dict[str, int]:
    """D_raw: number of pixels whose RGB values differ (zero tolerance), after
    cropping both images to their common top-left region (as the diff back-end does)."""
    a = np.asarray(Image.open(path_a).convert("RGB"))
    b = np.asarray(Image.open(path_b).convert("RGB"))
    h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
    d = int(np.any(a[:h, :w] != b[:h, :w], axis=-1).sum())
    return {"d_raw": d, "width": w, "height": h, "cropped": int(a.shape[:2] != b.shape[:2])}


@dataclass
class Capture:
    url: str
    norm_url: str
    file: str            # absolute path on disk
    basename: str
    load_time: Optional[float]
    tainted: bool = False   # F6: basename shared with another manifest entry
    error: Optional[str] = None


@dataclass
class Session:
    name: str
    path: str
    captures: Dict[str, Capture]       # keyed by normalized URL (last write wins, as on disk)
    entries: int
    collision_entries: int
    fence: Optional[float]


def _screenshot_path(session_dir: str, entry: dict) -> str:
    raw = (entry.get("screenshotPath") or "").replace("\\", "/")
    base = os.path.basename(raw)
    local = os.path.join(session_dir, "screenshots", base)
    return local if base else ""


def load_session(session_dir: str, thresholds: Thresholds = Thresholds()) -> Session:
    """Read a crawl session (summary.json manifest + screenshots/)."""
    mpath = os.path.join(session_dir, "summary.json")
    if not os.path.exists(mpath):
        raise FileNotFoundError(f"no manifest (F1): {mpath}")
    with open(mpath) as f:
        data = json.load(f)
    entries = [e for e in data if not e.get("error")]
    counts = collections.Counter(os.path.basename(_screenshot_path(session_dir, e)) for e in entries)
    caps: Dict[str, Capture] = {}
    loads: List[float] = []
    for e in entries:
        path = _screenshot_path(session_dir, e)
        base = os.path.basename(path)
        lt = float(e["timeTaken"]) if e.get("timeTaken") not in (None, "") else None
        if lt is not None:
            loads.append(lt)
        nu = e.get("normalizedUrl") or normalize_url(e["url"])
        caps[nu] = Capture(url=e["url"], norm_url=nu, file=path, basename=base,
                           load_time=lt, tainted=counts[base] > 1)
    fence = None
    if len(loads) >= thresholds.min_loads_for_fence:
        q1, q3 = np.percentile(loads, [25, 75])
        fence = float(q3 + thresholds.tukey_k * (q3 - q1))
    return Session(name=os.path.basename(os.path.normpath(session_dir)), path=session_dir,
                   captures=caps, entries=len(entries),
                   collision_entries=sum(v for v in counts.values() if v > 1), fence=fence)


@dataclass
class PairVerdict:
    norm_url: str
    verdict: str                       # VALID | INVALID | NO_PAIR
    reasons: List[str] = field(default_factory=list)
    signals: List[str] = field(default_factory=list)
    h_ratio: Optional[float] = None
    s_ratio: Optional[float] = None
    d_reported: Optional[int] = None
    d_raw: Optional[int] = None
    ref_file: Optional[str] = None
    cur_file: Optional[str] = None

    def to_dict(self):
        return asdict(self)


def _readable(path: str) -> bool:
    try:
        with Image.open(path) as im:
            im.verify()
        return os.path.getsize(path) > 0
    except Exception:
        return False


def validate_pair(ref: Capture, cur: Capture, ref_fence: Optional[float], cur_fence: Optional[float],
                  record: Optional[dict], t: Thresholds, pixel_tier: bool = True) -> PairVerdict:
    v = PairVerdict(norm_url=ref.norm_url, verdict="VALID", ref_file=ref.basename, cur_file=cur.basename)
    # F1
    if not (os.path.exists(ref.file) and os.path.exists(cur.file) and _readable(ref.file) and _readable(cur.file)):
        v.verdict, v.reasons = "INVALID", ["F1"]
        return v
    # F5/F6: correspondence. Normalized URLs match by construction; a shared basename
    # means another entry may have overwritten this file on disk.
    if ref.tainted or cur.tainted:
        v.verdict, v.reasons = "INVALID", ["F6"]
        return v
    with Image.open(ref.file) as a, Image.open(cur.file) as b:
        (wa, ha), (wb, hb) = a.size, b.size
    sa, sb = os.path.getsize(ref.file), os.path.getsize(cur.file)
    v.h_ratio = round(max(ha, hb) / min(ha, hb), 4)
    v.s_ratio = round(max(sa, sb) / min(sa, sb), 4)
    sig = {
        "H": v.h_ratio >= t.tau_h,
        "S": v.s_ratio >= t.tau_s,
        "B": min(sa, sb) < t.tau_b_bytes,
        "T": any(f is not None and lt is not None and lt > f
                 for f, lt in ((ref_fence, ref.load_time), (cur_fence, cur.load_time))),
    }
    v.signals = [k for k, on in sig.items() if on]
    if len(v.signals) >= t.min_signals:
        v.verdict, v.reasons = "INVALID", ["F2/F3/F4/F9"]
        return v
    if record is None or not pixel_tier:
        return v
    # Exact misattribution check when the record carries content hashes (diff back-end v5).
    if record.get("refSha256") and record.get("curSha256"):
        if (record["refSha256"], record["curSha256"]) != (sha256_file(ref.file), sha256_file(cur.file)):
            v.verdict, v.reasons = "INVALID", ["F8H"]
            v.d_reported = record.get("diffPixels")
            return v
    # F8: arithmetic consistency
    v.d_reported = int(record["diffPixels"])
    v.d_raw = raw_pixel_inequality(ref.file, cur.file)["d_raw"]
    if v.d_reported > v.d_raw:
        v.verdict, v.reasons = "INVALID", ["F8"]
    return v


def load_records(path: Optional[str]) -> Dict[str, dict]:
    """Comparison records (visual_diff_summary.json), keyed by page filename
    and, when present, by normalized URL."""
    if not path:
        return {}
    with open(path) as f:
        recs = json.load(f)
    out = {}
    for r in recs:
        if "diffPixels" not in r:
            continue
        out[r.get("page") or r.get("curFile")] = r
        if r.get("normalizedUrl"):
            out[r["normalizedUrl"]] = r
    return out


def validate_sessions(ref_dir: str, cur_dir: str, records_path: Optional[str] = None,
                      thresholds: Thresholds = Thresholds(), pixel_tier: bool = True) -> dict:
    """Algorithm 1 over two crawl sessions. Returns a JSON-serialisable report."""
    ref, cur = load_session(ref_dir, thresholds), load_session(cur_dir, thresholds)
    recs = load_records(records_path)
    verdicts: List[PairVerdict] = []
    for nu in sorted(set(ref.captures) | set(cur.captures)):
        if nu not in ref.captures or nu not in cur.captures:
            verdicts.append(PairVerdict(norm_url=nu, verdict="NO_PAIR", reasons=["F7"]))
            continue
        r, c = ref.captures[nu], cur.captures[nu]
        rec = recs.get(nu) or recs.get(c.basename)
        verdicts.append(validate_pair(r, c, ref.fence, cur.fence, rec, thresholds, pixel_tier))
    pairs = [v for v in verdicts if v.verdict != "NO_PAIR"]
    reached = [v for v in pairs if v.d_raw is not None or "F8" in v.reasons]
    summary = {
        "ref_session": ref.name, "cur_session": cur.name,
        "manifest_entries": ref.entries + cur.entries,
        "collision_entries": ref.collision_entries + cur.collision_entries,
        "pairs": len(pairs),
        "no_pair_F7": sum(v.verdict == "NO_PAIR" for v in verdicts),
        "tainted_F6": sum("F6" in v.reasons for v in pairs),
        "metadata_invalid": sum("F2/F3/F4/F9" in v.reasons for v in pairs),
        "reached_arithmetic_gate": len(reached),
        "impossible_F8": sum("F8" in v.reasons for v in pairs),
        "misattributed_F8H": sum("F8H" in v.reasons for v in pairs),
        "valid": sum(v.verdict == "VALID" for v in pairs),
    }
    return {"evl_version": "1.0.0", "thresholds": asdict(thresholds), "summary": summary,
            "pairs": [v.to_dict() for v in verdicts]}
