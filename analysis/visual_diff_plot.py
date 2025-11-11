"""
📊 Visual Diff Plot Generator v1.2
-----------------------------------
Reads visual_diff_summary.json and generates a bar chart
showing visual change percentages per page.
"""

import os
import json
import matplotlib.pyplot as plt

# === Paths ===
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
VISUAL_DIFF_FILE = os.path.join(ROOT, "results", "visual_diffs", "visual_diff_summary.json")
CHARTS_DIR = os.path.join(ROOT, "results", "charts")
os.makedirs(CHARTS_DIR, exist_ok=True)

# === Load Data ===
if not os.path.exists(VISUAL_DIFF_FILE):
    raise FileNotFoundError("❌ visual_diff_summary.json not found. Run visual_diff.js first!")

with open(VISUAL_DIFF_FILE, "r", encoding="utf-8") as f:
    data = json.load(f)

if not data:
    print("⚠️ No visual diff data available — all pages identical.")
    exit()

pages = [d["page"] for d in data]
diffs = [float(d["diffPercent"]) for d in data]

# === Plot Chart ===
plt.figure(figsize=(10, 5))
plt.bar(pages, diffs)
plt.xticks(rotation=30, ha="right")
plt.xlabel("Pages")
plt.ylabel("Visual Change (%)")
plt.title("Visual Change Percentage per Page")
plt.tight_layout()

chart_path = os.path.join(CHARTS_DIR, "visual_diff_chart.png")
plt.savefig(chart_path)
plt.close()

print(f"✅ Visual diff chart saved → {chart_path}")
