/**
 * Visual Regression Diff Back-end v5 (evidence-aware)
 * ---------------------------------------------------------------
 * Fixes the two defects found in the ICCIT 2026 study of v4 (visual_diff.js):
 *   1. Session pair must be given explicitly (no "two most recent folders" guess).
 *   2. Pages are matched by normalized URL from the manifests (fallback: exact
 *      filename). No suffix stripping, so about_2.png can never replace about.png.
 * Every record stores the SHA-256 of both screenshots, their sizes and the session
 * names, so the Evidence Validation Layer (python -m evl) can detect a record that
 * describes different files exactly (F8H), not only when D_reported > D_raw (F8).
 *
 * Usage:
 *   node visual_diff_v5.js --ref <session-folder> --cur <session-folder> [--out <label>]
 *                          [--results ../results] [--threshold 0.1] [--no-aa]
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const SESSION_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "_ga", "sessionid", "sid", "ts", "cachebust"]);

export function normalizeUrl(raw) {
  const u = new URL(raw.trim());
  u.hash = "";
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !SESSION_PARAMS.has(k.toLowerCase()))
    .sort(([a, x], [b, y]) => (a + "=" + x).localeCompare(b + "=" + y));
  u.search = new URLSearchParams(kept).toString();
  let p = u.pathname || "/";
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${p}${u.search}`;
}

function parseArgs(argv) {
  const a = { results: "../results", threshold: 0.1, includeAA: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--ref") a.ref = argv[++i];
    else if (k === "--cur") a.cur = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--results") a.results = argv[++i];
    else if (k === "--threshold") a.threshold = Number(argv[++i]);
    else if (k === "--no-aa") a.includeAA = false;
    else if (k === "-h" || k === "--help") a.help = true;
  }
  return a;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function cropTo(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const s = y * img.width * 4;
    img.data.copy(out.data, y * width * 4, s, s + width * 4);
  }
  return out;
}

/** Map normalizedUrl -> screenshot filename, from summary.json (or the folder). */
export function pageMap(sessionDir) {
  const shotDir = path.join(sessionDir, "screenshots");
  const files = new Set(fs.readdirSync(shotDir).filter((f) => f.toLowerCase().endsWith(".png")));
  const manifest = path.join(sessionDir, "summary.json");
  const map = new Map();
  if (fs.existsSync(manifest)) {
    const entries = JSON.parse(fs.readFileSync(manifest, "utf8")).filter((e) => !e.error);
    const counts = new Map();
    for (const e of entries) {
      const f = path.basename(String(e.screenshotPath).replace(/\\/g, "/"));
      counts.set(f, (counts.get(f) || 0) + 1);
    }
    for (const e of entries) {
      const f = path.basename(String(e.screenshotPath).replace(/\\/g, "/"));
      if (!files.has(f)) continue;
      const key = e.normalizedUrl || normalizeUrl(e.url);
      map.set(key, { file: f, url: e.url, shared: counts.get(f) > 1 });
    }
  } else {
    for (const f of files) map.set(f, { file: f, url: null, shared: false });
  }
  return map;
}

export function comparePair(refPath, curPath, { threshold = 0.1, includeAA = true } = {}) {
  const ba = fs.readFileSync(refPath), bb = fs.readFileSync(curPath);
  let A = PNG.sync.read(ba), B = PNG.sync.read(bb);
  const width = Math.min(A.width, B.width), height = Math.min(A.height, B.height);
  const cropped = A.width !== B.width || A.height !== B.height;
  const refSize = [A.width, A.height], curSize = [B.width, B.height];
  A = cropTo(A, width, height); B = cropTo(B, width, height);
  const diffPixels = pixelmatch(A.data, B.data, null, width, height, { threshold, includeAA });
  return {
    diffPixels, totalPixels: width * height,
    diffPercent: Number(((diffPixels / (width * height)) * 100).toFixed(4)),
    width, height, cropped, refSize, curSize,
    refSha256: sha256(ba), curSha256: sha256(bb),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.ref || !a.cur) {
    console.log("Usage: node visual_diff_v5.js --ref <session> --cur <session> [--out <label>] [--results ../results]");
    process.exit(a.help ? 0 : 2);
  }
  const refDir = path.resolve(a.results, a.ref), curDir = path.resolve(a.results, a.cur);
  for (const d of [refDir, curDir]) {
    if (!fs.existsSync(path.join(d, "screenshots"))) {
      console.error(`No screenshots/ folder in ${d}`);
      process.exit(2);
    }
  }
  const outDir = path.resolve(a.results, "visual_diffs_v5", a.out || `${path.basename(refDir)}__${path.basename(curDir)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const refMap = pageMap(refDir), curMap = pageMap(curDir);
  const records = [];
  const skipped = [];
  for (const [key, r] of refMap) {
    const c = curMap.get(key);
    if (!c) { skipped.push({ normalizedUrl: key, reason: "missing in current session (F7)" }); continue; }
    try {
      const res = comparePair(path.join(refDir, "screenshots", r.file), path.join(curDir, "screenshots", c.file),
        { threshold: a.threshold, includeAA: a.includeAA });
      records.push({
        normalizedUrl: key, page: c.file, refFile: r.file, curFile: c.file,
        refSession: path.basename(refDir), curSession: path.basename(curDir),
        filenameShared: r.shared || c.shared, ...res,
        tool: { name: "visual_diff_v5", pixelmatch: "5.x", threshold: a.threshold, includeAA: a.includeAA },
        createdAt: new Date().toISOString(),
      });
      console.log(`${res.diffPercent.toFixed(3).padStart(8)}%  ${key}${res.cropped ? "  (cropped)" : ""}`);
    } catch (err) {
      skipped.push({ normalizedUrl: key, reason: `unreadable (F1): ${err.message}` });
    }
  }
  for (const key of curMap.keys()) if (!refMap.has(key)) skipped.push({ normalizedUrl: key, reason: "missing in reference session (F7)" });

  const summaryPath = path.join(outDir, "visual_diff_summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(records, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped.json"), JSON.stringify(skipped, null, 2));
  console.log(`\n${records.length} records -> ${summaryPath}  (${skipped.length} skipped)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
