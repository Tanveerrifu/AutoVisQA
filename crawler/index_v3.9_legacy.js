// /**
//  * 🚀 QA Website Crawler v3.8 (Readable Timestamp Folders)
//  * --------------------------------------------------------
//  * ✅ Folder names: 11-Nov-2025(5_27PM)
//  * ✅ Compatible with visual_diff.js + report generator
//  * ✅ Retains stable screenshot names for cross-run comparison
//  */

// import puppeteer from "puppeteer";
// import fs from "fs-extra";
// import path from "path";
// import { URL } from "url";

// // === Load Configuration ===
// const config = JSON.parse(await fs.readFile("config.json", "utf-8"));

// // === Helper: format date as 11-Nov-2025(5_27PM)
// function formatTimestampFolder() {
//   const now = new Date();

//   const months = [
//     "Jan",
//     "Feb",
//     "Mar",
//     "Apr",
//     "May",
//     "Jun",
//     "Jul",
//     "Aug",
//     "Sep",
//     "Oct",
//     "Nov",
//     "Dec",
//   ];

//   const day = String(now.getDate()).padStart(2, "0");
//   const month = months[now.getMonth()];
//   const year = now.getFullYear();

//   let hours = now.getHours();
//   const minutes = now.getMinutes().toString().padStart(2, "0");
//   const ampm = hours >= 12 ? "PM" : "AM";
//   hours = hours % 12 || 12;

//   // replace ":" with "_" because ":" isn’t valid in Windows folder names
//   return `${day}-${month}-${year}(${hours}_${minutes}${ampm})`;
// }

// // === Globals ===
// const visited = new Set();
// const results = [];

// // ✅ Folder structure: /results/11-Nov-2025(5_27PM)/
// const folderName = formatTimestampFolder();
// const baseDir = path.join(process.cwd(), config.outputDir, folderName);
// await fs.ensureDir(baseDir);

// const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// // === Crawl Logic ===
// async function crawlPage(browser, currentUrl, depth = 0) {
//   if (visited.has(currentUrl) || depth > config.maxDepth) return;
//   visited.add(currentUrl);

//   const page = await browser.newPage();
//   const startTime = Date.now();
//   console.log(`🌐 Visiting (depth ${depth}): ${currentUrl}`);

//   try {
//     // Retry logic
//     for (let attempt = 1; attempt <= 3; attempt++) {
//       try {
//         await page.goto(currentUrl, {
//           waitUntil: "domcontentloaded",
//           timeout: 120000,
//         });
//         break;
//       } catch (err) {
//         console.warn(
//           `⚠️ Attempt ${attempt} failed for ${currentUrl}: ${err.message}`
//         );
//         if (attempt === 3) throw err;
//         console.log("🔁 Retrying in 5 seconds...");
//         await wait(5000);
//       }
//     }

//     console.log(`⏳ Waiting ${config.waitTime / 1000}s for content load...`);
//     await wait(config.waitTime);

//     // === Consistent filename generation ===
//     const urlObj = new URL(currentUrl);
//     let pathname = urlObj.pathname.replace(/\/$/, "");
//     if (pathname === "" || pathname === "/") pathname = "/home";

//     let sanitizedPath = pathname
//       .replace(/\.(html|php|aspx)$/i, "")
//       .replace(/[\/:?<>|#=&]/g, "_")
//       .replace(/^_+|_+$/g, "");

//     const fileBase = sanitizedPath || "home";

//     // === Output folders ===
//     const pdfDir = path.join(baseDir, "pdfs");
//     const imgDir = path.join(baseDir, "screenshots");
//     await fs.ensureDir(pdfDir);
//     await fs.ensureDir(imgDir);

//     // === Save files ===
//     const pdfPath = path.join(pdfDir, `${fileBase}.pdf`);
//     const screenshotPath = path.join(imgDir, `${fileBase}.png`);
//     await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
//     await page.screenshot({ path: screenshotPath, fullPage: true });

//     const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
//     results.push({
//       url: currentUrl,
//       depth,
//       pdfPath,
//       screenshotPath,
//       timeTaken,
//       timestamp: new Date().toISOString(),
//     });

//     console.log(`✅ Saved PDF: ${pdfPath}`);
//     console.log(`🖼️ Screenshot: ${screenshotPath}`);

//     const links = await page.$$eval("a", (as) =>
//       as.map((a) => a.href).filter((href) => href.startsWith(location.origin))
//     );

//     for (const link of links) {
//       await crawlPage(browser, link, depth + 1);
//     }
//   } catch (error) {
//     console.error(`❌ Error at ${currentUrl}: ${error.message}`);
//     results.push({ url: currentUrl, error: error.message });
//   } finally {
//     await page.close();
//   }
// }

// // === Main Runner ===
// (async () => {
//   console.log("🚀 Starting QA Website Crawler...\n");

//   const browser = await puppeteer.launch({
//     headless: config.headless,
//     defaultViewport: { width: 1366, height: 768 },
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });

//   await crawlPage(browser, config.startUrl);
//   await browser.close();

//   const summaryPath = path.join(baseDir, "summary.json");
//   await fs.writeJson(summaryPath, results, { spaces: 2 });

//   console.log(`\n📊 Crawl Completed`);
//   console.log(`🧾 Total Pages Captured: ${results.length}`);
//   console.log(`📁 Summary Saved To: ${summaryPath}`);
// })();

// Screenshot limit

/**
 * 🚀 QA Website Crawler v3.9 (20 Screenshot Limit)
 * --------------------------------------------------------
 * ✅ Folder names: 11-Nov-2025(5_27PM)
 * ✅ Compatible with visual_diff.js + report generator
 * ✅ Retains stable screenshot names for cross-run comparison
 * ✅ Stops automatically after 20 screenshots
 */

import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";
import { URL } from "url";

// === Load Configuration ===
const config = JSON.parse(await fs.readFile("config.json", "utf-8"));
config.startUrl = process.env.START_URL || config.startUrl;
config.waitTime = Number(process.env.WAIT_TIME || config.waitTime);
config.maxDepth = Number(process.env.MAX_DEPTH || config.maxDepth);
const runLabel = process.env.RUN_LABEL || "";

// === Helper: format date as 11-Nov-2025(5_27PM)
function formatTimestampFolder() {
  const now = new Date();
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = String(now.getDate()).padStart(2, "0");
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${day}-${month}-${year}(${hours}_${minutes}${ampm})`;
}

function sanitizeFolderPart(value) {
  return value
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function uniqueFileBase(fileBase) {
  const count = usedFileBases.get(fileBase) || 0;
  usedFileBases.set(fileBase, count + 1);
  return count === 0 ? fileBase : `${fileBase}_${count + 1}`;
}

// === Globals ===
const visited = new Set();
const results = [];
const usedFileBases = new Map();
let screenshotCount = 0; // 🧮 Global counter
const screenshotLimit = 20; // 🔒 Limit set to 20

// ✅ Folder structure: /results/11-Nov-2025(5_27PM)/
const timestampFolder = formatTimestampFolder();
const folderName = runLabel
  ? `${sanitizeFolderPart(runLabel)}-${timestampFolder}`
  : timestampFolder;
const baseDir = path.join(process.cwd(), config.outputDir, folderName);
await fs.ensureDir(baseDir);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === Crawl Logic ===
async function crawlPage(browser, currentUrl, depth = 0) {
  // 🔒 Stop if screenshot limit reached
  if (screenshotCount >= screenshotLimit) {
    console.log(
      `🛑 Screenshot limit (${screenshotLimit}) reached. Stopping crawl.`
    );
    return;
  }

  if (visited.has(currentUrl) || depth > config.maxDepth) return;
  visited.add(currentUrl);

  const page = await browser.newPage();
  const startTime = Date.now();
  console.log(`🌐 Visiting (depth ${depth}): ${currentUrl}`);

  try {
    // Retry logic
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

    // === Consistent filename generation ===
    const urlObj = new URL(currentUrl);
    let pathname = `${urlObj.pathname}${urlObj.search}${urlObj.hash}`.replace(
      /\/$/,
      ""
    );
    if (pathname === "" || pathname === "/") pathname = "/home";

    let sanitizedPath = pathname
      .replace(/\.(html|php|aspx)$/i, "")
      .replace(/[\/:?<>|#=&.%]/g, "_")
      .replace(/^_+|_+$/g, "");

    const fileBase = uniqueFileBase(sanitizedPath || "home");

    // === Output folders ===
    const pdfDir = path.join(baseDir, "pdfs");
    const imgDir = path.join(baseDir, "screenshots");
    await fs.ensureDir(pdfDir);
    await fs.ensureDir(imgDir);

    // === Save files (only if limit not reached) ===
    if (screenshotCount < screenshotLimit) {
      const pdfPath = path.join(pdfDir, `${fileBase}.pdf`);
      const screenshotPath = path.join(imgDir, `${fileBase}.png`);

      await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshotCount++; // ✅ Increment counter

      const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
      results.push({
        url: currentUrl,
        depth,
        pdfPath,
        screenshotPath,
        timeTaken,
        timestamp: new Date().toISOString(),
      });

      console.log(
        `✅ [${screenshotCount}/${screenshotLimit}] Saved PDF: ${pdfPath}`
      );
      console.log(`🖼️ Screenshot: ${screenshotPath}`);
    }

    // 🔒 Stop further crawling if limit reached
    if (screenshotCount >= screenshotLimit) {
      console.log(
        `🛑 Screenshot limit (${screenshotLimit}) reached. Halting further navigation.`
      );
      return;
    }

    // === Extract internal links ===
    const links = await page.$$eval("a", (as) =>
      as.map((a) => a.href).filter((href) => href.startsWith(location.origin))
    );

    for (const link of links) {
      if (screenshotCount >= screenshotLimit) break;
      await crawlPage(browser, link, depth + 1);
    }
  } catch (error) {
    console.error(`❌ Error at ${currentUrl}: ${error.message}`);
    results.push({ url: currentUrl, error: error.message });
  } finally {
    try {
      await page.close();
    } catch (closeError) {
      console.warn(`⚠️ Could not close page cleanly: ${closeError.message}`);
    }
  }
}

// === Main Runner ===
(async () => {
  console.log("🚀 Starting QA Website Crawler (Limited Mode)...\n");

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1366, height: 768 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  await crawlPage(browser, config.startUrl);
  await browser.close();

  const summaryPath = path.join(baseDir, "summary.json");
  await fs.writeJson(summaryPath, results, { spaces: 2 });

  console.log(`\n📊 Crawl Completed`);
  console.log(`🧾 Total Pages Captured: ${results.length}`);
  console.log(`📁 Summary Saved To: ${summaryPath}`);
})();
