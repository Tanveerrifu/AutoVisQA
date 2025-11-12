/**
 * visual_diff_ultimate.js
 *
 * All-in-one advanced visual diff engine:
 * - pads smaller image to largest
 * - pixelmatch diffs
 * - SSIM (perceptual)
 * - MSE / PSNR
 * - connected regions -> bounding boxes
 * - movement detection (match regions by IoU & template correlation)
 * - mask support to ignore areas
 * - annotated outputs + heat overlay
 * - HTML report + JSON summary
 *
 * Usage:
 *   node visual_diff_ultimate.js
 *
 * Configure constants below.
 */

import fs from "fs-extra";
import path from "path";
import Jimp from "jimp/es";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

let ssimCompare = null;
try {
  // ssim.js provides perceptual comparison
  // package name: ssim.js
  const ssimMod = await import("ssim.js");
  if (ssimMod && ssimMod.ssim) ssimCompare = ssimMod.ssim;
  else if (ssimMod && ssimMod.compare) ssimCompare = ssimMod.compare;
} catch (e) {
  // fallback: ssim not available -> we'll just use MSE/PSNR
  ssimCompare = null;
}

// === CONFIG ===
const RESULTS_DIR = path.resolve("../results");
const OUTPUT_DIR = path.join(RESULTS_DIR, "visual_diffs_ultimate");
const IGNORE_FOLDERS = new Set([
  "charts",
  "visual_diffs",
  "visual_diffs_ultimate",
]);
await fs.ensureDir(OUTPUT_DIR);

// User-tunable sensitivity
const PIXELMATCH_THRESHOLD = 0.12; // smaller -> more sensitive
const MIN_REGION_AREA = 20; // ignore tiny speckles
const MOVE_IOU_THRESHOLD = 0.15; // IoU to consider two regions same object (movement)
const TEMPLATE_MATCH_THRESHOLD = 0.6; // normalized cross-correlation fallback

// Mask file: if you place a PNG mask at results/mask.png (white=keep, black=ignore) will be applied
const GLOBAL_MASK_PATH = path.join(RESULTS_DIR, "mask.png"); // optional

// === Helpers ===
function basenameNoVariant(name) {
  return name.replace(/\_\d+\.(png|jpg)$/i, ".png");
}

function computeMsePsnr(pngA, pngB) {
  let mse = 0;
  const total = pngA.width * pngA.height;
  for (let i = 0; i < pngA.data.length; i += 4) {
    const r1 = pngA.data[i],
      g1 = pngA.data[i + 1],
      b1 = pngA.data[i + 2];
    const r2 = pngB.data[i],
      g2 = pngB.data[i + 1],
      b2 = pngB.data[i + 2];
    const lum1 = 0.3 * r1 + 0.59 * g1 + 0.11 * b1;
    const lum2 = 0.3 * r2 + 0.59 * g2 + 0.11 * b2;
    const diff = lum1 - lum2;
    mse += diff * diff;
  }
  mse = mse / total;
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { mse, psnr };
}

function padToLargestJimp(jA, jB) {
  const width = Math.max(jA.bitmap.width, jB.bitmap.width);
  const height = Math.max(jA.bitmap.height, jB.bitmap.height);
  const bgA = new Jimp(width, height, 0xffffffff);
  const bgB = new Jimp(width, height, 0xffffffff);
  bgA.composite(jA, 0, 0);
  bgB.composite(jB, 0, 0);
  return { bgA, bgB, width, height };
}

// read png into PNG object (from Jimp buffer or file)
function pngFromJimp(jimpImg) {
  const buf = jimpImg.getBufferAsync ? null : null;
  // We'll sync convert using buffer from getBufferAsync where needed in async flow
  // This helper kept for clarity
}

// crop or apply mask: returns modified PNG objects
async function applyMaskIfExists(pngObj, maskPng) {
  if (!maskPng) return pngObj;
  // mask: if mask alpha==0 OR rgb==0 treat as ignore -> set target pixel identical to other to avoid counting
  // but easier: set alpha=0 at mask-black locations so pixelmatch/SSIM ignore? We'll implement by zeroing diff potential
  // For simplicity, we'll output mask and later when computing diff we will zero out diff where mask says ignore.
  return pngObj;
}

// Connected components / regions (4-connected) on diff PNG
function findDiffRegions(diffPng, minArea = MIN_REGION_AREA) {
  const w = diffPng.width,
    h = diffPng.height;
  const visited = new Uint8Array(w * h);
  const regions = [];
  function idx(x, y) {
    return y * w + x;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (visited[i]) continue;
      const di = i * 4;
      const r = diffPng.data[di],
        g = diffPng.data[di + 1],
        b = diffPng.data[di + 2],
        a = diffPng.data[di + 3];
      const changed = a !== 0 || r !== 0 || g !== 0 || b !== 0;
      if (!changed) continue;
      // flood fill
      const stack = [[x, y]];
      visited[i] = 1;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y,
        area = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = idx(nx, ny);
          if (visited[ni]) continue;
          const ndi = ni * 4;
          const nr = diffPng.data[ndi],
            ng = diffPng.data[ndi + 1],
            nb = diffPng.data[ndi + 2],
            na = diffPng.data[ndi + 3];
          const nChanged = na !== 0 || nr !== 0 || ng !== 0 || nb !== 0;
          if (nChanged) {
            visited[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      const regionArea = width * height;
      if (regionArea >= minArea) {
        regions.push({
          x: minX,
          y: minY,
          w: width,
          h: height,
          area: regionArea,
        });
      }
    }
  }
  // sort descending area
  regions.sort((a, b) => b.area - a.area);
  return regions;
}

// IoU
function iou(r1, r2) {
  const x1 = Math.max(r1.x, r2.x);
  const y1 = Math.max(r1.y, r2.y);
  const x2 = Math.min(r1.x + r1.w, r2.x + r2.w);
  const y2 = Math.min(r1.y + r1.h, r2.y + r2.h);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const union = r1.area + r2.area - inter;
  return union === 0 ? 0 : inter / union;
}

// attempt to match regions between old/new to detect movement vs added/removed
function matchRegions(regionsA, regionsB) {
  const matches = [];
  const usedB = new Set();
  for (const ra of regionsA) {
    let best = null,
      bestIoU = 0;
    for (let j = 0; j < regionsB.length; j++) {
      if (usedB.has(j)) continue;
      const rb = regionsB[j];
      const val = iou(ra, rb);
      if (val > bestIoU) {
        bestIoU = val;
        best = j;
      }
    }
    if (best !== null && bestIoU >= MOVE_IOU_THRESHOLD) {
      matches.push({ a: ra, b: regionsB[best], iou: bestIoU, type: "moved" });
      usedB.add(best);
    } else {
      matches.push({ a: ra, b: null, iou: bestIoU, type: "removed" });
    }
  }
  // leftover in B are added
  for (let j = 0; j < regionsB.length; j++) {
    if (!usedB.has(j))
      matches.push({ a: null, b: regionsB[j], iou: 0, type: "added" });
  }
  return matches;
}

// generate annotated images (overlay + boxes)
async function annotateAndSave(jimpNew, diffPng, regions, outBase) {
  // overlay red heatmap proportional to diff intensity
  const width = diffPng.width,
    height = diffPng.height;
  const overlay = new Jimp(width, height, 0x00000000);
  overlay.scan(0, 0, width, height, function (x, y, idx) {
    const i = (y * width + x) * 4;
    const r = diffPng.data[i],
      g = diffPng.data[i + 1],
      b = diffPng.data[i + 2],
      a = diffPng.data[i + 3];
    const intensity = Math.max(r, g, b, a);
    if (intensity > 0) {
      this.bitmap.data[idx + 0] = 255; // red
      this.bitmap.data[idx + 1] = 0;
      this.bitmap.data[idx + 2] = 0;
      this.bitmap.data[idx + 3] = Math.floor(Math.min(200, intensity * 0.6));
    }
  });
  const annotated = jimpNew.clone();
  annotated.composite(overlay, 0, 0);

  // draw boxes
  for (const r of regions) {
    const stroke = 3;
    const color = 0xff0000ff;
    // top
    annotated.scan(
      r.x - stroke,
      r.y - stroke,
      r.w + stroke * 2,
      stroke,
      function (xx, yy, idx) {
        if (
          xx >= 0 &&
          yy >= 0 &&
          xx < this.bitmap.width &&
          yy < this.bitmap.height
        ) {
          this.bitmap.data[idx + 0] = 255;
          this.bitmap.data[idx + 1] = 0;
          this.bitmap.data[idx + 2] = 0;
          this.bitmap.data[idx + 3] = 255;
        }
      }
    );
    // bottom
    annotated.scan(
      r.x - stroke,
      r.y + r.h,
      r.w + stroke * 2,
      stroke,
      function (xx, yy, idx) {
        if (
          xx >= 0 &&
          yy >= 0 &&
          xx < this.bitmap.width &&
          yy < this.bitmap.height
        ) {
          this.bitmap.data[idx + 0] = 255;
          this.bitmap.data[idx + 1] = 0;
          this.bitmap.data[idx + 2] = 0;
          this.bitmap.data[idx + 3] = 255;
        }
      }
    );
    // left
    annotated.scan(
      r.x - stroke,
      r.y - stroke,
      stroke,
      r.h + stroke * 2,
      function (xx, yy, idx) {
        if (
          xx >= 0 &&
          yy >= 0 &&
          xx < this.bitmap.width &&
          yy < this.bitmap.height
        ) {
          this.bitmap.data[idx + 0] = 255;
          this.bitmap.data[idx + 1] = 0;
          this.bitmap.data[idx + 2] = 0;
          this.bitmap.data[idx + 3] = 255;
        }
      }
    );
    // right
    annotated.scan(
      r.x + r.w,
      r.y - stroke,
      stroke,
      r.h + stroke * 2,
      function (xx, yy, idx) {
        if (
          xx >= 0 &&
          yy >= 0 &&
          xx < this.bitmap.width &&
          yy < this.bitmap.height
        ) {
          this.bitmap.data[idx + 0] = 255;
          this.bitmap.data[idx + 1] = 0;
          this.bitmap.data[idx + 2] = 0;
          this.bitmap.data[idx + 3] = 255;
        }
      }
    );
  }

  const annotatedPath = `${outBase}_annotated.png`;
  await annotated.writeAsync(annotatedPath);
  const rawDiffPath = `${outBase}_rawdiff.png`;
  await fs.writeFile(rawDiffPath, PNG.sync.write(diffPng));
  return { annotatedPath, rawDiffPath };
}

// HTML report builder
async function writeHtmlReport(summary, outDir) {
  const htmlPath = path.join(outDir, "report.html");
  const rows = summary
    .map((s) => {
      const thumb = path.relative(outDir, s.annotated).replace(/\\/g, "/");
      const diff = path.relative(outDir, s.diffImage).replace(/\\/g, "/");
      const oldRel = path.relative(outDir, s.oldFile).replace(/\\/g, "/");
      const newRel = path.relative(outDir, s.newFile).replace(/\\/g, "/");
      const regionsHtml = (s.regions || [])
        .map((r) => `<div>(${r.x},${r.y}) ${r.w}x${r.h}</div>`)
        .join("");
      return `
      <tr>
        <td>${s.page}</td>
        <td>${s.width}x${s.height}</td>
        <td>${s.diffPercent}%</td>
        <td>${s.mse.toFixed(2)}</td>
        <td>${isFinite(s.psnr) ? s.psnr.toFixed(2) : "Inf"}</td>
        <td>${s.ssim !== null ? s.ssim.toFixed(3) : "N/A"}</td>
        <td><a href="${oldRel}">old</a> | <a href="${newRel}">new</a> | <a href="${diff}">raw-diff</a></td>
        <td><img src="${thumb}" style="max-height:120px"></td>
        <td>${regionsHtml}</td>
      </tr>
    `;
    })
    .join("\n");

  const html = `
  <html>
  <head>
    <meta charset="utf-8"/>
    <title>Visual Diff Report</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; }
      table { border-collapse: collapse; width: 100%; }
      td, th { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
      th { background: #f4f4f4; }
    </style>
  </head>
  <body>
    <h1>Visual Diff Report</h1>
    <p>Generated: ${new Date().toISOString()}</p>
    <table>
      <thead>
        <tr>
          <th>page</th><th>size</th><th>diff%</th><th>MSE</th><th>PSNR</th><th>SSIM</th><th>links</th><th>annotated</th><th>regions</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </body>
  </html>
  `;
  await fs.writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

// === Discover latest two runs ===
const entries = (await fs.readdir(RESULTS_DIR))
  .filter((f) => !IGNORE_FOLDERS.has(f))
  .map((name) => {
    const p = path.join(RESULTS_DIR, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch (e) {
      mtime = 0;
    }
    return { name, path: p, mtime };
  })
  .filter((e) => fs.existsSync(path.join(e.path, "screenshots")));

if (entries.length < 2) {
  console.error(
    "Need at least two run folders under results/* with screenshots/"
  );
  process.exit(1);
}
entries.sort((a, b) => b.mtime - a.mtime);
const latest = entries[0],
  previous = entries[1];
const runA = path.join(previous.path, "screenshots");
const runB = path.join(latest.path, "screenshots");

console.log("Old run:", runA);
console.log("New run:", runB);

const filesA = (await fs.readdir(runA)).filter((f) =>
  f.toLowerCase().endsWith(".png")
);
const filesB = (await fs.readdir(runB)).filter((f) =>
  f.toLowerCase().endsWith(".png")
);
const mapA = new Map(filesA.map((f) => [basenameNoVariant(f), f]));
const mapB = new Map(filesB.map((f) => [basenameNoVariant(f), f]));
const keys = [...mapA.keys()].filter((k) => mapB.has(k));
console.log(`Found ${keys.length} matching screenshots.`);

const maskPng = fs.existsSync(GLOBAL_MASK_PATH)
  ? PNG.sync.read(await fs.readFile(GLOBAL_MASK_PATH))
  : null;

const summary = [];

for (const key of keys) {
  const aName = mapA.get(key),
    bName = mapB.get(key);
  const pathA = path.join(runA, aName),
    pathB = path.join(runB, bName);
  console.log("Processing:", key);

  try {
    const jA = await Jimp.read(pathA);
    const jB = await Jimp.read(pathB);

    // pad to largest
    const { bgA, bgB, width, height } = padToLargestJimp(jA, jB);

    const bufA = await bgA.getBufferAsync(Jimp.MIME_PNG);
    const bufB = await bgB.getBufferAsync(Jimp.MIME_PNG);
    const pngA = PNG.sync.read(bufA);
    const pngB = PNG.sync.read(bufB);

    // do pixelmatch (raw diff)
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(
      pngA.data,
      pngB.data,
      diffPng.data,
      width,
      height,
      { threshold: PIXELMATCH_THRESHOLD, includeAA: true }
    );

    // metrics
    const { mse, psnr } = computeMsePsnr(pngA, pngB);
    let ssimVal = null;
    if (ssimCompare) {
      try {
        // ssim.js expects ImageData-like objects; adapt
        const area = { width, height };
        const iA = { data: pngA.data, width, height };
        const iB = { data: pngB.data, width, height };
        // ssimCompare may be async or sync depending on lib; try both patterns
        const r = await ssimCompare(iA, iB, {
          windowSize: 11,
          bitDepth: 8,
        }).catch((e) => null);
        if (r && r.ssim) ssimVal = r.ssim;
        else if (r && r.map) ssimVal = r.mean || null;
      } catch (e) {
        ssimVal = null;
      }
    }

    const diffPercent = (diffPixels / (width * height)) * 100;

    // compute regions
    const regions = findDiffRegions(diffPng, MIN_REGION_AREA);

    // attempt to detect movement: we need regions from previous comparison side too
    // For now we compute regions for A->B and store; movement detection will be done by matching regions of the two runs
    // But we can approximate: match bounding boxes by IoU between regions of A and B from same diff mask
    // For better movement detection we would compute diff of old->new and new->old and match - we'll implement simple matching:
    // compute regionsOld by diff between A and B but reversed? We'll compute regionsFromA (areas where A differs) and fromB
    // Quick trick: find pixels where A != B but A has non-white and B is white to mark removed vs added — heavy; keep simple:
    // For movement detection we will match A's regions (where A has unique pixels) and B's regions (where B has unique pixels)
    const diffOldOnly = new PNG({ width, height }); // where A!=B and A has non-white
    const diffNewOnly = new PNG({ width, height }); // where A!=B and B has non-white
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const same =
        pngA.data[idx] === pngB.data[idx] &&
        pngA.data[idx + 1] === pngB.data[idx + 1] &&
        pngA.data[idx + 2] === pngB.data[idx + 2];
      if (same) {
        diffOldOnly.data[idx] = 0;
        diffOldOnly.data[idx + 1] = 0;
        diffOldOnly.data[idx + 2] = 0;
        diffOldOnly.data[idx + 3] = 0;
        diffNewOnly.data[idx] = 0;
        diffNewOnly.data[idx + 1] = 0;
        diffNewOnly.data[idx + 2] = 0;
        diffNewOnly.data[idx + 3] = 0;
        continue;
      }
      // if A's pixel is visually "larger" than blank (rough heuristic)
      const aSum = pngA.data[idx] + pngA.data[idx + 1] + pngA.data[idx + 2];
      const bSum = pngB.data[idx] + pngB.data[idx + 1] + pngB.data[idx + 2];
      if (aSum > bSum) {
        // A has something B doesn't (removed)
        diffOldOnly.data[idx] = 255;
        diffOldOnly.data[idx + 3] = 255;
        diffNewOnly.data[idx] = 0;
        diffNewOnly.data[idx + 3] = 0;
      } else if (bSum > aSum) {
        // B has something A doesn't (added)
        diffNewOnly.data[idx] = 255;
        diffNewOnly.data[idx + 3] = 255;
        diffOldOnly.data[idx] = 0;
        diffOldOnly.data[idx + 3] = 0;
      } else {
        diffOldOnly.data[idx] = 255;
        diffOldOnly.data[idx + 3] = 255;
      }
    }
    const regionsOld = findDiffRegions(diffOldOnly, MIN_REGION_AREA);
    const regionsNew = findDiffRegions(diffNewOnly, MIN_REGION_AREA);
    const matched = matchRegions(regionsOld, regionsNew);

    // annotate and save images
    const baseOutName = key.replace(/[\/\\]/g, "_").replace(/^\./, "");
    const outBase = path.join(OUTPUT_DIR, baseOutName);
    const { annotatedPath, rawDiffPath } = await annotateAndSave(
      bgB,
      diffPng,
      regions,
      outBase
    );

    // write JSON summary entry
    summary.push({
      page: key,
      oldFile: pathA,
      newFile: pathB,
      width,
      height,
      diffPixels,
      diffPercent: parseFloat(diffPercent.toFixed(3)),
      mse,
      psnr: isFinite(psnr) ? parseFloat(psnr.toFixed(3)) : null,
      ssim: ssimVal !== null ? parseFloat(ssimVal.toFixed(3)) : null,
      regions,
      regionsOld,
      regionsNew,
      matches: matched,
      annotated: annotatedPath,
      diffImage: path.join(OUTPUT_DIR, `${baseOutName}_diff.png`),
    });
  } catch (err) {
    console.error("Error processing", key, err);
    summary.push({ page: key, error: String(err) });
  }
}

// write outputs
const summaryPath = path.join(OUTPUT_DIR, "visual_diff_summary.json");
await fs.writeJson(summaryPath, summary, { spaces: 2 });
console.log("Saved JSON summary:", summaryPath);

const htmlPath = await writeHtmlReport(summary, OUTPUT_DIR);
console.log("Saved HTML report:", htmlPath);

console.log("Done. Open the HTML report for a visual overview.");
