/**
 * QA Website Crawler v4.0 (evidence-aware)
 * --------------------------------------------------------
 * Folder per session: results/<label>-30-Aug-2026(12_38PM)/{screenshots,pdfs,summary.json}
 *
 * Changes from v3.9 (kept as index_v3.9_legacy.js, used for the ICCIT 2026 pilot):
 *  - Pages are de-duplicated by NORMALIZED URL (fragment and tracking parameters
 *    removed), so /, /#top and /#site-map are captured once, not three times.
 *  - Filenames are stable across sessions AND unique: <path>__<8-char hash of the
 *    normalized URL>.png. Two different pages can no longer collide (F6).
 *  - The manifest records what the Evidence Validation Layer needs: normalized and
 *    final URL (redirects), session and page id, document.readyState, viewport,
 *    image width/height, file size and SHA-256.
 *  - screenshotLimit / savePdf / viewport come from config.json or env vars.
 */
import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";
import crypto from "crypto";
import { URL } from "url";

// === Configuration (config.json, overridable by env) ===
const config = JSON.parse(await fs.readFile("config.json", "utf-8"));
config.startUrl = process.env.START_URL || config.startUrl;
config.waitTime = Number(process.env.WAIT_TIME ?? config.waitTime ?? 30000);
config.maxDepth = Number(process.env.MAX_DEPTH ?? config.maxDepth ?? 3);
config.screenshotLimit = Number(process.env.SCREENSHOT_LIMIT ?? config.screenshotLimit ?? 20);
config.savePdf = String(process.env.SAVE_PDF ?? config.savePdf ?? "true") !== "false";
config.viewport = config.viewport || { width: 1366, height: 768 };
const runLabel = process.env.RUN_LABEL || "";

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

export function fileBaseFor(normUrl) {
  const u = new URL(normUrl);
  let p = `${u.pathname}${u.search}`.replace(/\/$/, "");
  if (p === "" || p === "/") p = "/home";
  const readable = p.replace(/\.(html?|php|aspx)$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "home";
  const hash = crypto.createHash("sha1").update(normUrl).digest("hex").slice(0, 8);
  return `${readable}__${hash}`;
}

function formatTimestampFolder(now = new Date()) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(now.getDate()).padStart(2, "0");
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${day}-${months[now.getMonth()]}-${now.getFullYear()}(${hours}_${minutes}${ampm})`;
}

const sanitizeFolderPart = (v) => v.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();

// PNG width/height live in the IHDR chunk at bytes 16..23.
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// === Session state ===
const sessionId = runLabel ? `${sanitizeFolderPart(runLabel)}-${formatTimestampFolder()}` : formatTimestampFolder();
const baseDir = path.join(process.cwd(), config.outputDir, sessionId);
const imgDir = path.join(baseDir, "screenshots");
const pdfDir = path.join(baseDir, "pdfs");
const visited = new Set();
const results = [];
let captured = 0;

async function crawlPage(browser, rawUrl, depth = 0) {
  if (captured >= config.screenshotLimit || depth > config.maxDepth) return;
  let normUrl;
  try { normUrl = normalizeUrl(rawUrl); } catch { return; }
  if (visited.has(normUrl)) return;
  visited.add(normUrl);

  const page = await browser.newPage();
  const start = Date.now();
  console.log(`Visiting (depth ${depth}): ${rawUrl}`);
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
        break;
      } catch (err) {
        console.warn(`  attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw err;
        await wait(5000);
      }
    }
    await wait(config.waitTime);

    const fileBase = fileBaseFor(normUrl);
    const screenshotPath = path.join(imgDir, `${fileBase}.png`);
    const buf = await page.screenshot({ path: screenshotPath, fullPage: true });
    let pdfPath = null;
    if (config.savePdf) {
      pdfPath = path.join(pdfDir, `${fileBase}.pdf`);
      await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    }
    const readyState = await page.evaluate(() => document.readyState).catch(() => null);
    const finalUrl = page.url();
    captured++;
    const { width, height } = pngSize(buf);
    results.push({
      url: rawUrl,
      normalizedUrl: normUrl,
      finalUrl,
      redirected: normalizeUrl(finalUrl) !== normUrl,
      sessionId,
      pageId: captured,
      depth,
      screenshotPath,
      pdfPath,
      timeTaken: ((Date.now() - start) / 1000).toFixed(2),
      timestamp: new Date().toISOString(),
      readyState,
      viewport: config.viewport,
      width,
      height,
      fileSize: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    });
    console.log(`  [${captured}/${config.screenshotLimit}] ${fileBase}.png  ${width}x${height}`);
    if (captured >= config.screenshotLimit) return;

    const links = await page.$$eval("a", (as) => as.map((a) => a.href).filter((h) => h.startsWith(location.origin)));
    for (const link of links) {
      if (captured >= config.screenshotLimit) break;
      await crawlPage(browser, link, depth + 1);
    }
  } catch (error) {
    console.error(`  error at ${rawUrl}: ${error.message}`);
    results.push({ url: rawUrl, normalizedUrl: normUrl, sessionId, error: error.message, timestamp: new Date().toISOString() });
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  await fs.ensureDir(imgDir);
  if (config.savePdf) await fs.ensureDir(pdfDir);
  console.log(`Starting crawl of ${config.startUrl} -> ${baseDir}\n`);
  const browser = await puppeteer.launch({
    headless: config.headless ?? true,
    defaultViewport: config.viewport,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    await crawlPage(browser, config.startUrl);
  } finally {
    await browser.close();
  }
  const summaryPath = path.join(baseDir, "summary.json");
  await fs.writeJson(summaryPath, results, { spaces: 2 });
  console.log(`\nCaptured ${captured} pages. Manifest: ${summaryPath}`);
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
