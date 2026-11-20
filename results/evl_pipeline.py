"""
Evidence Validation Layer (EVL) analysis, run against the real AutoVisQA-main/results
capture archive (5 subjects crawled 2026-08-30: nodejs, mdn, github-docs, wikipedia, python;
plus w3c and webdev, whose crawls failed and are reported separately).

This implements Algorithm 1 (Screenshot Evidence Validation) from the paper, faithfully,
against real capture manifests and real screenshots -- no synthetic or invented data.
Run on the machine holding the results folder (needs PIL + numpy).
"""
import json, os, collections, statistics
from PIL import Image
import numpy as np

RESULTS = "."

SUBJECT_SESSIONS = {
    'nodejs': ['nodejs-30-Aug-2026(12_40PM)', 'nodejs-final-30-Aug-2026(12_51PM)'],
    'mdn': ['mdn-30-Aug-2026(12_42PM)', 'mdn-final-30-Aug-2026(12_54PM)'],
    'github-docs': ['github-docs-30-Aug-2026(12_47PM)', 'github-docs-final-30-Aug-2026(12_58PM)', 'github-docs-full-30-Aug-2026(1_05PM)'],
    'wikipedia': ['wikipedia-30-Aug-2026(12_44PM)', 'wikipedia-final-30-Aug-2026(12_56PM)', 'wikipedia-full-30-Aug-2026(1_03PM)'],
    'python': ['python-30-Aug-2026(12_38PM)', 'python-final-30-Aug-2026(12_49PM)', 'python-full-30-Aug-2026(1_01PM)'],
}

TAU_H = 2.0     # height-ratio geometry threshold (paper default)
TAU_S = 5.0     # file-size ratio threshold (paper default)
TAU_B_ABS = 50 * 1024  # absolute blank floor, 50KB (paper default, ICECE-derived)


def norm_url(u):
    u = u.split('#')[0]
    if u.endswith('/') and u.count('/') > 2:
        u = u[:-1]
    return u


def load_session(session_dir):
    """Return dict: normalized_url -> record{basename, tainted, timeTaken, raw_url}"""
    mpath = f"{session_dir}/summary.json"
    if not os.path.exists(mpath):
        return None, None
    data = json.load(open(mpath))
    basename_count = collections.Counter()
    entries = []
    for e in data:
        fn = os.path.basename(e['screenshotPath'].replace('\\', '/'))
        basename_count[fn] += 1
        entries.append((e['url'], fn, float(e['timeTaken'])))
    by_norm_url = {}
    for url, fn, t in entries:
        nu = norm_url(url)
        # last-write-wins matches on-disk reality
        by_norm_url[nu] = {'basename': fn, 'tainted': basename_count[fn] > 1, 'timeTaken': t, 'raw_url': url}
    load_times = [t for _, _, t in entries]
    tukey_fence = None
    if len(load_times) >= 4:
        q1, q3 = np.percentile(load_times, [25, 75])
        iqr = q3 - q1
        tukey_fence = q3 + 1.5 * iqr
    return by_norm_url, tukey_fence


def img_stats(path):
    im = Image.open(path)
    im.load()
    return im, im.size, os.path.getsize(path)  # size=(w,h)


def raw_pixel_inequality(im1, im2):
    a = np.array(im1.convert('RGB'))
    b = np.array(im2.convert('RGB'))
    h = min(a.shape[0], b.shape[0])
    w = min(a.shape[1], b.shape[1])
    a = a[:h, :w]
    b = b[:h, :w]
    diff = np.any(a != b, axis=-1)
    return int(diff.sum()), h, w


def analyze_pair(subject, ref_dir, cur_dir, ref_map, cur_map, ref_fence, cur_fence):
    ref_urls = set(ref_map.keys())
    cur_urls = set(cur_map.keys())
    common = ref_urls & cur_urls
    nopair = (ref_urls ^ cur_urls)
    results = {
        'subject': subject, 'ref': ref_dir, 'cur': cur_dir,
        'n_ref': len(ref_urls), 'n_cur': len(cur_urls),
        'n_common_url': len(common), 'n_nopair_f7': len(nopair),
        'n_tainted_f6': 0, 'n_geom_invalid': 0, 'n_blank': 0, 'n_timing': 0,
        'n_reached_arith_stage': 0, 'n_unreadable_f1': 0,
        'per_pair': []
    }
    for u in sorted(common):
        r, c = ref_map[u], cur_map[u]
        if r['tainted'] or c['tainted']:
            results['n_tainted_f6'] += 1
            results['per_pair'].append({'url': u, 'verdict': 'INVALID_F6', 'ref_file': r['basename'], 'cur_file': c['basename']})
            continue
        rp = f"{ref_dir}/screenshots/{r['basename']}"
        cp = f"{cur_dir}/screenshots/{c['basename']}"
        try:
            r_im, r_size, r_bytes = img_stats(rp)
            c_im, c_size, c_bytes = img_stats(cp)
        except Exception as ex:
            results['n_unreadable_f1'] += 1
            results['per_pair'].append({'url': u, 'verdict': 'INVALID_F1', 'error': str(ex)})
            continue
        h_ratio = max(r_size[1], c_size[1]) / min(r_size[1], c_size[1])
        s_ratio = max(r_bytes, c_bytes) / min(r_bytes, c_bytes)
        blank = min(r_bytes, c_bytes) < TAU_B_ABS
        slow = False
        if ref_fence is not None and r['timeTaken'] > ref_fence:
            slow = True
        if cur_fence is not None and c['timeTaken'] > cur_fence:
            slow = True
        signals = {'H': h_ratio >= TAU_H, 'S': s_ratio >= TAU_S, 'B': blank, 'T': slow}
        fired = [k for k, v in signals.items() if v]
        rec = {'url': u, 'ref_file': r['basename'], 'cur_file': c['basename'],
               'h_ratio': round(h_ratio, 3), 's_ratio': round(s_ratio, 3),
               'r_bytes': r_bytes, 'c_bytes': c_bytes,
               'r_dim': r_size, 'c_dim': c_size,
               'r_load': r['timeTaken'], 'c_load': c['timeTaken'], 'signals_fired': fired}
        if len(fired) >= 2:
            results['n_geom_invalid'] += 1
            rec['verdict'] = 'INVALID_GEOMETRY'
            results['per_pair'].append(rec)
            continue
        if blank:
            results['n_blank'] += 1
        if slow:
            results['n_timing'] += 1
        d_raw, h_used, w_used = raw_pixel_inequality(r_im, c_im)
        rec['d_raw'] = d_raw
        rec['h_used'] = h_used
        rec['w_used'] = w_used
        rec['verdict'] = 'VALID_REACHED_ARITH'
        results['n_reached_arith_stage'] += 1
        results['per_pair'].append(rec)
    return results


all_results = []
for subject, sessions in SUBJECT_SESSIONS.items():
    maps = []
    for s in sessions:
        m, fence = load_session(s)
        maps.append((s, m, fence))
    for i in range(len(maps) - 1):
        ref_dir, ref_map, ref_fence = maps[i]
        cur_dir, cur_map, cur_fence = maps[i + 1]
        res = analyze_pair(subject, ref_dir, cur_dir, ref_map, cur_map, ref_fence, cur_fence)
        all_results.append(res)

# ---- Now cross-reference against the EXISTING visual_diffs/<subject>/visual_diff_summary.json ----
for subject in SUBJECT_SESSIONS:
    summ_path = f"visual_diffs/{subject}/visual_diff_summary.json"
    if not os.path.exists(summ_path):
        continue
    existing = json.load(open(summ_path))
    existing_pages = {e['page']: e for e in existing}
    # find which of our computed session-pairs best matches this existing page set
    best = None
    best_overlap = -1
    for res in all_results:
        if res['subject'] != subject:
            continue
        computed_pages = {p['cur_file'] for p in res['per_pair'] if 'cur_file' in p}
        overlap = len(computed_pages & set(existing_pages.keys()))
        if overlap > best_overlap:
            best_overlap = overlap
            best = res
    if best is None:
        continue
    best['existing_backend_match'] = {'summary_path': summ_path, 'overlap': best_overlap, 'existing_n': len(existing_pages)}
    n_checked = 0
    n_impossible = 0
    impossible_list = []
    for p in best['per_pair']:
        if p.get('verdict') != 'VALID_REACHED_ARITH':
            continue
        page_key = p['cur_file']
        if page_key in existing_pages:
            d_reported = existing_pages[page_key]['diffPixels']
            d_raw = p['d_raw']
            n_checked += 1
            p['d_reported'] = d_reported
            p['arith_ok'] = d_reported <= d_raw
            if d_reported > d_raw:
                n_impossible += 1
                impossible_list.append({'page': page_key, 'd_reported': d_reported, 'd_raw': d_raw})
    best['arith_check'] = {'n_checked': n_checked, 'n_impossible': n_impossible, 'impossible_list': impossible_list}

# ---- Print summary ----
print("\n\n================ SUMMARY ================")
for res in all_results:
    print(f"\n--- {res['subject']}: {res['ref']} -> {res['cur']} ---")
    print(f"  ref_urls={res['n_ref']} cur_urls={res['n_cur']} common_urls={res['n_common_url']} nopair_F7={res['n_nopair_f7']}")
    print(f"  tainted_F6={res['n_tainted_f6']} geom_invalid={res['n_geom_invalid']} unreadable_F1={res['n_unreadable_f1']}")
    print(f"  blank_signal={res['n_blank']} timing_signal={res['n_timing']} reached_arith_stage={res['n_reached_arith_stage']}")
    if 'existing_backend_match' in res:
        print(f"  MATCHED EXISTING BACKEND: {res['existing_backend_match']}")
        print(f"  ARITH CHECK: {res['arith_check']['n_checked']} checked, {res['arith_check']['n_impossible']} impossible")
        if res['arith_check']['impossible_list']:
            print(f"    IMPOSSIBLE RECORDS: {res['arith_check']['impossible_list']}")

# Save full detail to JSON for later inspection / paper tables
with open('evl_analysis_output.json', 'w') as f:
    json.dump(all_results, f, indent=2, default=str)
print("\nSaved full detail to evl_analysis_output.json")
