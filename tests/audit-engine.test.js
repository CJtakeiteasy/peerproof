import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSampleAudit } from "../src/audit-engine.js";
import { parseStudyCsv, recomputeIndependently } from "../src/independent-verifier.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("end-to-end audit captures failure, repair, execution, and verdict", async () => {
  const streamed = [];
  const audit = await runSampleAudit(projectRoot, { onEvent: (event) => streamed.push(event) });
  assert.equal(audit.status, "completed");
  assert.notEqual(audit.execution.asSubmitted.exitCode, 0);
  assert.equal(audit.execution.repaired.exitCode, 0);
  assert.equal(audit.patch.classification, "infrastructure");
  assert.equal(audit.patch.analyticalLogicChanged, false);
  assert.equal(audit.repairWorkflow.proposal.status, "proposed");
  assert.equal(audit.repairWorkflow.classification.classification, "infrastructure");
  assert.equal(audit.repairWorkflow.classification.agentRecommendation, "infrastructure");
  assert.equal(audit.repairWorkflow.classification.policyClassification, "infrastructure");
  assert.equal(audit.repairWorkflow.classification.allowListMatch, true);
  assert.equal(audit.repairWorkflow.classification.allowListChecks.exactPatch, true);
  assert.equal(audit.repairWorkflow.approval.status, "approved");
  assert.equal(audit.repairWorkflow.application.actor, "Trusted fixture executor");
  assert.deepEqual(audit.runWorkflow.proposal.plan, {
    executable: "node",
    args: ["analysis.js"],
    cwd: ".",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  });
  assert.equal(audit.runWorkflow.classification.status, "eligible-for-approval");
  assert.deepEqual(audit.runWorkflow.approval.approvedPlan, audit.runWorkflow.proposal.plan);
  assert.equal(audit.runWorkflow.attempts.length, 2);
  assert.ok(audit.runWorkflow.attempts.every((attempt) => attempt.command === "node analysis.js"));
  assert.ok(audit.investigation.inspectedFiles.includes("analysis.js"));
  assert.match(audit.investigation.commandAttempt.stderr, /ENOENT|no such file|cannot find/i);
  assert.equal(audit.comparison.effectMatches, true);
  assert.equal(audit.verdict.label, "Fragile");
  assert.equal(audit.robustness.removedObservation, "P10");
  assert.equal(audit.robustness.effectStabilityScaleBasis, "absolute baseline coefficient");
  assert.equal(audit.dataDependencyCheck.status, "confirmed");
  assert.equal(audit.dataDependencyCheck.perturbation.observation, "P03");
  assert.equal(audit.dataDependencyCheck.crossCheck.match, true);
  assert.match(audit.provenance.datasetSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.schemaVersion, "1.9");
  assert.equal(audit.applicationAdmission.status, "exact-match");
  assert.equal(audit.applicationAdmission.verifierFilesMatched, true);
  assert.equal(audit.applicationAdmission.signed, false);
  assert.equal(audit.applicationAdmission.receiptCompleteness, "embedded-reviewed-manifest-and-observed-identities");
  assert.equal(audit.applicationAdmission.assetClosure.allRegisteredAssetsGoverned, true);
  assert.equal(audit.applicationAdmission.assetClosure.policyInventoryExact, true);
  assert.ok(audit.applicationAdmission.reviewedManifest.files["src/real-world-case.js"]);
  assert.match(
    audit.applicationAdmission.observedFileIdentities["src/real-world-case.js"].canonicalSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(audit.provenance.applicationCommitProvenance.value, audit.provenance.applicationCommit);
  assert.equal(audit.provenance.applicationCommitProvenance.cryptographicallyVerified, false);
  assert.match(audit.provenance.buildManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    audit.provenance.verifierRuntimeId,
    "peerproof.verifier-runtime.simple-ols.v1",
  );
  assert.match(audit.provenance.verifierRuntimeSourceSha256, /^[a-f0-9]{64}$/);
  assert.match(audit.provenance.casePolicyBundleSha256, /^[a-f0-9]{64}$/);
  assert.match(audit.provenance.casePolicyBundleSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.executionEnvironment.executionPolicyProfile, "peerproof.node-script.v1");
  assert.equal(audit.executionEnvironment.trustedCaseBinding, "peerproof.lighthouse-benchmark.v1");
  assert.equal(audit.executionEnvironment.casePolicyApprovalType, "version-controlled-maintainer-metadata");
  assert.equal(audit.executionEnvironment.casePolicySignatureVerification, "unsupported");
  assert.equal(audit.executionEnvironment.caseOrigin.type, "project-authored-synthetic-fixture");
  assert.match(audit.executionEnvironment.caseOrigin.authorityStatus, /no upstream scientific authority/i);
  assert.equal(audit.executionEnvironment.containerImageDigest, null);
  assert.equal(audit.executionEnvironment.containment.osSandbox, false);
  assert.equal(audit.executionEnvironment.containment.arbitraryRepositoryExecution, false);
  assert.match(audit.executionEnvironment.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.evidenceSelectionAttestation.repositoryManifest.status, "trusted reviewed assertion");
  assert.equal(audit.evidenceSelectionAttestation.machineLineage.status, "partial-static-confirmed");
  assert.equal(audit.evidenceSelectionAttestation.machineLineage.datasetReachable, true);
  assert.ok(audit.evidenceSelectionAttestation.machineLineage.edges.some(
    (edge) => edge.from === "src/load-study.js" && edge.to === "data/study.csv",
  ));
  assert.match(audit.evidenceSelectionAttestation.semanticMappingBoundary, /not independently proven/i);
  assert.equal(audit.architectureBoundaries.arbitraryRepositoryExecution, false);
  assert.deepEqual(streamed, audit.timeline);
});

function successfulAttempt(approval, extra = {}) {
  return {
    status: "completed",
    command: "node analysis.js",
    approvedPlan: structuredClone(approval.approvedPlan),
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: "lighthouse.author-result.v1",
      n: 10,
      coefficient: 1.27619,
      standardError: 0.250786,
      pValue: 0.00094284,
      ...extra,
    }),
    stderr: "",
  };
}

async function dataDependentAttempt(directory, approval) {
  const contract = JSON.parse(await readFile(path.join(directory, "peerproof.evidence.json"), "utf8"));
  const rows = parseStudyCsv(await readFile(path.join(directory, contract.dataset), "utf8"), contract);
  const baseline = recomputeIndependently(rows).baseline;
  return successfulAttempt(approval, {
    n: rows.length,
    coefficient: baseline.slope,
    standardError: baseline.standardError,
    pValue: baseline.pValue,
  });
}

test("as-submitted success independently recomputes evidence without applying a repair", async () => {
  let executions = 0;
  const audit = await runSampleAudit(projectRoot, {
    executor: async (directory, approval) => {
      executions += 1;
      return dataDependentAttempt(directory, approval);
    },
  });
  assert.equal(executions, 2);
  assert.equal(audit.verdict.label, "Fragile");
  assert.equal(audit.execution.asSubmitted.exitCode, 0);
  assert.equal(audit.execution.repaired, null);
  assert.equal(audit.patch.classification, "not-needed");
  assert.equal(audit.patch.file, null);
  assert.equal(audit.repairWorkflow.classification.status, "not-needed");
  assert.equal(audit.repairWorkflow.application.status, "not-needed");
  assert.equal(audit.runWorkflow.attempts.length, 1);
  assert.equal(audit.execution.asSubmitted.authorPipeline.coefficient, 1.27619);
  assert.equal(audit.execution.asSubmitted.independentVerifier.crossCheck.match, true);
  assert.equal(audit.dataDependencyCheck.confirmed, true);
});

test("a hard-coded canonical artifact fails the independent data-dependency canary", async () => {
  const audit = await runSampleAudit(projectRoot, {
    executor: async (_directory, approval) => successfulAttempt(approval),
  });
  assert.equal(audit.verdict.label, "Failed");
  assert.equal(audit.verdict.blockingStage, "data-dependency-canary");
  assert.equal(audit.dataDependencyCheck.status, "disconnected");
  assert.equal(audit.dataDependencyCheck.crossCheck.match, false);
  assert.equal(audit.comparison.authorVerifierCrossCheck.match, true);
  assert.equal(audit.comparison.dataDependencyConfirmed, false);
});

test("author-supplied leave-one-out evidence is rejected by the strict artifact schema", async () => {
  const audit = await runSampleAudit(projectRoot, {
    executor: async (_directory, approval) => successfulAttempt(approval, {
      leaveOneOut: [{ removedId: "P10", slope: 999, pValue: 0 }],
    }),
  });
  assert.equal(audit.verdict.label, "Unverifiable");
  assert.match(audit.verdict.reason, /fields must be exactly/i);
  assert.equal(audit.patch.classification, "not-needed");
});

test("valid author artifact that contradicts independent recomputation is Failed", async () => {
  const audit = await runSampleAudit(projectRoot, {
    executor: async (_directory, approval) => successfulAttempt(approval, { coefficient: 9.99 }),
  });
  assert.equal(audit.verdict.label, "Failed");
  assert.equal(audit.verdict.blockingStage, "pipeline-cross-check");
  assert.equal(audit.comparison.kind, "pipeline-mismatch");
  assert.equal(audit.comparison.authorPipelineEffect, 9.99);
  assert.equal(audit.comparison.independentVerifierEffect, 1.27619);
  assert.equal(audit.comparison.authorVerifierCrossCheck.match, false);
});

test("public benchmark ledger redacts absolute host paths", async () => {
  const secretPath = path.join(projectRoot, ".peerproof", "runs", "secret", "analysis.js");
  const audit = await runSampleAudit(projectRoot, {
    executor: async (_directory, approval) => ({
      status: "timeout",
      command: "node analysis.js",
      approvedPlan: structuredClone(approval.approvedPlan),
      exitCode: 1,
      stdout: "",
      stderr: `Timed out at ${secretPath}; OPENAI_API_KEY=sk-test_secret_12345678`,
    }),
  });
  const serialized = JSON.stringify(audit);
  assert.equal(audit.verdict.label, "Unverifiable");
  assert.doesNotMatch(serialized, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(serialized, /sk-test_secret/);
  assert.match(serialized, /<peerproof-root>|<audit-workspace>/);
});
