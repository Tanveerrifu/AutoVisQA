import os
import glob
import json
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

# === CONFIGURATION ===
RESULTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "results"))

# === STEP 1: Find latest crawl folder ===
folders = [f for f in glob.glob(os.path.join(RESULTS_DIR, "*")) if os.path.isdir(f)]

if not folders:
    print("⚠️ No crawl folders found inside:", RESULTS_DIR)
    exit(1)

latest_folder = max(folders, key=os.path.getmtime)
SUMMARY_PATH = os.path.join(latest_folder, "summary.json")

print(f"📂 Reading summary from: {SUMMARY_PATH}")

if not os.path.exists(SUMMARY_PATH):
    print(f"❌ No summary.json found in {latest_folder}")
    print("👉 Run the crawler again to generate summary.json")
    exit(1)

# === STEP 2: Load summary data ===
try:
    with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError:
    print("❌ summary.json is not a valid JSON file.")
    exit(1)

if not isinstance(data, list) or len(data) == 0:
    print("⚠️ summary.json is empty or invalid format.")
    exit(1)

# === STEP 3: Create DataFrame ===
df = pd.DataFrame(data)

if "url" not in df.columns or "timeTaken" not in df.columns:
    print("❌ Required fields missing (url, timeTaken).")
    exit(1)

df["timeTaken"] = pd.to_numeric(df["timeTaken"], errors="coerce")

# === STEP 4: Compute basic stats ===
total_pages = len(df)
avg_load_time = df["timeTaken"].mean()
max_load = df["timeTaken"].max()
min_load = df["timeTaken"].min()

print("\n📊 Research Summary")
print(f"🧾 Total Pages Crawled: {total_pages}")
print(f"⚡ Average Load Time: {avg_load_time:.2f} sec")
print(f"🐢 Slowest Page: {max_load:.2f} sec")
print(f"🚀 Fastest Page: {min_load:.2f} sec")

# === STEP 5: Save CSV ===
csv_path = os.path.join(latest_folder, "crawl_metrics.csv")
df.to_csv(csv_path, index=False)
print(f"💾 Metrics saved → {csv_path}")

# === STEP 6: Generate chart ===
chart_dir = os.path.join(RESULTS_DIR, "charts")
os.makedirs(chart_dir, exist_ok=True)

chart_path = os.path.join(chart_dir, f"load_time_{datetime.now().strftime('%d-%b-%Y(%I_%M%p)')}.png")

plt.figure(figsize=(10, 6))
plt.barh(df["url"], df["timeTaken"], color="royalblue")
plt.xlabel("Load Time (seconds)")
plt.ylabel("Page URL")
plt.title("Average Page Load Time (Top URLs)")
plt.tight_layout()
plt.savefig(chart_path)
plt.close()

print(f"📈 Chart saved → {chart_path}")

# === STEP 7: Export top slow pages ===
slowest_pages = df.nlargest(5, "timeTaken")[["url", "timeTaken"]]
slowest_path = os.path.join(latest_folder, "top_slowest_pages.csv")
slowest_pages.to_csv(slowest_path, index=False)

print(f"🐢 Top 5 slow pages saved → {slowest_path}")

# === STEP 8: Final summary ===
summary_data = {
    "total_pages": int(total_pages),
    "average_load_time": round(float(avg_load_time), 2),
    "slowest_page": round(float(max_load), 2),
    "fastest_page": round(float(min_load), 2),
    "chart_path": chart_path,
    "csv_path": csv_path,
    "slowest_pages_path": slowest_path
}

summary_json_path = os.path.join(latest_folder, "crawl_summary.json")
with open(summary_json_path, "w", encoding="utf-8") as f:
    json.dump(summary_data, f, indent=4)

print(f"\n✅ Crawl summary JSON saved → {summary_json_path}")
print("\n🎯 Web Recorder completed successfully!\n")
