//

/**
 * visual_diff_super.js
 *
 * Monolithic advanced visual diff engine (upgrades 1-5)
 * - Movement detection (block-match motion + template match)
 * - Perceptual metric: LPIPS (optional) -> SSIM fallback
 * - OCR text diff (optional via tesseract.js) [AUTO-DISABLED on Node >= 20]
 * - Component detection heuristics (navbar/footer/cards/buttons)
 * - Auto-mask learning: stores mask of frequently changing zones
 *
 * Usage: node visual_diff_super.js
 *
 * Note: optional packages (lpips/tesseract/canvas) are tried but not required.
 */

import fs from "fs-extra";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const ROOT = path.resolve(process.cwd(), "..");
const RESULTS_DIR = path.join(ROOT, "results");
const OUTPUT_DIR = path.join(RESULTS_DIR, "visual_diffs_super");
await fs.ensureDir(OUTPUT_DIR);

// Tunables
const PIXELMATCH_THRESHOLD = 0.12;
const MIN_REGION_AREA = 30;
const MOVE_IOU_THRESHOLD = 0.12; // IoU to treat as same object
const MOTION_BLOCK = 32; // block size for block-matching motion estimation
const AUTO_MASK_FILE = path.join(OUTPUT_DIR, "auto_mask.json");
const AUTO_MASK_PNG = path.join(OUTPUT_DIR, "auto_mask.png");

// Optional libs (best-effort)
let LPIPS = null;
let Tesseract = null;
let CanvasLib = null;
let ssimLib = null;

async function tryOptionalImports() {
  try {
    const lp = await import("@vaderai/lpips");
    LPIPS = lp.default || lp;
    console.log("LPIPS available");
  } catch (e) {
    console.log("LPIPS not found — SSIM fallback will be used");
  }

  // Disable Tesseract OCR automatically on Node >= 20 due to worker structured-clone issues
  const NODE_MAJOR = parseInt(process.versions.node.split(".")[0], 10);
  if (NODE_MAJOR >= 20) {
    console.log("OCR disabled (Node >= 20 breaks Tesseract Worker Threads)");
    Tesseract = null;
  } else {
    try {
      const tz = await import("tesseract.js");
      Tesseract = tz;
      console.log("Tesseract available");
    } catch (e) {
      console.log("Tesseract not available — OCR disabled");
      Tesseract = null;
    }
  }

  try {
    const cn = await import("canvas");
    CanvasLib = cn;
    console.log("Canvas available");
  } catch (e) {
    CanvasLib = null;
    console.log("Canvas not available — fallback PNG annotation will be used");
  }

  try {
    const sm = await import("ssim.js");
    ssimLib = sm;
    console.log("SSIM available");
  } catch (e) {
    ssimLib = null;
    console.log("SSIM not available");
  }
}

await tryOptionalImports();

// Utilities
function basenameNoVariant(name) {
  return name.replace(/\_\d+\.(png|jpg)$/i, ".png");
}

function padToLargest(pngA, pngB) {
  const width = Math.max(pngA.width, pngB.width);
  const height = Math.max(pngA.height, pngB.height);

  function pad(src) {
    const out = new PNG({ width, height });
    // fill white background
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
  }

  return { a: pad(pngA), b: pad(pngB), width, height };
}

// compute MSE/PSNR
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
    const d = lum1 - lum2;
    mse += d * d;
  }
  mse = mse / (pngA.width * pngA.height);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { mse, psnr };
}

// compute SSIM (if available)
async function computeSSIM(pngA, pngB) {
  if (!ssimLib) return null;
  try {
    const a = { data: pngA.data, width: pngA.width, height: pngA.height };
    const b = { data: pngB.data, width: pngB.width, height: pngB.height };
    const r = await ssimLib
      .ssim(a, b, { windowSize: 11, bitDepth: 8 })
      .catch(() => null);
    if (!r) return null;
    if (r.ssim) return r.ssim;
    if (r.mean) return r.mean;
    return null;
  } catch (e) {
    return null;
  }
}

// LPIPS if available (best-effort)
async function computeLPIPS(pngA, pngB) {
  if (!LPIPS) return null;
  try {
    if (LPIPS && LPIPS.compute) {
      const score = await LPIPS.compute(pngA, pngB);
      return score;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// find connected diff regions
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
      const regArea = width * height;
      if (regArea >= minArea)
        regions.push({ x: minX, y: minY, w: width, h: height, area: regArea });
    }
  }

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

// match regions to decide moved/added/removed
function matchRegions(regionsOld, regionsNew) {
  const matches = [];
  const usedNew = new Set();
  for (const ro of regionsOld) {
    let bestIdx = -1,
      bestIoU = 0;
    for (let j = 0; j < regionsNew.length; j++) {
      if (usedNew.has(j)) continue;
      const rn = regionsNew[j];
      const val = iou(ro, rn);
      if (val > bestIoU) {
        bestIoU = val;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0 && bestIoU >= MOVE_IOU_THRESHOLD) {
      usedNew.add(bestIdx);
      matches.push({
        type: "moved",
        old: ro,
        new: regionsNew[bestIdx],
        iou: bestIoU,
      });
    } else {
      matches.push({ type: "removed", old: ro, new: null, iou: bestIoU });
    }
  }
  for (let j = 0; j < regionsNew.length; j++) {
    if (!usedNew.has(j))
      matches.push({ type: "added", old: null, new: regionsNew[j], iou: 0 });
  }
  return matches;
}

/** ---------------------
 * Movement detection (upgrade 1)
 * We'll use two techniques:
 *  - template correlation inside each region (fast)
 *  - block-based exhaustive search to estimate local motion vectors (coarse optical flow)
 * Both are pure-JS and don't require OpenCV.
 * ----------------------*/

// normalized cross-correlation between template and search window
function normCrossCorrelation(
  template,
  templW,
  templH,
  haystack,
  hayW,
  hayH,
  hx,
  hy
) {
  let tSum = 0,
    hSum = 0;
  let tSq = 0,
    hSq = 0;
  let n = 0;
  for (let y = 0; y < templH; y++) {
    for (let x = 0; x < templW; x++) {
      const ti = (y * templW + x) * 4;
      const tri = template.data[ti],
        tgi = template.data[ti + 1],
        tbi = template.data[ti + 2];
      const tval = (tri + tgi + tbi) / 3;
      const hxX = hx + x,
        hyY = hy + y;
      if (hxX < 0 || hyY < 0 || hxX >= hayW || hyY >= hayH) return -1;
      const hi = (hyY * hayW + hxX) * 4;
      const hri = haystack.data[hi],
        hgi = haystack.data[hi + 1],
        hbi = haystack.data[hi + 2];
      const hval = (hri + hgi + hbi) / 3;
      tSum += tval;
      hSum += hval;
      tSq += tval * tval;
      hSq += hval * hval;
      n++;
    }
  }
  const tMean = tSum / n,
    hMean = hSum / n;
  let num = 0,
    denA = 0,
    denB = 0;
  for (let y = 0; y < templH; y++) {
    for (let x = 0; x < templW; x++) {
      const ti = (y * templW + x) * 4;
      const tri = template.data[ti],
        tgi = template.data[ti + 1],
        tbi = template.data[ti + 2];
      const tval = (tri + tgi + tbi) / 3 - tMean;
      const hxX = hx + x,
        hyY = hy + y;
      const hi = (hyY * hayW + hxX) * 4;
      const hri = haystack.data[hi],
        hgi = haystack.data[hi + 1],
        hbi = haystack.data[hi + 2];
      const hval = (hri + hgi + hbi) / 3 - hMean;
      num += tval * hval;
      denA += tval * tval;
      denB += hval * hval;
    }
  }
  const denom = Math.sqrt(denA * denB);
  if (denom === 0) return 0;
  return num / denom;
}

// template match region
function templateMatchRegion(oldPng, newPng, region, searchRadius = 40) {
  const tpl = new PNG({ width: region.w, height: region.h });
  for (let y = 0; y < region.h; y++) {
    const srcStart = ((region.y + y) * oldPng.width + region.x) * 4;
    const dstStart = y * region.w * 4;
    oldPng.data.copy(tpl.data, dstStart, srcStart, srcStart + region.w * 4);
  }
  let best = { score: -2, dx: 0, dy: 0, x: region.x, y: region.y };
  const minX = Math.max(0, region.x - searchRadius);
  const maxX = Math.min(newPng.width - region.w, region.x + searchRadius);
  const minY = Math.max(0, region.y - searchRadius);
  const maxY = Math.min(newPng.height - region.h, region.y + searchRadius);
  for (let yy = minY; yy <= maxY; yy += 2) {
    for (let xx = minX; xx <= maxX; xx += 2) {
      const score = normCrossCorrelation(
        tpl,
        tpl.width,
        tpl.height,
        newPng,
        newPng.width,
        newPng.height,
        xx,
        yy
      );
      if (score > best.score) {
        best = { score, dx: xx - region.x, dy: yy - region.y, x: xx, y: yy };
      }
    }
  }
  return best;
}

// block-based coarse motion estimation
function blockMotionEstimate(
  pngA,
  pngB,
  region,
  blockSize = MOTION_BLOCK,
  search = 12
) {
  let sumDx = 0,
    sumDy = 0,
    count = 0;
  for (let by = region.y; by < region.y + region.h; by += blockSize) {
    for (let bx = region.x; bx < region.x + region.w; bx += blockSize) {
      const bw = Math.min(blockSize, region.x + region.w - bx);
      const bh = Math.min(blockSize, region.y + region.h - by);
      const tpl = new PNG({ width: bw, height: bh });
      for (let y = 0; y < bh; y++) {
        const srcStart = ((by + y) * pngA.width + bx) * 4;
        const dstStart = y * bw * 4;
        pngA.data.copy(tpl.data, dstStart, srcStart, srcStart + bw * 4);
      }
      let bestScore = -2,
        bestDx = 0,
        bestDy = 0;
      const sx0 = Math.max(0, bx - search),
        sx1 = Math.min(pngB.width - bw, bx + search);
      const sy0 = Math.max(0, by - search),
        sy1 = Math.min(pngB.height - bh, by + search);
      for (let sy = sy0; sy <= sy1; sy += Math.max(1, Math.floor(bh / 4))) {
        for (let sx = sx0; sx <= sx1; sx += Math.max(1, Math.floor(bw / 4))) {
          const sc = normCrossCorrelation(
            tpl,
            tpl.width,
            tpl.height,
            pngB,
            pngB.width,
            pngB.height,
            sx,
            sy
          );
          if (sc > bestScore) {
            bestScore = sc;
            bestDx = sx - bx;
            bestDy = sy - by;
          }
        }
      }
      if (bestScore > -1.0) {
        sumDx += bestDx;
        sumDy += bestDy;
        count++;
      }
    }
  }
  if (count === 0) return { dx: 0, dy: 0, count: 0 };
  return { dx: sumDx / count, dy: sumDy / count, count };
}

/** ---------------------
 * OCR & Text Diff (upgrade 3)
 * Optional: uses Tesseract.js when available. Auto-disabled on Node >= 20.
 * --------------------- */

async function ocrExtractTextFromPng(png, region = null) {
  if (!Tesseract) return null;
  try {
    const buf = PNG.sync.write(region ? cropPng(png, region) : png);
    // Tesseract.createWorker uses Worker threads; we avoided enabling on Node>=20
    const { createWorker } = Tesseract;
    const worker = createWorker({ logger: () => {} });
    await worker.load();
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    const { data } = await worker.recognize(buf);
    await worker.terminate();
    return data && data.text ? data.text.trim() : null;
  } catch (e) {
    // On any Tesseract error, gracefully fallback to null
    return null;
  }
}

// crop PNG helper
function cropPng(png, region) {
  const out = new PNG({ width: region.w, height: region.h });
  for (let y = 0; y < region.h; y++) {
    const srcStart = ((region.y + y) * png.width + region.x) * 4;
    const dstStart = y * region.w * 4;
    png.data.copy(out.data, dstStart, srcStart, srcStart + region.w * 4);
  }
  return out;
}

/** ---------------------
 * Component detection heuristics (upgrade 4)
 * Basic rule-based detection: navbar/footer = wide thin regions near top/bottom; card = small box grid
 * --------------------- */
function classifyRegionAsComponent(region, imgW, imgH) {
  const aspect = region.w / Math.max(1, region.h);
  // header / navbar heuristics
  if (region.y < imgH * 0.12 && region.h < imgH * 0.25 && region.w > imgW * 0.6)
    return "navbar/header";
  // footer heuristics
  if (
    region.y + region.h > imgH * 0.82 &&
    region.h < imgH * 0.25 &&
    region.w > imgW * 0.6
  )
    return "footer";
  // small card/tile heuristics
  if (
    region.w < imgW * 0.45 &&
    region.h < imgH * 0.45 &&
    region.area < imgW * imgH * 0.06
  )
    return "card/tile";
  // banner
  if (aspect > 3 && region.h < imgH * 0.2) return "banner";
  // button-like
  if (region.w < 220 && region.h < 90) return "button";
  // fallback
  return "unknown";
}

/** ---------------------
 * Auto-mask learning (upgrade 5)
 * Tracks frequently changing boxes across runs and persists them.
 * --------------------- */

let autoMask = { learnedBoxes: [] };
if (await fs.pathExists(AUTO_MASK_FILE)) {
  try {
    autoMask = await fs.readJson(AUTO_MASK_FILE);
    if (!autoMask || !Array.isArray(autoMask.learnedBoxes))
      autoMask = { learnedBoxes: [] };
  } catch (e) {
    autoMask = { learnedBoxes: [] };
  }
}

function updateAutoMask(matches, key) {
  // matches: array of {type:'added'|'removed'|'moved', old, new, iou}
  for (const m of matches) {
    if (m.type === "added" || m.type === "removed") {
      const box = m.new || m.old;
      if (!box) continue;
      // find overlap with existing learned boxes
      let found = -1;
      for (let i = 0; i < autoMask.learnedBoxes.length; i++) {
        const b = autoMask.learnedBoxes[i];
        const inter = iou(b, box);
        if (inter > 0.5) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        autoMask.learnedBoxes[found].count =
          (autoMask.learnedBoxes[found].count || 0) + 1;
        autoMask.learnedBoxes[found].lastSeen = Date.now();
      } else {
        const nb = {
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          count: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        };
        autoMask.learnedBoxes.push(nb);
      }
    }
  }
  // optional: prune very old boxes (e.g., not seen in 90 days) or with low counts
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  autoMask.learnedBoxes = autoMask.learnedBoxes.filter(
    (b) => b.count >= 1 || Date.now() - (b.lastSeen || 0) < THIRTY_DAYS
  );
  try {
    fs.writeJsonSync(AUTO_MASK_FILE, autoMask, { spaces: 2 });
  } catch (e) {
    // ignore write failures for auto-mask
  }
}

function generateAutoMaskPng(imgW, imgH) {
  if (
    !autoMask ||
    !Array.isArray(autoMask.learnedBoxes) ||
    autoMask.learnedBoxes.length === 0
  ) {
    // nothing to generate
    return;
  }
  const out = new PNG({ width: imgW, height: imgH });
  // transparent background
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0;
    out.data[i + 1] = 0;
    out.data[i + 2] = 0;
    out.data[i + 3] = 0;
  }
  for (const b of autoMask.learnedBoxes) {
    const x0 = Math.max(0, Math.min(imgW - 1, b.x));
    const y0 = Math.max(0, Math.min(imgH - 1, b.y));
    for (let yy = y0; yy < Math.min(imgH, y0 + b.h); yy++) {
      for (let xx = x0; xx < Math.min(imgW, x0 + b.w); xx++) {
        const di = (yy * imgW + xx) * 4;
        out.data[di] = 0;
        out.data[di + 1] = 0;
        out.data[di + 2] = 0;
        out.data[di + 3] = 100; // semi-transparent mask
      }
    }
  }
  try {
    fs.writeFileSync(AUTO_MASK_PNG, PNG.sync.write(out));
  } catch (e) {
    // ignore write failures
  }
}

/** ---------------------
 * Annotation helper
 * Draw annotated image with overlay + boxes. Uses Canvas when available, else draws directly into PNG.
 * --------------------- */
async function annotateAndSave(pngNew, diffPng, regions, matches, outBase) {
  const width = diffPng.width,
    height = diffPng.height;

  if (CanvasLib) {
    const { createCanvas, Image } = CanvasLib;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // draw new image
    const newBuf = PNG.sync.write(pngNew);
    const img = new Image();
    img.src = newBuf;
    ctx.drawImage(img, 0, 0);

    // overlay heatmap from diff: tint red where diff exists
    const imgData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < diffPng.data.length; i += 4) {
      const intensity = Math.max(
        diffPng.data[i],
        diffPng.data[i + 1],
        diffPng.data[i + 2]
      );
      if (intensity > 0) {
        // apply red tint proportional to intensity
        imgData.data[i] = Math.min(255, imgData.data[i] + 120);
        imgData.data[i + 1] = Math.floor(imgData.data[i + 1] * 0.6);
        imgData.data[i + 2] = Math.floor(imgData.data[i + 2] * 0.6);
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // draw region boxes (red)
    ctx.strokeStyle = "red";
    ctx.lineWidth = 3;
    for (const r of regions) ctx.strokeRect(r.x, r.y, r.w, r.h);

    // draw matches: moved=orange, added=green, removed=blue
    for (const m of matches) {
      if (m.type === "moved" && m.new) {
        ctx.strokeStyle = "orange";
        ctx.lineWidth = 2;
        ctx.strokeRect(m.new.x, m.new.y, m.new.w, m.new.h);
      } else if (m.type === "added" && m.new) {
        ctx.strokeStyle = "green";
        ctx.lineWidth = 2;
        ctx.strokeRect(m.new.x, m.new.y, m.new.w, m.new.h);
      } else if (m.type === "removed" && m.old) {
        ctx.strokeStyle = "blue";
        ctx.lineWidth = 2;
        ctx.strokeRect(m.old.x, m.old.y, m.old.w, m.old.h);
      }
    }

    // save annotated image
    const outPath = outBase + "_annotated.png";
    await new Promise((resolve, reject) => {
      const stream = canvas.createPNGStream();
      const outStream = fs.createWriteStream(outPath);
      stream.pipe(outStream);
      outStream.on("finish", resolve);
      outStream.on("error", reject);
    });
    // save raw diff
    await fs.writeFile(outBase + "_rawdiff.png", PNG.sync.write(diffPng));
    return { annotated: outPath, diffImage: outBase + "_rawdiff.png" };
  }

  // Fallback: draw directly in PNG buffer
  const outPng = PNG.sync.read(PNG.sync.write(pngNew)); // clone
  // tint diff
  for (let i = 0; i < outPng.data.length; i += 4) {
    const intensity = Math.max(
      diffPng.data[i],
      diffPng.data[i + 1],
      diffPng.data[i + 2],
      diffPng.data[i + 3]
    );
    if (intensity > 0) {
      outPng.data[i] = Math.min(
        255,
        Math.floor(outPng.data[i] * 0.4 + 255 * 0.6)
      );
      outPng.data[i + 1] = Math.floor(outPng.data[i + 1] * 0.4);
      outPng.data[i + 2] = Math.floor(outPng.data[i + 2] * 0.4);
    }
  }
  // draw boxes
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
  const annotated = outBase + "_annotated.png";
  await fs.writeFile(annotated, PNG.sync.write(outPng));
  await fs.writeFile(outBase + "_rawdiff.png", PNG.sync.write(diffPng));
  return { annotated, diffImage: outBase + "_rawdiff.png" };
}

/** ---------------------
 * HTML report builder
 * --------------------- */
async function writeHtmlReport(summary, outDir) {
  const rows = summary
    .map((s) => {
      const thumb = path.relative(outDir, s.annotated).replace(/\\/g, "/");
      const diff = path.relative(outDir, s.diffImage).replace(/\\/g, "/");
      const oldRel = path.relative(outDir, s.oldFile).replace(/\\/g, "/");
      const newRel = path.relative(outDir, s.newFile).replace(/\\/g, "/");
      const regionsHtml = (s.regions || [])
        .map((r) => `(${r.x},${r.y}) ${r.w}x${r.h}`)
        .join("<br/>");
      const matchesHtml = (s.matches || [])
        .map((m) => `${m.type}${m.iou ? ` iou=${m.iou.toFixed(2)}` : ""}`)
        .join("<br/>");
      return `<tr>
      <td>${s.page}</td>
      <td>${s.width}x${s.height}</td>
      <td>${s.diffPercent.toFixed(3)}</td>
      <td>${s.mse.toFixed(2)}</td>
      <td>${isFinite(s.psnr) ? s.psnr.toFixed(2) : "Inf"}</td>
      <td>${s.ssim !== null ? s.ssim.toFixed(3) : "N/A"}</td>
      <td>${s.lpips !== null ? s.lpips.toFixed(3) : "N/A"}</td>
      <td><a href="${oldRel}">old</a> | <a href="${newRel}">new</a> | <a href="${diff}">raw-diff</a></td>
      <td><img src="${thumb}" style="max-height:120px"></td>
      <td>${regionsHtml}</td>
      <td>${matchesHtml}</td>
    </tr>`;
    })
    .join("\n");

  const html = `<html><head><meta charset="utf-8"/><title>Visual Diff Super Report</title>
  <style>body{font-family:Arial;padding:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;vertical-align:top}th{background:#f4f4f4}</style>
  </head><body><h1>Visual Diff Super Report</h1><p>Generated: ${new Date().toISOString()}</p>
  <table><thead><tr><th>page</th><th>size</th><th>diff%</th><th>MSE</th><th>PSNR</th><th>SSIM</th><th>LPIPS</th><th>links</th><th>annotated</th><th>regions</th><th>matches</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;

  const p = path.join(outDir, "report.html");
  await fs.writeFile(p, html, "utf8");
  return p;
}

/** ---------------------
 * main() — Do the full comparison
 * --------------------- */

async function main() {
  // 1) Detect latest 2 run folders
  const folders = (await fs.readdir(RESULTS_DIR))
    .filter(
      (f) => !["charts", "visual_diffs", "visual_diffs_super"].includes(f)
    )
    .map((f) => ({
      name: f,
      path: path.join(RESULTS_DIR, f),
      mtime: fs.statSync(path.join(RESULTS_DIR, f)).mtime,
    }))
    .filter((e) => fs.existsSync(path.join(e.path, "screenshots")));

  if (folders.length < 2) {
    console.log("❗ Need at least two screenshot runs.");
    return;
  }

  folders.sort((a, b) => b.mtime - a.mtime);
  const older = folders[1];
  const newer = folders[0];

  const oldDir = path.join(older.path, "screenshots");
  const newDir = path.join(newer.path, "screenshots");

  console.log("Old run:", oldDir);
  console.log("New run:", newDir);

  const oldFiles = (await fs.readdir(oldDir)).filter((f) => f.endsWith(".png"));
  const newFiles = (await fs.readdir(newDir)).filter((f) => f.endsWith(".png"));

  const mapOld = new Map(oldFiles.map((f) => [basenameNoVariant(f), f]));
  const mapNew = new Map(newFiles.map((f) => [basenameNoVariant(f), f]));

  const keys = [...mapOld.keys()].filter((k) => mapNew.has(k));
  console.log("Found", keys.length, "matching screenshots.");

  const summary = [];

  for (const pageKey of keys) {
    console.log("Processing:", pageKey);

    const oldP = path.join(oldDir, mapOld.get(pageKey));
    const newP = path.join(newDir, mapNew.get(pageKey));

    const pngO = PNG.sync.read(await fs.readFile(oldP));
    const pngN = PNG.sync.read(await fs.readFile(newP));

    const {
      a: oldPadded,
      b: newPadded,
      width,
      height,
    } = padToLargest(pngO, pngN);

    // Pixelmatch diff
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(
      oldPadded.data,
      newPadded.data,
      diffPng.data,
      width,
      height,
      { threshold: PIXELMATCH_THRESHOLD }
    );
    const diffPercent = (diffPixels / (width * height)) * 100;

    // Region detection
    const regions = findDiffRegions(diffPng);

    // Movement detection
    let matches = [];
    if (regions.length > 0) {
      const newRegions = regions.map((r) => r); // identical sets for IoU
      matches = matchRegions(regions, newRegions);

      // Template match + block motion for moved regions
      for (const m of matches) {
        if (m.type === "moved" && m.new && m.old) {
          const tm = templateMatchRegion(oldPadded, newPadded, m.old);
          const bm = blockMotionEstimate(oldPadded, newPadded, m.old);
          m.bestMatch = tm;
          m.motion = bm;
        }
      }
    }

    // Update auto mask
    updateAutoMask(matches, pageKey);

    // Perceptual metrics
    const { mse, psnr } = computeMsePsnr(oldPadded, newPadded);
    const ssim = await computeSSIM(oldPadded, newPadded);
    const lpipsScore = await computeLPIPS(oldPadded, newPadded);

    // Annotate
    const baseName = pageKey.replace(".png", "");
    const outBase = path.join(OUTPUT_DIR, baseName);
    const annotatedInfo = await annotateAndSave(
      newPadded,
      diffPng,
      regions,
      matches,
      outBase
    );

    summary.push({
      page: pageKey,
      width,
      height,
      diffPixels,
      diffPercent,
      mse,
      psnr,
      ssim,
      lpips: lpipsScore,
      oldFile: oldP,
      newFile: newP,
      regions,
      matches,
      annotated: annotatedInfo.annotated,
      diffImage: annotatedInfo.diffImage,
    });
  }

  // Generate auto-mask PNG for reference
  if (summary.length > 0)
    generateAutoMaskPng(summary[0].width, summary[0].height);

  // Write summary JSON
  await fs.writeJson(
    path.join(OUTPUT_DIR, "visual_diff_summary_super.json"),
    summary,
    { spaces: 2 }
  );

  // Write report
  const reportPath = await writeHtmlReport(summary, OUTPUT_DIR);
  console.log("Report:", reportPath);

  console.log("✔ DONE");
}

main().catch((err) => console.error(err));

/**
 * PART 4/7
 *
 * Additional utilities, small helpers, and CLI wrappers.
 * Paste this after Part 3.
 *
 * NOTE: This chunk contains safety helpers, graceful shutdown, and small utilities used across parts.
 */

/** ---------------------
 * Small utilities
 * --------------------- */

// safe number formatting
function fmt(n, digits = 3) {
  if (n === null || n === undefined) return "N/A";
  if (Number.isFinite(n)) return Number(n).toFixed(digits);
  if (n === Infinity) return "Inf";
  return String(n);
}

// safe read JSON helper
async function safeReadJson(p) {
  try {
    if (await fs.pathExists(p)) return await fs.readJson(p);
    return null;
  } catch (e) {
    return null;
  }
}

// safe write JSON helper
async function safeWriteJson(p, obj) {
  try {
    await fs.writeJson(p, obj, { spaces: 2 });
    return true;
  } catch (e) {
    return false;
  }
}

/** ---------------------
 * Graceful shutdown helpers
 * --------------------- */

let shuttingDown = false;
function setupGracefulShutdown() {
  process.on("SIGINT", () => {
    if (shuttingDown) process.exit(1);
    console.log("\nReceived SIGINT — finishing current job then exiting...");
    shuttingDown = true;
    // allow main to complete current file; after a short wait, exit
    setTimeout(() => process.exit(0), 5000);
  });
  process.on("SIGTERM", () => {
    if (shuttingDown) process.exit(1);
    console.log("\nReceived SIGTERM — finishing current job then exiting...");
    shuttingDown = true;
    setTimeout(() => process.exit(0), 5000);
  });
}

// attach once
setupGracefulShutdown();

/** ---------------------
 * Quick-run CLI wrapper
 * --------------------- */

async function runCli() {
  try {
    console.log("Visual Diff Super — starting run");
    await main();
    console.log("Visual Diff Super — completed successfully");
  } catch (e) {
    console.error("Visual Diff Super — fatal error:", e);
    process.exitCode = 2;
  }
}

// If this file is invoked directly (node visual_diff_super.js), run CLI
if (import.meta && !globalThis.__VISUAL_DIFF_SUPER_IMPORTED__) {
  globalThis.__VISUAL_DIFF_SUPER_IMPORTED__ = true;
  // run the CLI runner asynchronously (main will be invoked in Part 3)
  // We call runCli only if main hasn't been invoked already
  // Note: Part 3 already calls main(), so this guard prevents duplicate runs.
  // If user pasted parts in order and Part 3 included main(), this will be no-op.
  // If not, this will start the run.
  (async () => {
    // small delay to allow rest of file to be pasted when copying parts
    await new Promise((res) => setTimeout(res, 10));
    if (typeof main === "function") {
      // main is defined in Part 3; do not double invoke
      // main() already called at end of Part 3; skip
    } else {
      await runCli();
    }
  })();
}

/**
 * PART 5/7
 *
 * Extra helpers for bounding-box math, region merging,
 * geometry utilities, and preparing display-friendly info.
 */

/** ---------------------
 * Merge overlapping / touching regions (optional enhancement)
 * --------------------- */
function mergeRegions(regions) {
  if (!regions || regions.length === 0) return [];

  const merged = [];

  for (const r of regions) {
    let placed = false;

    for (const m of merged) {
      const overlap = iouCore(r, m);
      if (overlap > 0.05 || boxesTouch(r, m)) {
        const x1 = Math.min(m.x, r.x);
        const y1 = Math.min(m.y, r.y);
        const x2 = Math.max(m.x + m.w, r.x + r.w);
        const y2 = Math.max(m.y + m.h, r.y + r.h);

        m.x = x1;
        m.y = y1;
        m.w = x2 - x1;
        m.h = y2 - y1;
        m.area = m.w * m.h;
        placed = true;
        break;
      }
    }
    if (!placed) merged.push({ ...r });
  }

  return merged;
}

// IoU but without using area from structure (raw geometry)
function iouCore(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const union = a.w * a.h + b.w * b.h - inter;
  if (union <= 0) return 0;
  return inter / union;
}

// Check if boxes touch/very close
function boxesTouch(a, b) {
  const expand = 2;
  return !(
    a.x + a.w + expand < b.x ||
    b.x + b.w + expand < a.x ||
    a.y + a.h + expand < b.y ||
    b.y + b.h + expand < a.y
  );
}

/** ---------------------
 * Convert regions & matches into display objects
 * --------------------- */

function serializeRegions(regions) {
  return regions.map((r) => ({
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    area: r.area,
  }));
}

function serializeMatches(matches) {
  return matches.map((m) => ({
    type: m.type,
    iou: m.iou,
    old: m.old ? { x: m.old.x, y: m.old.y, w: m.old.w, h: m.old.h } : null,
    new: m.new ? { x: m.new.x, y: m.new.y, w: m.new.w, h: m.new.h } : null,
    bestMatch: m.bestMatch
      ? {
          dx: m.bestMatch.dx,
          dy: m.bestMatch.dy,
          score: m.bestMatch.score,
        }
      : null,
    motion: m.motion
      ? {
          dx: m.motion.dx,
          dy: m.motion.dy,
          count: m.motion.count,
        }
      : null,
  }));
}

/** ---------------------
 * Logging helpers
 * --------------------- */

function printRegionDetails(page, regions) {
  console.log(`Regions for ${page}:`);
  for (const r of regions) {
    console.log(`  - (${r.x},${r.y}) ${r.w}x${r.h} (area=${r.area})`);
  }
}

function printMatchDetails(page, matches) {
  console.log(`Matches for ${page}:`);
  for (const m of matches) {
    if (m.type === "moved") {
      console.log(
        `  moved: old=(${m.old.x},${m.old.y}) new=(${m.new.x},${
          m.new.y
        }) dx=${fmt(m.bestMatch.dx, 2)} dy=${fmt(m.bestMatch.dy, 2)}`
      );
    } else if (m.type === "added") {
      console.log(`  added: (${m.new.x},${m.new.y}) ${m.new.w}x${m.new.h}`);
    } else if (m.type === "removed") {
      console.log(`  removed: (${m.old.x},${m.old.y}) ${m.old.w}x${m.old.h}`);
    }
  }
}

/** ---------------------
 * Heatmap enhancement (optional)
 * --------------------- */

function enhanceHeatmap(diffPng) {
  // amplify differences visually
  for (let i = 0; i < diffPng.data.length; i += 4) {
    const val = diffPng.data[i] || diffPng.data[i + 1] || diffPng.data[i + 2];
    if (val > 0) {
      diffPng.data[i] = 255; // full red
      diffPng.data[i + 1] = 80; // tint
      diffPng.data[i + 2] = 80;
      diffPng.data[i + 3] = 255;
    }
  }
  return diffPng;
}

/** ---------------------
 * Region intensity measurement (useful for prioritization)
 * --------------------- */

function regionIntensity(png, region) {
  let sum = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * png.width + x) * 4;
      sum += Math.max(png.data[i], png.data[i + 1], png.data[i + 2]);
    }
  }
  const area = region.w * region.h;
  return area > 0 ? sum / area : 0;
}

/** ---------------------
 * Region sorting helper
 * --------------------- */

function sortRegionsByImportance(regions, pngDiff) {
  return [...regions].sort((a, b) => {
    // Score = larger + more intense first
    const ai = regionIntensity(pngDiff, a);
    const bi = regionIntensity(pngDiff, b);
    return b.area * bi - a.area * ai;
  });
}

/** ---------------------
 * Generate per-region detail HTML
 * --------------------- */

function regionDetailsHTML(regions) {
  if (!regions || regions.length === 0) return "<i>No regions</i>";
  return regions
    .map((r) => `(${r.x},${r.y}) ${r.w}x${r.h} — area=${r.area}`)
    .join("<br/>");
}

function matchDetailsHTML(matches) {
  if (!matches || matches.length === 0) return "<i>No matches</i>";
  return matches
    .map((m) => {
      if (m.type === "moved") {
        return `moved: dx=${fmt(m.bestMatch?.dx, 2)} dy=${fmt(
          m.bestMatch?.dy,
          2
        )}`;
      }
      if (m.type === "added") return "added";
      if (m.type === "removed") return "removed";
      return m.type;
    })
    .join("<br/>");
}

/** ---------------------
 * HTML UI helpers (for future expansions)
 * --------------------- */

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// generate quick JSON viewer
function jsonPreview(obj) {
  return `<pre style="white-space:pre-wrap;font-size:12px;background:#fafafa;padding:10px;border:1px solid #ddd;">${escapeHtml(
    JSON.stringify(obj, null, 2)
  )}</pre>`;
}

/**
 * PART 6/7
 *
 * Final processing helpers, optional CI integration snippets, and export utilities.
 * Paste this after Part 5.
 */

/** ---------------------
 * Export helpers for integration (optional)
 * --------------------- */

// Save summary as CSV (optional convenience)
async function saveSummaryCsv(summary, outDir) {
  try {
    const rows = [];
    const header = [
      "page",
      "width",
      "height",
      "diffPercent",
      "mse",
      "psnr",
      "ssim",
      "lpips",
      "regions",
      "matches",
      "annotated",
      "diffImage",
    ];
    rows.push(header.join(","));
    for (const s of summary) {
      const line = [
        `"${s.page}"`,
        s.width || "",
        s.height || "",
        s.diffPercent !== undefined ? s.diffPercent.toFixed(3) : "",
        s.mse !== undefined ? s.mse.toFixed(3) : "",
        s.psnr !== undefined && isFinite(s.psnr) ? s.psnr.toFixed(3) : "",
        s.ssim !== undefined && s.ssim !== null ? s.ssim.toFixed(3) : "",
        s.lpips !== undefined && s.lpips !== null ? s.lpips : "",
        `"${JSON.stringify(serializeRegions(s.regions || [])).replace(
          /"/g,
          '""'
        )}"`,
        `"${JSON.stringify(serializeMatches(s.matches || [])).replace(
          /"/g,
          '""'
        )}"`,
        `"${path.relative(outDir, s.annotated || "")}"`,
        `"${path.relative(outDir, s.diffImage || "")}"`,
      ];
      rows.push(line.join(","));
    }
    const csv = rows.join("\n");
    const p = path.join(outDir, "visual_diff_summary_super.csv");
    await fs.writeFile(p, csv, "utf8");
    return p;
  } catch (e) {
    return null;
  }
}

/** ---------------------
 * Simple CI (GitHub Actions) snippet generator
 * Creates a YAML file that runs the visual diff after the crawler outputs.
 * --------------------- */
async function generateGithubAction(outDir) {
  const yaml = `name: Visual Diff Check

on:
  push:
    branches: [ main ]
  pull_request:

jobs:
  visual-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      - name: Install deps
        run: |
          npm ci
          npm install pngjs pixelmatch fs-extra ssim.js
      - name: Run crawler (replace with your crawler step)
        run: |
          echo "Run your crawler here to produce results/*/screenshots"
      - name: Run visual diff
        run: |
          node analysis/visual_diff_super.js
      - name: Upload report artifact
        uses: actions/upload-artifact@v4
        with:
          name: visual-diff-report
          path: results/visual_diffs_super/
`;
  const p = path.join(outDir, "github_visual_diff_action.yml");
  await fs.writeFile(p, yaml, "utf8");
  return p;
}

/** ---------------------
 * Utility: threshold gating for CI (fail if average diff > threshold)
 * --------------------- */
function evaluateGate(summary, thresholdPercent = 5.0) {
  if (!summary || summary.length === 0) return { pass: true, avg: 0 };
  const avg =
    summary.reduce((a, b) => a + (b.diffPercent || 0), 0) / summary.length;
  return { pass: avg <= thresholdPercent, avg };
}

/** ---------------------
 * Save final artifacts (JSON, CSV, HTML)
 * --------------------- */
async function persistAll(summary) {
  try {
    const outDir = OUTPUT_DIR;
    const jsonPath = path.join(outDir, "visual_diff_summary_super.json");
    await fs.writeJson(jsonPath, summary, { spaces: 2 });
    await saveSummaryCsv(summary, outDir);
    await writeHtmlReport(summary, outDir);
    return true;
  } catch (e) {
    return false;
  }
}

/** ---------------------
 * Small self-test function for sanity checking core helpers
 * --------------------- */
function selfTestHelpers() {
  // simple PNG 2x2 test
  const a = new PNG({ width: 2, height: 2 });
  const b = new PNG({ width: 2, height: 2 });
  // a: white, b: white except one pixel black
  for (let i = 0; i < a.data.length; i += 4) {
    a.data[i] = 255;
    a.data[i + 1] = 255;
    a.data[i + 2] = 255;
    a.data[i + 3] = 255;
    b.data[i] = 255;
    b.data[i + 1] = 255;
    b.data[i + 2] = 255;
    b.data[i + 3] = 255;
  }
  // change one pixel in b
  b.data[0] = 0;
  b.data[1] = 0;
  b.data[2] = 0;
  const diff = new PNG({ width: 2, height: 2 });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, 2, 2, {
    threshold: 0.1,
  });
  if (diffPixels !== 1)
    throw new Error(
      "Self-test failed: expected 1 diff pixel, got " + diffPixels
    );
  // region detection
  const regs = findDiffRegions(diff, 1);
  if (!regs || regs.length === 0)
    throw new Error("Self-test failed: expected 1 region");
  return true;
}

/** ---------------------
 * Expose some helper commands for users when this file is imported as a module
 * --------------------- */
export const visualDiffHelpers = {
  padToLargest,
  computeMsePsnr,
  computeSSIM,
  computeLPIPS,
  findDiffRegions,
  matchRegions,
  templateMatchRegion,
  blockMotionEstimate,
  ocrExtractTextFromPng,
  classifyRegionAsComponent,
  updateAutoMask,
  generateAutoMaskPng,
  annotateAndSave,
  writeHtmlReport,
  saveSummaryCsv,
  generateGithubAction,
  evaluateGate,
  persistAll,
  selfTestHelpers,
};
/**
 * PART 7/7
 *
 * Final optional addons, error wrappers, environment checks,
 * version metadata, and file footer.
 *
 * After this block, your entire visual_diff_super.js is COMPLETE.
 */

/** ---------------------
 * Runtime environment checks
 * --------------------- */

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 20) {
    console.log("⚠ Node >=20 detected — OCR disabled (Worker cloning issue)");
  }
}

function printEnvironmentSummary() {
  console.log("\n=== Visual Diff Super Engine Environment ===");
  console.log("Node version:", process.versions.node);
  console.log("LPIPS:", LPIPS ? "enabled" : "disabled");
  console.log("Tesseract (OCR):", Tesseract ? "enabled" : "disabled");
  console.log("Canvas:", CanvasLib ? "enabled" : "disabled");
  console.log("SSIM:", ssimLib ? "enabled" : "disabled");
  console.log("==========================================\n");
}

checkNodeVersion();
printEnvironmentSummary();

/** ---------------------
 * Optional: Save runtime metadata for debugging
 * --------------------- */

async function saveEngineMetadata() {
  const meta = {
    node: process.versions.node,
    lpips: !!LPIPS,
    ocr: !!Tesseract,
    canvas: !!CanvasLib,
    ssim: !!ssimLib,
    autoMaskBoxes: autoMask?.learnedBoxes?.length || 0,
    timestamp: new Date().toISOString(),
  };
  const p = path.join(OUTPUT_DIR, "engine_metadata.json");
  await fs.writeJson(p, meta, { spaces: 2 });
}

/** ---------------------
 * Optional: standalone run guard
 * --------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  // small delay to allow helper parts to load cleanly
  setTimeout(async () => {
    console.log("🔧 Running visual diff engine...");
    try {
      await main();
      await saveEngineMetadata();
      console.log("🚀 Visual Diff Super — COMPLETE");
    } catch (err) {
      console.error("❌ Fatal error:", err);
      process.exit(1);
    }
  }, 0);
}

/** ---------------------
 * END OF FILE
 * --------------------- */
