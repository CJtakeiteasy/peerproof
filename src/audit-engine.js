import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { admitApplicationBuild, assertApplicationAdmissionContinuity } from "./build-integrity.js";
import {
  CLAIM_PROMPT_VERSION,
  CLAIM_SCHEMA_VERSION,
  extractSampleClaim,
} from "./claim-extractor.js";
import {
  CODEX_PROMPT_VERSION,
  CODEX_SDK_VERSION,
  INVESTIGATION_SCHEMA_VERSION,
  investigateRepository,
} from "./codex-investigator.js";
import { resolveApplicationCommitProvenance } from "./build-info.js";
import { buildExecutionEnvironmentManifest } from "./execution-environment.js";
import { approveDataResolution, classifyDataResolution } from "./data-resolution-policy.js";
import { traceJavaScriptEvidenceLineage } from "./js-lineage.js";
import { approveRepair, classifyRepairProposalForWorkspace } from "./repair-policy.js";
import { approveRunPlan, classifyRunPlanWorkspace, formatRunPlan } from "./run-policy.js";
import { LIGHTHOUSE_POLICY_CONTEXT } from "./policy-registry.js";
import { sampleCaseMetadata } from "./sample-case.js";
import { resolveVerifierRuntimeByContractId } from "./verifier-registry.js";
import { VERSION } from "./version.js";
import {
  createRunId,
  nowIso,
  redactAuditValue,
  sha256,
  sha256File,
  timelineEvent,
  writeJson,
} from "./utils.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const execFileAsync = promisify(execFile);
const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    executedVerifierFiles: (runtime?.runtimeSourceFiles || []).map((file) => ({
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

function executionStatus(error) {
  if (error?.name === "AbortError") return "aborted";
  if (error?.killed || error?.code === "ETIMEDOUT" || /timed?\s*out/i.test(error?.message || "")) return "timeout";
  return "failed";
}

async function parseAndVerifyExecution(args) {
  const runtime = resolveVerifierRuntimeByContractId(args.claim?.verification?.id);
  if (!runtime) throw new Error("No executable verifier runtime is registered for this contract");
  return runtime.verifyExecution(args);
}

async function executeApprovedRunPlan(repoDirectory, approval, {
  signal,
  execFileImpl = execFileAsync,
} = {}) {
  if (approval?.status !== "approved" || !approval.approvedPlan) {
    throw new Error("RunPlan has not crossed the execution-policy boundary");
  }
  const plan = approval.approvedPlan;
  const cwd = (await resolveWorkspacePath(repoDirectory, plan.cwd, "approved RunPlan cwd", {
    allowRoot: true,
    expectedType: "directory",
  })).resolved;
  const executable = plan.executable === "node" ? process.execPath : null;
  if (!executable) throw new Error("Approved executable is not implemented by the executor");
  try {
    const { stdout, stderr } = await execFileImpl(executable, plan.args, {
      cwd,
      encoding: "utf8",
      timeout: plan.timeoutMs,
      windowsHide: true,
      env: { PATH: process.env.PATH || "" },
      maxBuffer: approval.resourceLimits?.maxOutputBytes || 1024 * 1024,
      signal,
    });
    return {
      status: "completed",
      command: formatRunPlan(plan),
      approvedPlan: structuredClone(plan),
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      status: executionStatus(error),
      command: formatRunPlan(plan),
      approvedPlan: structuredClone(plan),
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
    };
  }
}

function makeRecorder(timeline, onEvent, redactionOptions) {
  return async (event) => {
    const safeEvent = redactAuditValue(event, redactionOptions);
    timeline.push(safeEvent);
    if (onEvent) await onEvent(safeEvent);
    return safeEvent;
  };
}

function sameApprovedPatch(proposal, approval) {
  return approval?.approvedPatch?.file === proposal?.file
    && approval?.approvedPatch?.oldText === proposal?.oldText
    && approval?.approvedPatch?.newText === proposal?.newText;
}

async function applyInfrastructureRepair(repoDirectory, proposal, classification, approval) {
  if (approval?.status !== "approved" || !classification?.allowListMatch) {
    throw new Error("Repair has not crossed the independent policy boundary");
  }
  if (!sameApprovedPatch(proposal, approval)) {
    throw new Error("Executor received a patch that differs from the exact approved proposal");
  }
  const filePath = (await resolveWorkspacePath(repoDirectory, proposal.file, "approved patch target", {
    expectedType: "file",
  })).resolved;
  const before = await readFile(filePath, "utf8");
  const matches = before.split(proposal.oldText).length - 1;
  if (matches !== 1) {
    throw new Error(`Approved patch expected exactly one oldText match, found ${matches}`);
  }
  const after = before.replace(proposal.oldText, proposal.newText);
  await writeFile(filePath, after, "utf8");
  return {
    classification: classification.policyClassification,
    approvedBy: approval.actor,
    allowListRule: classification.allowListRule,
    analyticalLogicChanged: false,
    file: proposal.file,
    beforeHash: sha256(before),
    afterHash: sha256(after),
    diff: [
      `--- a/${proposal.file}`,
      `+++ b/${proposal.file}`,
      "@@ exact allow-listed replacement @@",
      `-${proposal.oldText}`,
      `+${proposal.newText}`,
    ].join("\n"),
  };
}

function notRunInvestigation(reason) {
  return {
    decision: "abstain",
    abstentionReason: reason,
    mode: "not-run",
    currentRunModelCall: false,
    displayLabel: "Repository investigation · not run",
    disclosure: reason,
    summary: reason,
    inspectedFiles: [],
    hypothesis: "No repository hypothesis was formed.",
    entryPoint: "Not identified",
    runPlan: null,
    dataFiles: [],
    repositoryResolution: {
      resolvedBy: "Not run",
      currentRunModelCall: false,
      manifestFile: "",
      resolvedDataFile: "",
      evidence: reason,
    },
    blockers: [],
    proposedRepair: {
      repairCandidateId: "none",
      classificationAdvisory: "none",
      file: "",
      oldText: "",
      newText: "",
      rationale: reason,
      description: "No repair was proposed.",
    },
  };
}

function stageProvenance(extraction, claim, investigation, dataApproval, verifierRuntime) {
  return [
    {
      stage: "Reported evidence",
      mode: extraction.mode,
      label: extraction.displayLabel,
      detail: `${extraction.disclosure} ${claim?.sourceAnchor?.label || "Source anchor not available"}.`,
    },
    {
      stage: "Verification policy",
      mode: "deterministic",
      label: claim?.verification?.policyLabel || "No compatible verifier contract",
      detail: claim?.verification
        ? verifierRuntime?.presentation?.verificationPolicyDetail
          || "PeerProof attached the selected deterministic verifier policy independently from claim extraction."
        : "The extracted evidence was retained, but no current PeerProof verifier contract supports it.",
    },
    {
      stage: "Repository investigator",
      mode: investigation.mode,
      label: investigation.displayLabel,
      detail: investigation.disclosure,
    },
    {
      stage: "Repository data resolution",
      mode: "deterministic",
      label: dataApproval?.status === "approved" ? "Data-path policy · approved" : "Data-path policy · not approved",
      detail: dataApproval?.status === "approved"
        ? `${dataApproval.approvedDataFile} was policy-approved under ${dataApproval.contract.schemaVersion}. ${dataApproval.mappingAssertion}.`
        : "No repository data file crossed the independent data-path policy boundary.",
    },
    {
      stage: "Execution & verdict",
      mode: "deterministic",
      label: "PeerProof · local deterministic decision",
      detail: "Execution artifacts or the reason they could not be obtained were preserved in the Evidence Ledger.",
    },
  ];
}

function aiDisclosure(extraction, investigation) {
  const liveStages = [extraction, investigation].filter((stage) => stage.mode === "live").length;
  if (liveStages === 2) {
    return {
      status: "live",
      title: "Live AI audit",
      message: "GPT-5.6 extracted reported evidence and Codex investigated this repository during the current run.",
      detail: "PeerProof independently attached policy, controlled execution, and computed the verdict.",
    };
  }
  if (liveStages === 1) {
    return {
      status: "hybrid",
      title: "Partial live AI audit",
      message: investigation.mode === "not-run"
        ? "GPT-5.6 ran live, but repository investigation was not needed because the claim was not executable."
        : "One AI stage ran live; the other used its explicitly labeled reviewed fixture.",
      detail: "See the per-stage provenance below for the exact boundary.",
    };
  }
  return {
    status: "offline-fixture",
    title: "Offline fixture mode",
    message: "This AI result was loaded from a reviewed benchmark fixture and is not a live AI audit.",
    detail: "Local policies, execution attempts, and the deterministic verdict still ran for this request.",
  };
}

function repairWorkflow(investigation, classification, approval, application, notNeededReason = null) {
  if (notNeededReason) {
    return {
      proposal: {
        actor: investigation.mode === "live" ? "Codex (read-only)" : "Reviewed investigator record",
        status: "not-needed",
        description: notNeededReason,
        repairCandidateId: investigation.proposedRepair?.repairCandidateId || "none",
        classificationAdvisory: investigation.proposedRepair?.classificationAdvisory || "none",
        file: investigation.proposedRepair?.file || null,
        oldText: investigation.proposedRepair?.oldText || null,
        newText: investigation.proposedRepair?.newText || null,
      },
      classification: {
        actor: "Patch policy engine",
        agentRecommendation: investigation.proposedRepair?.classificationAdvisory || "none",
        policyClassification: "not-needed",
        classification: "not-needed",
        allowListMatch: null,
        status: "not-needed",
        rationale: notNeededReason,
      },
      approval: {
        actor: "Trusted case repair policy",
        status: "not-needed",
        mechanism: "No repair approval requested",
        scope: "No file write",
      },
      application: {
        actor: "Trusted fixture executor",
        status: "not-needed",
        file: null,
      },
    };
  }
  return {
    proposal: {
      actor: investigation.mode === "live" ? "Codex (read-only)" : "Reviewed investigator record",
      status: investigation.proposedRepair?.repairCandidateId === "none" ? "not-proposed" : "proposed",
      description: investigation.proposedRepair?.description || "No repair proposal.",
      repairCandidateId: investigation.proposedRepair?.repairCandidateId || "none",
      classificationAdvisory: investigation.proposedRepair?.classificationAdvisory || "none",
      file: investigation.proposedRepair?.file || null,
      oldText: investigation.proposedRepair?.oldText || null,
      newText: investigation.proposedRepair?.newText || null,
    },
    classification: classification || {
      actor: "Patch policy engine",
      agentRecommendation: investigation.proposedRepair?.classificationAdvisory || "none",
      policyClassification: "not-run",
      classification: "not-run",
      allowListMatch: null,
      status: "not-run",
      rationale: "Patch policy was not reached.",
    },
      approval: approval || {
      actor: "Trusted case repair policy",
      status: "not-run",
      mechanism: "No approval",
      scope: "No patch scope granted",
    },
    application: application || {
      actor: "Trusted fixture executor",
      status: "not-run",
      file: null,
    },
  };
}

function runWorkflow(investigation, classification, approval, attempts) {
  return {
    proposal: {
      actor: investigation.mode === "live" ? "Codex (read-only)" : "Reviewed investigator record",
      status: investigation.runPlan ? "proposed" : "not-proposed",
      plan: investigation.runPlan || null,
    },
    classification: classification || {
      actor: "Run policy engine",
      status: "not-run",
      classification: "not-run",
      checks: {},
      rationale: "Run policy was not reached.",
    },
    approval: approval || {
      actor: "Trusted case run policy",
      status: "not-run",
      approvedPlan: null,
      scope: "No execution scope granted",
    },
    attempts,
  };
}

function dataResolutionWorkflow(investigation, classification, approval) {
  return {
    proposal: {
      actor: investigation.mode === "live" ? "Codex (read-only)" : "Reviewed investigator record",
      status: investigation.repositoryResolution?.resolvedDataFile ? "proposed" : "not-proposed",
      paperDatasetLabel: null,
      ...investigation.repositoryResolution,
    },
    classification: classification || {
      actor: "Data-path policy engine",
      status: "not-run",
      classification: "not-run",
      checks: {},
      rationale: "Data-path policy was not reached.",
    },
    approval: approval || {
      actor: "Trusted benchmark data policy",
      status: "not-run",
      approvedDataFile: null,
      scope: "No repository data file approved",
    },
  };
}

function selectedClaimOrPlaceholder(claim, extraction) {
  if (claim) return claim;
  return {
    id: "no_executable_claim",
    text: "No executable quantitative claim was identified.",
    source: { pageLabel: null, section: null, paragraph: null, quote: extraction.noClaimsReason || "No claim quote available." },
    evidence: { datasetLabel: null, statisticalTest: null, testFamily: "other", missingEvidence: ["executable quantitative claim"] },
    reportedEvidence: { label: extraction.displayLabel },
    verification: null,
    executionSupport: { status: "extracted-only", message: extraction.noClaimsReason || "No executable quantitative claim was identified." },
  };
}

export async function runSampleAudit(projectRoot, {
  onEvent,
  extractionOptions,
  investigationOptions,
  executor = executeApprovedRunPlan,
  signal,
  expectedApplicationAdmission,
} = {}) {
  // The server and CLI admit before dynamic import; direct library callers are
  // also refused here before any audit workspace or audited artifact is read.
  const applicationAdmission = assertApplicationAdmissionContinuity(
    expectedApplicationAdmission,
    await admitApplicationBuild(applicationRoot),
  );
  const auditId = createRunId();
  const startedAt = nowIso();
  const runDirectory = path.join(projectRoot, ".peerproof", "runs", auditId);
  const repoDirectory = path.join(runDirectory, "repo");
  const sampleRoot = path.join(projectRoot, "samples", "fragile-study");
  const timeline = [];
  const record = makeRecorder(timeline, onEvent, { projectRoot, runDirectory });
  let extraction;
  let claim;
  let investigation = notRunInvestigation("Repository investigation has not started.");
  let dataClassification;
  let dataApproval;
  let runClassification;
  let runApproval;
  let asSubmitted = null;
  let repairedAttempt = null;
  let classification;
  let approval;
  let patch = null;
  let application = null;
  let repairNotNeededReason = null;
  let dataDependencyCheck = null;
  let machineLineage = null;
  let verifierRuntime = null;

  await mkdir(runDirectory, { recursive: true });
  await cp(path.join(sampleRoot, "repo"), repoDirectory, { recursive: true });

  const finish = async ({ verdict, comparison = null, robustness = null, execution = null }) => {
    const ledgerClaim = selectedClaimOrPlaceholder(claim, extraction);
    const disclosure = aiDisclosure(extraction, investigation);
    const canonicalExecution = execution?.repaired || execution?.asSubmitted || null;
    const patchLedger = patch || {
      classification: repairNotNeededReason ? "not-needed" : classification?.policyClassification || "none",
      approvedBy: approval?.actor || null,
      analyticalLogicChanged: false,
      file: null,
      beforeHash: null,
      afterHash: null,
      diff: repairNotNeededReason || "No patch was applied.",
    };
    const investigationTrace = {
      ...investigation,
      suggestedCommand: investigation.runPlan ? formatRunPlan(investigation.runPlan) : "No RunPlan proposed",
      approvedCommand: runApproval?.approvedPlan ? formatRunPlan(runApproval.approvedPlan) : "No RunPlan approved",
      commandAttempt: asSubmitted,
      proposedRepair: { ...investigation.proposedRepair, diff: patchLedger.diff },
      responsibilityBoundary: {
        investigator: "Inspects and proposes exact RunPlan and patch objects; no execution or write authority.",
        runPolicy: "Independently validates executable, literal args, cwd, artifact type, timeout, and trusted-fixture scope.",
        dataPolicy: verifierRuntime?.presentation?.dataPolicyDescription
          || "Separates the paper's dataset label from a verifier-owned evidence contract and exact repository file approval.",
        patchPolicy: "Independently derives an allow-list match from exact file/oldText/newText; investigator labels are advisory only.",
        executor: "Runs only checked-in trusted fixture code with the approved RunPlan. This host process is not an OS-level network or filesystem sandbox.",
      },
    };
    const resolvedDataWorkflow = dataResolutionWorkflow(investigation, dataClassification, dataApproval);
    resolvedDataWorkflow.proposal.paperDatasetLabel = ledgerClaim.evidence.datasetLabel || null;
    const executionEnvironment = await buildExecutionEnvironmentManifest(projectRoot, repoDirectory, runApproval);
    const runtimeProvenance = verifierRuntime
      ? Object.fromEntries(Object.entries(verifierRuntime.provenanceFiles).map(([key, file]) => {
        const identity = applicationAdmission.fileIdentities[file];
        if (!identity) throw new Error(`Verifier provenance file is absent from build admission: ${file}`);
        return [key, identity.canonicalSha256];
      }))
      : {};
    const applicationCommitProvenance = resolveApplicationCommitProvenance(applicationRoot);
    const audit = {
      schemaVersion: "1.9",
      id: auditId,
      auditStatus: "completed",
      status: "completed",
      mode: disclosure.status,
      aiDisclosure: disclosure,
      stageProvenance: [
        {
          stage: "Application admission",
          mode: "deterministic",
        label: "Unsigned local build · reviewed manifest match",
          detail: `${applicationAdmission.fileCount} implementation files matched the reviewed build manifest before this audit ran; the manifest is version-controlled but unsigned.`,
        },
        ...stageProvenance(extraction, ledgerClaim, investigation, dataApproval, verifierRuntime),
      ],
      case: sampleCaseMetadata,
      startedAt,
      completedAt: nowIso(),
      applicationAdmission: applicationAdmissionLedger(applicationAdmission, verifierRuntime),
      claim: ledgerClaim,
      investigation: investigationTrace,
      execution: execution || { asSubmitted, repaired: repairedAttempt },
      runWorkflow: runWorkflow(investigation, runClassification, runApproval, [asSubmitted, repairedAttempt].filter(Boolean)),
      dataResolutionWorkflow: resolvedDataWorkflow,
      evidenceSelectionAttestation: {
        status: dataApproval ? "declared-and-policy-approved" : "not-approved",
        paperStatement: {
          sourceAnchorStatus: ledgerClaim.sourceAnchor?.status || "not-available",
          page: ledgerClaim.sourceAnchor?.matchedPageNumber || ledgerClaim.source.pageLabel || null,
        },
        repositoryManifest: dataApproval ? {
          file: dataApproval.manifestFile,
          schemaVersion: dataApproval.contract.schemaVersion,
          status: "trusted reviewed assertion",
        } : null,
        loaderEvidence: investigation.repositoryResolution?.evidence || null,
        machineLineage,
        sourceDataset: dataApproval ? { file: dataApproval.approvedDataFile, hashRecorded: true } : null,
        preprocessing: dataApproval?.evidenceAttestation?.preprocessing
          || "No verifier-owned preprocessing attestation is available.",
        analysisReadyColumns: dataApproval?.evidenceAttestation?.analysisReadyFields || null,
        semanticMappingBoundary: "Paper-term to repository-column mappings are reviewed metadata, not independently proven scientific equivalence.",
      },
      executionEnvironment,
      architectureBoundaries: {
        arbitraryRepositoryExecution: false,
        auditedCodeIsolation: "Checked-in reviewed fixtures only; host child process without OS-level filesystem or network containment.",
        pdfSourceAnchoring: "Bounded child-process page text-layer matching without OS network isolation; scanned/image-only PDFs require future OCR.",
        auditStorage: "Single-process in-memory lookup with TTL plus local run artifacts; no durable queue or signed external ledger URL.",
        buildAuthenticity: applicationAdmission.trustBoundary,
      },
      dataDependencyCheck,
      repairWorkflow: repairWorkflow(investigation, classification, approval, application, repairNotNeededReason),
      patch: patchLedger,
      comparison: comparison || { kind: "unverifiable", reason: verdict.reason },
      robustness: robustness || { kind: "unverifiable", reason: verdict.reason },
      verdict,
      timeline,
      evidenceGraph: [
        { id: "claim", label: "Claim", value: ledgerClaim.text, status: claim ? "extracted" : "not-extracted", tone: claim ? "neutral" : "warning" },
        { id: "paper", label: "Paper source", value: ledgerClaim.source.pageLabel || ledgerClaim.source.section || "Not reported", status: ledgerClaim.sourceAnchor?.status === "anchored" ? "source-anchored" : "source-referenced", tone: ledgerClaim.sourceAnchor?.status === "anchored" ? "confirmed" : "warning" },
        { id: "paper-data", label: "Paper dataset label", value: ledgerClaim.evidence.datasetLabel || "Not identified", status: ledgerClaim.evidence.datasetLabel ? "reported" : "not-reported", tone: "neutral" },
        { id: "repo-data", label: "Repository data", value: dataApproval?.approvedDataFile || "Not approved", status: dataApproval ? "policy-approved" : "not-approved", tone: dataApproval ? "confirmed" : "warning" },
        { id: "run", label: "RunPlan", value: runApproval?.approvedPlan ? formatRunPlan(runApproval.approvedPlan) : "Not approved", status: runApproval ? "policy-approved" : "not-approved", tone: runApproval ? "confirmed" : "warning" },
        { id: "execution", label: "Execution", value: canonicalExecution?.exitCode === 0 ? "Artifact received" : "No canonical artifact", status: canonicalExecution?.exitCode === 0 ? "completed" : "not-completed", tone: canonicalExecution?.exitCode === 0 ? "confirmed" : "warning" },
        { id: "canonical", label: "Canonical result", value: canonicalExecution?.independentVerifier ? "Author ↔ verifier compared" : "Not independently checked", status: canonicalExecution?.independentVerifier ? "independently-checked" : "not-checked", tone: canonicalExecution?.independentVerifier ? "confirmed" : "warning" },
        { id: "lineage", label: "Static lineage", value: machineLineage?.reason || "Lineage trace not completed", status: machineLineage?.status || "not-checked", tone: machineLineage?.datasetReachable ? "confirmed" : "warning" },
        { id: "dependency", label: "Data dependency", value: dataDependencyCheck?.reason || "Canary not completed", status: dataDependencyCheck?.confirmed ? "canary-confirmed" : dataDependencyCheck?.status || "not-checked", tone: dataDependencyCheck?.confirmed ? "confirmed" : "warning" },
        { id: "verdict", label: "Verdict", value: verdict.label, status: "issued", tone: verdict.tone === "danger" ? "warning" : "neutral" },
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
        paperSha256: await sha256File(path.join(sampleRoot, "paper.md")),
        analysisSha256AsSubmitted: await sha256File(path.join(sampleRoot, "repo", "analysis.js")),
        repairedFileSha256AsSubmitted: patchLedger.beforeHash,
        repairedFileSha256Repaired: patchLedger.afterHash,
        evidenceManifestSha256: await sha256File(path.join(repoDirectory, dataApproval?.manifestFile || "peerproof.evidence.json")),
        datasetSha256: await sha256File(path.join(repoDirectory, dataApproval?.approvedDataFile || "data/study.csv")),
        ...runtimeProvenance,
        dataResolutionPolicySourceSha256: await sha256File(path.join(projectRoot, "src", "data-resolution-policy.js")),
        javascriptLineageSourceSha256: await sha256File(path.join(projectRoot, "src", "js-lineage.js")),
        evidencePackageContractSha256: dataApproval?.contract ? sha256(JSON.stringify(dataApproval.contract)) : null,
        repairPolicySourceSha256: await sha256File(path.join(projectRoot, "src", "repair-policy.js")),
        runPolicySourceSha256: await sha256File(path.join(projectRoot, "src", "run-policy.js")),
        policyRegistrySourceSha256: await sha256File(path.join(projectRoot, "src", "policy-registry.js")),
        casePolicyBundleSourceSha256: runApproval?.casePolicyBundle?.bundleSha256 || null,
        verificationPolicySourceSha256: await sha256File(path.join(projectRoot, "src", "verification-policy.js")),
        verifierRegistrySourceSha256: await sha256File(path.join(projectRoot, "src", "verifier-registry.js")),
        verifierRuntimeSourceFiles: verifierRuntime?.runtimeSourceFiles || [],
        verificationContractId: ledgerClaim.verification?.id || null,
        verifierRuntimeId: verifierRuntime?.id || null,
        verificationContractSha256: ledgerClaim.verification ? sha256(JSON.stringify(ledgerClaim.verification)) : null,
        claimPromptVersion: extraction.promptVersion || CLAIM_PROMPT_VERSION,
        claimSchemaVersion: extraction.schemaVersion || CLAIM_SCHEMA_VERSION,
        openAiResponseId: extraction.responseId || null,
        openAiRequestId: extraction.requestId || null,
        clientRequestId: extraction.clientRequestId || null,
        actualClaimModel: extraction.model || null,
        codexPromptVersion: investigation.promptVersion || CODEX_PROMPT_VERSION,
        codexSchemaVersion: investigation.schemaVersion || INVESTIGATION_SCHEMA_VERSION,
        codexThreadId: investigation.threadId || null,
        configuredCodexModel: investigation.model || null,
        codexSdkVersion: investigation.sdkVersion || CODEX_SDK_VERSION,
        verdictEngine: "PeerProof · deterministic verifier v2",
        executionRuntime: process.version,
        executionPlatform: executionEnvironment.platform,
        executionArchitecture: executionEnvironment.architecture,
        executionLocale: executionEnvironment.locale,
        executionTimeZone: executionEnvironment.timeZone,
        applicationLockSha256: executionEnvironment.applicationLockSha256,
        auditedProjectLockSha256: executionEnvironment.auditedProjectLockSha256,
        containerImageDigest: executionEnvironment.containerImageDigest,
        executionEnvironmentSha256: executionEnvironment.manifestSha256,
        executionPolicyProfile: executionEnvironment.executionPolicyProfile,
        executionCaseBinding: executionEnvironment.trustedCaseBinding,
        casePolicyBundleSha256: executionEnvironment.casePolicyBundleSha256,
      },
    };
    const publicAudit = redactAuditValue(audit, { projectRoot, runDirectory });
    await writeJson(path.join(runDirectory, "audit.json"), publicAudit);
    return publicAudit;
  };

  const unverifiable = async (reason, rule, stage) => {
    const verdict = {
      label: "Unverifiable",
      tone: "neutral",
      scope: "Audit completed without executable verification",
      reason,
      rule,
      blockingStage: stage,
    };
    await record(timelineEvent("verdict", "completed", "Unverifiable verdict issued", reason, { rule, blockingStage: stage }));
    return finish({ verdict });
  };

  const completeSuccessfulAttempt = async (attempt, source) => {
    let parsed;
    try {
      parsed = await verifierRuntime.verifyExecution({ claim, attempt, repoDirectory, dataApproval });
    } catch (error) {
      const normalized = verifierRuntime.normalizeError(error) || {
        category: "artifact",
        stage: "artifact",
        reason: `The verifier runtime rejected the execution artifact: ${error.message}`,
        rule: "Verifier runtime rejection -> Unverifiable",
      };
      if (normalized.category === "pipeline-mismatch") {
        const failedAttempt = verifierRuntime.buildExecutionRecord({
          attempt,
          execution: normalized.execution,
          includeRobustness: false,
        });
        const verdict = {
          label: "Failed",
          tone: "danger",
          scope: normalized.scope,
          reason: normalized.reason,
          rule: normalized.rule,
          blockingStage: normalized.stage,
        };
        await record(timelineEvent(
          normalized.stage,
          "blocked",
          normalized.title,
          normalized.detail,
          { comparison: normalized.comparison },
        ));
        await record(timelineEvent("verdict", "completed", "Failed verdict issued", verdict.reason, { rule: verdict.rule }));
        return finish({
          verdict,
          comparison: normalized.comparison,
          robustness: { kind: "unverifiable", reason: "Robustness was not interpreted after the canonical pipeline mismatch." },
          execution: source === "as-submitted"
            ? { asSubmitted: failedAttempt, repaired: null }
            : { asSubmitted, repaired: failedAttempt },
        });
      }
      await record(timelineEvent(normalized.stage, "blocked", "Verifier runtime rejected the execution evidence", error.message));
      return unverifiable(normalized.reason, normalized.rule, normalized.stage);
    }
    const { execution, verification } = parsed;
    const comparisonPresentation = verifierRuntime.presentation.comparisonSummary({ execution, source });
    await record(timelineEvent(
      "execute",
      "completed",
      comparisonPresentation.title,
      comparisonPresentation.detail,
      { command: attempt.command, approvedPlan: attempt.approvedPlan, exitCode: attempt.exitCode },
    ));
    const completedAttempt = verifierRuntime.buildExecutionRecord({ attempt, execution });
    try {
      machineLineage = await traceJavaScriptEvidenceLineage({
        repoDirectory,
        approvedPlan: runApproval.approvedPlan,
        approvedDataFile: dataApproval.approvedDataFile,
      });
    } catch (error) {
      machineLineage = {
        schemaVersion: "peerproof.javascript-lineage.v1",
        status: "not-statically-confirmed",
        reason: `The bounded static lineage trace could not complete: ${error.message}`,
        limitations: ["This result does not change the independent numerical canary outcome."],
      };
    }
    await record(timelineEvent(
      "evidence-lineage",
      machineLineage.datasetReachable ? "completed" : "disclosed",
      machineLineage.datasetReachable
        ? "Static repository-to-dataset lineage partially confirmed"
        : "Static repository-to-dataset lineage not confirmed",
      machineLineage.reason,
      { machineLineage },
    ));
    await record(timelineEvent(
      "data-dependency-canary",
      "completed",
      verifierRuntime.presentation.canaryPreparationTitle,
      verifierRuntime.presentation.canaryPreparationDetail({ dataApproval }),
    ));
    try {
      dataDependencyCheck = await verifierRuntime.runDataDependencyCanary({
        runDirectory,
        repoDirectory,
        dataApproval,
        runApproval,
        executor,
        signal,
      });
    } catch (error) {
      await record(timelineEvent("data-dependency-canary", "blocked", "Data-dependency canary could not be verified", error.message));
      return unverifiable(
        `The canonical result matched, but the author pipeline's dependency on the approved dataset could not be verified: ${error.message}`,
        "Canonical match without a valid data-dependency canary → Unverifiable",
        "data-dependency-canary",
      );
    }
    await record(timelineEvent(
      "data-dependency-canary",
      dataDependencyCheck.confirmed ? "completed" : "blocked",
      dataDependencyCheck.confirmed ? "Author pipeline data dependency confirmed" : "Author pipeline data dependency not confirmed",
      dataDependencyCheck.reason,
      { dataDependencyCheck },
    ));
    if (dataDependencyCheck.status === "indeterminate") {
      return unverifiable(
        dataDependencyCheck.reason,
        "Canary execution without a valid artifact → Unverifiable",
        "data-dependency-canary",
      );
    }
    if (!dataDependencyCheck.confirmed) {
      const verdict = {
        label: "Failed",
        tone: "danger",
        scope: "The author pipeline was numerically disconnected from the approved dataset canary",
        reason: dataDependencyCheck.reason,
        rule: "Canonical match + canary mismatch → Failed",
        blockingStage: "data-dependency-canary",
      };
      await record(timelineEvent("verdict", "completed", "Failed verdict issued", verdict.reason, { rule: verdict.rule }));
      return finish({
        verdict,
        comparison: { ...verification.comparison, dataDependencyConfirmed: false },
        robustness: { kind: "unverifiable", reason: "Robustness was not interpreted after the author pipeline failed its data-dependency canary." },
        execution: source === "as-submitted"
          ? { asSubmitted: completedAttempt, repaired: null }
          : { asSubmitted, repaired: completedAttempt },
      });
    }
    if (verification.verdict.label === "Unverifiable") {
      return unverifiable(verification.verdict.reason, verification.verdict.rule, "verifier");
    }
    const robustnessPresentation = verifierRuntime.presentation.robustnessSummary({ verification });
    await record(timelineEvent(
      "robustness",
      "completed",
      robustnessPresentation.title,
      robustnessPresentation.detail,
      { robustness: verification.robustness },
    ));
    await record(timelineEvent(
      "verdict",
      "completed",
      `${verification.verdict.label} verdict issued`,
      verification.verdict.reason,
      { rule: verification.verdict.rule },
    ));
    return finish({
      verdict: {
        ...verification.verdict,
        scope: verifierRuntime.presentation.verdictScope,
      },
      comparison: { ...verification.comparison, dataDependencyConfirmed: true },
      robustness: verification.robustness,
      execution: source === "as-submitted"
        ? { asSubmitted: completedAttempt, repaired: null }
        : { asSubmitted, repaired: completedAttempt },
    });
  };

  await record(timelineEvent(
    "ingest",
    "completed",
    "Evidence package sealed",
    "The reviewed repository package was copied into a per-audit workspace; paper, code, manifest, and data provenance are hashed in the final ledger.",
  ));

  extraction = await extractSampleClaim(projectRoot, {
    clientRequestId: `peerproof_${auditId}`,
    ...extractionOptions,
    signal,
  });
  claim = extraction.claim;
  await record(timelineEvent(
    "claim",
    "completed",
    extraction.mode === "live" ? "Reported evidence extracted by GPT-5.6" : "Reviewed reported evidence loaded",
    claim
      ? "Reported evidence was retained; PeerProof evaluated verifier support separately."
      : extraction.noClaimsReason || "No executable quantitative claim was identified.",
    { mode: extraction.mode, warning: extraction.warning, verificationPolicy: claim?.verification?.policyLabel || null },
  ));

  if (!claim) {
    return unverifiable(
      extraction.noClaimsReason || "No executable quantitative claim was identified.",
      "No selected quantitative claim → Unverifiable",
      "claim",
    );
  }
  if (claim.executionSupport?.status !== "supported" || !claim.verification) {
    return unverifiable(
      claim.executionSupport?.message || "The selected claim is outside the current verifier scope.",
      "Unsupported verifier contract → Unverifiable",
      "verification-policy",
    );
  }
  verifierRuntime = resolveVerifierRuntimeByContractId(claim.verification.id);
  if (!verifierRuntime) {
    return unverifiable(
      "The selected contract has no registered executable verifier runtime.",
      "Missing verifier runtime → Unverifiable",
      "verification-policy",
    );
  }

  investigation = await investigateRepository(repoDirectory, claim, { ...investigationOptions, signal });
  await record(timelineEvent(
    "investigate",
    "completed",
    investigation.mode === "live" ? "Codex identified the claim-producing execution path" : "Reviewed repository investigation loaded",
    investigation.summary,
    { mode: investigation.mode, warning: investigation.warning },
  ));
  await record(timelineEvent(
    "proposal",
    "completed",
    "Investigator proposed exact RunPlan and patch objects",
    `${investigation.runPlan ? formatRunPlan(investigation.runPlan) : "No RunPlan"}; ${investigation.proposedRepair.description}`,
    { runPlan: investigation.runPlan, proposal: investigation.proposedRepair },
  ));

  dataClassification = await classifyDataResolution(
    repoDirectory,
    investigation.repositoryResolution,
    claim,
    verifierRuntime,
  );
  await record(timelineEvent(
    "data-policy",
    dataClassification.status === "rejected" ? "blocked" : "completed",
    "Independent policy classified the repository data resolution",
    dataClassification.rationale,
    { dataClassification },
  ));
  if (dataClassification.status === "rejected") {
    return unverifiable(
      "The investigator's repository data resolution was ambiguous or outside the current evidence-package contract.",
      "Unapproved repository data file → Unverifiable",
      "data-policy",
    );
  }
  dataApproval = approveDataResolution(dataClassification, investigation.repositoryResolution);
  await record(timelineEvent(
    "data-approval",
    "completed",
    "Trusted data policy approved the exact repository file",
    `${dataApproval.approvedDataFile}; ${dataApproval.scope}.`,
    { dataApproval },
  ));

  runClassification = await classifyRunPlanWorkspace(
    repoDirectory,
    investigation.runPlan,
    LIGHTHOUSE_POLICY_CONTEXT,
  );
  await record(timelineEvent(
    "run-policy",
    runClassification.status === "rejected" ? "blocked" : "completed",
    "Independent policy classified the exact RunPlan",
    runClassification.rationale,
    { runClassification },
  ));
  if (runClassification.status === "rejected") {
    return unverifiable(
      "The investigator's RunPlan failed the independent execution allow-list.",
      "Unapproved RunPlan → Unverifiable",
      "run-policy",
    );
  }
  runApproval = approveRunPlan(runClassification, investigation.runPlan);
  await record(timelineEvent(
    "run-approval",
    "completed",
    "Trusted fixture policy approved the exact RunPlan",
    `${formatRunPlan(runApproval.approvedPlan)}; ${runApproval.scope}. No OS-level network isolation is claimed.`,
    { runApproval },
  ));

  asSubmitted = await executor(repoDirectory, runApproval, { signal });
  if (asSubmitted.status === "aborted") signal?.throwIfAborted();
  await record(timelineEvent(
    "execute",
    asSubmitted.exitCode === 0 ? "completed" : "blocked",
    asSubmitted.exitCode === 0 ? "As-submitted RunPlan completed" : "As-submitted RunPlan blocked",
    asSubmitted.exitCode === 0
      ? "The exact policy-approved RunPlan completed without modification."
      : asSubmitted.status === "timeout"
        ? "The exact policy-approved RunPlan exceeded its timeout."
        : "The exact policy-approved RunPlan confirmed the repository blocker before repair.",
    { command: asSubmitted.command, approvedPlan: asSubmitted.approvedPlan, exitCode: asSubmitted.exitCode, stderr: asSubmitted.stderr },
  ));
  if (asSubmitted.status === "timeout") {
    return unverifiable(
      `The policy-approved as-submitted RunPlan timed out after ${runApproval.approvedPlan.timeoutMs} ms.`,
      "Execution timeout → Unverifiable",
      "execution",
    );
  }
  if (asSubmitted.exitCode === 0) {
    repairNotNeededReason = "The as-submitted RunPlan completed successfully, so no repair was evaluated, approved, or applied.";
    await record(timelineEvent(
      "repair",
      "completed",
      "No repair required",
      repairNotNeededReason,
    ));
    return completeSuccessfulAttempt(asSubmitted, "as-submitted");
  }

  classification = await classifyRepairProposalForWorkspace(
    repoDirectory,
    investigation.proposedRepair,
    LIGHTHOUSE_POLICY_CONTEXT,
  );
  await record(timelineEvent(
    "patch-policy",
    classification.status === "rejected" ? "blocked" : "completed",
    "Independent policy classified the exact patch",
    classification.rationale,
    { classification },
  ));
  if (classification.status === "rejected") {
    return unverifiable(
      "The proposed repair was not one of the approved infrastructure-only transformations.",
      "Rejected or analytical patch → Unverifiable",
      "patch-policy",
    );
  }
  approval = approveRepair(classification, investigation.proposedRepair);
  await record(timelineEvent(
    "patch-approval",
    "completed",
    "Trusted fixture policy approved the exact patch",
    `${approval.mechanism}; approval scope: ${approval.scope}.`,
    { approval },
  ));

  try {
    patch = await applyInfrastructureRepair(repoDirectory, investigation.proposedRepair, classification, approval);
  } catch (error) {
    return unverifiable(
      `The approved repair could not be applied exactly: ${error.message}`,
      "Patch differs from approval or no longer applies → Unverifiable",
      "patch-execution",
    );
  }
  application = { actor: "Trusted fixture executor", status: "applied", file: patch.file, afterSha256: patch.afterHash };
  await record(timelineEvent(
    "repair",
    "completed",
    "Trusted fixture executor applied the approved investigator proposal",
    "The executor applied the exact proposal matched by policy; only data-path resolution changed.",
    { patch, application },
  ));

  repairedAttempt = await executor(repoDirectory, runApproval, { signal });
  if (repairedAttempt.status === "aborted") signal?.throwIfAborted();
  if (repairedAttempt.status === "timeout") {
    await record(timelineEvent("execute", "blocked", "Approved RunPlan timed out after repair", repairedAttempt.stderr, { command: repairedAttempt.command }));
    return unverifiable(
      `The policy-approved RunPlan timed out after ${runApproval.approvedPlan.timeoutMs} ms.`,
      "Execution timeout → Unverifiable",
      "execution",
    );
  }
  if (repairedAttempt.exitCode !== 0) {
    await record(timelineEvent("execute", "blocked", "Approved RunPlan still failed after repair", repairedAttempt.stderr, { command: repairedAttempt.command, exitCode: repairedAttempt.exitCode }));
    return unverifiable(
      "The approved repair did not produce a successful execution artifact.",
      "Non-zero repaired execution → Unverifiable",
      "execution",
    );
  }

  return completeSuccessfulAttempt(repairedAttempt, "repaired");
}

export { applyInfrastructureRepair, executeApprovedRunPlan, parseAndVerifyExecution };
