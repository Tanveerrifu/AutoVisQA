"""
📊 Web Recorder & Performance Analyzer v3.0
--------------------------------------------
Reads the latest crawl summary.json, extracts performance metrics,
saves CSV + JSON summaries, and generates graphs for research.
"""

import json
import os
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

# === CONFIG ===
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS_DIR = os.path.join(ROOT, "results")

# Detect the latest crawl folder (ignore 'visual_diffs')
crawl_folders = [
    f for f in os.listdir(RESULTS_DIR)
    if os.path.isdir(os.path.join(RESULTS_DIR, f)) and f != "visual_diffs"
]
if not crawl_folders:
    raise FileNotFoundError("❌ No crawl folders found inside /results.")

DATE_FOLDER = max(crawl_folders)
SUMMARY_PATH = os.path.join(RESULTS_DIR, DATE_FOLDER, "summary.json")

print(f"📂 Reading summary from: {SUMMARY_PATH}")

# === LOAD DATA ===
with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

df = pd.DataFrame(data)
df = df[df['timeTaken'].notna()].copy()
df['timeTaken'] = df['timeTaken'].astype(float)

# === METRICS ===
total_pages = len(df)
avg_time = df['timeTaken'].mean()
median_time = df['timeTaken'].median()
std_time = df['timeTaken'].std()
min_time = df['timeTaken'].min()
max_time = df['timeTaken'].max()
p90 = df['timeTaken'].quantile(0.9)
p95 = df['timeTaken'].quantile(0.95)
errors = [d for d in data if 'error' in d]

print("\n📊 Research Summary")
print(f"📅 Date: {DATE_FOLDER}")
print(f"📄 Total Pages Crawled: {total_pages}")
print(f"⚡ Average Load Time: {avg_time:.2f} s")
print(f"🔸 Median Load Time: {median_time:.2f} s")
print(f"📈 Std Deviation: {std_time:.2f} s")
print(f"🚀 Min / Max: {min_time:.2f} / {max_time:.2f} s")
print(f"🎯 P90 / P95: {p90:.2f} / {p95:.2f} s")
print(f"❌ Errors: {len(errors)}")

# === SAVE CSV & SUMMARY ===
csv_out = os.path.join(RESULTS_DIR, DATE_FOLDER, "crawl_metrics.csv")
df.to_csv(csv_out, index=False)
print(f"📁 Metrics saved → {csv_out}")

summary = {
    "date": DATE_FOLDER,
    "total_pages": int(total_pages),
    "avg_time": round(avg_time, 3),
    "median_time": round(median_time, 3),
    "std_time": round(std_time, 3),
    "min_time": round(min_time, 3),
    "max_time": round(max_time, 3),
    "p90": round(p90, 3),
    "p95": round(p95, 3),
    "errors": len(errors),
    "generated_at": datetime.utcnow().isoformat() + "Z"
}
json_out = os.path.join(RESULTS_DIR, DATE_FOLDER, "crawl_summary.json")
with open(json_out, "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)
print(f"🧾 Summary saved → {json_out}")

# === CHARTS ===
charts_dir = os.path.join(RESULTS_DIR, "charts")
os.makedirs(charts_dir, exist_ok=True)

# Bar Chart — Load Times
plt.figure(figsize=(12, 5))
plt.bar(range(len(df)), df["timeTaken"])
plt.title(f"Page Load Time Distribution — {DATE_FOLDER}")
plt.xlabel("Page Index")
plt.ylabel("Load Time (s)")
plt.tight_layout()
bar_path = os.path.join(charts_dir, f"load_time_{DATE_FOLDER}.png")
plt.savefig(bar_path)
plt.close()
print(f"📈 Load time chart saved → {bar_path}")

# Boxplot — Spread of Load Times
plt.figure(figsize=(7, 4))
plt.boxplot(df["timeTaken"], vert=False)
plt.title(f"Load Time Boxplot — {DATE_FOLDER}")
plt.xlabel("Load Time (s)")
plt.tight_layout()
box_path = os.path.join(charts_dir, f"boxplot_{DATE_FOLDER}.png")
plt.savefig(box_path)
plt.close()
print(f"📊 Boxplot saved → {box_path}")

# Histogram — Load Time Frequency
plt.figure(figsize=(8, 4))
plt.hist(df["timeTaken"], bins=10)
plt.title(f"Load Time Histogram — {DATE_FOLDER}")
plt.xlabel("Load Time (s)")
plt.ylabel("Count")
plt.tight_layout()
hist_path = os.path.join(charts_dir, f"hist_{DATE_FOLDER}.png")
plt.savefig(hist_path)
plt.close()
print(f"📉 Histogram saved → {hist_path}")

# Slowest pages
slow_pages = df.sort_values(by="timeTaken", ascending=False).head(10)
top_path = os.path.join(RESULTS_DIR, DATE_FOLDER, "top_slowest_pages.csv")
slow_pages.to_csv(top_path, index=False)
print(f"🐢 Top slow pages saved → {top_path}")

print("\n✅ Analysis complete.")
