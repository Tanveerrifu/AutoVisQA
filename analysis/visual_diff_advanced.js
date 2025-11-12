/**
 * Advanced Visual Diff Engine (Node.js)
 *
 * Features:
 * - Pads smaller image to the larger image (no cropping) so missing elements are counted.
 * - Uses pixelmatch for pixel diffs.
 * - Computes MSE & PSNR metrics.
 * - Detects connected changed regions and draws bounding boxes (annotated output).
 * - Writes visual_diff_summary.json with details for each page.
 *
 * Requires: jimp, pngjs, pixelmatch, fs-extra
 * Install: npm i jimp pngjs pixelmatch fs-extra
 */

import fs from "fs-extra";
import path from "path";
import Jimp from "jimp";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const RESULTS_DIR = path.resolve("../results");
const OUTPUT_DIR = path.join(RESULTS_DIR, "visual_diffs");
await fs.ensureDir(OUTPUT_DIR);

// === Helpers ===
function basenameNoVariant(name) {
  // preserve your previous naming normalization if required
  return name.replace(/\_\d+\.(png|jpg)$/i, ".png");
}

async function loadPngWithJimp(filepath) {
  const img = await Jimp.read(filepath);
  // ensure PNG format buffer
  const buf = await img.getBufferAsync(Jimp.MIME_PNG);
  const png = PNG.sync.read(buf);
  return { jimp: img, png };
}

// pad smaller image to largest width/height and return two PNG objects and Jimp images
async function padToLargest(jimpA, jimpB) {
  const width = Math.max(jimpA.bitmap.width, jimpB.bitmap.width);
  const height = Math.max(jimpA.bitmap.height, jimpB.bitmap.height);

  // create white background canvases
  const bgA = new Jimp(width, height, 0xffffffff); // white bg
  const bgB = new Jimp(width, height, 0xffffffff);

  // composite original images at top-left (0,0)
  bgA.composite(jimpA, 0, 0);
  bgB.composite(jimpB, 0, 0);

  const bufA = await bgA.getBufferAsync(Jimp.MIME_PNG);
  const bufB = await bgB.getBufferAsync(Jimp.MIME_PNG);

  const pngA = PNG.sync.read(bufA);
  const pngB = PNG.sync.read(bufB);

  return { jimpA: bgA, jimpB: bgB, pngA, pngB, width, height };
}

// compute MSE and PSNR
function computeMsePsnr(imgA, imgB) {
  let mse = 0;
  const total = imgA.width * imgA.height;
  for (let i = 0; i < imgA.data.length; i += 4) {
    // compare luminance (simple average of RGB)
    const r1 = imgA.data[i],
      g1 = imgA.data[i + 1],
      b1 = imgA.data[i + 2];
    const r2 = imgB.data[i],
      g2 = imgB.data[i + 1],
      b2 = imgB.data[i + 2];
    const lum1 = (r1 + g1 + b1) / 3;
    const lum2 = (r2 + g2 + b2) / 3;
    const diff = lum1 - lum2;
    mse += diff * diff;
  }
  mse = mse / total;
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { mse, psnr };
}

// analyze diff PNG and find bounding boxes of connected regions
function findDiffRegions(diffPng, thresholdRGBA = 0) {
  // We'll detect all pixels where diff.alpha != 0 OR any channel > threshold
  const w = diffPng.width,
    h = diffPng.height;
  const visited = new Uint8Array(w * h);
  const regions = [];

  function getIdx(x, y) {
    return y * w + x;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idxPixel = y * w + x;
      if (visited[idxPixel]) continue;
      const di = idxPixel * 4;
      const r = diffPng.data[di],
        g = diffPng.data[di + 1],
        b = diffPng.data[di + 2],
        a = diffPng.data[di + 3];
      const changed =
        a !== 0 || r > thresholdRGBA || g > thresholdRGBA || b > thresholdRGBA;
      if (!changed) continue;

      // BFS/stack flood fill to find connected region
      const stack = [[x, y]];
      visited[idxPixel] = 1;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        // update bounds
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // neighbors 4-connected
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = getIdx(nx, ny);
          if (visited[nIdx]) continue;
          const ndi = nIdx * 4;
          const nr = diffPng.data[ndi],
            ng = diffPng.data[ndi + 1],
            nb = diffPng.data[ndi + 2],
            na = diffPng.data[ndi + 3];
          const nChanged =
            na !== 0 ||
            nr > thresholdRGBA ||
            ng > thresholdRGBA ||
            nb > thresholdRGBA;
          if (nChanged) {
            visited[nIdx] = 1;
            stack.push([nx, ny]);
          }
        }
      }

      const area = (maxX - minX + 1) * (maxY - minY + 1);
      regions.push({
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        area,
      });
    }
  }

  // optional: filter tiny speckles
  const MIN_AREA = 16; // tune this
  return regions
    .filter((r) => r.area >= MIN_AREA)
    .sort((a, b) => b.area - a.area);
}

// draw bounding boxes onto a Jimp image
function drawBoxes(jimpImage, regions, options = {}) {
  const stroke = options.stroke ?? 3;
  const color = options.color ?? 0xff0000ff; // red (RGBA)
  for (const r of regions) {
    // draw rectangle border by filling four rectangles
    // top
    jimpImage.scan(
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
        )
          (this.bitmap.data[idx + 0] = 255),
            (this.bitmap.data[idx + 1] = 0),
            (this.bitmap.data[idx + 2] = 0),
            (this.bitmap.data[idx + 3] = 255);
      }
    );
    // bottom
    jimpImage.scan(
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
        )
          (this.bitmap.data[idx + 0] = 255),
            (this.bitmap.data[idx + 1] = 0),
            (this.bitmap.data[idx + 2] = 0),
            (this.bitmap.data[idx + 3] = 255);
      }
    );
    // left
    jimpImage.scan(
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
        )
          (this.bitmap.data[idx + 0] = 255),
            (this.bitmap.data[idx + 1] = 0),
            (this.bitmap.data[idx + 2] = 0),
            (this.bitmap.data[idx + 3] = 255);
      }
    );
    // right
    jimpImage.scan(
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
        )
          (this.bitmap.data[idx + 0] = 255),
            (this.bitmap.data[idx + 1] = 0),
            (this.bitmap.data[idx + 2] = 0),
            (this.bitmap.data[idx + 3] = 255);
      }
    );
  }
}

// === Discover latest two crawl runs (same logic as your previous script) ===
const ignoreFolders = new Set(["charts", "visual_diffs"]);
const entries = (await fs.readdir(RESULTS_DIR))
  .filter((f) => !ignoreFolders.has(f))
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
  console.error("Need at least two results/<run> folders with screenshots/");
  process.exit(1);
}

entries.sort((a, b) => b.mtime - a.mtime);
const latest = entries[0],
  previous = entries[1];
const runA = path.join(previous.path, "screenshots");
const runB = path.join(latest.path, "screenshots");

console.log("Old run:", runA);
console.log("New run:", runB);

// load file lists and match by normalized base name
const filesA = (await fs.readdir(runA)).filter((f) =>
  f.toLowerCase().endsWith(".png")
);
const filesB = (await fs.readdir(runB)).filter((f) =>
  f.toLowerCase().endsWith(".png")
);
const mapA = new Map(filesA.map((f) => [basenameNoVariant(f), f]));
const mapB = new Map(filesB.map((f) => [basenameNoVariant(f), f]));

const keys = [...mapA.keys()].filter((k) => mapB.has(k));
console.log(`Found ${keys.length} matching screenshots to compare.`);

const summary = [];

for (const key of keys) {
  const fileA = mapA.get(key),
    fileB = mapB.get(key);
  const pathA = path.join(runA, fileA),
    pathB = path.join(runB, fileB);
  console.log("\nProcessing:", key);
  try {
    // load with Jimp so we can pad/annotate easily
    const jA = await Jimp.read(pathA);
    const jB = await Jimp.read(pathB);

    // pad to largest
    const { jimpA, jimpB, pngA, pngB, width, height } = await padToLargest(
      jA,
      jB
    );

    // do pixelmatch
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(
      pngA.data,
      pngB.data,
      diffPng.data,
      width,
      height,
      { threshold: 0.1, includeAA: true }
    );

    // metrics
    const { mse, psnr } = computeMsePsnr(pngA, pngB);
    const diffPercent = ((diffPixels / (width * height)) * 100).toFixed(3);

    // regions (bounding boxes)
    const regions = findDiffRegions(diffPng);
    console.log(
      `   diffPixels=${diffPixels}, diff%=${diffPercent}, regions=${
        regions.length
      }, mse=${mse.toFixed(2)}, psnr=${
        isFinite(psnr) ? psnr.toFixed(2) : "Inf"
      }`
    );

    // annotate: overlay heat-like alpha diff onto imageB copy and draw boxes
    // create overlay: where diff exists, color red with alpha proportional to diff
    const overlay = new Jimp(width, height, 0x00000000);
    // paint overlay from diffPng data
    overlay.scan(0, 0, width, height, function (x, y, idx) {
      const i = (y * width + x) * 4;
      const r = diffPng.data[i],
        g = diffPng.data[i + 1],
        b = diffPng.data[i + 2],
        a = diffPng.data[i + 3];
      const alpha = Math.min(255, Math.max(a, r, g, b)); // take max channel as intensity
      if (alpha > 0) {
        // red overlay, alpha scaled
        this.bitmap.data[idx + 0] = 255;
        this.bitmap.data[idx + 1] = 0;
        this.bitmap.data[idx + 2] = 0;
        this.bitmap.data[idx + 3] = Math.floor(alpha * 0.7); // soften a bit
      }
    });

    // Compose overlay on top of new image (jimpB)
    const annotated = jimpB.clone();
    annotated.composite(overlay, 0, 0);

    // draw boxes
    drawBoxes(annotated, regions, { stroke: 3 });

    // save annotated and diff image
    const baseOutName = key.replace(/\//g, "_").replace(/^\./, "");
    const annotatedPath = path.join(OUTPUT_DIR, `${baseOutName}_annotated.png`);
    const diffImgPath = path.join(OUTPUT_DIR, `${baseOutName}_rawdiff.png`);
    await annotated.writeAsync(annotatedPath);
    await fs.writeFile(
      path.join(OUTPUT_DIR, `${baseOutName}_diff.png`),
      PNG.sync.write(diffPng)
    );
    await fs.writeFile(diffImgPath, PNG.sync.write(diffPng));

    // build structured region details (clip big areas to keep file small)
    const regionSummary = regions.map((r) => ({
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      area: r.area,
    }));

    // push to summary
    summary.push({
      page: key,
      oldFile: pathA,
      newFile: pathB,
      width,
      height,
      diffPixels,
      diffPercent: parseFloat(diffPercent),
      mse,
      psnr: isFinite(psnr) ? parseFloat(psnr.toFixed(3)) : null,
      regions: regionSummary,
      annotated: annotatedPath,
      diffImage: path.join(OUTPUT_DIR, `${baseOutName}_diff.png`),
    });
  } catch (err) {
    console.error("  Error processing", key, err);
    summary.push({ page: key, error: String(err) });
  }
}

// write summary
const summaryPath = path.join(OUTPUT_DIR, "visual_diff_summary.json");
await fs.writeJson(summaryPath, summary, { spaces: 2 });
console.log("\nSaved summary:", summaryPath);
