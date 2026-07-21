import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSampleAudit } from "../src/audit-engine.js";
import { attachVerificationPolicy } from "../src/verification-policy.js";
import { fallbackInvestigation, sampleClaim } from "../src/sample-case.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeInvestigation(overrides = {}) {
  const investigation = structuredClone(fallbackInvestigation);
  Object.assign(investigation, overrides);
  if (overrides.proposedRepair) {
    investigation.proposedRepair = {
      ...structuredClone(fallbackInvestigation.proposedRepair),
      ...overrides.proposedRepair,
    };
  }
  return investigation;
}

function fakeCodexOptions(investigation) {
  class FakeCodex {
    startThread() {
      return {
        id: "thread_unverifiable_test",
        run: async () => ({ finalResponse: JSON.stringify(investigation) }),
      };
    }
  }
  return { enabled: true, loadSdk: async () => ({ Codex: FakeCodex }) };
}

function executorResult(approval, overrides) {
  return {
    status: "failed",
    command: "node analysis.js",
    approvedPlan: structuredClone(approval.approvedPlan),
    exitCode: 1,
    stdout: "",
    stderr: "execution failed",
    ...overrides,
  };
}

function assertCompletedUnverifiable(audit, blockingStage) {
  assert.equal(audit.status, "completed");
  assert.equal(audit.auditStatus, "completed");
  assert.equal(audit.verdict.label, "Unverifiable");
  assert.equal(audit.verdict.blockingStage, blockingStage);
  assert.equal(audit.timeline.at(-1).stage, "verdict");
  assert.equal(audit.timeline.at(-1).status, "completed");
}

test("analytical or unapproved investigator patch becomes a completed Unverifiable ledger", async () => {
  const investigation = fakeInvestigation({
    proposedRepair: {
      classificationAdvisory: "infrastructure",
      newText: "const significanceThreshold = 0.5;",
    },
  });
  const audit = await runSampleAudit(projectRoot, {
    investigationOptions: fakeCodexOptions(investigation),
  });
  assertCompletedUnverifiable(audit, "patch-policy");
  assert.equal(audit.repairWorkflow.classification.status, "rejected");
  assert.equal(audit.patch.file, null);
});

test("unsupported structured claim becomes a completed Unverifiable ledger", async () => {
  const unsupportedClaim = attachVerificationPolicy({
    id: "claim_survival",
    text: "The intervention improved survival.",
    source: { pageLabel: "PDF p. 8", section: "Results", paragraph: null, quote: "Survival improved." },
    evidence: {
      ...structuredClone(sampleClaim.evidence),
      testFamily: "survival",
      effectType: "hazard_ratio",
      statisticalTest: "Cox proportional hazards model",
    },
  });
  const audit = await runSampleAudit(projectRoot, {
    extractionOptions: {
      apiKey: "test-key",
      extractor: async () => ({
        mode: "live",
        model: "gpt-5.6-test",
        responseId: "resp_test_unsupported",
        promptVersion: "test.prompt",
        schemaVersion: "test.schema",
        displayLabel: "GPT-5.6 · structured extraction",
        disclosure: "Test extraction.",
        claims: [unsupportedClaim],
        noClaimsReason: null,
      }),
    },
  });
  assertCompletedUnverifiable(audit, "verification-policy");
  assert.equal(audit.investigation.mode, "not-run");
  assert.equal(audit.claim.verification, null);
});

test("successful process without stdout JSON becomes a completed Unverifiable ledger", async () => {
  let attempt = 0;
  const executor = async (_directory, approval) => {
    attempt += 1;
    return attempt === 1
      ? executorResult(approval, { stderr: "ENOENT: author-local data path" })
      : executorResult(approval, { status: "completed", exitCode: 0, stdout: "human-readable output only", stderr: "" });
  };
  const audit = await runSampleAudit(projectRoot, { executor });
  assertCompletedUnverifiable(audit, "artifact");
  assert.equal(audit.execution.repaired.exitCode, 0);
  assert.match(audit.verdict.reason, /machine-readable artifact/i);
});

test("execution timeout becomes a completed Unverifiable ledger", async () => {
  const executor = async (_directory, approval) => executorResult(approval, {
    status: "timeout",
    stderr: "Process timed out",
  });
  const audit = await runSampleAudit(projectRoot, { executor });
  assertCompletedUnverifiable(audit, "execution");
  assert.equal(audit.execution.asSubmitted.status, "timeout");
  assert.match(audit.verdict.reason, /timed out/i);
});

test("repaired non-zero execution becomes a completed Unverifiable ledger", async () => {
  let attempt = 0;
  const executor = async (_directory, approval) => {
    attempt += 1;
    return executorResult(approval, {
      stderr: attempt === 1 ? "ENOENT: author-local data path" : "Runtime dependency missing",
    });
  };
  const audit = await runSampleAudit(projectRoot, { executor });
  assertCompletedUnverifiable(audit, "execution");
  assert.equal(audit.execution.repaired.exitCode, 1);
});

test("empty claim extraction becomes a completed Unverifiable ledger", async () => {
  const audit = await runSampleAudit(projectRoot, {
    extractionOptions: {
      apiKey: "test-key",
      extractor: async () => ({
        mode: "live",
        model: "gpt-5.6-test",
        responseId: "resp_test_empty",
        promptVersion: "test.prompt",
        schemaVersion: "test.schema",
        displayLabel: "GPT-5.6 · structured extraction",
        disclosure: "Test extraction.",
        claims: [],
        noClaimsReason: "No executable quantitative claim was present.",
      }),
    },
  });
  assertCompletedUnverifiable(audit, "claim");
  assert.match(audit.claim.text, /No executable quantitative claim/);
});
