import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { extractPdfPages, extractPdfPagesInProcess, runPdfWorker } from "../src/pdf-source.js";

function makeTextPdf(text) {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("pinned PDF.js dependency extracts a real one-page PDF text layer", async () => {
  const result = await extractPdfPages(makeTextPdf("Exposure predicts outcome beta = 1.2, p < 0.001."));
  assert.equal(result.status, "text-layer-extracted");
  assert.equal(result.pageCount, 1);
  assert.match(result.pages[0].text, /Exposure predicts outcome/);
  assert.match(result.pages[0].text, /p < 0\.001/);
  assert.equal(result.isolation.process, "separate-node-child");
  assert.equal(result.isolation.wallClockTimeoutMs, 15_000);
  assert.equal(result.isolation.maxOldSpaceMb, 256);
  assert.equal(result.isolation.networkIsolation, "not-os-enforced");
});

test("PDF source extraction records page text and layout evidence hashes", async () => {
  let cleaned = false;
  let destroyed = false;
  const result = await extractPdfPagesInProcess(Buffer.from("%PDF-test"), {
    loadPdfjs: async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: [
                { str: "Exposure predicts outcome", transform: [1, 0, 0, 1, 72, 720], width: 140, height: 12 },
                { str: "(beta = 1.2, p < 0.001).", transform: [1, 0, 0, 1, 220, 720], width: 130, height: 12, hasEOL: true },
              ],
            }),
            cleanup: () => { cleaned = true; },
          }),
          destroy: async () => { destroyed = true; },
        }),
        destroy: async () => {},
      }),
    }),
  });
  assert.equal(result.status, "text-layer-extracted");
  assert.equal(result.pageCount, 1);
  assert.match(result.pages[0].textSha256, /^[a-f0-9]{64}$/);
  assert.match(result.pages[0].layoutBoxesSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.pages[0].textItemCount, 2);
  assert.match(result.pages[0].text, /Exposure predicts outcome/);
  assert.equal(cleaned, true);
  assert.equal(destroyed, true);
});

test("PDF source extraction labels an empty text layer as image-only or scanned", async () => {
  const result = await extractPdfPagesInProcess(Buffer.from("%PDF-test"), {
    loadPdfjs: async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({ items: [] }),
            cleanup: () => {},
          }),
          destroy: async () => {},
        }),
        destroy: async () => {},
      }),
    }),
  });
  assert.equal(result.status, "image-only-or-scanned");
  assert.equal(result.pages[0].hasExtractableText, false);
});

test("PDF source extraction rejects unreasonable page counts before reading pages", async () => {
  await assert.rejects(
    extractPdfPagesInProcess(Buffer.from("%PDF-test"), {
      loadPdfjs: async () => ({
        getDocument: () => ({
          promise: Promise.resolve({ numPages: 201, destroy: async () => {} }),
          destroy: async () => {},
        }),
      }),
    }),
    /page count must be between 1 and 200/i,
  );
});

test("PDF worker enforces a hard wall-clock timeout", async () => {
  await assert.rejects(
    runPdfWorker(Buffer.from("%PDF-test"), {
      timeoutMs: 50,
      workerPath: fileURLToPath(new URL("fixtures/pdf-worker-hang.js", import.meta.url)),
    }),
    /timed out after 50 ms/i,
  );
});
