import path from "node:path";
import { fileURLToPath } from "node:url";
import { admitApplicationBuild, assertApplicationAdmissionContinuity } from "./build-integrity.js";
import { resolveApplicationCommitProvenance } from "./build-info.js";
import {
  admitPublicEvidenceWorkspace,
  PublicEvidenceAdmissionError,
  resolvePublicEvidenceBundle,
} from "./public-evidence-bundle.js";
import { resolveVerifierRuntimeByContractId } from "./verifier-registry.js";
import { VERSION } from "./version.js";
import { createRunId, nowIso, sha256, timelineEvent } from "./utils.js";

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeRecorder(timeline, onEvent) {
  return async (event) => {
    timeline.push(event);
    if (onEvent) await onEvent(event);
  };
}

function upstreamAttempt(bundle) {
  return {
    status: bundle.upstreamExecution.status,
    command: bundle.upstreamExecution.command,
    exitCode: null,
    stdout: "",
    stderr: bundle.upstreamExecution.stderr,
  };
}

function runtimeProvenance(applicationAdmission, runtime) {
  return Object.fromEntries(Object.entries(runtime.provenanceFiles).map(([key, relative]) => {
    const identity = applicationAdmission.fileIdentities[relative];
    if (!identity) throw new Error(`Verifier provenance file is absent from build admission: ${relative}`);
    return [key, identity.canonicalSha256];
  }));
}

function applicationAdmissionLedger(receipt, runtime) {
  return {
    schemaVersion: receipt.schemaVersion,
    actor: receipt.actor,
    status: receipt.status,
    manifestFile: receipt.manifestFile,
    buildManifestSha256: receipt.buildManifestSha256,
    contentHashMode: receipt.contentHashMode,
    fileCount: receipt.fileCount,
    verifierFilesMatched: receipt.verifierFilesMatched,
    executedVerifierFiles: runtime.runtimeSourceFiles.map((file) => ({
      file,
      canonicalSha256: receipt.fileIdentities[file]?.canonicalSha256 || null,
    })),
    runtimeClosure: structuredClone(receipt.runtimeClosure),
    assetClosure: structuredClone(receipt.assetClosure),
    reviewedManifest: structuredClone(receipt.reviewedManifest),
    observedFileIdentities: structuredClone(receipt.fileIdentities),
    receiptCompleteness: "embedded-reviewed-manifest-and-observed-identities",
    signatureStatus: receipt.signatureStatus,
    signed: receipt.signed,
    signature: null,
    trustBoundary: receipt.trustBoundary,
  };
}

export async function runIndependentEvidenceAudit(projectRoot, {
  bundleId,
  onEvent,
  signal,
  afterEvidenceAdmission,
  expectedApplicationAdmission,
} = {}) {
  signal?.throwIfAborted();
  // Direct library consumers re-admit the application here. The server and CLI
  // additionally perform this check before dynamically importing audit runtimes.
  const applicationAdmission = assertApplicationAdmissionContinuity(
    expectedApplicationAdmission,
    await admitApplicationBuild(applicationRoot),
  );
  const bundle = resolvePublicEvidenceBundle(bundleId);
  if (!bundle) throw new Error(`Unknown reviewed public-evidence bundle: ${bundleId}`);
  const runtime = resolveVerifierRuntimeByContractId(bundle.verifierContractId);
  if (!runtime || runtime.strategy !== "independent-evidence-audit") {
    throw new Error(`Public-evidence bundle ${bundle.id} has no registered independent verifier runtime`);
  }
  const runtimeHashes = runtimeProvenance(applicationAdmission, runtime);

  // Identity admission is deliberately the first file-consuming operation.
  // No source record is trusted, CSV is parsed, or statistic is calculated before it succeeds.
  const admittedSnapshot = await admitPublicEvidenceWorkspace(projectRoot, bundle);
  const admission = admittedSnapshot.receipt;
  if (afterEvidenceAdmission) await afterEvidenceAdmission(admission);
  signal?.throwIfAborted();

  // These records and the CSV are all consumed from the same single-read,
  // in-memory canonical snapshot whose identities were admitted above.
  const sourceRecord = JSON.parse(admittedSnapshot.readText(bundle.sourceRecord));
  const investigationRecord = JSON.parse(admittedSnapshot.readText(bundle.investigationRecord));
  if (investigationRecord.schemaVersion !== "peerproof.recorded-investigation.v2"
    || investigationRecord.currentRunModelCall !== false
    || investigationRecord.review?.status !== "reviewed-committed"
    || investigationRecord.review.signature !== null) {
    throw new PublicEvidenceAdmissionError(
      "The admitted repository-investigation record failed its semantic review contract; statistics were not calculated.",
      { file: bundle.investigationRecord },
    );
  }
  let contractEvaluation;
  let evidence;
  let verification;
  try {
    contractEvaluation = runtime.evaluateEvidenceContract({
      manifest: bundle.evidenceManifest,
      claim: bundle.claim,
    });
    evidence = await runtime.loadEvidence({
      readEvidenceText: admittedSnapshot.readText,
      manifest: bundle.evidenceManifest,
      sourceRecord,
    });
    signal?.throwIfAborted();
    verification = runtime.recompute(evidence, {
      manifest: bundle.evidenceManifest,
      claim: bundle.claim,
    });
  } catch (error) {
    const normalized = runtime.normalizeError(error);
    if (normalized) error.normalizedAuditFailure = normalized;
    throw error;
  }
  const comparison = runtime.buildComparison({ evidence, verification });
  const robustness = runtime.runRobustnessSuite({ evidence, verification });
  const verdict = runtime.applyVerdict({ evidence, verification, claim: bundle.claim });
  const visualEvidence = runtime.buildVisualEvidence({ evidence, verification });
  const executionRecord = runtime.buildExecutionRecord({ evidence, verification });
  const sourceAttempt = upstreamAttempt(bundle);
  const startedAt = nowIso();
  const id = createRunId();

  const investigation = {
    mode: "recorded-public-case",
    currentRunModelCall: false,
    displayLabel: "Recorded public investigation",
    disclosure: investigationRecord.disclosure,
    summary: investigationRecord.summary,
    inspectedFiles: [...investigationRecord.inspectedFiles],
    hypothesis: investigationRecord.hypothesis,
    entryPoint: investigationRecord.entryPoint,
    suggestedCommand: null,
    command: sourceAttempt.command,
    dataFiles: [bundle.evidenceManifest.dataset],
    repositoryResolution: {
      resolvedBy: "Reviewed public-evidence admission policy",
      currentRunModelCall: false,
      manifestFile: bundle.policyFile,
      resolvedDataFile: bundle.evidenceManifest.dataset,
      evidence: `All ${admission.fileCount} public-case files matched the reviewed canonical-content bundle and were captured in one admitted snapshot before statistics ran.`,
    },
    blockers: [structuredClone(bundle.upstreamExecution.blocker)],
    commandAttempt: sourceAttempt,
    proposedRepair: {
      classificationAdvisory: "none",
      description: investigationRecord.proposedStrategy,
      diff: "No source patch applied.\n+ Canonical-content admitted snapshot bytes were evaluated by the registered independent verifier runtime.",
    },
    responsibilityBoundary: {
      investigator: "Identified the package structure, runtime blocker, and bounded independent-verification scope.",
      admissionPolicy: "Read once, matched the complete public-case inventory and expected canonical identities, then supplied those same captured bytes to the verifier.",
      verifierRegistry: `Resolved ${runtime.id} from ${bundle.verifierContractId}.`,
      executor: "Read the admitted CSV and computed only the registered deterministic contract; no repository writes.",
    },
  };

  const dataResolutionWorkflow = {
    kind: "public-evidence-admission",
    proposal: {
      actor: "Reviewed public-case bundle",
      resolvedBy: "Reviewed public-evidence admission policy",
      currentRunModelCall: false,
      resolvedDataFile: bundle.evidenceManifest.dataset,
    },
    classification: {
      actor: "Public-evidence identity policy",
      status: "eligible-for-approval",
      classification: contractEvaluation.classification,
      checks: {
        completeFileInventory: true,
        expectedCanonicalSha256Match: true,
        expectedCanonicalGitBlobMatch: true,
        rawSha256Recorded: true,
        singleReadSnapshot: true,
        noSymlinks: true,
        verifierContractRegistered: true,
        ...contractEvaluation.checks,
      },
    },
    approval: {
      ...admission,
      contract: {
        schemaVersion: bundle.evidenceManifest.schemaVersion,
        verifierContractId: bundle.verifierContractId,
      },
      approvedDataFile: bundle.evidenceManifest.dataset,
      mappingAssertion: "Dataset identity and reported-target source are reviewed and hash-admitted; paper PDF artifact anchoring is not claimed.",
    },
  };

  const evidenceIdentity = admission.fileIdentities[bundle.evidenceManifest.dataset];
  const sourceRecordIdentity = admission.fileIdentities[bundle.sourceRecord];
  const investigationRecordIdentity = admission.fileIdentities[bundle.investigationRecord];
  const repairWorkflow = {
    proposal: {
      actor: "Recorded investigator evidence",
      status: "proposed-execution-strategy",
      description: investigation.proposedRepair.description,
    },
    classification: {
      actor: "Public-evidence and verifier policy",
      agentRecommendation: "none",
      policyClassification: "no-source-change",
      classification: "no-source-change",
      allowListMatch: null,
      status: "eligible-for-approval",
      rationale: "The strategy modifies no source and resolves a registered verifier only after canonical-content admission into a single-read snapshot.",
    },
    approval: {
      actor: admission.actor,
      status: admission.status,
      mechanism: "Complete-file canonical identity admission into a single-read snapshot plus registered verifier dispatch",
      humanApproval: false,
      scope: admission.scope,
    },
    application: {
      actor: "Registered PeerProof verifier runtime",
      status: "executed",
      verifierFile: runtime.runtimeSourceFiles[0],
      verifierSha256: runtimeHashes.verifierRuntimeSourceSha256,
      evidenceFile: `${bundle.sourcePath}/${bundle.evidenceManifest.dataset}`,
      evidenceSha256: evidenceIdentity.canonicalSha256,
    },
  };

  const timeline = [];
  const record = makeRecorder(timeline, onEvent);
  const comparisonPresentation = runtime.presentation.comparisonSummary({ verification });
  const robustnessPresentation = runtime.presentation.robustnessSummary({ verification });
  const events = [
    timelineEvent(
      "ingest",
      "completed",
      "Reviewed public evidence snapshot admitted",
      `${admission.fileCount} files recorded raw SHA-256 identities, matched expected canonical SHA-256 identities, and were captured before parsing.`,
    ),
    timelineEvent(
      "claim",
      "completed",
      "Reviewed transcription loaded with explicit anchoring limits",
      `The reported targets come from ${bundle.sourceRecord}; no redistributed paper PDF or deterministic page-text anchoring is claimed.`,
    ),
    timelineEvent("investigate", "completed", "Repository structure and scope identified", investigation.summary),
    timelineEvent(
      "execute",
      "blocked",
      "Original package runtime not available in this deployment",
      sourceAttempt.stderr,
      { command: sourceAttempt.command, exitCode: null, status: sourceAttempt.status },
    ),
    timelineEvent(
      "approval",
      "completed",
      "Registered independent verifier approved",
      `${runtime.id} was resolved from the verifier registry after public-evidence admission.`,
    ),
    timelineEvent("execute", "completed", comparisonPresentation.title, comparisonPresentation.detail),
    timelineEvent("robustness", "completed", robustnessPresentation.title, robustnessPresentation.detail),
    timelineEvent("verdict", "completed", `${verdict.displayLabel} issued`, verdict.reason),
  ];
  for (const event of events) {
    signal?.throwIfAborted();
    await record(event);
  }

  const verdictScopeDisclosure = {
    title: "What this verdict covers",
    means: `The canonical-content admitted package/mirror CSV matched ${verification.matchedChecks} of ${verification.checks.length} reviewed reported values at declared precision.`,
    doesNotMean: bundle.verdictScopeDisclosure.doesNotMean,
    dataChain: bundle.verdictScopeDisclosure.dataChain,
  };
  const sourceAnchor = {
    status: sourceRecord.anchor.status,
    label: "Reviewed transcription · paper artifact not anchored",
    independentlyAnchored: false,
    sourceRecord: bundle.sourceRecord,
    sourceRecordSha256: sourceRecordIdentity.canonicalSha256,
    documentSha256: sourceRecord.documentArtifact.sha256,
  };

  const environment = {
    schemaVersion: "peerproof.independent-evidence-environment.v1",
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
    publicEvidenceBundleId: bundle.id,
    publicEvidenceBundleSha256: bundle.bundleSha256,
    applicationBuildManifestSha256: applicationAdmission.buildManifestSha256,
    applicationAdmissionStatus: applicationAdmission.status,
    verifierContractId: bundle.verifierContractId,
    verifierRuntimeId: runtime.id,
    executionStrategy: runtime.strategy,
    upstreamPipelineExecuted: false,
    arbitraryRepositoryExecution: false,
  };
  const executionEnvironment = { ...environment, manifestSha256: sha256(JSON.stringify(environment)) };
  const applicationCommitProvenance = resolveApplicationCommitProvenance(applicationRoot);

  return {
    schemaVersion: "1.4",
    id,
    auditStatus: "completed",
    status: "completed",
    mode: "recorded-public-case",
    aiDisclosure: {
      status: "recorded-public-case",
      title: "Recorded public-case investigation",
      message: "The repository investigation is a reviewed source record, not a live Codex call in this browser.",
      detail: "Canonical-content snapshot admission, strict evidence parsing, and the registered numerical verifier ran locally for this request.",
    },
    stageProvenance: [
      {
        stage: "Application admission",
        mode: "deterministic",
        label: "Unsigned local build · reviewed manifest match",
        detail: `${applicationAdmission.fileCount} implementation files matched the reviewed build manifest before this audit ran; the manifest is version-controlled but unsigned.`,
      },
      {
        stage: "Reported evidence",
        mode: "reviewed-transcription",
        label: sourceAnchor.label,
        detail: `Targets are reviewed in ${bundle.sourceRecord}; deterministic PDF artifact anchoring is unavailable and not claimed.`,
      },
      {
        stage: "Evidence admission",
        mode: "deterministic",
        label: "Public evidence bundle · canonical identity match",
        detail: `${admission.fileCount} files passed complete inventory, realpath, symlink, raw-identity recording, and declared canonical-identity checks before the admitted snapshot was consumed.`,
      },
      {
        stage: "Verification policy",
        mode: "deterministic",
        label: runtime.contract.policyLabel,
        detail: runtime.presentation.verificationPolicyDetail,
      },
      {
        stage: "Repository investigator",
        mode: "recorded-public-case",
        label: investigation.displayLabel,
        detail: investigation.disclosure,
      },
      {
        stage: "Execution & verdict",
        mode: "deterministic",
        label: `${runtime.id} · live local verification`,
        detail: `The registered runtime strictly parsed ${evidence.rows.length} admitted rows and recomputed ${verification.checks.length} statistics.`,
      },
    ],
    case: structuredClone(bundle.case),
    startedAt,
    completedAt: nowIso(),
    applicationAdmission: applicationAdmissionLedger(applicationAdmission, runtime),
    publicEvidenceAdmission: {
      schemaVersion: "peerproof.public-evidence-admission-export.v1",
      receipt: structuredClone(admission),
      reviewedBundle: structuredClone(bundle),
      receiptCompleteness: "embedded-reviewed-bundle-and-observed-identities",
      signed: false,
      signature: null,
      trustBoundary: "The local canonical-content snapshot is admitted; declared upstream origins and reviewer identity are not cryptographically authenticated.",
    },
    claim: {
      ...structuredClone(bundle.claim),
      source: {
        pageLabel: sourceRecord.anchor.pageLabel,
        section: sourceRecord.anchor.section,
        quote: sourceRecord.anchor.quote,
        url: sourceRecord.publicationUrl,
      },
      sourceAnchor,
      evidence: {
        ...structuredClone(bundle.claim.evidence),
        figure: sourceRecord.anchor.figure,
        dataset: bundle.evidenceManifest.dataset,
        reportedTargets: structuredClone(evidence.targets),
        precisionRule: "observed.toFixed(decimals) === reviewed reported value",
      },
      reportedEvidence: {
        actor: "Reviewed paper-source transcription",
        label: sourceAnchor.label,
        responsibility: "Supplies reviewed targets while explicitly disclosing the absent paper artifact hash.",
      },
      verification: {
        id: runtime.contract.id,
        policyLabel: runtime.contract.policyLabel,
        runtimeId: runtime.id,
      },
      executionSupport: {
        status: "supported-independent-evidence",
        message: "Executable by a registered independent verifier from a single-read canonical-content admitted snapshot.",
      },
    },
    investigation,
    dataResolutionWorkflow,
    execution: {
      asSubmitted: sourceAttempt,
      independentVerifier: executionRecord,
    },
    executionEnvironment,
    repairWorkflow,
    patch: {
      classification: "no-source-change",
      approvedBy: repairWorkflow.approval.actor,
      analyticalLogicChanged: false,
      file: null,
      beforeHash: null,
      afterHash: null,
      diff: investigation.proposedRepair.diff,
    },
    comparison,
    robustness,
    visualEvidence,
    verdict,
    verdictScopeDisclosure,
    timeline,
    evidenceGraph: [
      { id: "claim", label: "Claim", value: bundle.claim.text, status: "reviewed-public-claim", tone: "neutral" },
      { id: "paper", label: "Paper source", value: `DOI ${sourceRecord.doi}`, status: sourceRecord.anchor.status, tone: "warning" },
      { id: "bundle", label: "Evidence admission", value: `${admission.fileCount} canonical-content files`, status: "snapshot-admitted", tone: "confirmed" },
      { id: "repo", label: "Repository", value: `declared commit ${bundle.origin.repositoryCommit.slice(0, 7)}`, status: "maintainer-declared-origin", tone: "neutral" },
      { id: "data", label: "Repository data", value: `${evidence.rows.length.toLocaleString("en-US")} rows · ${verification.summaries.length} groups`, status: "identity-and-schema-admitted", tone: "confirmed" },
      { id: "execution", label: "Registered verifier", value: runtime.id, status: "completed", tone: "confirmed" },
      { id: "canonical", label: "Numerical result", value: `${verification.matchedChecks}/${verification.checks.length} matched`, status: "independently-checked", tone: verification.mismatches.length ? "warning" : "confirmed" },
      { id: "scope", label: "Scope", value: runtime.presentation.verdictScope, status: "bounded", tone: "warning" },
      { id: "verdict", label: "Verdict", value: verdict.displayLabel, status: "issued", tone: verification.mismatches.length ? "warning" : "neutral" },
    ],
    provenance: {
      applicationVersion: VERSION,
      applicationCommit: applicationCommitProvenance.value,
      applicationCommitProvenance,
      applicationCommitSource: applicationCommitProvenance.source,
      applicationCommitFormatValid: applicationCommitProvenance.formatValid,
      applicationCommitCryptographicallyVerified: applicationCommitProvenance.cryptographicallyVerified,
      applicationAdmissionStatus: applicationAdmission.status,
      buildManifestSha256: applicationAdmission.buildManifestSha256,
      buildManifestFileCount: applicationAdmission.fileCount,
      buildManifestVerifierFilesMatched: applicationAdmission.verifierFilesMatched,
      buildManifestSignatureStatus: applicationAdmission.signatureStatus,
      publicEvidenceBundleId: bundle.id,
      publicEvidenceBundleSha256: bundle.bundleSha256,
      publicEvidenceHashMode: admission.contentHashMode,
      publicEvidenceFileCount: admission.fileCount,
      publicEvidenceAdmissionStatus: "canonical-match-single-read-snapshot-before-statistics",
      publicEvidenceSnapshotMode: admission.snapshotMode,
      paperDoi: sourceRecord.doi,
      paperSourceRecordRawSha256: sourceRecordIdentity.rawSha256,
      paperSourceRecordSha256: sourceRecordIdentity.canonicalSha256,
      investigationRecordRawSha256: investigationRecordIdentity.rawSha256,
      investigationRecordSha256: investigationRecordIdentity.canonicalSha256,
      paperArtifactSha256: sourceRecord.documentArtifact.sha256,
      paperAnchorStatus: sourceRecord.anchor.status,
      repositoryCommit: bundle.origin.repositoryCommit,
      dataMirrorCommit: bundle.origin.dataMirrorCommit,
      sourceLicense: bundle.origin.license,
      datasetRawSha256: evidenceIdentity.rawSha256,
      datasetSha256: evidenceIdentity.canonicalSha256,
      datasetCanonicalSha256: evidenceIdentity.canonicalSha256,
      datasetGitBlob: evidenceIdentity.canonicalGitBlobSha1,
      datasetCanonicalGitBlobSha1: evidenceIdentity.canonicalGitBlobSha1,
      datasetCanonicalization: evidenceIdentity.canonicalization,
      datasetProvenanceStatus: bundle.origin.authorityStatus,
      verifierRuntimeId: runtime.id,
      verificationContractId: runtime.contract.id,
      ...runtimeHashes,
      executionEnvironmentSha256: executionEnvironment.manifestSha256,
      verdictEngine: `${runtime.id} · deterministic`,
      runtime: process.version,
    },
  };
}
