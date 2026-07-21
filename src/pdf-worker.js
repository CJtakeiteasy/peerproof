import { extractPdfPagesInProcess, PDF_WORKER_MAX_RESULT_BYTES } from "./pdf-source.js";

let handled = false;
process.once("message", async (message) => {
  if (handled || message?.type !== "parse") return;
  handled = true;
  try {
    const bytes = Buffer.isBuffer(message.bytes) ? message.bytes : Buffer.from(message.bytes);
    const result = await extractPdfPagesInProcess(bytes);
    if (Buffer.byteLength(JSON.stringify(result)) > PDF_WORKER_MAX_RESULT_BYTES) {
      throw new Error("parser result exceeded the output limit");
    }
    process.send?.({ type: "result", result }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({ type: "error", error: error.message }, () => process.disconnect?.());
  }
});
