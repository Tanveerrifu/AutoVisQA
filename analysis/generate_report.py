"""
📄 QA Research Report Generator v3.1
------------------------------------
Combines crawl performance, visual regression data,
and visualization charts into one self-contained research-style HTML dashboard.
✅ Chart is now embedded as Base64 (no broken images!)
"""

import os
import json
from datetime import datetime
import statistics
import base64

# === Paths ===
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS = os.path.join(ROOT, "results")
VISUAL_DIFFS = os.path.join(RESULTS, "visual_diffs")
CHARTS = os.path.join(RESULTS, "charts")

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
visual_diff_path = os.path.join(VISUAL_DIFFS, "visual_diff_summary.json")
chart_path = os.path.join(CHARTS, "visual_diff_chart.png")
report_path = os.path.join(RESULTS, "research_report.html")

# === Load Crawl Summary ===
if not os.path.exists(crawl_summary_path):
    raise FileNotFoundError(f"❌ Missing crawl summary: {crawl_summary_path}")

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

# === Embed chart as Base64 ===
chart_html = "<p>⚠️ No chart found.</p>"
if os.path.exists(chart_path):
    with open(chart_path, "rb") as img_file:
        encoded_chart = base64.b64encode(img_file.read()).decode("utf-8")
        chart_html = f"<img src='data:image/png;base64,{encoded_chart}' class='chart' width='600'/>"

# === Build HTML ===
timestamp = datetime.now().strftime("%d %b %Y, %I:%M %p")
html = f"""
<html>
<head>
<title>QA Research Report — {latest_folder}</title>
<style>
body {{
  font-family: 'Segoe UI', Arial;
  margin: 40px;
  background: #f8f9fb;
  color: #333;
}}
h1, h2 {{ color: #1a73e8; }}
.card {{
  background: white;
  padding: 20px;
  border-radius: 12px;
  box-shadow: 0 3px 10px rgba(0,0,0,0.1);
  margin-bottom: 25px;
}}
.metric {{ font-size: 1.1em; margin: 5px 0; }}
footer {{ text-align:center; margin-top:40px; font-size:0.9em; color:#666; }}
img.chart {{
  display:block;
  margin:auto;
  border-radius:10px;
  box-shadow:0 2px 8px rgba(0,0,0,0.15);
}}
</style>
</head>
<body>
<h1>QA Automation Research Report</h1>
<h3>Run: {latest_folder}</h3>
<p>Generated on: {timestamp}</p>

<div class="card">
  <h2>📊 Crawl Performance Summary</h2>
  <p class="metric"><b>Total Pages Crawled:</b> {total_pages}</p>
  <p class="metric"><b>Average Load Time:</b> {avg_time} seconds</p>
  <p class="metric"><b>Median Load Time:</b> {median_time} seconds</p>
  <p class="metric"><b>Slowest Page Load:</b> {max_time} seconds</p>
  <p class="metric"><b>Errors:</b> {errors}</p>
</div>

<div class="card">
  <h2>🖼️ Visual Regression Summary</h2>
  <p class="metric"><b>Compared Pages:</b> {len(visual_diff_data)}</p>
  <p class="metric"><b>Average Change:</b> {avg_change}%</p>
  <p class="metric"><b>UI Stability Index:</b> {ui_stability}%</p>
</div>

<div class="card">
  <h2>📈 Visual Change Chart</h2>
  {chart_html}
</div>

<div class="card">
  <h2>📁 Source Files</h2>
  <ul>
    <li><b>Crawl Summary:</b> {crawl_summary_path}</li>
    <li><b>Visual Diff Summary:</b> {visual_diff_path}</li>
    <li><b>Chart:</b> {chart_path}</li>
  </ul>
</div>

<footer>
  <p>📘 QA Research Automation Framework — Generated {timestamp}</p>
</footer>

</body>
</html>
"""

# === Save the report ===
with open(report_path, "w", encoding="utf-8") as f:
    f.write(html)

print(f"✅ Research report generated → {report_path}")
