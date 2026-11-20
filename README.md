# AutoVisQA

**Evidence validation for automated visual regression testing.**

AutoVisQA is a screenshot-based visual regression harness (Puppeteer crawler + pixel-diff back-ends)
together with the capture archive and analysis scripts behind the paper:

> T. Hasan, **"When Screenshot Diffing Lies: Detecting Invalid Evidence in Automated Visual
> Regression Testing,"** in *Proc. 29th International Conference on Computer and Information
> Technology (IEEE ICCIT 2026)*. Accepted for oral presentation.

---

## Why this exists

A visual regression pipeline captures a page, captures it again later, diffs the two screenshots
and thresholds the changed-pixel count. The diff always returns a number, even when its inputs are
meaningless: a blank pre-render capture, two different pages paired by a colliding filename, or a
stored record computed on the wrong pair of screenshots.

This project treats **evidence validity** as a separate stage that runs *before* any threshold
decision. Its key check is a simple arithmetic invariant:

```
D_reported <= D_raw
```

A diff tool may report *fewer* changed pixels than actually differ (tolerances, masking), but it can
never report *more*. Any record that does is impossible, with no ground-truth label needed.

## Main findings (pilot, 5 documentation sites, 81 matched capture pairs)

| Measure | Result | 95% CI |
|---|---|---|
| Manifest entries colliding on filename within a session (CAR) | 35 / 260 = **13.5%** | 9.8–18.1% |
| Matched pairs that are invalid evidence (IPR) | 9 / 81 = **11.1%** | 6.0–19.8% |
| Records reaching the arithmetic gate that are impossible (IRR) | 3 / 72 = **4.2%** | 1.4–11.5% |

* Re-executing the diff back-end reproduced every impossible record exactly. All of them were real
  pipeline defects: records computed on a different session pair, or on a different page after a
  filename collision inside the diff tool. **No false alarms (5/5).**
* The invariant is one-sided: it caught 5 of the 17 records attached to the wrong pair.
* Metadata-only checks cost 2.6 ms/pair; pixel-level checks cost 232 ms/pair. They catch
  disjoint failures, so you need both.

## Repository layout

| Path | Contents |
|---|---|
| `crawler/` | Puppeteer crawler. Writes `results/<session>/summary.json` and full-page screenshots |
| `analysis/visual_diff.js` | Diff back-end that produced the stored records (pixelmatch 5.3.0, threshold 0.1, `includeAA: true`) |
| `analysis/*.py` | Report, dashboard and AI-insight utilities from the original AutoVisQA harness |
| `results/<subject>-*-30-Aug-2026*/` | Pilot capture archive: 5 subjects, 2–3 sessions each, crawled 2026-08-30 |
| `results/visual_diffs/<subject>/` | Stored comparison records checked in the paper |
| `results/evl_final_analysis.py` | Evidence Validation Layer (Algorithm 1). Reproduces the paper's main numbers |
| `results/evidence_inventory.py` | Within-session filename-collision counts |
| `results/paper-iccit2026/scripts/` | Ground-truth and cross-check scripts |
| `results/paper-iccit2026/data/` | Per-pair tables used by `evl_final_analysis.py` |
| `evl/` | Evidence Validation Layer as a reusable Python package and CLI |
| `tests/` | Unit and paper-regression tests |
| `results/paper-iccit2026/1526.pdf` | Camera-ready paper |

## Quick start

Requirements: Node.js 18+, Python 3.10+ (`pip install -r requirements.txt`), and (optional) ImageMagick 6.9+.

```bash
git clone https://github.com/Tanveerrifu/AutoVisQA.git
cd AutoVisQA
(cd analysis && npm install)
(cd crawler && npm install)
pip install -r requirements.txt
```

### Reproduce the paper's numbers

```bash
cd results
python3 evidence_inventory.py      # CAR: 35/260 collision-affected manifest entries
python3 evl_final_analysis.py      # 81 pairs -> 8 F6-tainted, 1 geometry-invalid, 72 reach the gate, 3 impossible

cd paper-iccit2026/scripts
node reexecute_backend.mjs python  # which session pair reproduces each stored record
                                   # (also: wikipedia, github-docs, nodejs, mdn)
python3 realign_records.py         # every stored record vs. the pair it actually describes
python3 imagemagick_recount.py     # raw-pixel recount cross-checked with ImageMagick
```

### Run your own crawl and diff

See [Typical workflow](#typical-workflow) below (crawler v4 + diff back-end v5 + EVL).

## New in v2: evidence-aware tooling

The study found two defects in the original pipeline (filename collisions and records attached to the
wrong session pair). The repository now ships fixed tools. The originals are kept unchanged so the
paper stays reproducible.

| Tool | What it does |
|---|---|
| `python -m evl validate` | The Evidence Validation Layer as a reusable CLI: pairs pages by normalized URL, flags F1/F6/F7, metadata anomalies (H, S, B, T), impossible records (F8) and, for v5 records, records that describe different files (F8H). `--fail-on-invalid` makes it a CI gate. |
| `analysis/visual_diff_v5.js` | Diff back-end v5: explicit `--ref/--cur` sessions, pages matched by normalized URL (no `_2` suffix stripping), and every record stores both screenshots' SHA-256, sizes and session names. |
| `crawler/index.js` (v4.0) | De-duplicates pages by normalized URL, writes collision-free stable filenames (`<path>__<hash>.png`), and records final URL, redirects, `readyState`, dimensions, file size and SHA-256 in `summary.json`. The pilot's crawler is kept as `crawler/index_v3.9_legacy.js`. |
| `tests/` and `.github/workflows/tests.yml` | Unit tests for every failure class, plus a regression test that the archive still reproduces the paper's numbers. |

### Typical workflow

```bash
# 1. Crawl twice (before and after a change)
cd crawler && RUN_LABEL=mysite node index.js        # ... deploy ... then again
# 2. Diff with the v5 back-end
cd ../analysis
node visual_diff_v5.js --ref "mysite-<date1>" --cur "mysite-<date2>" --out mysite
# 3. Validate the evidence before trusting any number
cd ..
python3 -m evl validate \
  --ref "results/mysite-<date1>" --cur "results/mysite-<date2>" \
  --records results/visual_diffs_v5/mysite/visual_diff_summary.json \
  --out results/visual_diffs_v5/mysite/evl_report.json --fail-on-invalid
```

Example on the pilot archive (original records, Wikipedia):

```text
$ python3 -m evl validate --ref "results/wikipedia-30-Aug-2026(12_44PM)" \
      --cur "results/wikipedia-final-30-Aug-2026(12_56PM)" \
      --records results/visual_diffs/wikipedia/visual_diff_summary.json
  Impossible records (F8)                  2
   [F2/F3/F4/F9] https://en.wikipedia.org/wiki/Special:Random  signals=H,S
   [F8] https://en.wikipedia.org/wiki/Special:RecentChanges  reported=376635 raw=0
   [F8] https://en.wikipedia.org/wiki/Special:Search  reported=17 raw=0
```

The CLI pairs pages by URL, so its pair counts can differ slightly from the paper's file-level
pairing; the paper's exact numbers come from `results/evl_final_analysis.py`.

### Running the tests

```bash
python3 -m unittest discover -s tests -v
(cd analysis && node --test visual_diff_v5.test.mjs)
(cd crawler && node --test fileBase.test.mjs)
```

## Failure taxonomy

| ID | Failure | ID | Failure |
|---|---|---|---|
| F1 | Missing / unreadable capture | F6 | Colliding filenames |
| F2 | Truncated / pre-render capture | F7 | Page missing from one session |
| F3 | Unstable geometry | F8 | Impossible record (`D_reported > D_raw`) |
| F4 | File-size anomaly | F9 | Abnormal metadata (load time, viewport) |
| F5 | Pair mismatch | | |

Thresholds used in the pilot (identical for every subject): height ratio `τH = 2`,
file-size ratio `τS = 5`, blank floor `τB = 50 KB`, and a per-session Tukey fence on load time.

## Known issue

`analysis/visual_diff.js` (v4, used in the pilot) normalizes filenames with `/_\d+\.png$/ → .png`, so a capture such as
`about_2.png` silently replaces `about.png` in its comparison map. It is left unmodified because the
paper studies the records it produced. Use `analysis/visual_diff_v5.js` for new work: it fixes this and
stores content hashes so the EVL can detect misattributed records exactly.

## Configuration and secrets

`config.json` holds report thresholds and notification settings. **Never commit credentials.**
Provide the SMTP password through the `SMTP_PASSWORD` environment variable.

## Citation

```bibtex
@inproceedings{hasan2026screenshot,
  author    = {Tanvir Hasan},
  title     = {When Screenshot Diffing Lies: Detecting Invalid Evidence in Automated Visual Regression Testing},
  booktitle = {Proc. 29th International Conference on Computer and Information Technology (ICCIT)},
  publisher = {IEEE},
  year      = {2026}
}
```

## Contact

Tanvir Hasan, Independent Researcher, Dhaka, Bangladesh. tanvir.cse.cu@gmail.com
