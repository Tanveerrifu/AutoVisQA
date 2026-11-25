"""ImageMagick cross-check of the raw-pixel recount (D_raw), ICCIT 2026 paper 1526, Section VI-E.

For every pair that reached the arithmetic gate (verdict REACHED_ARITH in evl_final_rows.json):
 1. count unequal pixels ourselves (numpy, RGB, zero tolerance, cropped to the common top-left region);
 2. count them again with ImageMagick: compare -metric PDC -fuzz 0%
    (use AE on older builds where PDC is unavailable);
    (done in 4000-px horizontal bands, because ImageMagick refuses very tall images);
 3. report how many pairs agree exactly.


"""

import json
import os
import subprocess
from decimal import Decimal, InvalidOperation
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))  # the results/ folder

# first (reference) and second (current) session of each subject
S = {
    "python": ("python-30-Aug-2026(12_38PM)", "python-final-30-Aug-2026(12_49PM)"),
    "nodejs": ("nodejs-30-Aug-2026(12_40PM)", "nodejs-final-30-Aug-2026(12_51PM)"),
    "mdn": ("mdn-30-Aug-2026(12_42PM)", "mdn-final-30-Aug-2026(12_54PM)"),
    "wikipedia": ("wikipedia-30-Aug-2026(12_44PM)", "wikipedia-final-30-Aug-2026(12_56PM)"),
    "github-docs": ("github-docs-30-Aug-2026(12_47PM)", "github-docs-final-30-Aug-2026(12_58PM)"),
}

rows = [
    r
    for r in json.load(open(os.path.join(R, "evl_final_rows.json")))
    if r["verdict"] == "REACHED_ARITH"
]

metrics = subprocess.check_output(["compare", "-list", "metric"], text=True)
metric = "PDC" if "PDC" in metrics.split() else "AE"

agree, out = 0, []
for r in rows:
    a = f"{R}/{S[r['subject']][0]}/screenshots/{r['page']}"
    b = f"{R}/{S[r['subject']][1]}/screenshots/{r['page']}"
    A, B = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    w, h = min(A.width, B.width), min(A.height, B.height)

    # 1. our own count
    x, y = np.array(A)[:h, :w], np.array(B)[:h, :w]
    mine = int(np.any(x != y, axis=-1).sum())

    # 2. ImageMagick count, band by band
    im, bad = 0, False
    with TemporaryDirectory(prefix="imagemagick-recount-") as tmp:
        band_a, band_b = Path(tmp) / "a.png", Path(tmp) / "b.png"
        for y0 in range(0, h, 4000):
            box = (0, y0, w, min(y0 + 4000, h))
            A.crop(box).save(band_a)
            B.crop(box).save(band_b)
            p = subprocess.run(
                ["compare", "-precision", "17", "-metric", metric, "-fuzz", "0%",
                 str(band_a), str(band_b), "null:"],
                capture_output=True,
                text=True,
            )
            txt = (p.stderr or p.stdout).strip()
            try:
                count = Decimal(txt.split()[0])
                if (
                    p.returncode not in (0, 1)
                    or not count.is_finite()
                    or not 0 <= count <= w * (box[3] - y0)
                    or count != count.to_integral_value()
                ):
                    raise ValueError("ImageMagick did not return a pixel count")
            except (IndexError, InvalidOperation, ValueError):
                print("IMERR", r["subject"], r["page"], f"{metric}, row {y0}", txt[:120])
                bad = True
                break
            im += int(count)
    if bad:
        continue

    agree += mine == im
    out.append((r["subject"], r["page"], mine, im, mine == im))

# 3. summary
print(len(rows), f"pairs; exact agreement mine vs ImageMagick ({metric}):", agree)
for o in out:
    if not o[4]:
        print("DIFF", o)
json.dump(
    out,
    open(os.path.join(os.path.dirname(__file__), "im_check.json"), "w"),
    indent=1,
)
