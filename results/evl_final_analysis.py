"""
Final consolidated Evidence-Validation-Layer analysis for the new paper's Results section.
Merges the repository's own static_pairs.csv + recomputed.csv (base session -> final session,
for the 5 documentation-style subjects crawled 2026-08-30) with:
  - within-session filename-collision taint status (F6), computed from summary.json manifests
  - per-session Tukey-fence timing thresholds, computed from summary.json load times
and classifies every row through Algorithm 1 (existence -> pair-correspondence -> geometry/
file-size/blank/timing -> arithmetic consistency), exactly as specified in the paper.

No invented numbers: every value below is read or derived from files already in results/.
"""
import csv, json, os, collections
import numpy as np

TAU_H = 2.0
TAU_S = 5.0
TAU_B_KB = 50  # 50KB blank floor, same constant used in the prior/pilot deployment

SESSIONS = {
    'python': ('python-30-Aug-2026(12_38PM)', 'python-final-30-Aug-2026(12_49PM)'),
    'nodejs': ('nodejs-30-Aug-2026(12_40PM)', 'nodejs-final-30-Aug-2026(12_51PM)'),
    'mdn': ('mdn-30-Aug-2026(12_42PM)', 'mdn-final-30-Aug-2026(12_54PM)'),
    'wikipedia': ('wikipedia-30-Aug-2026(12_44PM)', 'wikipedia-final-30-Aug-2026(12_56PM)'),
    'github-docs': ('github-docs-30-Aug-2026(12_47PM)', 'github-docs-final-30-Aug-2026(12_58PM)'),
}


def taint_set_and_fence(session_dir):
    data = json.load(open(f"{session_dir}/summary.json"))
    basename_count = collections.Counter()
    load_times = []
    for e in data:
        fn = os.path.basename(e['screenshotPath'].replace('\\', '/'))
        basename_count[fn] += 1
        load_times.append(float(e['timeTaken']))
    tainted = {k for k, v in basename_count.items() if v > 1}
    q1, q3 = np.percentile(load_times, [25, 75])
    fence = q3 + 1.5 * (q3 - q1)
    return tainted, fence, load_times


meta = {}
for subj, (base, final) in SESSIONS.items():
    t_base, fence_base, _ = taint_set_and_fence(base)
    t_final, fence_final, _ = taint_set_and_fence(final)
    meta[subj] = {'tainted': t_base | t_final, 'fence_base': fence_base, 'fence_final': fence_final}

# load static_pairs.csv (has url,isfrag,h1,h2,kb1,kb2,load1,load2,diffpct)
static = {}
with open('paper-iccit2026/data/static_pairs.csv') as f:
    for row in csv.DictReader(f):
        key = (row['site'], row['page'])
        static[key] = row

# load recomputed.csv (has recomp_pct, recomp_pct_thr30)
recomp = {}
with open('paper-iccit2026/data/recomputed.csv') as f:
    for row in csv.DictReader(f):
        key = (row['site'], row['page'])
        recomp[key] = row

rows = []
for key, s in static.items():
    subj, page = key
    r = recomp.get(key)
    if r is None:
        continue
    h1, h2 = float(s['h1']), float(s['h2'])
    kb1, kb2 = float(s['kb1']), float(s['kb2'])
    load1, load2 = float(s['load1']), float(s['load2'])
    tool_pct = float(s['diffpct'])
    recomp_pct = float(r['recomp_pct'])
    recomp_pct_thr30 = float(r['recomp_pct_thr30'])

    tainted = page in meta[subj]['tainted']
    h_ratio = max(h1, h2) / min(h1, h2)
    s_ratio = max(kb1, kb2) / min(kb1, kb2)
    blank = min(kb1, kb2) < TAU_B_KB
    slow = (load1 > meta[subj]['fence_base']) or (load2 > meta[subj]['fence_final'])
    signals = {'H': h_ratio >= TAU_H, 'S': s_ratio >= TAU_S, 'B': blank, 'T': slow}
    fired = [k for k, v in signals.items() if v]

    if tainted:
        verdict = 'INVALID_F6_TAINT'
    elif len(fired) >= 2:
        verdict = 'INVALID_GEOMETRY'
    else:
        verdict = 'REACHED_ARITH'

    impossible_strict = tool_pct > recomp_pct
    impossible_thr30 = tool_pct > recomp_pct_thr30

    rows.append({
        'subject': subj, 'page': page, 'url': s['url'], 'isfrag': s['isfrag'],
        'h1': h1, 'h2': h2, 'kb1': kb1, 'kb2': kb2, 'load1': load1, 'load2': load2,
        'h_ratio': round(h_ratio, 3), 's_ratio': round(s_ratio, 3),
        'signals_fired': fired, 'tainted_f6': tainted, 'verdict': verdict,
        'tool_pct': tool_pct, 'recomp_pct': recomp_pct, 'recomp_pct_thr30': recomp_pct_thr30,
        'impossible_strict': impossible_strict, 'impossible_thr30': impossible_thr30,
    })

# ---------------- aggregate ----------------
n_total = len(rows)
n_tainted = sum(1 for r in rows if r['tainted_f6'])
n_geom_invalid = sum(1 for r in rows if r['verdict'] == 'INVALID_GEOMETRY')
n_reached_arith = sum(1 for r in rows if r['verdict'] == 'REACHED_ARITH')
n_invalid_total = n_tainted + n_geom_invalid

# arithmetic consistency, computed only among rows that reached that stage (Algorithm 1 order)
reached = [r for r in rows if r['verdict'] == 'REACHED_ARITH']
n_impossible_strict_gated = sum(1 for r in reached if r['impossible_strict'])
n_impossible_thr30_gated = sum(1 for r in reached if r['impossible_thr30'])

# also report ungated (checked against ALL rows regardless of taint/geometry gate) for transparency
n_impossible_strict_all = sum(1 for r in rows if r['impossible_strict'])
n_impossible_thr30_all = sum(1 for r in rows if r['impossible_thr30'])

print(f"TOTAL comparable pairs (base->final, 5 subjects): {n_total}")
print(f"  Missing-membership (F7, from alignment.csv, not in this table): see alignment.csv separately")
print(f"  Tainted by within-session filename collision (F6): {n_tainted} ({100*n_tainted/n_total:.1f}%)")
print(f"  Invalid by geometry/file-size/blank/timing (>=2 signals), among untainted: {n_geom_invalid} ({100*n_geom_invalid/n_total:.1f}%)")
print(f"  TOTAL invalid pairs (F6 + geometry-class): {n_invalid_total} -> IPR = {100*n_invalid_total/n_total:.1f}%")
print(f"  Reached arithmetic-consistency stage: {n_reached_arith}")
print(f"  Impossible records (strict, gated -- only among pairs that passed geometry/taint gates): {n_impossible_strict_gated} / {n_reached_arith}")
print(f"  Impossible records (thr30-tolerant, gated): {n_impossible_thr30_gated} / {n_reached_arith}")
print(f"  [transparency] Impossible records if checked on ALL {n_total} rows regardless of gating: strict={n_impossible_strict_all}, thr30={n_impossible_thr30_all}")

print("\nPer-subject breakdown:")
by_subj = collections.defaultdict(list)
for r in rows:
    by_subj[r['subject']].append(r)
for subj, rs in by_subj.items():
    n = len(rs)
    tainted = sum(1 for r in rs if r['tainted_f6'])
    geom = sum(1 for r in rs if r['verdict'] == 'INVALID_GEOMETRY')
    reached_s = [r for r in rs if r['verdict'] == 'REACHED_ARITH']
    imp = sum(1 for r in reached_s if r['impossible_strict'])
    print(f"  {subj}: n={n} tainted_F6={tainted} geom_invalid={geom} reached_arith={len(reached_s)} impossible_strict={imp}")

print("\nAll impossible (strict) records among gated (reached_arith) pairs:")
for r in reached:
    if r['impossible_strict']:
        print(f"  {r['subject']}/{r['page']}: tool={r['tool_pct']}% recomp={r['recomp_pct']}% recomp_thr30={r['recomp_pct_thr30']}% h1={r['h1']} h2={r['h2']} kb1={r['kb1']} kb2={r['kb2']}")

print("\nAll geometry-invalid rows:")
for r in rows:
    if r['verdict'] == 'INVALID_GEOMETRY':
        print(f"  {r['subject']}/{r['page']}: h_ratio={r['h_ratio']} s_ratio={r['s_ratio']} signals={r['signals_fired']} tool_pct={r['tool_pct']}")

print("\nAll F6-tainted rows (collision-affected filenames):")
for r in rows:
    if r['tainted_f6']:
        print(f"  {r['subject']}/{r['page']}: url={r['url']} isfrag={r['isfrag']} tool_pct={r['tool_pct']} recomp_pct={r['recomp_pct']}")

with open('evl_final_rows.json', 'w') as f:
    json.dump(rows, f, indent=2, default=str)
print("\nSaved evl_final_rows.json")
