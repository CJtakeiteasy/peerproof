import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  AuditConcurrencyGate,
  AuditStore,
  DailyAiBudget,
  ExtractionRateLimiter,
  auditGate,
  decodeBase64Strict,
  resolveDemoAiOptions,
  server,
  streamAudit,
} from "../server.js";
import { VERSION } from "../src/version.js";

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("health endpoint reports configuration without claiming a live audit", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.equal(health.ok, true);
  assert.equal(health.version, VERSION);
  assert.equal(health.applicationCommitProvenance.value, health.applicationCommit);
  assert.match(health.applicationCommitProvenance.source, /^(git-repository|git-archive-substitution|configured-environment)$/);
  assert.equal(health.applicationCommitProvenance.formatValid, true);
  assert.equal(health.applicationCommitProvenance.cryptographicallyVerified, false);
  assert.equal(health.applicationAdmission.status, "exact-match");
  assert.match(health.applicationAdmission.buildManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(health.applicationAdmission.verifierFilesMatched, true);
  assert.equal(health.applicationAdmission.assetClosure.allRegisteredAssetsGoverned, true);
  assert.equal(health.applicationAdmission.assetClosure.policyInventoryExact, true);
  assert.equal(health.applicationAdmission.signatureStatus, "unsigned-version-controlled-manifest");
  assert.equal(typeof health.requireLiveGpt, "boolean");
  assert.equal(typeof health.requireLiveCodex, "boolean");
  assert.equal(typeof health.liveRecordingReady, "boolean");
  assert.equal(typeof health.aiRuntimeConfigured, "boolean");
  assert.equal(typeof health.publicLiveAuditsEnabled, "boolean");
  assert.equal(health.publicLiveAuditsRequireJudgeToken, true);
  assert.equal(typeof health.globalAiBudgetRemaining, "number");
  assert.equal(health.capabilities.arbitraryRepositoryExecution, false);
  assert.equal(health.capabilities.auditedCodeIsolation, "reviewed-fixture-host-process");
  assert.equal(health.capabilities.executionPolicyProfiles[0].id, "peerproof.node-script.v1");
  assert.equal(health.capabilities.trustedExecutionCases.length, 2);
  assert.ok(health.capabilities.trustedExecutionCases.every((entry) => /^[a-f0-9]{64}$/.test(entry.bundleSha256)));
  assert.ok(health.capabilities.trustedExecutionCases.every(
    (entry) => entry.repositoryContentHashMode === "utf8-lf-normalized-or-binary-raw-sha256",
  ));
  assert.ok(health.capabilities.trustedExecutionCases.every((entry) => entry.signed === false));
  assert.ok(health.capabilities.trustedExecutionCases.every(
    (entry) => entry.signatureVerification === "unsupported",
  ));
  assert.ok(health.capabilities.trustedExecutionCases.every(
    (entry) => entry.origin.type === "project-authored-synthetic-fixture",
  ));
  assert.equal(health.capabilities.publicEvidenceCases.length, 1);
  assert.equal(health.capabilities.publicEvidenceCases[0].id, "peerproof.datasaurus-dozen.v1");
  assert.equal(health.capabilities.publicEvidenceCases[0].fileCount, 8);
  assert.equal(health.capabilities.publicEvidenceCases[0].signed, false);
  assert.equal(health.capabilities.publicEvidenceCases[0].signatureVerification, "unsupported");
  assert.equal(health.capabilities.verifierContracts.length, 2);
  assert.equal(health.capabilities.verifierContracts[0].id, "peerproof.simple-univariate-ols.v3");
  assert.equal(health.capabilities.verifierContracts[0].runtimeId, "peerproof.verifier-runtime.simple-ols.v1");
  assert.match(health.capabilities.pdfAnchoring, /bounded-child-process/);
  assert.equal(health.capabilities.reviewedCaseAdmission, "versioned-exact-content-policy-bundles");
  assert.equal(
    health.capabilities.applicationBuildAdmission,
    "trusted-runtime-transitive-closure-drift-detection-with-post-load-continuity",
  );
  assert.equal(health.capabilities.signedLedgerExports, false);
  assert.equal("liveAudit" in health, false);
});

test("web responses set browser isolation and embedding headers", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test("HTTP demo audit is stored and retrievable", async () => {
  const createdResponse = await fetch(`${baseUrl}/api/audits/demo`, { method: "POST" });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);
  assert.equal(created.verdict.label, "Fragile");
  assert.equal(created.investigation.repositoryResolution.resolvedBy, "Reviewed fixture");
  assert.equal(created.investigation.repositoryResolution.currentRunModelCall, false);
  assert.equal(created.dataDependencyCheck.confirmed, true);
  const fetchedResponse = await fetch(`${baseUrl}/api/audits/${created.id}`);
  const fetched = await fetchedResponse.json();
  assert.equal(fetchedResponse.status, 200);
  assert.equal(fetched.id, created.id);
  assert.deepEqual(fetched.runWorkflow.approval.approvedPlan, fetched.runWorkflow.proposal.plan);
});

test("SSE demo exposes server-generated timeline and completion events", async () => {
  const response = await fetch(`${baseUrl}/api/audits/demo/stream`, { method: "POST" });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(body, /event: audit-start/);
  assert.match(body, /event: timeline/);
  assert.match(body, /event: audit-complete/);
  assert.match(body, /"label":"Fragile"/);
  assert.doesNotMatch(body, /event: audit-error/);
});

test("claim extraction endpoint enforces token, content type, Base64, and PDF signature", async () => {
  const previousToken = process.env.PEERPROOF_JUDGE_TOKEN;
  process.env.PEERPROOF_JUDGE_TOKEN = "judge-secret";
  try {
    const unauthorized = await fetch(`${baseUrl}/api/claims/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unauthorized.status, 401);

    const wrongType = await fetch(`${baseUrl}/api/claims/extract`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-PeerProof-Token": "judge-secret" },
      body: "paper",
    });
    assert.equal(wrongType.status, 415);

    const invalidBase64 = await fetch(`${baseUrl}/api/claims/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PeerProof-Token": "judge-secret" },
      body: JSON.stringify({ paper: { name: "paper.pdf", mimeType: "application/pdf", base64: "%%%=" } }),
    });
    assert.equal(invalidBase64.status, 400);

    const fakePdf = await fetch(`${baseUrl}/api/claims/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PeerProof-Token": "judge-secret" },
      body: JSON.stringify({ paper: { name: "paper.pdf", mimeType: "application/pdf", base64: Buffer.from("not a pdf").toString("base64") } }),
    });
    assert.equal(fakePdf.status, 400);
  } finally {
    if (previousToken === undefined) delete process.env.PEERPROOF_JUDGE_TOKEN;
    else process.env.PEERPROOF_JUDGE_TOKEN = previousToken;
  }
});

test("strict Base64 decoder rejects alternate or malformed encodings", () => {
  assert.deepEqual(decodeBase64Strict(Buffer.from("paper").toString("base64")), Buffer.from("paper"));
  assert.throws(() => decodeBase64Strict("cGFwZXI"), /canonical Base64/);
  assert.throws(() => decodeBase64Strict("%%%="), /invalid characters/);
});

test("audit store is TTL-bound and evicts the least recently used entry", () => {
  const evicted = [];
  const store = new AuditStore({ max: 2, ttlMs: 100, onEvict: (id) => evicted.push(id) });
  store.set({ id: "a" }, 0);
  store.set({ id: "b" }, 1);
  assert.equal(store.get("a", 2).id, "a");
  store.set({ id: "c" }, 3);
  assert.equal(store.get("b", 4), null);
  assert.deepEqual(evicted, ["b"]);
  assert.equal(store.get("a", 101), null);
  assert.deepEqual(evicted, ["b", "a"]);
});

test("extraction rate limiter enforces minute and day budgets", () => {
  const limiter = new ExtractionRateLimiter({ minuteLimit: 2, dayLimit: 3 });
  assert.equal(limiter.consume("ip", 1).allowed, true);
  assert.equal(limiter.consume("ip", 2).allowed, true);
  assert.equal(limiter.consume("ip", 3).allowed, false);
  assert.equal(limiter.consume("ip", 60_001).allowed, true);
  assert.equal(limiter.consume("ip", 120_001).allowed, false);
});

test("rate limiter evicts stale and least-recent clients to cap memory", () => {
  const day = 86_400_000;
  const limiter = new ExtractionRateLimiter({ minuteLimit: 3, dayLimit: 20, maxClients: 2 });
  limiter.consume("stale", 0);
  limiter.consume("recent", day * 3);
  limiter.consume("new", day * 3 + 1);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.clients.has("stale"), false);
  limiter.consume("newest", day * 3 + 2);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.clients.has("recent"), false);
});

test("audit concurrency gate releases capacity exactly once", () => {
  const gate = new AuditConcurrencyGate({ maxConcurrent: 1 });
  const release = gate.acquire();
  assert.equal(typeof release, "function");
  assert.equal(gate.acquire(), null);
  release();
  release();
  assert.equal(gate.active, 0);
  assert.equal(typeof gate.acquire(), "function");
});

test("global AI budget enforces a daily call ceiling", () => {
  const budget = new DailyAiBudget({ dailyLimit: 3 });
  assert.deepEqual(budget.consume(2, 1), { allowed: true, remaining: 1 });
  assert.equal(budget.consume(2, 2).allowed, false);
  assert.deepEqual(budget.consume(1, 3), { allowed: true, remaining: 0 });
  assert.equal(budget.consume(1, 86_400_001).allowed, true);
  assert.throws(() => budget.consume(0), /positive integer/i);
});

test("public demo stays offline unless both the live flag and judge token authorize model spend", () => {
  const names = ["PEERPROOF_PUBLIC_LIVE_AUDITS", "PEERPROOF_JUDGE_TOKEN", "OPENAI_API_KEY", "PEERPROOF_USE_CODEX"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PEERPROOF_PUBLIC_LIVE_AUDITS = "true";
    process.env.PEERPROOF_JUDGE_TOKEN = "judge-secret";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.PEERPROOF_USE_CODEX = "false";
    const budget = new DailyAiBudget({ dailyLimit: 2 });
    const offline = resolveDemoAiOptions({ headers: {} }, { budget });
    assert.equal(offline.liveAuthorized, false);
    assert.equal(offline.extractionOptions.apiKey, null);
    assert.equal(budget.used, 0);
    const live = resolveDemoAiOptions({ headers: { "x-peerproof-token": "judge-secret" } }, { budget });
    assert.equal(live.liveAuthorized, true);
    assert.equal(live.expectedAiCalls, 1);
    assert.equal(budget.used, 1);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("audit endpoints enforce the shared concurrency cap", async () => {
  const releases = [];
  for (let index = 0; index < auditGate.maxConcurrent; index += 1) releases.push(auditGate.acquire());
  try {
    const response = await fetch(`${baseUrl}/api/audits/real-world`, { method: "POST" });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.match(payload.error, /capacity/i);
    assert.equal(response.headers.get("retry-after"), "5");
  } finally {
    releases.forEach((release) => release());
  }
});

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

test("SSE emits heartbeats while work is pending", async () => {
  const response = new FakeSseResponse();
  await streamAudit(new EventEmitter(), response, {
    expectedEvents: 1,
    command: "test",
    heartbeatMs: 5,
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 18));
      return { id: "heartbeat_test", status: "completed" };
    },
  });
  assert.match(response.chunks.join(""), /: heartbeat/);
  assert.match(response.chunks.join(""), /event: audit-complete/);
});

test("SSE client disconnect aborts ongoing audit work", async () => {
  const response = new FakeSseResponse();
  let aborted = false;
  const streaming = streamAudit(new EventEmitter(), response, {
    expectedEvents: 1,
    command: "test",
    heartbeatMs: 5,
    run: async (_onEvent, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  response.emit("close");
  await streaming;
  assert.equal(aborted, true);
  assert.doesNotMatch(response.chunks.join(""), /event: audit-error/);
});
