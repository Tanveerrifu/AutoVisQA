/**
 * visual_diff_hybrid.js
 * Hybrid visual diff engine: canvas -> jimp -> pngjs fallback
 *
 * Usage:
 *   node visual_diff_hybrid.js
 *
 * Output:
 *   results/visual_diffs_hybrid/* (annotated images, diffs, visual_diff_summary.json, report.html)
 */

import fs from "fs-extra";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const RESULTS_DIR = path.resolve("../results");
const OUTPUT_DIR = path.join(RESULTS_DIR, "visual_diffs_hybrid");
await fs.ensureDir(OUTPUT_DIR);

// Tuning
const PIXELMATCH_THRESHOLD = 0.12;
const MIN_REGION_AREA = 20;
const MOVE_IOU_THRESHOLD = 0.15;

// Try to load optional libraries in order: canvas -> jimp -> none
let Canvas = null;
let Jimp = null;
let ssimLib = null;

async function tryImports() {
  try {
    // prefer canvas (fast & great drawing)
    const cn = await import("canvas");
    Canvas = cn;
    console.log("Renderer: canvas");
  } catch (e) {
    try {
      const jm = await import("jimp");
      // jimp export issues: support both default and namespace
      Jimp = jm.default || jm;
      console.log("Renderer: jimp");
    } catch (e2) {
      console.log("Renderer: pure-png fallback (no canvas/jimp)");
    }
  }

  try {
    const sm = await import("ssim.js");
    ssimLib = sm;
    console.log("SSIM: available");
  } catch (e) {
    console.log("SSIM: not available (ok)");
  }
}

await tryImports();

// Helpers
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
  mse = mse / (pngA.width * pngA.height);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { mse, psnr };
}

function padToLargestPng(pngA, pngB) {
  const width = Math.max(pngA.width, pngB.width);
  const height = Math.max(pngA.height, pngB.height);

  const makePad = (src) => {
    const out = new PNG({ width, height });
    // fill white
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = 255;
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
      out.data[i + 3] = 255;
    }
    // copy rows
    for (let y = 0; y < src.height; y++) {
      const srcStart = y * src.width * 4;
      const dstStart = y * width * 4;
      src.data.copy(out.data, dstStart, srcStart, srcStart + src.width * 4);
    }
    return out;
  };

  return { a: makePad(pngA), b: makePad(pngB), width, height };
}

// find regions (connected components) in diff PNG
function findDiffRegions(diffPng, minArea = MIN_REGION_AREA) {
  const w = diffPng.width,
    h = diffPng.height;
  const visited = new Uint8Array(w * h);
  const regions = [];
  const idx = (x, y) => y * w + x;

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

      // flood
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
      const regArea = width * height;
      if (regArea >= minArea)
        regions.push({ x: minX, y: minY, w: width, h: height, area: regArea });
    }
  }
  regions.sort((a, b) => b.area - a.area);
  return regions;
}

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

function matchRegions(regA, regB) {
  const matches = [];
  const usedB = new Set();
  for (const a of regA) {
    let best = null,
      bestIoU = 0,
      bestIdx = -1;
    for (let j = 0; j < regB.length; j++) {
      if (usedB.has(j)) continue;
      const b = regB[j];
      const val = iou(a, b);
      if (val > bestIoU) {
        bestIoU = val;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0 && bestIoU >= MOVE_IOU_THRESHOLD) {
      matches.push({ type: "moved", a, b: regB[bestIdx], iou: bestIoU });
      usedB.add(bestIdx);
    } else {
      matches.push({ type: "removed", a, b: null, iou: bestIoU });
    }
  }
  for (let j = 0; j < regB.length; j++) {
    if (!usedB.has(j))
      matches.push({ type: "added", a: null, b: regB[j], iou: 0 });
  }
  return matches;
}

// draw boxes and overlay using available renderer
async function annotateAndSave(pngNew, diffPng, regions, outBase, renderer) {
  // renderer: {type:"canvas"|"jimp"|"png"} and appropriate libs attached
  const width = diffPng.width,
    height = diffPng.height;

  if (renderer && renderer.type === "canvas") {
    const { createCanvas, Image } = renderer.lib;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // draw new image
    const newBuf = PNG.sync.write(pngNew);
    const img = new Image();
    img.src = newBuf;
    ctx.drawImage(img, 0, 0);

    // overlay heat from diff
    const imgData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < diffPng.data.length; i += 4) {
      const alpha = Math.max(
        diffPng.data[i],
        diffPng.data[i + 1],
        diffPng.data[i + 2],
        diffPng.data[i + 3]
      );
      if (alpha > 0) {
        imgData.data[i] = Math.min(255, imgData.data[i] + 120);
        imgData.data[i + 1] = imgData.data[i + 1] * 0.6;
        imgData.data[i + 2] = imgData.data[i + 2] * 0.6;
        imgData.data[i + 3] = Math.min(
          255,
          imgData.data[i + 3] + Math.floor(alpha * 0.6)
        );
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // draw boxes
    ctx.strokeStyle = "red";
    ctx.lineWidth = 3;
    for (const r of regions) ctx.strokeRect(r.x, r.y, r.w, r.h);

    const out = outBase + "_annotated.png";
    const outStream = fs.createWriteStream(out);
    const pngStream = canvas.createPNGStream();
    pngStream.pipe(outStream);
    await new Promise((res) => outStream.on("close", res));
    // save raw diff too
    await fs.writeFile(outBase + "_rawdiff.png", PNG.sync.write(diffPng));
    return {
      annotated: outBase + "_annotated.png",
      diff: outBase + "_rawdiff.png",
    };
  }

  if (renderer && renderer.type === "jimp") {
    const J = renderer.lib;
    const newBuf = PNG.sync.write(pngNew);
    const jimg = await J.read(newBuf);
    // overlay heat
    const overlay = new J(width, height, 0x00000000);
    overlay.scan(0, 0, width, height, function (x, y, idx) {
      const i = (y * width + x) * 4;
      const intensity = Math.max(
        diffPng.data[i],
        diffPng.data[i + 1],
        diffPng.data[i + 2],
        diffPng.data[i + 3]
      );
      if (intensity > 0) {
        this.bitmap.data[idx + 0] = 255;
        this.bitmap.data[idx + 1] = 0;
        this.bitmap.data[idx + 2] = 0;
        this.bitmap.data[idx + 3] = Math.floor(Math.min(200, intensity * 0.6));
      }
    });
    jimg.composite(overlay, 0, 0);
    // draw boxes
    for (const r of regions) {
      const stroke = 3;
      // top
      jimg.scan(
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
            this.bitmap.data[idx] = 255;
            this.bitmap.data[idx + 1] = 0;
            this.bitmap.data[idx + 2] = 0;
            this.bitmap.data[idx + 3] = 255;
          }
        }
      );
      // bottom
      jimg.scan(
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
            this.bitmap.data[idx] = 255;
            this.bitmap.data[idx + 1] = 0;
            this.bitmap.data[idx + 2] = 0;
            this.bitmap.data[idx + 3] = 255;
          }
        }
      );
      // left
      jimg.scan(
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
            this.bitmap.data[idx] = 255;
            this.bitmap.data[idx + 1] = 0;
            this.bitmap.data[idx + 2] = 0;
            this.bitmap.data[idx + 3] = 255;
          }
        }
      );
      // right
      jimg.scan(
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
            this.bitmap.data[idx] = 255;
            this.bitmap.data[idx + 1] = 0;
            this.bitmap.data[idx + 2] = 0;
            this.bitmap.data[idx + 3] = 255;
          }
        }
      );
    }
    const annotatedPath = outBase + "_annotated.png";
    await jimg.writeAsync(annotatedPath);
    await fs.writeFile(outBase + "_rawdiff.png", PNG.sync.write(diffPng));
    return { annotated: annotatedPath, diff: outBase + "_rawdiff.png" };
  }

  // pure png fallback - draw boxes by modifying pngNew buffer directly
  // overlay red tint
  const outPng = PNG.sync.read(PNG.sync.write(pngNew)); // clone
  for (let i = 0; i < outPng.data.length; i += 4) {
    const intensity = Math.max(
      diffPng.data[i],
      diffPng.data[i + 1],
      diffPng.data[i + 2],
      diffPng.data[i + 3]
    );
    if (intensity > 0) {
      // blend red
      outPng.data[i] = Math.min(
        255,
        Math.floor(outPng.data[i] * 0.4 + 255 * 0.6)
      );
      outPng.data[i + 1] = Math.floor(outPng.data[i + 1] * 0.4);
      outPng.data[i + 2] = Math.floor(outPng.data[i + 2] * 0.4);
    }
  }
  // draw boxes (3px)
  const stroke = 3;
  for (const r of regions) {
    for (
      let y = Math.max(0, r.y - stroke);
      y < Math.min(outPng.height, r.y + r.h + stroke);
      y++
    ) {
      for (
        let x = Math.max(0, r.x - stroke);
        x < Math.min(outPng.width, r.x + r.w + stroke);
        x++
      ) {
        const onBorder =
          y < r.y + stroke ||
          y >= r.y + r.h - stroke ||
          x < r.x + stroke ||
          x >= r.x + r.w - stroke;
        if (!onBorder) continue;
        const di = (y * outPng.width + x) * 4;
        outPng.data[di] = 255;
        outPng.data[di + 1] = 0;
        outPng.data[di + 2] = 0;
        outPng.data[di + 3] = 255;
      }
    }
  }
  const annotatedPath = outBase + "_annotated.png";
  await fs.writeFile(annotatedPath, PNG.sync.write(outPng));
  await fs.writeFile(outBase + "_rawdiff.png", PNG.sync.write(diffPng));
  return { annotated: annotatedPath, diff: outBase + "_rawdiff.png" };
}

// HTML report
async function writeHtmlReport(summary, outDir) {
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
        <td>${s.diffPercent.toFixed(3)}</td>
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
  <html><head><meta charset="utf-8"/><title>Visual Diff Report</title>
  <style>body{font-family:Arial;padding:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;vertical-align:top}th{background:#f4f4f4}</style>
  </head><body>
  <h1>Visual Diff Report</h1><p>Generated: ${new Date().toISOString()}</p>
  <table><thead><tr><th>page</th><th>size</th><th>diff%</th><th>MSE</th><th>PSNR</th><th>SSIM</th><th>links</th><th>annotated</th><th>regions</th></tr></thead><tbody>
  ${rows}
  </tbody></table></body></html>`;
  const p = path.join(outDir, "report.html");
  await fs.writeFile(p, html, "utf8");
  return p;
}

// Discover latest two runs
const ignore = new Set([
  "charts",
  "visual_diffs",
  "visual_diffs_hybrid",
  "visual_diffs_ultimate",
]);
const runs = (await fs.readdir(RESULTS_DIR))
  .filter((d) => !ignore.has(d))
  .map((name) => {
    const p = path.join(RESULTS_DIR, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch (e) {}
    return { name, path: p, mtime };
  })
  .filter((e) => fs.existsSync(path.join(e.path, "screenshots")));

if (runs.length < 2) {
  console.error("Need at least two results/* folders with screenshots/");
  process.exit(1);
}
runs.sort((a, b) => b.mtime - a.mtime);
const latest = runs[0],
  previous = runs[1];
const runA = path.join(previous.path, "screenshots");
const runB = path.join(latest.path, "screenshots");
console.log("Old run:", runA);
console.log("New run:", runB);

// choose renderer object
let renderer = null;
if (Canvas) {
  renderer = { type: "canvas", lib: Canvas };
} else if (Jimp) {
  renderer = { type: "jimp", lib: Jimp };
} else {
  renderer = { type: "png" };
}

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

const summary = [];

for (const key of keys) {
  const aName = mapA.get(key),
    bName = mapB.get(key);
  const pathA = path.join(runA, aName),
    pathB = path.join(runB, bName);
  console.log("Processing:", key);
  try {
    // read PNGs
    const pngA = PNG.sync.read(await fs.readFile(pathA));
    const pngB = PNG.sync.read(await fs.readFile(pathB));

    // pad to largest
    const { a: padA, b: padB, width, height } = padToLargestPng(pngA, pngB);

    // pixelmatch diff
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(
      padA.data,
      padB.data,
      diffPng.data,
      width,
      height,
      { threshold: PIXELMATCH_THRESHOLD, includeAA: true }
    );

    // metrics
    const { mse, psnr } = computeMsePsnr(padA, padB);
    let ssimVal = null;
    if (ssimLib && ssimLib.ssim) {
      try {
        const iA = { data: padA.data, width, height };
        const iB = { data: padB.data, width, height };
        const r = await ssimLib
          .ssim(iA, iB, { windowSize: 11, bitDepth: 8 })
          .catch(() => null);
        if (r && r.ssim) ssimVal = r.ssim;
      } catch (e) {}
    }

    const diffPercent = (diffPixels / (width * height)) * 100;
    const regions = findDiffRegions(diffPng, MIN_REGION_AREA);

    // detect added/removed regions by checking pixel intensity difference direction
    const diffOldOnly = new PNG({ width, height });
    const diffNewOnly = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const same =
        padA.data[idx] === padB.data[idx] &&
        padA.data[idx + 1] === padB.data[idx + 1] &&
        padA.data[idx + 2] === padB.data[idx + 2];
      if (same) {
        diffOldOnly.data[idx] = 0;
        diffOldOnly.data[idx + 3] = 0;
        diffNewOnly.data[idx] = 0;
        diffNewOnly.data[idx + 3] = 0;
        continue;
      }
      const aSum = padA.data[idx] + padA.data[idx + 1] + padA.data[idx + 2];
      const bSum = padB.data[idx] + padB.data[idx + 1] + padB.data[idx + 2];
      if (aSum > bSum) {
        diffOldOnly.data[idx] = 255;
        diffOldOnly.data[idx + 3] = 255;
      } else if (bSum > aSum) {
        diffNewOnly.data[idx] = 255;
        diffNewOnly.data[idx + 3] = 255;
      } else {
        diffOldOnly.data[idx] = 255;
        diffOldOnly.data[idx + 3] = 255;
        diffNewOnly.data[idx] = 255;
        diffNewOnly.data[idx + 3] = 255;
      }
    }
    const regionsOld = findDiffRegions(diffOldOnly, MIN_REGION_AREA);
    const regionsNew = findDiffRegions(diffNewOnly, MIN_REGION_AREA);
    const matches = matchRegions(regionsOld, regionsNew);

    // annotate + save
    const baseOut = path.join(
      OUTPUT_DIR,
      key.replace(/[\/\\]/g, "_").replace(/^\./, "")
    );
    const saved = await annotateAndSave(
      padB,
      diffPng,
      regions,
      baseOut,
      renderer
    );

    const entry = {
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
      matches,
      annotated: saved.annotated,
      diffImage: saved.diff,
    };
    summary.push(entry);
    console.log(`   Done: ${entry.diffPercent}% (${regions.length} regions)`);
  } catch (err) {
    console.error(" Error processing", key, err);
    summary.push({ page: key, error: String(err) });
  }
}

// write summary + report
const summaryPath = path.join(OUTPUT_DIR, "visual_diff_summary.json");
await fs.writeJson(summaryPath, summary, { spaces: 2 });
console.log("Saved JSON:", summaryPath);
const reportPath = await writeHtmlReport(summary, OUTPUT_DIR);
console.log("Saved report:", reportPath);
console.log("All done. Open the HTML report in your browser.");
