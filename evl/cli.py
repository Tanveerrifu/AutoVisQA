"""Command line: python -m evl validate --ref <session> --cur <session> [--records file]"""
from __future__ import annotations

import argparse
import json
import sys

from .core import Thresholds, validate_sessions


def _print_summary(rep: dict) -> None:
    s = rep["summary"]
    print(f"EVL {rep['evl_version']}  {s['ref_session']}  ->  {s['cur_session']}")
    rows = [("Matched pairs", s["pairs"]), ("No pair (F7)", s["no_pair_F7"]),
            ("Filename-collision tainted (F6)", s["tainted_F6"]),
            ("Metadata invalid (>=2 of H,S,B,T)", s["metadata_invalid"]),
            ("Reached arithmetic gate", s["reached_arithmetic_gate"]),
            ("Impossible records (F8)", s["impossible_F8"]),
            ("Records for different files (F8H)", s["misattributed_F8H"]),
            ("Valid", s["valid"])]
    for k, v in rows:
        print(f"  {k:<36}{v:>6}")
    bad = [p for p in rep["pairs"] if p["verdict"] == "INVALID"]
    if bad:
        print("\n  Invalid pairs:")
        for p in bad:
            extra = ""
            if p.get("d_reported") is not None and p.get("d_raw") is not None:
                extra = f"  reported={p['d_reported']} raw={p['d_raw']}"
            elif p.get("signals"):
                extra = f"  signals={','.join(p['signals'])}"
            print(f"   [{'/'.join(p['reasons'])}] {p['norm_url']}{extra}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="evl", description="Evidence Validation Layer for visual regression testing")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="validate two crawl sessions and (optionally) their diff records")
    v.add_argument("--ref", required=True, help="reference session folder (has summary.json, screenshots/)")
    v.add_argument("--cur", required=True, help="current session folder")
    v.add_argument("--records", help="visual_diff_summary.json produced by the diff back-end")
    v.add_argument("--out", help="write the full JSON report here")
    v.add_argument("--metadata-only", action="store_true", help="skip pixel-level checks (fast tier)")
    v.add_argument("--tau-h", type=float, default=2.0)
    v.add_argument("--tau-s", type=float, default=5.0)
    v.add_argument("--tau-b-kb", type=float, default=50.0)
    v.add_argument("--fail-on-invalid", action="store_true", help="exit 1 if any pair is INVALID (for CI gates)")
    a = ap.parse_args(argv)

    t = Thresholds(tau_h=a.tau_h, tau_s=a.tau_s, tau_b_bytes=int(a.tau_b_kb * 1024))
    rep = validate_sessions(a.ref, a.cur, a.records, t, pixel_tier=not a.metadata_only)
    _print_summary(rep)
    if a.out:
        with open(a.out, "w") as f:
            json.dump(rep, f, indent=2)
        print(f"\nReport written to {a.out}")
    if a.fail_on_invalid and any(p["verdict"] == "INVALID" for p in rep["pairs"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
