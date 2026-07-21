import path from "node:path";
import { sha256, sha256File } from "./utils.js";

async function optionalFileHash(filePath) {
  try {
    return await sha256File(filePath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

export async function buildExecutionEnvironmentManifest(projectRoot, repoDirectory, runApproval) {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const manifest = {
    schemaVersion: "peerproof.execution-environment.v1",
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
    locale: resolved.locale || null,
    timeZone: resolved.timeZone || null,
    executorEnvironmentKeys: ["PATH"],
    randomSeed: "not-used-by-current-deterministic-fixtures",
    applicationLockfile: "package-lock.json",
    applicationLockSha256: await optionalFileHash(path.join(projectRoot, "package-lock.json")),
    auditedProjectLockSha256: await optionalFileHash(path.join(repoDirectory, "package-lock.json")),
    containerImageDigest: null,
    nativeNumericalLibraries: [],
    executionPolicyProfile: runApproval?.profileId || null,
    trustedCaseBinding: runApproval?.trustedCaseId || null,
    casePolicyBundleSha256: runApproval?.casePolicyBundle?.bundleSha256 || null,
    casePolicyApprovalType: runApproval?.casePolicyBundle?.approvalType || null,
    casePolicySignatureVerification: runApproval?.casePolicyBundle?.signatureVerification || null,
    caseOrigin: runApproval?.casePolicyBundle?.origin
      ? structuredClone(runApproval.casePolicyBundle.origin)
      : null,
    executionResourceLimits: runApproval?.resourceLimits || null,
    containment: {
      trustedFixtureOnly: true,
      arbitraryRepositoryExecution: false,
      osSandbox: false,
      networkIsolation: "not-enforced",
      sourceMount: "per-audit writable copy",
      nonRootGuaranteedByExecutor: false,
      processTreeTermination: "not-guaranteed",
    },
  };
  return { ...manifest, manifestSha256: sha256(JSON.stringify(manifest)) };
}
