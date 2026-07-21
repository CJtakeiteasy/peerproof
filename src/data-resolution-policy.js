import { readFile } from "node:fs/promises";
import { resolveWorkspacePath } from "./workspace-path.js";

export async function classifyDataResolution(repoDirectory, resolution, claim, verifierRuntime) {
  try {
    if (!verifierRuntime?.id
      || typeof verifierRuntime.validateEvidenceManifest !== "function"
      || typeof verifierRuntime.evaluateEvidenceContract !== "function") {
      throw new Error("a registered executable verifier runtime is required");
    }
    const manifestPath = await resolveWorkspacePath(repoDirectory, resolution?.manifestFile, "manifestFile", { expectedType: "file" });
    const proposedDataPath = await resolveWorkspacePath(repoDirectory, resolution?.resolvedDataFile, "resolvedDataFile", { expectedType: "file" });
    const manifest = verifierRuntime.validateEvidenceManifest(
      JSON.parse(await readFile(manifestPath.resolved, "utf8")),
    );
    const declaredDataPath = await resolveWorkspacePath(repoDirectory, manifest.dataset, "manifest dataset", { expectedType: "file" });
    const contractEvaluation = verifierRuntime.evaluateEvidenceContract({ manifest, claim });
    const checks = {
      investigatorEvidencePresent: typeof resolution?.evidence === "string" && resolution.evidence.trim().length > 0,
      resolutionActorDeclared: ["Codex", "Reviewed fixture", "Recorded public investigation", "Not run"].includes(resolution?.resolvedBy),
      proposedFileMatchesManifest: proposedDataPath.normalized === declaredDataPath.normalized,
      manifestPathRealpathSafe: true,
      dataPathRealpathSafe: true,
      dataFileExists: true,
      ...contractEvaluation.checks,
    };
    const approved = Object.values(checks).every(Boolean);
    return {
      actor: "Data-path policy engine",
      verifierRuntimeId: verifierRuntime.id,
      status: approved ? "eligible-for-approval" : "rejected",
      classification: approved
        ? contractEvaluation.classification
        : contractEvaluation.rejectedClassification,
      checks,
      manifestFile: manifestPath.normalized,
      resolvedDataFile: declaredDataPath.normalized,
      contract: manifest,
      claimMapping: manifest.claimMapping,
      approvalMetadata: contractEvaluation.approval,
      rationale: approved
        ? `${contractEvaluation.approvedRationale} lstat and realpath checks keep both manifest and data inside the per-audit workspace.`
        : contractEvaluation.rejectedRationale,
    };
  } catch (error) {
    return {
      actor: "Data-path policy engine",
      verifierRuntimeId: verifierRuntime?.id || null,
      status: "rejected",
      classification: verifierRuntime?.evidenceContractDescription?.rejectedClassification
        || "ambiguous-or-unsupported-verifier-evidence",
      checks: {},
      manifestFile: resolution?.manifestFile || null,
      resolvedDataFile: resolution?.resolvedDataFile || null,
      contract: null,
      rationale: `Data resolution could not be validated: ${error.message}`,
    };
  }
}

export function approveDataResolution(classification, resolution) {
  if (classification?.status !== "eligible-for-approval" || !classification.contract
    || classification.checks?.manifestPathRealpathSafe !== true
    || classification.checks?.dataPathRealpathSafe !== true) {
    throw new Error("Data-path policy rejected the proposed repository data file");
  }
  return {
    actor: classification.approvalMetadata.actor,
    status: "approved",
    resolvedBy: resolution.resolvedBy,
    resolutionEvidence: resolution.evidence,
    manifestFile: classification.manifestFile,
    approvedDataFile: classification.resolvedDataFile,
    contract: structuredClone(classification.contract),
    verifierRuntimeId: classification.verifierRuntimeId,
    claimMapping: structuredClone(classification.claimMapping),
    mappingSource: "Reviewed evidence manifest",
    mappingAssertion: classification.approvalMetadata.mappingAssertion,
    evidenceAttestation: structuredClone(classification.approvalMetadata.evidenceAttestation),
    scope: classification.approvalMetadata.scope,
  };
}
