import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCasePolicyBundle } from "./case-policy-bundle.js";
import { CASE_POLICY_ASSETS } from "./runtime-assets.js";
import { sha256 } from "./utils.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function loadCaseBundle(asset) {
  const raw = readFileSync(path.join(projectRoot, ...asset.path.split("/")), "utf8");
  const bundle = validateCasePolicyBundle(JSON.parse(raw));
  return deepFreeze({ ...bundle, policyFile: asset.path, bundleSha256: sha256(raw) });
}

const nodeScriptProfile = deepFreeze({
  id: "peerproof.node-script.v1",
  label: "NodeScriptPolicy v1",
  executable: "node",
  argumentCount: { minimum: 1, maximum: 3 },
  entryExtensions: [".js", ".mjs", ".cjs"],
  expectedArtifacts: ["stdout-json"],
  timeoutMs: { minimum: 1_000, maximum: 30_000 },
  argumentForm: "literal repository-relative entry point; no shell syntax",
  filesystemAccess: "registered working directory and entry point inside reviewed fixture",
  dependencyHandling: "preinstalled runtime only; no dependency installation during audit",
  resourceLimits: { maxOutputBytes: 1024 * 1024, maxWallClockMs: 30_000 },
  executor: "trusted-fixture-host-process",
});

const caseBundles = CASE_POLICY_ASSETS.map(loadCaseBundle);

const trustedCases = deepFreeze(Object.fromEntries(caseBundles.map((bundle) => [bundle.id, bundle])));
const executionProfiles = deepFreeze({ [nodeScriptProfile.id]: nodeScriptProfile });

export const LIGHTHOUSE_POLICY_CONTEXT = deepFreeze({
  profileId: nodeScriptProfile.id,
  trustedCaseId: "peerproof.lighthouse-benchmark.v1",
});

export const NESTED_NODE_POLICY_CONTEXT = deepFreeze({
  profileId: nodeScriptProfile.id,
  trustedCaseId: "peerproof.nested-node-policy-eval.v1",
});

export function resolvePolicyContext(context) {
  const profile = executionProfiles[context?.profileId] || null;
  const trustedCase = trustedCases[context?.trustedCaseId] || null;
  const valid = Boolean(profile && trustedCase && trustedCase.profileId === profile.id);
  return { valid, profile: valid ? profile : null, trustedCase: valid ? trustedCase : null };
}

export function listExecutionPolicyProfiles() {
  return Object.values(executionProfiles).map((profile) => ({
    id: profile.id,
    label: profile.label,
    executor: profile.executor,
    argumentForm: profile.argumentForm,
    dependencyHandling: profile.dependencyHandling,
    resourceLimits: profile.resourceLimits,
  }));
}

export function listTrustedPolicyCases() {
  return Object.values(trustedCases).map((trustedCase) => ({
    id: trustedCase.id,
    label: trustedCase.label,
    profileId: trustedCase.profileId,
    scope: trustedCase.scope,
    bundleSchemaVersion: trustedCase.schemaVersion,
    policyFile: trustedCase.policyFile,
    bundleSha256: trustedCase.bundleSha256,
    repositoryRevisionType: trustedCase.repository.revisionType,
    repositoryContentHashMode: trustedCase.repository.contentHashMode,
    repositoryFileCount: Object.keys(trustedCase.repository.files).length,
    reviewStatus: trustedCase.review.status,
    approvalType: "version-controlled-maintainer-metadata",
    signed: false,
    signatureVerification: "unsupported",
    origin: structuredClone(trustedCase.origin),
  }));
}
