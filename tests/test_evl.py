"""Unit tests for the Evidence Validation Layer. Run: python3 -m unittest discover -s tests"""
import json
import os
import tempfile
import unittest

import numpy as np
from PIL import Image

from evl import Thresholds, normalize_url, raw_pixel_inequality, sha256_file, validate_sessions


def _dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f)


def _png(path, h=200, w=100, color=(240, 240, 240), noise_px=0, seed=0, big=False):
    arr = np.full((h, w, 3), color, dtype=np.uint8)
    if big:  # high-entropy content so the file is large (not "blank")
        arr = np.random.default_rng(seed).integers(0, 255, (h, w, 3), dtype=np.uint8)
    if noise_px:
        arr.reshape(-1, 3)[:noise_px] = (0, 0, 0)
    Image.fromarray(arr).save(path)


def _session(root, name, pages, loads=None):
    """pages: list of (url, filename, image-kwargs)."""
    d = os.path.join(root, name)
    os.makedirs(os.path.join(d, "screenshots"))
    entries = []
    for i, (url, fn, kw) in enumerate(pages):
        p = os.path.join(d, "screenshots", fn)
        if not os.path.exists(p):
            _png(p, **kw)
        entries.append({"url": url, "screenshotPath": f"C:\\x\\screenshots\\{fn}",
                        "timeTaken": str((loads or [5.0] * len(pages))[i])})
    _dump(entries, os.path.join(d, "summary.json"))
    return d


BIG = {"big": True, "h": 200, "w": 200}


class NormalizeUrlTest(unittest.TestCase):
    def test_fragment_slash_and_session_params_removed(self):
        self.assertEqual(normalize_url("https://Ex.org/a/#top"), "https://ex.org/a")
        self.assertEqual(normalize_url("https://ex.org/a?utm_source=x&b=2"), "https://ex.org/a?b=2")
        self.assertEqual(normalize_url("https://ex.org/"), "https://ex.org/")


class RawCountTest(unittest.TestCase):
    def test_counts_unequal_pixels_and_crops(self):
        with tempfile.TemporaryDirectory() as t:
            a, b = os.path.join(t, "a.png"), os.path.join(t, "b.png")
            _png(a, h=10, w=10)
            _png(b, h=12, w=10, noise_px=7)
            r = raw_pixel_inequality(a, b)
            self.assertEqual((r["d_raw"], r["height"], r["cropped"]), (7, 10, 1))


class AlgorithmTest(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        root = self.t.name
        u = "https://ex.org/"
        self.ref = _session(root, "s1", [
            (u + "ok", "ok.png", dict(BIG, seed=1)),
            (u + "imp", "imp.png", dict(BIG, seed=2)),
            (u + "geo", "geo.png", dict(BIG, seed=3)),
            (u + "only-ref", "only.png", dict(BIG, seed=4)),
            (u + "dup", "dup.png", dict(BIG, seed=5)),
            (u + "dup#x", "dup.png", dict(BIG, seed=5)),
        ])
        self.cur = _session(root, "s2", [
            (u + "ok", "ok.png", dict(BIG, seed=1)),
            (u + "imp", "imp.png", dict(BIG, seed=2)),
            (u + "geo", "geo.png", dict(h=2000, w=200, color=(10, 20, 30))),
            (u + "dup", "dup.png", dict(BIG, seed=5)),
        ])
        # identical files for ok/imp, so D_raw = 0
        self.records = os.path.join(root, "records.json")
        _dump([{"page": "ok.png", "diffPixels": 0}, {"page": "imp.png", "diffPixels": 25}], self.records)

    def tearDown(self):
        self.t.cleanup()

    def verdicts(self, **kw):
        rep = validate_sessions(self.ref, self.cur, self.records, **kw)
        return rep, {p["norm_url"].rsplit("/", 1)[-1]: p for p in rep["pairs"]}

    def test_each_failure_class(self):
        rep, v = self.verdicts()
        self.assertEqual(v["ok"]["verdict"], "VALID")
        self.assertEqual(v["imp"]["reasons"], ["F8"])              # 25 > 0 is impossible
        self.assertEqual(v["only-ref"]["reasons"], ["F7"])
        self.assertEqual(v["dup"]["reasons"], ["F6"])              # dup.png shared in s1
        self.assertEqual(v["geo"]["reasons"], ["F2/F3/F4/F9"])     # H and S fire
        self.assertEqual(rep["summary"]["impossible_F8"], 1)

    def test_metadata_only_tier_misses_impossible_record(self):
        _, v = self.verdicts(pixel_tier=False)
        self.assertEqual(v["imp"]["verdict"], "VALID")

    def test_thresholds_are_configurable(self):
        _, v = self.verdicts(thresholds=Thresholds(tau_h=100, tau_s=100))
        self.assertNotIn("F2/F3/F4/F9", v["geo"]["reasons"])

    def test_hash_mismatch_detected_even_when_arithmetic_is_consistent(self):
        f = os.path.join(self.ref, "screenshots", "ok.png")
        _dump([{"page": "ok.png", "diffPixels": 0, "refSha256": "0" * 64,
               "curSha256": sha256_file(f)}], self.records)
        _, v = self.verdicts()
        self.assertEqual(v["ok"]["reasons"], ["F8H"])


if __name__ == "__main__":
    unittest.main()
