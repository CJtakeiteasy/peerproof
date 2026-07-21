import assert from "node:assert/strict";
import test from "node:test";
import { inferMimeType } from "../public/file-utils.js";

test("empty browser MIME is inferred from Markdown extension", () => {
  assert.equal(inferMimeType({ name: "paper.md", type: "" }), "text/markdown");
  assert.equal(inferMimeType({ name: "paper.markdown", type: "" }), "text/markdown");
});

test("empty browser MIME is inferred from text extension", () => {
  assert.equal(inferMimeType({ name: "paper.txt", type: "" }), "text/plain");
});
