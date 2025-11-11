"""
📄 QA Research Report Generator v4.3 — Research Analytics Edition
------------------------------------------------------------
✅ Includes:
- Cover Page (title, author, institution, date)
- Summary Metrics Table
- Visual Diff Chart (UI Stability)
- Performance Chart (Page Load Times)
- Responsive, centered chart containers
- Auto PDF export using WeasyPrint (no wkhtmltopdf needed)
"""

import os
import json
import statistics
import base64
from datetime import datetime
import pandas as pd
import matplotlib.pyplot as plt
from weasyprint import HTML

# === Paths ===
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS = os.path.join(ROOT, "results")
VISUAL_DIFFS = os.path.join(RESULTS, "visual_diffs")
CHARTS = os.path.join(RESULTS, "charts")

# Ensure chart folder exists
os.makedirs(CHARTS, exist_ok=True)

# === Auto-detect latest crawl folder ===
folders = [
    f for f in os.listdir(RESULTS)
    if os.path.isdir(os.path.join(RESULTS, f))
    and f not in ["visual_diffs", "charts"]
]
if not folders:
    raise FileNotFoundError("❌ No crawl results found in /results/")

latest_folder = max(
    folders,
    key=lambda f: os.path.getmtime(os.path.join(RESULTS, f))
)
crawl_summary_path = os.path.join(RESULTS, latest_folder, "summary.json")
crawl_metrics_path = os.path.join(RESULTS, latest_folder, "crawl_metrics.csv")
visual_diff_path = os.path.join(VISUAL_DIFFS, "visual_diff_summary.json")

visual_chart_path = os.path.join(CHARTS, "visual_diff_chart.png")
performance_chart_path = os.path.join(CHARTS, "performance_chart.png")

report_html = os.path.join(RESULTS, "research_report.html")
report_pdf = os.path.join(RESULTS, "research_report.pdf")

# === Load Crawl Summary ===
with open(crawl_summary_path, "r", encoding="utf-8") as f:
    crawl_data = json.load(f)

total_pages = len([p for p in crawl_data if "error" not in p])
errors = len([p for p in crawl_data if "error" in p])
times = [float(p.get("timeTaken", 0)) for p in crawl_data if "timeTaken" in p]

avg_time = round(statistics.mean(times), 2) if times else 0
median_time = round(statistics.median(times), 2) if times else 0
max_time = round(max(times), 2) if times else 0

# === Load Visual Diff Summary ===
visual_diff_data = []
if os.path.exists(visual_diff_path):
    with open(visual_diff_path, "r", encoding="utf-8") as f:
        visual_diff_data = json.load(f)

ui_stability = 100
if visual_diff_data:
    diffs = [float(v["diffPercent"]) for v in visual_diff_data]
    avg_change = round(sum(diffs) / len(diffs), 3)
    ui_stability = round(100 - avg_change, 2)
else:
    avg_change = 0.0

# === Generate Performance Chart ===
if os.path.exists(crawl_metrics_path):
    df = pd.read_csv(crawl_metrics_path)
    if "url" in df.columns and "timeTaken" in df.columns:
        plt.figure(figsize=(10, 6))
        plt.barh(df["url"], df["timeTaken"], color="#1a73e8")
        plt.xlabel("Load Time (seconds)")
        plt.ylabel("Pages")
        plt.title("Average Page Load Time per URL")
        plt.tight_layout()
        plt.savefig(performance_chart_path)
        plt.close()

# === Embed charts as Base64 ===
def embed_chart(path):
    if os.path.exists(path):
        with open(path, "rb") as img_file:
            return f"<img src='data:image/png;base64,{base64.b64encode(img_file.read()).decode('utf-8')}' class='chart'/>"
    return "<p>⚠️ Chart not available.</p>"

visual_chart_html = embed_chart(visual_chart_path)
performance_chart_html = embed_chart(performance_chart_path)

# === Build HTML ===
timestamp = datetime.now().strftime("%d %B %Y, %I:%M %p")

html = f"""
<html>
<head>
<meta charset="utf-8">
<title>QA Research Report — {latest_folder}</title>
<style>
body {{
  font-family: 'Segoe UI', Arial, sans-serif;
  margin: 40px;
  background: #ffffff;
  color: #333;
}}
h1, h2, h3 {{
  color: #1a73e8;
  text-align: center;
}}
.cover {{
  text-align: center;
  padding-top: 120px;
  page-break-after: always;
}}
.cover h1 {{
  font-size: 36px;
  margin-bottom: 0;
}}
.cover p {{
  font-size: 18px;
  color: #555;
}}
.card {{
  background: #fafafa;
  padding: 25px;
  border-radius: 10px;
  box-shadow: 0 3px 10px rgba(0,0,0,0.1);
  margin-bottom: 30px;
}}
.metric {{
  font-size: 1.1em;
  margin: 5px 0;
}}
table {{
  border-collapse: collapse;
  width: 100%;
  margin-top: 15px;
}}
th, td {{
  border: 1px solid #ddd;
  padding: 10px;
  text-align: center;
}}
th {{
  background-color: #1a73e8;
  color: white;
}}
.chart-container {{
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 30px auto;
  width: 100%;
  max-width: 750px;
  padding: 15px;
  background: #f9f9f9;
  border-radius: 12px;
  box-shadow: 0 3px 10px rgba(0,0,0,0.08);
}}
img.chart {{
  max-width: 100%;
  height: auto;
  border-radius: 10px;
  display: block;
}}
footer {{
  text-align:center;
  margin-top:40px;
  font-size:0.9em;
  color:#666;
  page-break-before: always;
}}
</style>
</head>
<body>

<!-- Cover Page -->
<div class="cover">
  <h1>AI-Driven Website QA Research Report</h1>
  <p><b>Project:</b> Automated Visual & Functional Testing Framework</p>
  <p><b>Researcher:</b> Tanvir Hasan</p>
  <p><b>Institution:</b> City University</p>
  <p><b>Date Generated:</b> {timestamp}</p>
</div>

<!-- Main Content -->
<h2>Executive Summary</h2>
<div class="card">
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Pages Crawled</td><td>{total_pages}</td></tr>
    <tr><td>Average Load Time</td><td>{avg_time} seconds</td></tr>
    <tr><td>Median Load Time</td><td>{median_time} seconds</td></tr>
    <tr><td>Slowest Page Load</td><td>{max_time} seconds</td></tr>
    <tr><td>Pages Compared</td><td>{len(visual_diff_data)}</td></tr>
    <tr><td>Average Visual Change</td><td>{avg_change}%</td></tr>
    <tr><td>UI Stability Index</td><td>{ui_stability}%</td></tr>
    <tr><td>Errors</td><td>{errors}</td></tr>
  </table>
</div>

<h2>🖼️ Visual Stability Chart</h2>
<p style="text-align:center; color:#555;">Visual change percentage across compared pages.</p>
<div class="chart-container">
  {visual_chart_html}
</div>

<h2>⚙️ Performance Load Chart</h2>
<p style="text-align:center; color:#555;">Average page load time across all crawled URLs.</p>
<div class="chart-container">
  {performance_chart_html}
</div>

<footer>
  <p>📘 Generated automatically by QA Research Automation Framework</p>
  <p><b>Run Folder:</b> {latest_folder}</p>
  <p><b>Generated on:</b> {timestamp}</p>
</footer>

</body>
</html>
"""

# === Save HTML ===
with open(report_html, "w", encoding="utf-8") as f:
    f.write(html)

print(f"✅ Research report (HTML) generated → {report_html}")

# === Export to PDF using WeasyPrint ===
try:
    HTML(report_html).write_pdf(report_pdf)
    print(f"📄 PDF version exported successfully → {report_pdf}")
except Exception as e:
    print(f"⚠️ PDF export failed: {e}")
