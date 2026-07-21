import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSummaryMatrixCsv,
  runRealWorldAudit,
  SummaryMatrixEvidenceError,
} from "../src/real-world-case.js";
import {
  PublicEvidenceAdmissionError,
  resolvePublicEvidenceBundle,
  validatePaperSourceRecord,
  validatePublicEvidenceBundle,
  validateRecordedInvestigationRecord,
} from "../src/public-evidence-bundle.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public Datasaurus case applies the paper's printed two-decimal claim exactly", async () => {
  const streamed = [];
  const audit = await runRealWorldAudit(projectRoot, { onEvent: (event) => streamed.push(event) });
  assert.equal(audit.status, "completed");
  assert.equal(audit.auditStatus, "completed");
  assert.equal(audit.case.kind, "real-world");
  assert.equal(audit.comparison.rowCount, 1846);
  assert.equal(audit.comparison.datasetCount, 13);
  assert.equal(audit.comparison.expectedChecks, 65);
  assert.equal(audit.comparison.passedChecks, 20);
  assert.equal(audit.comparison.failedChecks, 45);
  assert.ok(audit.comparison.maxAbsoluteDifference > 0.005);
  assert.equal(audit.robustness.mismatchedChecks, 45);
  assert.equal(audit.patch.file, null);
  assert.equal(audit.patch.analyticalLogicChanged, false);
  assert.equal(audit.verdict.label, "Failed");
  assert.equal(audit.verdict.displayLabel, "Package snapshot mismatch");
  assert.match(audit.verdict.scope, /20 \/ 65 printed values matched.*admitted package\/mirror only/);
  assert.match(audit.verdict.reason, /does not establish that the paper is false/i);
  assert.match(audit.verdictScopeDisclosure.doesNotMean, /not a finding that the paper is false/i);
  assert.match(audit.verdictScopeDisclosure.dataChain, /not represented as a same-commit export/i);
  assert.equal(audit.execution.asSubmitted.status, "not-available");
  assert.equal(audit.execution.asSubmitted.exitCode, null);
  assert.match(audit.execution.asSubmitted.stderr, /not a standalone runnable package installation/i);
  assert.equal(audit.provenance.datasetSha256, "febad7f618c51699815060a075ba80f13f6f1474e24e11d52ad5599ee269cc51");
  assert.equal(audit.provenance.datasetGitBlob, "10ad97cd8ac1862e128448a2a4bf94f1bf5f3a2f");
  assert.match(audit.provenance.datasetRawSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.provenance.datasetCanonicalSha256, audit.provenance.datasetSha256);
  assert.equal(audit.provenance.datasetCanonicalGitBlobSha1, audit.provenance.datasetGitBlob);
  assert.equal(audit.provenance.datasetCanonicalization, "utf8-newlines-to-lf");
  const sourceRecordText = await readFile(
    path.join(projectRoot, "samples", "datasaurus-dozen", "SOURCE.md"),
    "utf8",
  );
  assert.match(sourceRecordText, new RegExp(audit.provenance.datasetSha256));
  assert.match(sourceRecordText, new RegExp(audit.provenance.datasetGitBlob));
  assert.equal(audit.provenance.publicEvidenceBundleId, "peerproof.datasaurus-dozen.v1");
  assert.equal(
    audit.provenance.publicEvidenceAdmissionStatus,
    "canonical-match-single-read-snapshot-before-statistics",
  );
  assert.equal(audit.applicationAdmission.status, "exact-match");
  assert.equal(audit.applicationAdmission.verifierFilesMatched, true);
  assert.equal(audit.applicationAdmission.signed, false);
  assert.equal(audit.applicationAdmission.receiptCompleteness, "embedded-reviewed-manifest-and-observed-identities");
  assert.equal(audit.applicationAdmission.assetClosure.allRegisteredAssetsGoverned, true);
  assert.equal(audit.applicationAdmission.assetClosure.policyInventoryExact, true);
  assert.equal(audit.publicEvidenceAdmission.receiptCompleteness, "embedded-reviewed-bundle-and-observed-identities");
  assert.equal(audit.publicEvidenceAdmission.reviewedBundle.id, "peerproof.datasaurus-dozen.v1");
  assert.equal(
    audit.publicEvidenceAdmission.receipt.fileIdentities["data/datasaurus.csv"].canonicalSha256,
    audit.provenance.datasetCanonicalSha256,
  );
  assert.match(audit.provenance.buildManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.provenance.verifierRuntimeId, "peerproof.verifier-runtime.summary-matrix.v1");
  assert.equal(audit.provenance.sourceLicense, "MIT");
  assert.match(audit.provenance.datasetProvenanceStatus, /cross-source mirror/i);
  assert.equal(audit.claim.source.pageLabel, "PDF p. 3");
  assert.equal(audit.claim.evidence.precisionRule, "observed.toFixed(decimals) === reviewed reported value");
  assert.equal(audit.claim.sourceAnchor.independentlyAnchored, false);
  assert.equal(audit.claim.sourceAnchor.status, "reviewed-transcription-not-artifact-anchored");
  assert.equal(audit.provenance.paperArtifactSha256, null);
  assert.match(audit.provenance.investigationRecordSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.dataResolutionWorkflow.approval.status, "approved");
  assert.equal(audit.dataResolutionWorkflow.classification.checks.expectedCanonicalSha256Match, true);
  assert.equal(audit.dataResolutionWorkflow.classification.checks.singleReadSnapshot, true);
  assert.equal(audit.repairWorkflow.application.verifierFile, "src/verifiers/summary-matrix.js");
  assert.equal(
    audit.repairWorkflow.application.verifierSha256,
    audit.provenance.verifierRuntimeSourceSha256,
  );
  assert.equal(
    audit.repairWorkflow.application.evidenceSha256,
    audit.provenance.datasetSha256,
  );
  assert.equal("afterSha256" in audit.repairWorkflow.application, false);
  assert.deepEqual(
    audit.comparison.mismatchExamples.find((item) => item.dataset === "away" && item.metric === "meanX"),
    {
      dataset: "away",
      metric: "meanX",
      observed: 54.266099784,
      formattedObserved: "54.27",
      reportedValue: "54.26",
    },
  );
  assert.deepEqual(streamed, audit.timeline);
});

test("canonical-content admission records raw bytes without conflating CRLF and LF identities", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-public-canonical-"));
  try {
    const caseRoot = path.join(temporaryRoot, "samples", "datasaurus-dozen");
    await cp(path.join(projectRoot, "samples", "datasaurus-dozen"), caseRoot, { recursive: true });
    const dataset = path.join(caseRoot, "data", "datasaurus.csv");
    const lf = (await readFile(dataset, "utf8")).replace(/\r\n?/g, "\n");
    await writeFile(dataset, lf.replaceAll("\n", "\r\n"), "utf8");
    const audit = await runRealWorldAudit(temporaryRoot);
    assert.equal(audit.provenance.datasetCanonicalSha256, "febad7f618c51699815060a075ba80f13f6f1474e24e11d52ad5599ee269cc51");
    assert.notEqual(audit.provenance.datasetRawSha256, audit.provenance.datasetCanonicalSha256);
    assert.equal(audit.provenance.datasetCanonicalization, "utf8-newlines-to-lf");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("public evidence identity mismatch stops admission before statistics", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-public-evidence-"));
  try {
    const caseRoot = path.join(temporaryRoot, "samples", "datasaurus-dozen");
    await cp(path.join(projectRoot, "samples", "datasaurus-dozen"), caseRoot, { recursive: true });
    const dataset = path.join(caseRoot, "data", "datasaurus.csv");
    const original = await readFile(dataset, "utf8");
    await writeFile(dataset, original.replace("55.3846", "55.3847"), "utf8");
    await assert.rejects(
      runRealWorldAudit(temporaryRoot),
      (error) => error instanceof PublicEvidenceAdmissionError
        && error.code === "PUBLIC_EVIDENCE_ADMISSION_FAILED"
        && error.details.mismatched.some((item) => item.file === "data/datasaurus.csv"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("public audit consumes the single-read admitted snapshot when source paths change afterward", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-public-snapshot-"));
  try {
    const caseRoot = path.join(temporaryRoot, "samples", "datasaurus-dozen");
    await cp(path.join(projectRoot, "samples", "datasaurus-dozen"), caseRoot, { recursive: true });
    const dataset = path.join(caseRoot, "data", "datasaurus.csv");
    const audit = await runRealWorldAudit(temporaryRoot, {
      afterEvidenceAdmission: async () => writeFile(dataset, "dataset,x,y\ndino,not-a-number,1\n", "utf8"),
    });
    assert.equal(audit.comparison.rowCount, 1846);
    assert.equal(audit.verdict.displayLabel, "Package snapshot mismatch");
    assert.equal(audit.provenance.publicEvidenceSnapshotMode, "single-read-in-memory-canonical-bytes");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("summary-matrix CSV contract rejects malformed, non-finite, extra, unexpected, and duplicate evidence", async () => {
  const bundle = resolvePublicEvidenceBundle("peerproof.datasaurus-dozen.v1");
  const manifest = structuredClone(bundle.evidenceManifest);
  const csv = await readFile(path.join(projectRoot, bundle.sourcePath, manifest.dataset), "utf8");
  assert.equal(parseSummaryMatrixCsv(csv, manifest).length, 1846);
  const invalidCases = [
    csv.replace("55.3846", "not-a-number"),
    csv.replace("55.3846", ""),
    csv.replace("dino,55.3846,97.1795", "dino,55.3846,97.1795,extra"),
    csv.replace("dino,55.3846,97.1795", "unknown,55.3846,97.1795"),
    csv.replace("dino,51.5385,96.0256", "dino,55.3846,97.1795"),
    `${csv}\n`,
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () => parseSummaryMatrixCsv(invalid, manifest),
      (error) => error instanceof SummaryMatrixEvidenceError
        && error.code === "SUMMARY_MATRIX_EVIDENCE_INVALID",
    );
  }
});

test("public-evidence bundles reject self-attested signatures and unpinned records", () => {
  const original = resolvePublicEvidenceBundle("peerproof.datasaurus-dozen.v1");
  const fakeSignature = structuredClone(original);
  fakeSignature.review.signature = "unverified-signature";
  assert.throws(() => validatePublicEvidenceBundle(fakeSignature), /signatures are not supported or verified/i);

  const unpinnedRecord = structuredClone(original);
  delete unpinnedRecord.files[unpinnedRecord.sourceRecord];
  assert.throws(() => validatePublicEvidenceBundle(unpinnedRecord), /sourceRecord must be identity-pinned/i);

  const incompleteOrigin = structuredClone(original);
  delete incompleteOrigin.origin.repositoryCommit;
  assert.throws(() => validatePublicEvidenceBundle(incompleteOrigin), /origin.*fields must be exactly/i);

  const incompleteUpstream = structuredClone(original);
  delete incompleteUpstream.upstreamExecution.blocker.line;
  assert.throws(() => validatePublicEvidenceBundle(incompleteUpstream), /blocker fields must be exactly/i);
});

test("paper-source and investigation schemas reject fields missing from downstream contracts", async () => {
  const bundle = resolvePublicEvidenceBundle("peerproof.datasaurus-dozen.v1");
  const source = JSON.parse(await readFile(path.join(projectRoot, bundle.sourcePath, bundle.sourceRecord), "utf8"));
  const investigation = JSON.parse(await readFile(
    path.join(projectRoot, bundle.sourcePath, bundle.investigationRecord),
    "utf8",
  ));
  assert.equal(validatePaperSourceRecord(source, bundle), source);
  assert.equal(validateRecordedInvestigationRecord(investigation, bundle), investigation);
  delete source.review.licensingStatus;
  assert.throws(() => validatePaperSourceRecord(source, bundle), /paper-source review fields must be exactly/i);
  delete investigation.review.reviewedAt;
  assert.throws(
    () => validateRecordedInvestigationRecord(investigation, bundle),
    /recorded-investigation review fields must be exactly/i,
  );
});
