import { createRequire } from "node:module";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./utils.js";

const require = createRequire(import.meta.url);
const pdfjsPackageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const standardFontDataUrl = `${path.join(pdfjsPackageRoot, "standard_fonts")}/`;
const MAX_PDF_PAGES = 200;
const MAX_PAGE_TEXT_ITEMS = 100_000;
const MAX_TOTAL_TEXT_CHARACTERS = 5_000_000;
export const PDF_WORKER_TIMEOUT_MS = 15_000;
export const PDF_WORKER_MAX_RESULT_BYTES = 8 * 1024 * 1024;
const PDF_WORKER_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const defaultWorkerPath = fileURLToPath(new URL("./pdf-worker.js", import.meta.url));

function joinTextItems(items) {
  let text = "";
  for (const item of items) {
    if (typeof item?.str !== "string" || item.str.length === 0) continue;
    if (text && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.trim();
}

export async function extractPdfPagesInProcess(bytes, {
  loadPdfjs = () => import("pdfjs-dist/legacy/build/pdf.mjs"),
} = {}) {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    standardFontDataUrl,
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF page count must be between 1 and ${MAX_PDF_PAGES}`);
    }
    const pages = [];
    let totalTextCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      if (content.items.length > MAX_PAGE_TEXT_ITEMS) {
        throw new Error(`PDF page ${pageNumber} exceeded the text-item limit`);
      }
      const textItems = content.items.filter((item) => typeof item?.str === "string" && item.str.length > 0);
      const text = joinTextItems(textItems);
      totalTextCharacters += text.length;
      if (totalTextCharacters > MAX_TOTAL_TEXT_CHARACTERS) {
        throw new Error("PDF text layer exceeded the total character limit");
      }
      const boxes = textItems.map((item) => ({
        text: item.str,
        x: Number.isFinite(item.transform?.[4]) ? item.transform[4] : null,
        y: Number.isFinite(item.transform?.[5]) ? item.transform[5] : null,
        width: Number.isFinite(item.width) ? item.width : null,
        height: Number.isFinite(item.height) ? item.height : null,
      }));
      pages.push({
        pageNumber,
        text,
        textSha256: sha256(text),
        textItemCount: textItems.length,
        layoutBoxesSha256: sha256(JSON.stringify(boxes)),
        hasExtractableText: text.length > 0,
      });
      page.cleanup();
    }
    return {
      parser: "pdfjs-dist",
      status: pages.some((page) => page.hasExtractableText) ? "text-layer-extracted" : "image-only-or-scanned",
      pageCount: document.numPages,
      pages,
    };
  } finally {
    if (document) await document.destroy?.();
    else await loadingTask.destroy?.();
  }
}

function minimalWorkerEnvironment() {
  const env = {
    PATH: process.env.PATH || "",
    NODE_ENV: "production",
  };
  for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

export function runPdfWorker(bytes, {
  signal,
  timeoutMs = PDF_WORKER_TIMEOUT_MS,
  workerPath = defaultWorkerPath,
  forkImpl = fork,
} = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("PDF worker input must be a Buffer");
  if (signal?.aborted) return Promise.reject(new Error("PDF parsing was aborted"));
  return new Promise((resolve, reject) => {
    const child = forkImpl(workerPath, [], {
      execArgv: ["--max-old-space-size=256"],
      env: minimalWorkerEnvironment(),
      windowsHide: true,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let settled = false;
    let diagnostics = "";
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners();
      child.stderr?.removeAllListeners();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(new Error("PDF parsing was aborted"));
    const timer = setTimeout(
      () => finish(new Error(`PDF parser worker timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => {
      if (Buffer.byteLength(diagnostics) >= PDF_WORKER_MAX_DIAGNOSTIC_BYTES) return;
      diagnostics += chunk.toString("utf8").slice(0, PDF_WORKER_MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(diagnostics));
    });
    child.once("error", (error) => finish(new Error(`PDF parser worker failed: ${error.message}`)));
    child.once("exit", (code, workerSignal) => {
      if (!settled) finish(new Error(
        `PDF parser worker exited before returning a result (code ${code}, signal ${workerSignal || "none"})${diagnostics ? `: ${diagnostics.trim()}` : ""}`,
      ));
    });
    child.on("message", (message) => {
      if (message?.type === "error") {
        finish(new Error(`PDF parser worker rejected the document: ${message.error || "unknown error"}`));
        return;
      }
      if (message?.type !== "result") return;
      const resultBytes = Buffer.byteLength(JSON.stringify(message.result));
      if (resultBytes > PDF_WORKER_MAX_RESULT_BYTES) {
        finish(new Error("PDF parser worker result exceeded the output limit"));
        return;
      }
      finish(null, { ...message.result, isolation: {
        process: "separate-node-child",
        wallClockTimeoutMs: timeoutMs,
        maxOldSpaceMb: 256,
        maxResultBytes: PDF_WORKER_MAX_RESULT_BYTES,
        networkIsolation: "not-os-enforced",
      } });
    });
    child.send({ type: "parse", bytes }, (error) => {
      if (error) finish(new Error(`PDF parser worker IPC failed: ${error.message}`));
    });
  });
}

export async function extractPdfPages(bytes, options = {}) {
  return runPdfWorker(bytes, options);
}
