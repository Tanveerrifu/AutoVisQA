"""
📊 QA Research Report Generator v5.7 — Interactive + PDF Trendline Fixed
-----------------------------------------------------------------------
✅ Interactive Plotly trendline in HTML
✅ Always-visible static PNG fallback in PDF
✅ Full executive summary, visual diff, performance charts, top 5 slow pages
✅ Auto HTML + PDF export (WeasyPrint)
"""

import os
import json
import statistics
import base64
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime
from weasyprint import HTML
import plotly.graph_objects as go

# === Setup ===
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS = os.path.join(ROOT, "results")
VISUAL_DIFFS = os.path.join(RESULTS, "visual_diffs")
CHARTS = os.path.join(RESULTS, "charts")
os.makedirs(CHARTS, exist_ok=True)

# === Detect All Crawl Folders ===
folders = [
    f for f in os.listdir(RESULTS)
    if os.path.isdir(os.path.join(RESULTS, f))
    and f not in ["visual_diffs", "charts"]
]
if not folders:
    raise FileNotFoundError("❌ No crawl results found in /results/")

folders_sorted = sorted(
    folders,
    key=lambda f: os.path.getmtime(os.path.join(RESULTS, f))
)
latest_folder = folders_sorted[-1]

# === File Paths ===
crawl_summary_path = os.path.join(RESULTS, latest_folder, "summary.json")
crawl_metrics_path = os.path.join(RESULTS, latest_folder, "crawl_metrics.csv")
visual_diff_path = os.path.join(VISUAL_DIFFS, "visual_diff_summary.json")

visual_chart_path = os.path.join(CHARTS, "visual_diff_chart.png")
performance_chart_path = os.path.join(CHARTS, "performance_chart.png")
trend_chart_path = os.path.join(CHARTS, "performance_trend_chart.png")

report_html = os.path.join(RESULTS, "research_report.html")
report_pdf = os.path.join(RESULTS, "research_report.pdf")

# === Load Latest Crawl Summary ===
with open(crawl_summary_path, "r", encoding="utf-8") as f:
    crawl_data = json.load(f)

# === Load Performance Data ===
metrics_data = []
if os.path.exists(crawl_metrics_path):
    try:
        df_metrics = pd.read_csv(crawl_metrics_path)
        if "url" in df_metrics.columns and "timeTaken" in df_metrics.columns:
            metrics_data = df_metrics[["url", "timeTaken"]].values.tolist()
    except:
        metrics_data = []
else:
    for page in crawl_data:
        if "url" in page and "timeTaken" in page:
            metrics_data.append([page["url"], page["timeTaken"]])

# === Compute Key Stats ===
times = []
for _, t in metrics_data:
    try:
        times.append(float(t))
    except:
        pass

avg_time = round(statistics.mean(times), 2) if times else 0
median_time = round(statistics.median(times), 2) if times else 0
max_time = round(max(times), 2) if times else 0
total_pages = len([p for p in crawl_data if "error" not in p])
errors = len([p for p in crawl_data if "error" in p])

# === Load Visual Diff Summary ===
visual_diff_data = []
if os.path.exists(visual_diff_path):
    with open(visual_diff_path, "r", encoding="utf-8") as f:
        visual_diff_data = json.load(f)

ui_stability = 100
if visual_diff_data:
    diffs = [float(v.get("diffPercent", 0)) for v in visual_diff_data]
    avg_change = round(sum(diffs) / len(diffs), 3)
    ui_stability = round(100 - avg_change, 2)
else:
    avg_change = 0.0

# === Generate Performance Chart ===
if metrics_data:
    df_chart = pd.DataFrame(metrics_data, columns=["url", "timeTaken"])
    df_chart["timeTaken"] = pd.to_numeric(df_chart["timeTaken"], errors="coerce")
    df_chart = df_chart.dropna(subset=["timeTaken"]).sort_values("timeTaken", ascending=False).head(10)
    plt.figure(figsize=(10, 6))
    plt.barh(df_chart["url"], df_chart["timeTaken"], color="#1a73e8")
    plt.xlabel("Load Time (seconds)")
    plt.ylabel("Page URL")
    plt.title("Average Page Load Time (Top 10 URLs)")
    plt.tight_layout()
    plt.savefig(performance_chart_path)
    plt.close()

# === Generate Trend Data (for interactive + static fallback) ===
trend_data = []
for f in folders_sorted:
    folder_path = os.path.join(RESULTS, f)
    csv_path = os.path.join(folder_path, "crawl_metrics.csv")
    summary_path = os.path.join(folder_path, "summary.json")
    run_times = []

    if os.path.exists(csv_path):
        try:
            df = pd.read_csv(csv_path)
            if "timeTaken" in df.columns:
                run_times = pd.to_numeric(df["timeTaken"], errors="coerce").dropna().tolist()
        except:
            pass
    elif os.path.exists(summary_path):
        try:
            with open(summary_path, "r", encoding="utf-8") as j:
                js = json.load(j)
                for page in js:
                    if "timeTaken" in page:
                        try:
                            run_times.append(float(page["timeTaken"]))
                        except:
                            pass
        except:
            pass

    if run_times:
        trend_data.append((f, round(statistics.mean(run_times), 2)))

# === Create static PNG for PDF fallback ===
if len(trend_data) >= 1:
    labels_static, averages_static = zip(*trend_data)
    plt.figure(figsize=(10, 5))
    plt.plot(labels_static, averages_static, marker="o", color="#00796B", linewidth=2)
    plt.title("Average Load Time Trend Across Crawls")
    plt.xlabel("Crawl Run (Date & Time)")
    plt.ylabel("Average Load Time (s)")
    plt.grid(True, linestyle="--", alpha=0.6)
    plt.tight_layout()
    plt.savefig(trend_chart_path)
    plt.close()

# === Interactive Plotly chart + always-on PNG fallback ===
interactive_trend_html_fragment = "<p>⚠️ Not enough crawl data for trendline.</p>"
trend_png_html = ""
if len(trend_data) >= 2:
    labels, averages = zip(*trend_data)
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=list(labels),
        y=list(averages),
        mode="lines+markers",
        marker=dict(size=10, color="#00796B"),
        line=dict(width=3),
        hovertemplate="Run: %{x}<br>Avg Time: %{y}s<extra></extra>"
    ))
    fig.update_layout(
        title="Interactive Load Time Trendline",
        xaxis_title="Crawl Run (Date & Time)",
        yaxis_title="Average Load Time (s)",
        template="plotly_white"
    )
    interactive_trend_html_fragment = fig.to_html(full_html=False, include_plotlyjs="cdn")

# embed static PNG directly (always visible in PDF)
if os.path.exists(trend_chart_path):
    with open(trend_chart_path, "rb") as imgf:
        encoded_trend = base64.b64encode(imgf.read()).decode("utf-8")
        trend_png_html = f"<div><img src='data:image/png;base64,{encoded_trend}' style='max-width:100%;height:auto;border-radius:6px;'/></div>"

# === Helper to embed static charts ===
def embed_chart(path):
    if os.path.exists(path):
        with open(path, "rb") as img_file:
            encoded = base64.b64encode(img_file.read()).decode("utf-8")
            return f"<img src='data:image/png;base64,{encoded}' class='chart' style='max-width:100%;height:auto;border-radius:10px;display:block;margin:auto;'/>"
    return "<p>⚠️ Chart not available.</p>"

visual_chart_html = embed_chart(visual_chart_path)
performance_chart_html = embed_chart(performance_chart_path)

# === Top 5 Slowest Pages ===
slowest_html = "<p>⚠️ No performance data available.</p>"
if metrics_data:
    top5 = sorted(metrics_data, key=lambda x: float(x[1]) if str(x[1]).replace('.', '', 1).lstrip('-').isdigit() else 0, reverse=True)[:5]
    slowest_html = "<table style='width:100%;border-collapse:collapse;'><tr><th>Rank</th><th>Page URL</th><th>Load Time (s)</th></tr>"
    for i, (url, t) in enumerate(top5, 1):
        try:
            t_val = float(t)
            color = "#f44336" if i == 1 else "#4CAF50" if t_val < avg_time else "#ff9800"
            slowest_html += f"<tr style='color:{color}'><td>{i}</td><td>{url}</td><td>{round(t_val,2)}</td></tr>"
        except:
            slowest_html += f"<tr><td>{i}</td><td>{url}</td><td>{t}</td></tr>"
    slowest_html += "</table>"

# === Build HTML ===
timestamp = datetime.now().strftime("%d %B %Y, %I:%M %p")

html = f"""
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>QA Research Report — {latest_folder}</title>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<style>
body {{ font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; background: #ffffff; color: #333; }}
h1, h2 {{ color: #1a73e8; text-align: center; }}
.card {{ background: #fafafa; padding: 20px; border-radius: 10px; box-shadow: 0 3px 10px rgba(0,0,0,0.08); margin-bottom: 30px; }}
.chart-container {{ display:flex; justify-content:center; align-items:center; margin:30px auto; width:100%; max-width:900px; padding:15px; background:#f9f9f9; border-radius:12px; }}
img.chart {{ max-width:100%; height:auto; border-radius:10px; display:block; }}
footer {{ text-align:center; margin-top:40px; font-size:0.9em; color:#666; }}
table {{ width:100%; border-collapse:collapse; margin-top:10px; }}
th, td {{ border:1px solid #ddd; padding:8px; text-align:center; }}
th {{ background:#1a73e8; color:white; }}
</style>
</head>
<body>

<h1>AI-Driven Website QA Research Report</h1>

<div class="card">
  <h2>Executive Summary</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Pages Crawled</td><td>{total_pages}</td></tr>
    <tr><td>Average Load Time</td><td>{avg_time} s</td></tr>
    <tr><td>Median Load Time</td><td>{median_time} s</td></tr>
    <tr><td>Slowest Page Load</td><td>{max_time} s</td></tr>
    <tr><td>Average Visual Change</td><td>{avg_change}%</td></tr>
    <tr><td>UI Stability Index</td><td>{ui_stability}%</td></tr>
    <tr><td>Errors</td><td>{errors}</td></tr>
  </table>
</div>

<h2>🖼️ Visual Stability Chart</h2>
<div class="chart-container card">{visual_chart_html}</div>

<h2>⚙️ Performance Load Chart</h2>
<div class="chart-container card">{performance_chart_html}</div>

<h2>📈 Performance Trendline</h2>
<p style="text-align:center;color:#555;">Interactive version (HTML) + static version (PDF) below</p>
<div class="chart-container card">
  {interactive_trend_html_fragment}
  {trend_png_html}
</div>

<h2>🏁 Top 5 Slowest Pages</h2>
<div class="card">{slowest_html}</div>

<footer>
  <p>📘 Generated automatically by QA Research Automation Framework</p>
  <p><b>Run Folder:</b> {latest_folder} — <b>Generated on:</b> {timestamp}</p>
</footer>

</body></html>
"""

# === Save HTML and PDF ===
with open(report_html, "w", encoding="utf-8") as f:
    f.write(html)
print(f"✅ Interactive HTML report generated → {report_html}")

try:
    HTML(report_html).write_pdf(report_pdf)
    print(f"📄 PDF exported successfully → {report_pdf}")
except Exception as e:
    print(f"⚠️ PDF export failed: {e}")
