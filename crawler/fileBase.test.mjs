// Run: node --test crawler/fileBase.test.mjs  (does not launch a browser)
import test from "node:test";
import assert from "node:assert/strict";
process.argv[1] = "test"; // keep index.js from starting a crawl
const { normalizeUrl, fileBaseFor } = await import("./index.js");

test("fragment URLs are the same page", () => {
  assert.equal(normalizeUrl("https://www.python.org/#top"), normalizeUrl("https://www.python.org/"));
});

test("filenames are unique per page and stable across runs", () => {
  const a = fileBaseFor(normalizeUrl("https://ex.org/w/index.php?title=A"));
  const b = fileBaseFor(normalizeUrl("https://ex.org/w/index.php?title=B"));
  assert.notEqual(a, b);
  assert.equal(a, fileBaseFor(normalizeUrl("https://ex.org/w/index.php?title=A")));
});
