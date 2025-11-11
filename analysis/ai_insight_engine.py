"""
ai_insight_engine.py
Phase 4 — AI QA Insight Engine

Usage:
    python ai_insight_engine.py

What it does:
- Auto-detects latest run folder in ../results
- Loads crawl_metrics.csv (or summary.json fallback) and visual_diff_summary.json
- Runs anomaly detection on performance & visual diffs
- Creates an insights JSON and an HTML snippet
- (Optional) If OPENAI_API_KEY set and openai installed -> uses OpenAI to produce polished summary
- Optionally injects the HTML snippet into the existing results/research_report.html and regenerates PDF (WeasyPrint)
"""

import os
import json
import math
import statistics
import base64
from datetime import datetime

try:
    import pandas as pd
except Exception:
    pd = None

# Optional OpenAI usage (only if available and configured)
try:
    import openai
except Exception:
    openai = None

# Optional PDF regeneration (WeasyPrint)
try:
    from weasyprint import HTML
except Exception:
    HTML = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS_DIR = os.path.join(ROOT, "results")
VISUAL_DIFFS_DIR = os.path.join(RESULTS_DIR, "visual_diffs")

INSIGHT_OUTPUT = os.path.join(RESULTS_DIR, "ai_insights.json")
INSIGHT_HTML_SNIPPET = os.path.join(RESULTS_DIR, "ai_insights_snippet.html")


# -------------------------
# Helper utilities
# -------------------------
def latest_results_folder():
    folders = [
        f for f in os.listdir(RESULTS_DIR)
        if os.path.isdir(os.path.join(RESULTS_DIR, f))
        and f not in ("visual_diffs", "charts")
    ]
    if not folders:
        raise FileNotFoundError("No result folders found in results/")
    folders_sorted = sorted(
        folders,
        key=lambda f: os.path.getmtime(os.path.join(RESULTS_DIR, f))
    )
    return folders_sorted[-1], folders_sorted


def load_crawl_metrics(folder):
    """Return list of [url, timeTaken] and dict mapping url->time"""
    metrics_path = os.path.join(RESULTS_DIR, folder, "crawl_metrics.csv")
    summary_path = os.path.join(RESULTS_DIR, folder, "summary.json")
    metrics = []
    if pd is not None and os.path.exists(metrics_path):
        try:
            df = pd.read_csv(metrics_path)
            if "url" in df.columns and "timeTaken" in df.columns:
                for _, r in df[["url", "timeTaken"]].iterrows():
                    metrics.append([str(r["url"]), float(r["timeTaken"])])
                return metrics
        except Exception:
            pass

    # fallback to summary.json
    if os.path.exists(summary_path):
        with open(summary_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            for p in data:
                url = p.get("url")
                t = p.get("timeTaken")
                if url is not None and t is not None:
                    try:
                        metrics.append([str(url), float(t)])
                    except:
                        pass
    return metrics


def load_visual_diffs():
    path = os.path.join(VISUAL_DIFFS_DIR, "visual_diff_summary.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def iqr_outliers(values):
    """Return indices of IQR outliers (upper outliers)"""
    if not values:
        return []
    vals = sorted(values)
    q1_idx = int(len(vals) * 0.25)
    q3_idx = int(len(vals) * 0.75)
    q1 = vals[q1_idx]
    q3 = vals[q3_idx]
    iqr = q3 - q1
    if iqr == 0:
        return []
    upper = q3 + 1.5 * iqr
    # return indices of values > upper
    return [i for i, v in enumerate(values) if v > upper]


def zscore_outliers(values, threshold=2.5):
    import statistics as stats
    if len(values) < 2:
        return []
    mean = stats.mean(values)
    stdev = stats.pstdev(values) if stats.pstdev(values) != 0 else None
    if not stdev:
        return []
    out = []
    for i, v in enumerate(values):
        z = (v - mean) / stdev
        if abs(z) >= threshold:
            out.append(i)
    return out


# -------------------------
# Anomaly detection
# -------------------------
def detect_performance_anomalies(latest_folder, folders_sorted):
    """
    Detect:
    - unusually slow pages within latest run (IQR or z-score)
    - pages with large percent increase vs previous run averages
    - overall runaway increase (avg_time jump)
    """
    result = {"per_page": [], "run_level": []}

    latest_metrics = load_crawl_metrics(latest_folder)
    if not latest_metrics:
        return result

    # Values and mapping
    urls = [u for u, t in latest_metrics]
    times = [float(t) for _, t in latest_metrics]
    # per-page: internal outliers
    iqr_idx = iqr_outliers(times)
    z_idx = zscore_outliers(times, threshold=2.5)
    outlier_indices = sorted(set(iqr_idx + z_idx))

    for i in outlier_indices:
        result["per_page"].append({
            "url": urls[i],
            "time": times[i],
            "reason": "internal_outlier",
            "iqr": (i in iqr_idx),
            "zscore": (i in z_idx)
        })

    # compare with previous run (if exists)
    prev_avg = None
    prev_folder = None
    # find previous folder that has metrics
    for f in reversed(folders_sorted[:-1]):
        candidate = load_crawl_metrics(f)
        if candidate:
            prev_folder = f
            prev_times = [float(t) for _, t in candidate]
            prev_avg = statistics.mean(prev_times) if prev_times else None
            prev_map = {u: float(t) for u, t in candidate}
            break

    latest_avg = statistics.mean(times) if times else None
    if prev_avg is not None and latest_avg is not None:
        percent_change = ((latest_avg - prev_avg) / prev_avg) * 100.0 if prev_avg != 0 else None
        result["run_level"].append({
            "previous_run": prev_folder,
            "previous_avg": prev_avg,
            "latest_avg": latest_avg,
            "percent_change": percent_change,
            "alert": (percent_change is not None and abs(percent_change) > 20)  # threshold 20%
        })

        # per-url percent increase vs previous value for that url
        per_url_increases = []
        for u, t in latest_metrics:
            prev_t = prev_map.get(u)
            if prev_t is not None:
                try:
                    pct = ((float(t) - float(prev_t)) / float(prev_t)) * 100.0 if float(prev_t) != 0 else None
                    if pct is not None and abs(pct) >= 30:  # per-page threshold 30%
                        per_url_increases.append({"url": u, "previous": prev_t, "latest": t, "pct_change": pct})
                except:
                    pass
        result["per_page"].extend([{"url": p["url"], "time": p["latest"], "reason": "percent_increase", "pct": p["pct_change"]} for p in per_url_increases])

    return result


def detect_visual_anomalies():
    """
    From visual_diff_summary.json detect pages with high diffPercent
    Use IQR or threshold (e.g., > 1% or mean+2*std)
    """
    visual = load_visual_diffs()
    result = []
    if not visual:
        return result
    diffs = []
    for v in visual:
        try:
            diffs.append(float(v.get("diffPercent", 0)))
        except:
            diffs.append(0.0)
    mean = statistics.mean(diffs) if diffs else 0
    stdev = statistics.pstdev(diffs) if len(diffs) > 1 else 0
    thr = max(1.0, mean + 2 * stdev)  # at least 1% diff as minimum concern
    for v in visual:
        dp = float(v.get("diffPercent", 0))
        if dp >= thr:
            result.append({"url": v.get("url"), "diffPercent": dp, "reason": "high_diff"})
    return result


# -------------------------
# Natural language summary (optional OpenAI)
# -------------------------
def make_prompt(perf_anoms, visual_anoms, run_info):
    lines = []
    lines.append("You are an assistant that summarizes QA crawl results and highlights anomalies.")
    lines.append("Provide short bullet points: key findings, likely causes, and prioritized recommendations.")
    lines.append("")
    lines.append("Run info:")
    lines.append(json.dumps(run_info, indent=2))
    lines.append("")
    lines.append("Performance anomalies (per_page):")
    lines.append(json.dumps(perf_anoms.get("per_page", []), indent=2))
    lines.append("")
    lines.append("Run-level performance (run_level):")
    lines.append(json.dumps(perf_anoms.get("run_level", []), indent=2))
    lines.append("")
    lines.append("Visual anomalies:")
    lines.append(json.dumps(visual_anoms, indent=2))
    lines.append("")
    lines.append("Now generate a concise summary (3-6 bullets) and 2 prioritized remediation suggestions.")
    return "\n".join(lines)


def generate_text_summary(perf_anoms, visual_anoms, run_info):
    """
    If openai is configured and OPENAI_API_KEY present, call the API.
    Otherwise, produce a local rule-based summary.
    """
    # If OpenAI available and key present, call it
    if openai is not None and os.environ.get("OPENAI_API_KEY"):
        try:
            prompt = make_prompt(perf_anoms, visual_anoms, run_info)
            # Use ChatCompletion if available; adapt to user's environment
            # We'll use `gpt-4o-mini` or fallback to `gpt-4o` depending on availability
            model = os.environ.get("AI_MODEL", "gpt-4o-mini")  # user can override
            resp = openai.ChatCompletion.create(
                model=model,
                messages=[{"role": "system", "content": "You are a QA data analyst."},
                          {"role": "user", "content": prompt}],
                max_tokens=450,
                temperature=0.2,
            )
            text = ""
            # Extract assistant text
            if "choices" in resp and len(resp["choices"]) > 0:
                text = resp["choices"][0]["message"]["content"].strip()
            if text:
                return {"source": "openai", "text": text}
        except Exception as e:
            # fallback to local
            pass

    # Local fallback: generate bullets
    bullets = []
    # Run level
    for r in perf_anoms.get("run_level", []):
        pct = r.get("percent_change")
        if pct is not None:
            if abs(pct) > 20:
                bullets.append(f"Run average load time changed by {pct:.1f}% vs previous run ({r.get('previous_run')}). Investigate overall performance regressions.")
            else:
                bullets.append(f"Run average load time changed by {pct:.1f}% vs previous run ({r.get('previous_run')}).")

    # Per page performance
    per_perf = perf_anoms.get("per_page", [])
    if per_perf:
        n = len(per_perf)
        bullets.append(f"{n} page(s) show performance concerns (internal outliers or large % increases). Examples:")
        for p in per_perf[:4]:
            if p.get("reason") == "percent_increase":
                bullets.append(f" • {p.get('url')} ↑ {p.get('pct',0):.1f}%")
            else:
                bullets.append(f" • {p.get('url')} — {p.get('time')}s (outlier)")

    # Visual
    if visual_anoms:
        bullets.append(f"{len(visual_anoms)} visual change(s) exceed threshold — possible UI regressions. Check screenshots/PDFs for those URLs.")

    if not bullets:
        bullets.append("No significant anomalies detected in this run. System looks stable.")

    # Prioritized recommendations
    recs = [
        "Check the top slow pages and audit heavy network requests / large images / blocking scripts.",
        "For visual diffs, open the saved PDFs/screenshots for the flagged pages and run a DOM/selector-level diff to locate the root cause."
    ]

    text = "\n".join(["- " + b for b in bullets] + ["", "Recommendations:"] + ["- " + r for r in recs])
    return {"source": "local", "text": text}


# -------------------------
# Integration with report (append HTML snippet & save json)
# -------------------------
def build_insight_payload(perf_anoms, visual_anoms, summary_text, latest_folder):
    payload = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "run_folder": latest_folder,
        "performance_anomalies": perf_anoms,
        "visual_anomalies": visual_anoms,
        "summary": summary_text,
    }
    return payload


def write_insights_json(payload):
    try:
        with open(INSIGHT_OUTPUT, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"AI insights saved → {INSIGHT_OUTPUT}")
    except Exception as e:
        print("Failed to save insights JSON:", e)


def html_snippet_from_summary(payload):
    ts = payload.get("timestamp")
    summary = payload.get("summary", {}).get("text", "")
    source = payload.get("summary", {}).get("source", "local")
    perf_count = len(payload.get("performance_anomalies", {}).get("per_page", [])) + len(payload.get("performance_anomalies", {}).get("run_level", []))
    vis_count = len(payload.get("visual_anomalies", []))
    html = f"""
<div style="background:#fff8e1;border-left:6px solid #ffb300;padding:15px;border-radius:8px;margin:20px 0;">
  <h3 style="color:#ff9800;margin:0 0 8px 0;">🤖 AI Insights (automated) — source: {source}</h3>
  <p style="margin:0 0 8px 0;color:#444;font-size:0.95em;"><b>Generated:</b> {ts}</p>
  <div style="font-size:0.95em;color:#222;">{summary.replace(chr(10), '<br/>')}</div>
  <hr/>
  <p style="margin:8px 0 0 0;color:#666;font-size:0.85em;">Detected performance anomalies: <b>{perf_count}</b> — visual anomalies: <b>{vis_count}</b></p>
</div>
"""
    return html


def inject_into_report(html_snippet):
    report_path = os.path.join(RESULTS_DIR, "research_report.html")
    if not os.path.exists(report_path):
        print("Cannot inject: research_report.html not found.")
        return False
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            content = f.read()
        # naive injection: before closing body
        if "</body>" in content:
            new_content = content.replace("</body>", f"{html_snippet}\n</body>")
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Injected AI insights into {report_path}")
            return True
        else:
            print("Could not find </body> in research_report.html — skipping injection.")
            return False
    except Exception as e:
        print("Failed to inject snippet:", e)
        return False


def regenerate_pdf():
    report_path = os.path.join(RESULTS_DIR, "research_report.html")
    out_pdf = os.path.join(RESULTS_DIR, "research_report.pdf")
    if HTML is None:
        print("WeasyPrint not available; skipping PDF regeneration.")
        return False
    try:
        HTML(report_path).write_pdf(out_pdf)
        print(f"Regenerated PDF → {out_pdf}")
        return True
    except Exception as e:
        print("PDF regeneration failed:", e)
        return False


# -------------------------
# Main runner
# -------------------------
def main(auto_inject=True, auto_regen_pdf=True):
    latest, folders_sorted = latest_results_folder()
    print("Latest run:", latest)

    perf_anoms = detect_performance_anomalies(latest, folders_sorted)
    visual_anoms = detect_visual_anomalies()

    # Basic run info
    run_info = {
        "latest_run": latest,
        "num_pages": len(load_crawl_metrics(latest)),
        "visual_diffs_count": len(load_visual_diffs()),
    }

    summary = generate_text_summary(perf_anoms, visual_anoms, run_info)
    payload = build_insight_payload(perf_anoms, visual_anoms, summary, latest)

    # Save JSON
    write_insights_json(payload)

    # Create HTML snippet and save
    snippet = html_snippet_from_summary(payload)
    try:
        with open(INSIGHT_HTML_SNIPPET, "w", encoding="utf-8") as f:
            f.write(snippet)
        print("AI insights snippet saved →", INSIGHT_HTML_SNIPPET)
    except Exception as e:
        print("Failed to save html snippet:", e)

    # Inject into report
    if auto_inject:
        injected = inject_into_report(snippet)
        if injected and auto_regen_pdf:
            regenerate_pdf()

    # Print short console summary
    print("----- AI Insight Summary -----")
    print(summary.get("text", ""))
    print("-----------------------------")

    return payload


if __name__ == "__main__":
    main()
