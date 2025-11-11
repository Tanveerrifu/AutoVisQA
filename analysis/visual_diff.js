/**
 * 🧩 Visual Regression Detector v3.8 (Timestamped Folder Support)
 * ---------------------------------------------------------------
 * ✅ Automatically finds the last two crawl folders
 * ✅ Works with folders like 11-Nov-2025(5_27PM)
 * ✅ Ignores non-crawl directories (charts, visual_diffs)
 * ✅ Compatible with Puppeteer crawler v3.8
 */

import fs from "fs-extra";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// === CONFIG ===
const resultsDir = "../results";
const ignoreFolders = ["charts", "visual_diffs"];

// === Get all subfolders and their modification time ===
const allEntries = (await fs.readdir(resultsDir))
  .filter(f => !ignoreFolders.includes(f))
  .map(f => ({
    name: f,
    path: path.join(resultsDir, f),
    mtime: fs.statSync(path.join(resultsDir, f)).mtime
  }))
  .filter(entry => fs.existsSync(path.join(entry.path, "screenshots"))); // only folders with screenshots

if (allEntries.length < 2) {
  console.error("⚠️ Need at least two crawl folders with screenshots inside /results!");
  process.exit(1);
}

// === Sort by most recent ===
allEntries.sort((a, b) => b.mtime - a.mtime);
const [latest, previous] = [allEntries[0], allEntries[1]];

const runA = path.join(previous.path, "screenshots");
const runB = path.join(latest.path, "screenshots");
const outputDir = path.join(resultsDir, "visual_diffs");
await fs.ensureDir(outputDir);

console.log("🔍 Comparing latest two crawl runs:");
console.log(`📁 Old: ${runA}`);
console.log(`📁 New: ${runB}\n`);

// === Comparison ===
function baseName(file) {
  return file.replace(/\_\d+\.(png|jpg)$/i, ".png");
}

const filesA = (await fs.readdir(runA)).filter(f => f.endsWith(".png"));
const filesB = (await fs.readdir(runB)).filter(f => f.endsWith(".png"));

const mapA = new Map(filesA.map(f => [baseName(f), f]));
const mapB = new Map(filesB.map(f => [baseName(f), f]));

let summary = [];

for (const [key, fileA] of mapA) {
  if (!mapB.has(key)) continue;

  const fileB = mapB.get(key);
  const imgA = PNG.sync.read(await fs.readFile(path.join(runA, fileA)));
  const imgB = PNG.sync.read(await fs.readFile(path.join(runB, fileB)));

  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true
  });

  const diffPercent = ((diffPixels / (width * height)) * 100).toFixed(3);
  const diffPath = path.join(outputDir, `diff_${key}`);
  await fs.writeFile(diffPath, PNG.sync.write(diff));

  summary.push({ page: key, diffPixels, diffPercent, diffPath });
  console.log(`📸 ${key}: ${diffPercent}% difference`);
}

// === Save Summary ===
const summaryPath = path.join(outputDir, "visual_diff_summary.json");
await fs.writeJson(summaryPath, summary, { spaces: 2 });

if (summary.length > 0) {
  const avgChange = (
    summary.reduce((acc, s) => acc + parseFloat(s.diffPercent), 0) / summary.length
  ).toFixed(3);
  console.log(`\n✅ Average visual change: ${avgChange}% across ${summary.length} pages`);
} else {
  console.log("⚠️ No matching screenshots found!");
}

console.log(`📊 Summary saved → ${summaryPath}`);
