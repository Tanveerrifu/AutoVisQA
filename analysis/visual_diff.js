/**
 * 🧩 Visual Regression Detection v3.3 (Stable)
 * --------------------------------------------
 * Auto-detects the last two valid crawl runs (folders with screenshots)
 * and compares their screenshots using pixelmatch.
 */

import fs from "fs-extra";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// === Locate valid crawl folders ===
const resultsDir = "../results";
const allFolders = (await fs.readdir(resultsDir)).filter(
  (f) => !["charts", "visual_diffs"].includes(f)
); // ignore these

// Filter for folders that actually contain screenshots
const crawlFolders = [];
for (const folder of allFolders) {
  const shotsPath = path.join(resultsDir, folder, "screenshots");
  if (await fs.pathExists(shotsPath)) crawlFolders.push(folder);
}

if (crawlFolders.length < 2) {
  console.error(
    "⚠️ Need at least two crawl folders with screenshots inside /results!"
  );
  process.exit(1);
}

// Sort and pick last two
crawlFolders.sort();
const runA = path.join(
  resultsDir,
  crawlFolders[crawlFolders.length - 2],
  "screenshots"
);
const runB = path.join(
  resultsDir,
  crawlFolders[crawlFolders.length - 1],
  "screenshots"
);
const outputDir = path.join(resultsDir, "visual_diffs");
await fs.ensureDir(outputDir);

console.log(`🔍 Comparing:\n📁 ${runA}\n📁 ${runB}\n`);

// === Comparison Helper ===
function baseName(file) {
  return file.replace(/\_\d+\.(png|jpg)$/i, ".png");
}

// === Load Files ===
const filesA = (await fs.readdir(runA)).filter((f) => f.endsWith(".png"));
const filesB = (await fs.readdir(runB)).filter((f) => f.endsWith(".png"));

const mapA = new Map(filesA.map((f) => [baseName(f), f]));
const mapB = new Map(filesB.map((f) => [baseName(f), f]));

let summary = [];

for (const [key, fileA] of mapA) {
  if (!mapB.has(key)) continue;

  const fileB = mapB.get(key);
  const imgA = PNG.sync.read(await fs.readFile(path.join(runA, fileA)));
  const imgB = PNG.sync.read(await fs.readFile(path.join(runB, fileB)));

  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(
    imgA.data,
    imgB.data,
    diff.data,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: true,
    }
  );

  const diffPercent = ((diffPixels / (width * height)) * 100).toFixed(3);
  const diffPath = path.join(outputDir, `diff_${key}`);
  await fs.writeFile(diffPath, PNG.sync.write(diff));

  summary.push({ page: key, diffPixels, diffPercent, diffPath });
  console.log(`📸 ${key}: ${diffPercent}% difference`);
}

const summaryPath = path.join(outputDir, "visual_diff_summary.json");
await fs.writeJson(summaryPath, summary, { spaces: 2 });

if (summary.length > 0) {
  const avgChange = (
    summary.reduce((acc, s) => acc + parseFloat(s.diffPercent), 0) /
    summary.length
  ).toFixed(3);
  console.log(
    `\n✅ Average visual change: ${avgChange}% across ${summary.length} pages`
  );
} else {
  console.log("⚠️ No matching screenshots found!");
}

console.log(`📊 Summary saved → ${summaryPath}`);
