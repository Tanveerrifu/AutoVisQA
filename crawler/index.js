/**
 * 🚀 QA Website Crawler v3.6 (Research-Ready)
 * --------------------------------------------
 * ✅ Crawls all internal pages
 * ✅ Saves both PDF + Screenshot per page
 * ✅ Organizes by date inside /results/YYYY-MM-DD/
 * ✅ Uses consistent filenames (for visual diff)
 * ✅ Fully compatible with analysis & visual regression tools
 */

import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";
import { URL } from "url";

// === Load Configuration ===
const config = JSON.parse(await fs.readFile("config.json", "utf-8"));

// === Globals ===
const visited = new Set();
const results = [];
const today = new Date().toISOString().split("T")[0];

// ✅ Save results in ../results/YYYY-MM-DD/
const baseDir = path.join(process.cwd(), config.outputDir, today);
await fs.ensureDir(baseDir);

// === Helper: Wait ===
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === Crawl Logic ===
async function crawlPage(browser, currentUrl, depth = 0) {
  if (visited.has(currentUrl) || depth > config.maxDepth) return;
  visited.add(currentUrl);

  const page = await browser.newPage();
  const startTime = Date.now();
  console.log(`🌐 Visiting (depth ${depth}): ${currentUrl}`);

  try {
    // === Robust load with retries ===
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        });
        break;
      } catch (err) {
        console.warn(
          `⚠️ Attempt ${attempt} failed for ${currentUrl}: ${err.message}`
        );
        if (attempt === 3) throw err;
        console.log("🔁 Retrying in 5 seconds...");
        await wait(5000);
      }
    }

    console.log(`⏳ Waiting ${config.waitTime / 1000}s for content load...`);
    await wait(config.waitTime);

    // === Consistent Filenames ===
    const urlObj = new URL(currentUrl);
    let pathname = urlObj.pathname.replace(/\/$/, ""); // remove trailing slash
    if (pathname === "" || pathname === "/") pathname = "/home";

    let sanitizedPath = pathname
      .replace(/\.(html|php|aspx)$/i, "") // remove extensions
      .replace(/[\/:?<>|#=&]/g, "_") // replace invalid chars
      .replace(/^_+|_+$/g, ""); // trim underscores

    const fileBase = sanitizedPath || "home";

    // === Ensure output directories ===
    const pdfDir = path.join(baseDir, "pdfs");
    const imgDir = path.join(baseDir, "screenshots");
    await fs.ensureDir(pdfDir);
    await fs.ensureDir(imgDir);

    // === Save PDF ===
    const pdfPath = path.join(pdfDir, `${fileBase}.pdf`);
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });

    // === Save Screenshot ===
    const screenshotPath = path.join(imgDir, `${fileBase}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // ✅ Verify file saved
    const exists = await fs.pathExists(screenshotPath);
    console.log(
      exists
        ? `🖼️ Screenshot saved: ${screenshotPath}`
        : `⚠️ Screenshot failed: ${screenshotPath}`
    );

    // === Record metadata ===
    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    results.push({
      url: currentUrl,
      depth,
      pdfPath,
      screenshotPath,
      timeTaken,
      timestamp: new Date().toISOString(),
    });

    // === Extract internal links ===
    const links = await page.$$eval("a", (as) =>
      as.map((a) => a.href).filter((href) => href.startsWith(location.origin))
    );

    for (const link of links) {
      await crawlPage(browser, link, depth + 1);
    }
  } catch (error) {
    console.error(`❌ Error at ${currentUrl}: ${error.message}`);
    results.push({ url: currentUrl, error: error.message });
  } finally {
    await page.close();
  }
}

// === Main Runner ===
(async () => {
  console.log("🚀 Starting QA Website Crawler...\n");

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1366, height: 768 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  await crawlPage(browser, config.startUrl);
  await browser.close();

  // === Save summary ===
  const summaryPath = path.join(baseDir, "summary.json");
  await fs.writeJson(summaryPath, results, { spaces: 2 });

  console.log(`\n📊 Crawl Completed`);
  console.log(`🧾 Total Pages Captured: ${results.length}`);
  console.log(`📁 Summary Saved To: ${summaryPath}`);
})();
