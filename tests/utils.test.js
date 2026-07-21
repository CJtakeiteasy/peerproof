import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { redactAuditValue, redactExecutionText } from "../src/utils.js";

test("execution text redacts host paths and API keys", () => {
  const projectRoot = path.resolve("C:/Users/reviewer/peerproof");
  const runDirectory = path.join(projectRoot, ".peerproof", "runs", "audit_123");
  const text = `${runDirectory}\\repo\\analysis.js\nfile:///C:/Users/reviewer/peerproof/server.js\nsk-test_secret_123456`;
  const redacted = redactExecutionText(text, { projectRoot, runDirectory });
  assert.match(redacted, /<audit-workspace>/);
  assert.match(redacted, /<peerproof-root>/);
  assert.match(redacted, /<redacted-api-key>/);
  assert.doesNotMatch(redacted, /Users[\\/]reviewer/);
});

test("nested public ledger values are redacted recursively", () => {
  const projectRoot = path.resolve("C:/deploy/peerproof");
  const value = {
    execution: { stderr: `${projectRoot}\\.peerproof\\runs\\audit_x\\analysis.js` },
    timeline: [{ detail: `OPENAI_API_KEY=sk-secret_12345678` }],
  };
  const redacted = redactAuditValue(value, { projectRoot, runDirectory: path.join(projectRoot, ".peerproof", "runs", "audit_x") });
  assert.doesNotMatch(JSON.stringify(redacted), /C:[\\/]deploy/);
  assert.doesNotMatch(JSON.stringify(redacted), /sk-secret/);
});

test("Windows file URLs with literal spaces are redacted on every host OS", () => {
  const projectRoot = "C:/Users/reviewer/path with spaces/peerproof";
  const redacted = redactExecutionText(
    "file:///C:/Users/reviewer/path with spaces/peerproof/server.js",
    { projectRoot },
  );
  assert.equal(redacted, "<peerproof-root>/server.js");
});

test("Windows file URLs with percent-encoded spaces are redacted on every host OS", () => {
  const projectRoot = "C:/Users/reviewer/path with spaces/peerproof";
  const redacted = redactExecutionText(
    "file:///C:/Users/reviewer/path%20with%20spaces/peerproof/server.js",
    { projectRoot },
  );
  assert.equal(redacted, "<peerproof-root>/server.js");
});

test("Windows file URLs are recovered from a Linux-resolved Windows root", () => {
  const projectRoot = "/home/runner/work/peerproof/C:/Users/reviewer/path with spaces/peerproof";
  const text = [
    "file:///C:/Users/reviewer/path with spaces/peerproof/server.js",
    "file:///C:/Users/reviewer/path%20with%20spaces/peerproof/server.js",
  ].join("\n");
  const redacted = redactExecutionText(text, { projectRoot });
  assert.equal(redacted, "<peerproof-root>/server.js\n<peerproof-root>/server.js");
});
