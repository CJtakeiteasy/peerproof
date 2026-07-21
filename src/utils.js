import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactExecutionText(value, { runDirectory, projectRoot } = {}) {
  if (value === null || value === undefined) return value;
  let redacted = String(value);
  const roots = [
    [runDirectory, "<audit-workspace>"],
    [projectRoot, "<peerproof-root>"],
  ];
  for (const [root, replacement] of roots) {
    if (!root) continue;
    const candidates = new Set([
      String(root),
      path.resolve(String(root)),
    ]);
    const variants = new Set();
    for (const candidate of candidates) {
      const slash = candidate.replaceAll("\\", "/");
      const backslash = candidate.replaceAll("/", "\\");
      variants.add(candidate);
      variants.add(slash);
      variants.add(backslash);

      if (slash.startsWith("/")) {
        const fileUrl = `file://${slash}`;
        variants.add(fileUrl);
        variants.add(encodeURI(fileUrl));
      }

      const windowsAbsolute = slash.match(/(?:^|\/)([A-Za-z]:\/.*)$/)?.[1];
      if (windowsAbsolute) {
        const fileUrl = `file:///${windowsAbsolute}`;
        variants.add(windowsAbsolute);
        variants.add(windowsAbsolute.replaceAll("/", "\\"));
        variants.add(fileUrl);
        variants.add(encodeURI(fileUrl));
      }
    }
    for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
      redacted = redacted.replace(new RegExp(escapeRegExp(variant), "gi"), replacement);
    }
  }
  return redacted
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "<redacted-api-key>")
    .replace(/((?:OPENAI|CODEX)_API_KEY\s*[=:]\s*)[^\s"']+/gi, "$1<redacted-api-key>");
}

export function redactAuditValue(value, options) {
  if (typeof value === "string") return redactExecutionText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactAuditValue(item, options)]),
    );
  }
  return value;
}

export function safeJsonParse(value) {
  const trimmed = String(value).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object found in response");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function createRunId() {
  return `audit_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function assertSafeRelativePath(candidate) {
  const normalized = path.posix.normalize(String(candidate).replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe repository path: ${candidate}`);
  }
  return normalized;
}

export function nowIso() {
  return new Date().toISOString();
}

export function timelineEvent(stage, status, title, detail, extra = {}) {
  return {
    id: randomUUID(),
    stage,
    status,
    title,
    detail,
    timestamp: nowIso(),
    ...extra,
  };
}
