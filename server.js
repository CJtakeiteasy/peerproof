import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitApplicationBuild,
  assertApplicationAdmissionContinuity,
} from "./src/build-integrity.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
// Audit and model runtimes are deliberately loaded only after the governed
// application surface matches the reviewed build manifest.
const startupApplicationAdmission = await admitApplicationBuild(projectRoot);
const [
  { extractClaimsWithGpt },
  { runSampleAudit },
  { runRealWorldAudit },
  { resolveApplicationCommitProvenance },
  { redactExecutionText },
  { VERSION },
  { listExecutionPolicyProfiles, listTrustedPolicyCases },
  { listPublicEvidenceBundles },
  { listVerifierContracts },
] = await Promise.all([
  import("./src/claim-extractor.js"),
  import("./src/audit-engine.js"),
  import("./src/real-world-case.js"),
  import("./src/build-info.js"),
  import("./src/utils.js"),
  import("./src/version.js"),
  import("./src/policy-registry.js"),
  import("./src/public-evidence-bundle.js"),
  import("./src/verifier-registry.js"),
]);
assertApplicationAdmissionContinuity(
  startupApplicationAdmission,
  await admitApplicationBuild(projectRoot),
);
const publicRoot = path.join(projectRoot, "public");
const runsRoot = path.join(projectRoot, ".peerproof", "runs");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const AUDIT_TTL_MS = Number(process.env.PEERPROOF_AUDIT_TTL_MS || 60 * 60 * 1000);
const MAX_MEMORY_AUDITS = Number(process.env.PEERPROOF_MAX_MEMORY_AUDITS || 20);
const HEARTBEAT_MS = Number(process.env.PEERPROOF_SSE_HEARTBEAT_MS || 12_000);
const MAX_PAPER_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 21 * 1024 * 1024;
const securityHeaders = Object.freeze({
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
});

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

class AuditStore {
  constructor({ max = 20, ttlMs = 60 * 60 * 1000, onEvict = () => {} } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.onEvict = onEvict;
    this.map = new Map();
  }

  set(audit, now = Date.now()) {
    this.cleanup(now);
    this.map.delete(audit.id);
    this.map.set(audit.id, { audit, expiresAt: now + this.ttlMs });
    while (this.map.size > this.max) {
      const oldestId = this.map.keys().next().value;
      this.map.delete(oldestId);
      this.onEvict(oldestId);
    }
  }

  get(id, now = Date.now()) {
    const entry = this.map.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.map.delete(id);
      this.onEvict(id);
      return null;
    }
    // A successful read makes this the most recently used entry.
    this.map.delete(id);
    this.map.set(id, entry);
    return entry.audit;
  }

  cleanup(now = Date.now()) {
    for (const [id, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(id);
        this.onEvict(id);
      }
    }
  }

  get size() {
    return this.map.size;
  }
}

class ExtractionRateLimiter {
  constructor({ minuteLimit = 3, dayLimit = 20, maxClients = 5_000 } = {}) {
    this.minuteLimit = minuteLimit;
    this.dayLimit = dayLimit;
    this.maxClients = maxClients;
    this.clients = new Map();
  }

  cleanup(now = Date.now()) {
    const day = Math.floor(now / 86_400_000);
    for (const [key, current] of this.clients) {
      if (current.day < day - 1) this.clients.delete(key);
    }
  }

  consume(key, now = Date.now()) {
    const minute = Math.floor(now / 60_000);
    const day = Math.floor(now / 86_400_000);
    if (!this.clients.has(key) && this.clients.size >= this.maxClients) {
      this.cleanup(now);
      while (this.clients.size >= this.maxClients) {
        this.clients.delete(this.clients.keys().next().value);
      }
    }
    const current = this.clients.get(key) || { minute, minuteCount: 0, day, dayCount: 0 };
    if (current.minute !== minute) {
      current.minute = minute;
      current.minuteCount = 0;
    }
    if (current.day !== day) {
      current.day = day;
      current.dayCount = 0;
    }
    if (current.minuteCount >= this.minuteLimit || current.dayCount >= this.dayLimit) {
      return { allowed: false, retryAfter: current.minuteCount >= this.minuteLimit ? 60 - Math.floor((now % 60_000) / 1000) : 86_400 };
    }
    current.minuteCount += 1;
    current.dayCount += 1;
    this.clients.delete(key);
    this.clients.set(key, current);
    return { allowed: true, remainingMinute: this.minuteLimit - current.minuteCount, remainingDay: this.dayLimit - current.dayCount };
  }

  get size() {
    return this.clients.size;
  }
}

class AuditConcurrencyGate {
  constructor({ maxConcurrent = 2 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  acquire() {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

class DailyAiBudget {
  constructor({ dailyLimit = 50 } = {}) {
    this.dailyLimit = Number.isInteger(dailyLimit) && dailyLimit > 0 ? dailyLimit : 50;
    this.day = null;
    this.used = 0;
  }

  consume(units = 1, now = Date.now()) {
    const day = Math.floor(now / 86_400_000);
    if (this.day !== day) {
      this.day = day;
      this.used = 0;
    }
    if (!Number.isInteger(units) || units < 1) throw new Error("AI budget units must be a positive integer");
    if (this.used + units > this.dailyLimit) {
      return { allowed: false, remaining: this.dailyLimit - this.used, retryAfter: 86_400 };
    }
    this.used += units;
    return { allowed: true, remaining: this.dailyLimit - this.used };
  }
}

function removeRunDirectory(auditId) {
  if (!/^audit_[a-f0-9]{12}$/.test(auditId)) return;
  void rm(path.join(runsRoot, auditId), { recursive: true, force: true }).catch(() => {});
}

const audits = new AuditStore({ max: MAX_MEMORY_AUDITS, ttlMs: AUDIT_TTL_MS, onEvict: removeRunDirectory });
const extractionLimiter = new ExtractionRateLimiter({
  minuteLimit: Number(process.env.PEERPROOF_EXTRACT_PER_MINUTE || 3),
  dayLimit: Number(process.env.PEERPROOF_EXTRACT_PER_DAY || 20),
});
const auditLimiter = new ExtractionRateLimiter({
  minuteLimit: Number(process.env.PEERPROOF_AUDIT_PER_MINUTE || 8),
  dayLimit: Number(process.env.PEERPROOF_AUDIT_PER_DAY || 100),
});
const auditGate = new AuditConcurrencyGate({
  maxConcurrent: Number(process.env.PEERPROOF_MAX_CONCURRENT_AUDITS || 2),
});
const globalAiBudget = new DailyAiBudget({
  dailyLimit: Number(process.env.PEERPROOF_GLOBAL_AI_DAILY_LIMIT || 50),
});

function json(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...securityHeaders,
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request, limitBytes = MAX_JSON_BODY_BYTES) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > limitBytes) throw httpError(413, "Request body exceeds the 21 MB JSON transport limit");
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw httpError(413, "Request body exceeds the 21 MB JSON transport limit");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body is not valid JSON");
  }
}

function beginSse(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    ...securityHeaders,
  });
  response.flushHeaders?.();
}

function sendSse(response, event, value) {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function streamAudit(request, response, { expectedEvents, command, run, heartbeatMs = HEARTBEAT_MS }) {
  const controller = new AbortController();
  const abortOnDisconnect = () => {
    if (!response.writableEnded) controller.abort(new Error("SSE client disconnected"));
  };
  response.once("close", abortOnDisconnect);
  beginSse(response);
  sendSse(response, "audit-start", { expectedEvents, command });
  const heartbeat = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    const audit = await run((event) => sendSse(response, "timeline", event), controller.signal);
    if (!controller.signal.aborted) {
      audits.set(audit);
      sendSse(response, "audit-complete", audit);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error);
      sendSse(response, "audit-error", {
        auditStatus: "system-error",
        error: redactExecutionText(error.message || "Audit failed", { projectRoot }),
      });
    }
  } finally {
    clearInterval(heartbeat);
    response.off("close", abortOnDisconnect);
    if (!response.writableEnded) response.end();
  }
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""));
  const rightBytes = Buffer.from(String(right || ""));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function resolveDemoAiOptions(request, { budget = globalAiBudget } = {}) {
  const offline = {
    liveAuthorized: false,
    extractionOptions: { apiKey: null, requireLive: false },
    investigationOptions: { enabled: false, requireLive: false },
  };
  if (process.env.PEERPROOF_PUBLIC_LIVE_AUDITS !== "true") return offline;
  const judgeToken = process.env.PEERPROOF_JUDGE_TOKEN;
  if (!judgeToken || !safeEqual(request.headers["x-peerproof-token"], judgeToken)) return offline;
  const gptCalls = process.env.OPENAI_API_KEY ? 1 : 0;
  const codexCalls = process.env.PEERPROOF_USE_CODEX === "true"
    && (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) ? 1 : 0;
  const expectedCalls = gptCalls + codexCalls;
  if (!expectedCalls) return offline;
  const admission = budget.consume(expectedCalls);
  if (!admission.allowed) throw httpError(429, "Global live-AI daily budget exhausted");
  return {
    liveAuthorized: true,
    expectedAiCalls: expectedCalls,
    remainingAiCalls: admission.remaining,
    extractionOptions: {},
    investigationOptions: {},
  };
}

function clientKey(request) {
  if (process.env.PEERPROOF_TRUST_PROXY === "true") {
    return String(request.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

function admitAudit(request, response) {
  const rate = auditLimiter.consume(clientKey(request));
  if (!rate.allowed) {
    json(response, 429, { error: "Audit rate limit exceeded" }, { "Retry-After": String(rate.retryAfter) });
    return null;
  }
  const release = auditGate.acquire();
  if (!release) {
    json(response, 503, { error: "Audit capacity is busy; retry shortly" }, { "Retry-After": "5" });
    return null;
  }
  return release;
}

function decodeBase64Strict(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw httpError(400, "paper.base64 is not valid canonical Base64");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw httpError(400, "paper.base64 contains invalid characters");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw httpError(400, "paper.base64 is not canonical Base64");
  return bytes;
}

function validatePaperInput(paper, bytes) {
  const extension = path.extname(path.basename(paper.name)).toLowerCase();
  const mimeType = paper.mimeType || "application/octet-stream";
  const allowed = (extension === ".pdf" && mimeType === "application/pdf")
    || ([".md", ".markdown"].includes(extension) && ["text/markdown", "text/plain"].includes(mimeType))
    || (extension === ".txt" && mimeType === "text/plain");
  if (!allowed) throw httpError(415, "Only PDF, Markdown, and plain-text papers with matching MIME types are allowed");
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw httpError(400, "PDF content does not have a valid PDF signature");
  }
}

async function serveStatic(response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    json(response, 400, { error: "Invalid encoded path" });
    return;
  }
  if (decoded.includes("\0")) {
    json(response, 400, { error: "Invalid path" });
    return;
  }
  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  const normalized = path.normalize(relative);
  const filePath = path.resolve(publicRoot, normalized);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    json(response, 400, { error: "Invalid path" });
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      ...securityHeaders,
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found" });
  }
}

async function cleanupStaleRunDirectories(now = Date.now()) {
  try {
    const entries = await readdir(runsRoot, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const target = path.join(runsRoot, entry.name);
      const details = await stat(target);
      if (now - details.mtimeMs > AUDIT_TTL_MS) await rm(target, { recursive: true, force: true });
    }));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Run cleanup failed", error);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      const gptConfigured = Boolean(process.env.OPENAI_API_KEY);
      const codexConfigured = process.env.PEERPROOF_USE_CODEX === "true" && Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
      const applicationCommitProvenance = resolveApplicationCommitProvenance(projectRoot);
      json(response, 200, {
        ok: true,
        version: VERSION,
        applicationCommit: applicationCommitProvenance.value,
        applicationCommitProvenance,
        applicationAdmission: {
          status: startupApplicationAdmission.status,
          manifestFile: startupApplicationAdmission.manifestFile,
          buildManifestSha256: startupApplicationAdmission.buildManifestSha256,
          fileCount: startupApplicationAdmission.fileCount,
          verifierFilesMatched: startupApplicationAdmission.verifierFilesMatched,
          signatureStatus: startupApplicationAdmission.signatureStatus,
          assetClosure: startupApplicationAdmission.assetClosure,
        },
        aiRuntimeConfigured: gptConfigured || codexConfigured,
        gptConfigured,
        codexConfigured,
        requireLiveGpt: process.env.PEERPROOF_REQUIRE_LIVE_GPT === "true",
        requireLiveCodex: process.env.PEERPROOF_REQUIRE_LIVE_CODEX === "true",
        liveRecordingReady: gptConfigured && codexConfigured
          && process.env.PEERPROOF_REQUIRE_LIVE_GPT === "true"
          && process.env.PEERPROOF_REQUIRE_LIVE_CODEX === "true",
        claimModelConfigured: process.env.OPENAI_MODEL || "gpt-5.6",
        codexModelConfigured: process.env.CODEX_MODEL || "gpt-5.6",
        publicLiveAuditsEnabled: process.env.PEERPROOF_PUBLIC_LIVE_AUDITS === "true",
        publicLiveAuditsRequireJudgeToken: true,
        globalAiDailyLimit: globalAiBudget.dailyLimit,
        globalAiBudgetRemaining: Math.max(0, globalAiBudget.dailyLimit - globalAiBudget.used),
        demoReady: process.env.PEERPROOF_ALLOW_TRUSTED_DEMO_EXECUTION !== "false",
        publicCaseReady: true,
        capabilities: {
          arbitraryRepositoryExecution: false,
          auditedCodeIsolation: "reviewed-fixture-host-process",
          executionPolicyProfiles: listExecutionPolicyProfiles(),
          trustedExecutionCases: listTrustedPolicyCases(),
          publicEvidenceCases: listPublicEvidenceBundles(),
          verifierContracts: listVerifierContracts(),
          pdfAnchoring: "bounded-child-process-page-text-layer; OCR-unavailable; OS-network-isolation-unavailable",
          reviewedCaseAdmission: "versioned-exact-content-policy-bundles",
          applicationBuildAdmission: "trusted-runtime-transitive-closure-drift-detection-with-post-load-continuity",
          auditStorage: "single-process-memory-index-with-local-TTL-artifacts",
          signedLedgerExports: false,
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "public, max-age=86400", ...securityHeaders });
      response.end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/audits/demo") {
      if (process.env.PEERPROOF_ALLOW_TRUSTED_DEMO_EXECUTION === "false") {
        json(response, 403, { error: "Trusted fixture execution is disabled" });
        return;
      }
      const release = admitAudit(request, response);
      if (!release) return;
      try {
        const aiOptions = resolveDemoAiOptions(request);
        const audit = await runSampleAudit(projectRoot, {
          ...aiOptions,
          expectedApplicationAdmission: startupApplicationAdmission,
        });
        audits.set(audit);
        json(response, 200, audit);
      } finally {
        release();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/audits/demo/stream") {
      if (process.env.PEERPROOF_ALLOW_TRUSTED_DEMO_EXECUTION === "false") {
        json(response, 403, { error: "Trusted fixture execution is disabled" });
        return;
      }
      const release = admitAudit(request, response);
      if (!release) return;
      try {
        const aiOptions = resolveDemoAiOptions(request);
        await streamAudit(request, response, {
          expectedEvents: 18,
          command: "$ peerproof audit samples/fragile-study",
          run: (onEvent, signal) => runSampleAudit(projectRoot, {
            ...aiOptions,
            onEvent,
            signal,
            expectedApplicationAdmission: startupApplicationAdmission,
          }),
        });
      } finally {
        release();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/audits/real-world") {
      const release = admitAudit(request, response);
      if (!release) return;
      try {
        const audit = await runRealWorldAudit(projectRoot, {
          expectedApplicationAdmission: startupApplicationAdmission,
        });
        audits.set(audit);
        json(response, 200, audit);
      } finally {
        release();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/audits/real-world/stream") {
      const release = admitAudit(request, response);
      if (!release) return;
      try {
        await streamAudit(request, response, {
          expectedEvents: 8,
          command: "$ peerproof verify samples/datasaurus-dozen --scope independent",
          run: (onEvent, signal) => runRealWorldAudit(projectRoot, {
            onEvent,
            signal,
            expectedApplicationAdmission: startupApplicationAdmission,
          }),
        });
      } finally {
        release();
      }
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/audits/")) {
      const auditId = url.pathname.split("/").at(-1);
      const audit = audits.get(auditId);
      if (!audit) {
        json(response, 404, { error: "Audit not found or expired" });
        return;
      }
      json(response, 200, audit);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/claims/extract") {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw httpError(415, "Content-Type must be application/json");
      }
      const requiredToken = process.env.PEERPROOF_JUDGE_TOKEN;
      if (requiredToken && !safeEqual(request.headers["x-peerproof-token"], requiredToken)) {
        throw httpError(401, "A valid judge demo token is required");
      }
      const rate = extractionLimiter.consume(clientKey(request));
      if (!rate.allowed) {
        json(response, 429, { error: "Claim extraction rate limit exceeded" }, { "Retry-After": String(rate.retryAfter) });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.paper?.name || !body.paper?.base64) throw httpError(400, "paper.name and paper.base64 are required");
      if (body.paper.base64.length > Math.ceil(MAX_PAPER_BYTES / 3) * 4) {
        throw httpError(413, "Paper exceeds the 15 MB input limit");
      }
      const bytes = decodeBase64Strict(body.paper.base64);
      if (bytes.length > MAX_PAPER_BYTES) throw httpError(413, "Paper exceeds the 15 MB input limit");
      validatePaperInput(body.paper, bytes);
      if (!process.env.OPENAI_API_KEY) throw httpError(503, "Live paper extraction is not configured");
      const budget = globalAiBudget.consume(1);
      if (!budget.allowed) throw httpError(429, "Global live-AI daily budget exhausted");
      const controller = new AbortController();
      const abortOnDisconnect = () => {
        if (!response.writableEnded) controller.abort(new Error("Upload client disconnected"));
      };
      response.once("close", abortOnDisconnect);
      try {
        const result = await extractClaimsWithGpt({
          filename: body.paper.name,
          mimeType: body.paper.mimeType,
          bytes,
          signal: controller.signal,
        });
        json(response, 200, result);
      } finally {
        response.off("close", abortOnDisconnect);
      }
      return;
    }

    if (request.method === "GET") {
      await serveStatic(response, url.pathname);
      return;
    }
    json(response, 405, { error: "Method not allowed" });
  } catch (error) {
    if (!error.statusCode) console.error(error);
    if (!response.headersSent) {
      json(response, error.statusCode || 500, {
        auditStatus: error.statusCode ? undefined : "system-error",
        error: redactExecutionText(error.message || "Internal server error", { projectRoot }),
        hint: process.env.NODE_ENV === "production" ? undefined : "Check the server terminal for details.",
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
});

const cleanupTimer = setInterval(() => {
  audits.cleanup();
  void cleanupStaleRunDirectories();
}, Math.min(AUDIT_TTL_MS, 15 * 60 * 1000));
cleanupTimer.unref?.();
void cleanupStaleRunDirectories();

function startServer() {
  return server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const gptConfigured = Boolean(process.env.OPENAI_API_KEY);
    const codexConfigured = process.env.PEERPROOF_USE_CODEX === "true"
      && Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
    console.log(`PeerProof is running at http://${displayHost}:${port} (bound to ${host})`);
    console.log(gptConfigured || codexConfigured
      ? `AI runtime configured. Claim model: ${process.env.OPENAI_MODEL || "gpt-5.6"}; Codex model: ${process.env.CODEX_MODEL || "gpt-5.6"}.`
      : "Credential-free demo mode. Set OPENAI_API_KEY for live evidence extraction.");
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export {
  AuditConcurrencyGate,
  AuditStore,
  DailyAiBudget,
  ExtractionRateLimiter,
  auditGate,
  audits,
  decodeBase64Strict,
  globalAiBudget,
  readJsonBody,
  resolveDemoAiOptions,
  server,
  startServer,
  streamAudit,
};
