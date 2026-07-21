const MIME_BY_EXTENSION = new Map([
  [".pdf", "application/pdf"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
]);

function inferMimeType(file) {
  const declared = String(file?.type || "").trim().toLowerCase();
  if (declared) return declared;
  const name = String(file?.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return MIME_BY_EXTENSION.get(dot >= 0 ? name.slice(dot) : "") || "application/octet-stream";
}

export { inferMimeType };
