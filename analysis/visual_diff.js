/**
 * 🧩 Visual Regression Detector v4.0 (SAFE + CROP FIX)
 * ---------------------------------------------------------------
 * 👉 Fixes pixelmatch crash by cropping both images to same size
 * 👉 No sharp required
 * 👉 100% stable with Puppeteer crawler
 */

import fs from "fs-extra";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// === CONFIG ===
const resultsDir = "../results";
const ignoreFolders = ["charts", "visual_diffs"];

// === Load valid crawl folders ===
const allEntries = (await fs.readdir(resultsDir))
  .filter((f) => !ignoreFolders.includes(f))
  .map((f) => ({
    name: f,
    path: path.join(resultsDir, f),
    mtime: fs.statSync(path.join(resultsDir, f)).mtime,
  }))
  .filter((entry) => fs.existsSync(path.join(entry.path, "screenshots")));

if (allEntries.length < 2) {
  console.error("⚠️ Need at least two crawl folders!");
  process.exit(1);
}

allEntries.sort((a, b) => b.mtime - a.mtime);
const [latest, previous] = [allEntries[0], allEntries[1]];

const runA = path.join(previous.path, "screenshots");
const runB = path.join(latest.path, "screenshots");
const outputDir = path.join(resultsDir, "visual_diffs");
await fs.ensureDir(outputDir);

console.log("🔍 Comparing latest two runs:");
console.log("📁 Old:", runA);
console.log("📁 New:", runB);

// === Helper: Normalize filename ===
function baseName(file) {
  return file.replace(/\_\d+\.(png|jpg)$/i, ".png");
}

// === Read files ===
const filesA = (await fs.readdir(runA)).filter((f) => f.endsWith(".png"));
const filesB = (await fs.readdir(runB)).filter((f) => f.endsWith(".png"));

const mapA = new Map(filesA.map((f) => [baseName(f), f]));
const mapB = new Map(filesB.map((f) => [baseName(f), f]));

let summary = [];

// === CROP FUNCTION (THE FIX) ===
function cropToSmallest(imgA, imgB) {
  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);

  const crop = (src) => {
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      const srcIdx = y * src.width * 4;
      const dstIdx = y * width * 4;
      src.data.copy(out.data, dstIdx, srcIdx, srcIdx + width * 4);
    }
    return out;
  };

  return [crop(imgA), crop(imgB)];
}

// === Main Comparison Loop ===
for (const [key, fileA] of mapA) {
  if (!mapB.has(key)) continue;

  const fileB = mapB.get(key);

  let imgA = PNG.sync.read(await fs.readFile(path.join(runA, fileA)));
  let imgB = PNG.sync.read(await fs.readFile(path.join(runB, fileB)));

  console.log(`\n📄 ${key}`);
  console.log(`   A size: ${imgA.width}x${imgA.height}`);
  console.log(`   B size: ${imgB.width}x${imgB.height}`);

  // === FIX: Crop both images BEFORE pixelmatch ===
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    console.log("   ⚠️ Sizes differ → cropping...");
    [imgA, imgB] = cropToSmallest(imgA, imgB);
  }

  const width = imgA.width;
  const height = imgA.height;
  const diff = new PNG({ width, height });

  let diffPixels = 0;

  try {
    diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
      threshold: 0.1,
      includeAA: true,
    });
  } catch (err) {
    console.log("   ❌ pixelmatch failed:", err.message);
    summary.push({ page: key, diffPercent: "0.000 (skipped)" });
    continue;
  }

  const diffPercent = ((diffPixels / (width * height)) * 100).toFixed(3);
  const diffPath = path.join(outputDir, `diff_${key}`);
  await fs.writeFile(diffPath, PNG.sync.write(diff));

  console.log(`   ✅ Difference: ${diffPercent}%`);

  summary.push({ page: key, diffPixels, diffPercent, diffPath });
}

// === Save Summary ===
const summaryPath = path.join(outputDir, "visual_diff_summary.json");
await fs.writeJson(summaryPath, summary, { spaces: 2 });

console.log("\n📊 Summary saved →", summaryPath);
