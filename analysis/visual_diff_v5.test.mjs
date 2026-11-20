// Run: node --test analysis/visual_diff_v5.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { normalizeUrl, pageMap, comparePair } from "./visual_diff_v5.js";

function png(file, w, h, dark = 0) {
  const p = new PNG({ width: w, height: h });
  p.data.fill(240);
  for (let i = 0; i < dark; i++) p.data.writeUInt32BE(0x000000ff, i * 4);
  fs.writeFileSync(file, PNG.sync.write(p));
}

test("normalizeUrl drops fragment, trailing slash and tracking params", () => {
  assert.equal(normalizeUrl("https://Ex.org/a/#top"), "https://ex.org/a");
  assert.equal(normalizeUrl("https://ex.org/a?utm_source=x&b=2"), "https://ex.org/a?b=2");
});

test("pageMap never merges about.png and about_2.png", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vd5-"));
  fs.mkdirSync(path.join(d, "screenshots"));
  png(path.join(d, "screenshots", "about.png"), 4, 4);
  png(path.join(d, "screenshots", "about_2.png"), 4, 4, 3);
  fs.writeFileSync(path.join(d, "summary.json"), JSON.stringify([
    { url: "https://ex.org/about", screenshotPath: "x/about.png" },
    { url: "https://ex.org/other", screenshotPath: "x/about_2.png" },
  ]));
  const m = pageMap(d);
  assert.equal(m.get("https://ex.org/about").file, "about.png");
  assert.equal(m.get("https://ex.org/other").file, "about_2.png");
});

test("comparePair crops, counts, and records content hashes", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vd5-"));
  png(path.join(d, "a.png"), 10, 10);
  png(path.join(d, "b.png"), 10, 12, 5);
  const r = comparePair(path.join(d, "a.png"), path.join(d, "b.png"));
  assert.equal(r.diffPixels, 5);
  assert.equal(r.cropped, true);
  assert.equal(r.refSha256.length, 64);
  assert.notEqual(r.refSha256, r.curSha256);
});
