"""
🧠 Visual Diff Analyzer v1.0
-----------------------------------------
Reads visual_diff_summary.json and plots page-level UI change percentages.
"""

import os
import json
import pandas as pd
import matplotlib.pyplot as plt

# === CONFIG ===
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS_DIR = os.path.join(ROOT, "results", "visual_diffs")
SUMMARY_PATH = os.path.join(RESULTS_DIR, "visual_diff_summary.json")

if not os.path.exists(SUMMARY_PATH):
    raise FileNotFoundError(f"❌ No visual_diff_summary.json found at {SUMMARY_PATH}")

print(f"📂 Reading visual diff data from: {SUMMARY_PATH}")

# === LOAD DATA ===
with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

df = pd.DataFrame(data)
df["diffPercent"] = df["diffPercent"].astype(float)

avg_change = df["diffPercent"].mean()
max_change = df["diffPercent"].max()
min_change = df["diffPercent"].min()

print("\n📊 Visual Change Summary")
print(f"🧾 Pages compared: {len(df)}")
print(f"⚡ Average Change: {avg_change:.3f}%")
print(f"🔸 Min / Max Change: {min_change:.3f}% / {max_change:.3f}%")

# === PLOT ===
plt.figure(figsize=(12, 6))
plt.barh(df["page"], df["diffPercent"], color="skyblue")
plt.axvline(avg_change, color="red", linestyle="--", label=f"Average: {avg_change:.2f}%")
plt.title("Visual Change Percentage by Page")
plt.xlabel("Change (%)")
plt.ylabel("Page")
plt.legend()
plt.tight_layout()

plot_path = os.path.join(RESULTS_DIR, "visual_diff_plot.png")
plt.savefig(plot_path)
plt.close()

print(f"📈 Visual diff plot saved → {plot_path}")
print("✅ Visualization complete.")
