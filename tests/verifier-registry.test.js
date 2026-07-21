import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listVerifierContracts,
  matchVerifierContract,
  resolveVerifierRuntime,
} from "../src/verifier-registry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const supportedClaim = {
  evidence: {
    testFamily: "ols",
    effectType: "regression_coefficient",
    datasetLabel: "Study cohort",
    reportedEffect: 1.276,
    reportedEffectRaw: "1.276",
    reportedEffectDecimals: 3,
    reportedP: { operator: "<", value: 0.001, raw: "p < 0.001" },
  },
};

test("verifier registry exposes matcher, contract, implementation, and robustness suite", () => {
  const contracts = listVerifierContracts();
  assert.equal(contracts.length, 2);
  const ols = contracts.find((contract) => contract.id === "peerproof.simple-univariate-ols.v3");
  const summary = contracts.find((contract) => contract.id === "peerproof.summary-matrix.v3");
  assert.equal(ols.runtimeId, "peerproof.verifier-runtime.simple-ols.v1");
  assert.equal(ols.executionStrategy, "author-pipeline-cross-check");
  assert.match(ols.claimSpecMatcher, /ols/i);
  assert.match(ols.independentImplementation, /statistics/i);
  assert.match(ols.robustnessSuite, /leave-one-out/i);
  assert.ok(ols.executableInterface.includes("runDataDependencyCanary"));
  assert.ok(ols.runtimeSourceFiles.includes("src/verifiers/simple-ols.js"));
  assert.equal(summary.runtimeId, "peerproof.verifier-runtime.summary-matrix.v1");
  assert.equal(summary.executionStrategy, "independent-evidence-audit");
  assert.match(summary.claimSpecMatcher, /summary_matrix/i);
  assert.ok(summary.executableInterface.includes("buildVisualEvidence"));
  assert.equal(summary.executableInterface.includes("runDataDependencyCanary"), false);
  assert.match(summary.architectureStatus, /multi-contract registry/i);
});

test("registry resolves the public summary-matrix claim to a distinct runtime", () => {
  const claim = {
    evidence: {
      testFamily: "descriptive_summary_matrix",
      effectType: "summary_matrix",
      precisionRule: "reported-print-precision",
    },
  };
  const runtime = resolveVerifierRuntime(claim);
  assert.equal(runtime.id, "peerproof.verifier-runtime.summary-matrix.v1");
  assert.equal(runtime.strategy, "independent-evidence-audit");
});

test("registry matches only compatible structured ClaimSpecs", () => {
  assert.equal(matchVerifierContract(supportedClaim)?.id, "peerproof.simple-univariate-ols.v3");
  assert.equal(matchVerifierContract({
    evidence: { ...supportedClaim.evidence, testFamily: "correlation", effectType: "correlation_coefficient" },
  }), null);
});

test("registry resolves an executable verifier runtime rather than metadata only", () => {
  const runtime = resolveVerifierRuntime(supportedClaim);
  assert.equal(runtime.id, "peerproof.verifier-runtime.simple-ols.v1");
  for (const method of [
    "validateEvidenceManifest",
    "validateAuthorArtifact",
    "loadEvidence",
    "recompute",
    "compareAuthorArtifact",
    "buildExecutionRecord",
    "runRobustnessSuite",
    "applyVerdict",
    "verifyExecution",
    "runDataDependencyCanary",
    "evaluateEvidenceContract",
    "normalizeError",
  ]) {
    assert.equal(typeof runtime[method], "function", `${method} must be executable`);
  }
  assert.equal(
    runtime.presentation.verificationPolicyDetail,
    "PeerProof - not GPT-5.6 - attached printed-precision comparison, strict significance, and independent leave-one-out rules.",
  );
  assert.match(runtime.presentation.verificationPolicyDetail, /^[\x00-\x7f]+$/);
});

test("central audit orchestration does not encode OLS result shapes or error classes", async () => {
  const source = await readFile(path.join(projectRoot, "src", "audit-engine.js"), "utf8");
  for (const forbidden of [
    "simple-ols.js",
    "IndependentCrossCheckMismatch",
    "DatasetResolutionError",
    "ArtifactSchemaError",
    "execution.baseline.slope",
    "verification.robustness.removedObservation",
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} belongs in the verifier runtime`);
  }
});
