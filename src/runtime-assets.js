import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_ASSET_CLOSURE_SCHEMA_VERSION = "peerproof.runtime-asset-closure.v1";

function asset(relative, role, kind, options = {}) {
  return Object.freeze({ path: relative, role, kind, ...options });
}

export const CASE_POLICY_ASSETS = Object.freeze([
  asset("policies/cases/lighthouse-benchmark.v1.json", "trusted-case-policy", "case-policy"),
  asset("policies/cases/nested-node-policy-eval.v1.json", "trusted-case-policy", "case-policy", {
    includeRepositoryFilesInBuild: true,
  }),
]);

export const PUBLIC_EVIDENCE_POLICY_ASSETS = Object.freeze([
  asset("policies/public-cases/datasaurus-dozen.v1.json", "public-evidence-policy", "public-evidence-policy"),
]);

const STATIC_RUNTIME_ASSETS = Object.freeze([
  asset("package.json", "application-metadata", "application-metadata"),
  asset("package-lock.json", "dependency-lock", "dependency-lock"),
  asset("public/index.html", "judge-interface", "browser-entry-document"),
  asset("public/styles.css", "judge-interface", "browser-style"),
  asset("Dockerfile", "deployment-entry", "deployment-entry"),
  asset(".dockerignore", "deployment-policy", "deployment-policy"),
  asset("start.cmd", "launcher", "launcher"),
  asset("start.sh", "launcher", "launcher"),
  asset("samples/fragile-study/paper.md", "reviewed-benchmark-evidence", "reviewed-benchmark-evidence"),
  asset("scripts/generate-build-manifest.js", "release-integrity-tool", "release-integrity-tool"),
  asset("scripts/build-integrity-check.js", "release-integrity-tool", "release-integrity-tool"),
]);

export const REGISTERED_RUNTIME_ASSETS = Object.freeze([
  ...STATIC_RUNTIME_ASSETS,
  ...CASE_POLICY_ASSETS,
  ...PUBLIC_EVIDENCE_POLICY_ASSETS,
]);

export const POLICY_ASSET_DIRECTORIES = Object.freeze([
  "policies/cases",
  "policies/public-cases",
]);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function runtimeAssetClosureDescriptor() {
  const identity = {
    policyDirectories: [...POLICY_ASSET_DIRECTORIES],
    assets: REGISTERED_RUNTIME_ASSETS.map((entry) => ({ ...entry })),
  };
  return {
    schemaVersion: RUNTIME_ASSET_CLOSURE_SCHEMA_VERSION,
    ...identity,
    registrySha256: digest(identity),
  };
}

export function validateRuntimeAssetClosureDescriptor(descriptor) {
  const expected = runtimeAssetClosureDescriptor();
  if (JSON.stringify(descriptor) !== JSON.stringify(expected)) {
    throw new Error("build-integrity assetClosure must match the fixed runtime asset registry");
  }
  return descriptor;
}

async function inventoryPolicyDirectory(projectRoot, relative, nested = "") {
  const segments = nested ? nested.split("/") : [];
  const directory = path.join(projectRoot, ...relative.split("/"), ...segments);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  const unsupported = [];
  for (const entry of entries) {
    const child = nested ? `${nested}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const inventory = await inventoryPolicyDirectory(projectRoot, relative, child);
      files.push(...inventory.files);
      unsupported.push(...inventory.unsupported);
    } else if (entry.isFile()) files.push(`${relative}/${child}`);
    else unsupported.push(`${relative}/${child}`);
  }
  return { files, unsupported };
}

export async function inspectRuntimeAssetClosure(projectRoot, manifest) {
  const descriptor = runtimeAssetClosureDescriptor();
  const registered = new Map(descriptor.assets.map((entry) => [entry.path, entry]));
  const policyRoles = new Set(["trusted-case-policy", "public-evidence-policy"]);
  const registeredPolicies = descriptor.assets
    .filter((entry) => policyRoles.has(entry.role))
    .map((entry) => entry.path)
    .sort();
  const governedPolicies = Object.entries(manifest.files)
    .filter(([, identity]) => policyRoles.has(identity.role))
    .map(([relative]) => relative)
    .sort();
  const missingGoverned = descriptor.assets
    .filter((entry) => manifest.files[entry.path]?.role !== entry.role)
    .map((entry) => entry.path);
  const unregisteredGovernedPolicies = governedPolicies
    .filter((relative) => !registered.has(relative));
  const actualPolicyFiles = [];
  const unsupportedPolicyEntries = [];
  for (const directory of descriptor.policyDirectories) {
    const inventory = await inventoryPolicyDirectory(projectRoot, directory);
    actualPolicyFiles.push(...inventory.files);
    unsupportedPolicyEntries.push(...inventory.unsupported);
  }
  actualPolicyFiles.sort();
  const unregisteredOnDisk = actualPolicyFiles.filter((relative) => !registeredPolicies.includes(relative));
  const missingOnDisk = registeredPolicies.filter((relative) => !actualPolicyFiles.includes(relative));
  return {
    match: missingGoverned.length === 0
      && unregisteredGovernedPolicies.length === 0
      && unregisteredOnDisk.length === 0
      && missingOnDisk.length === 0
      && unsupportedPolicyEntries.length === 0,
    schemaVersion: descriptor.schemaVersion,
    registrySha256: descriptor.registrySha256,
    registeredAssetCount: descriptor.assets.length,
    registeredPolicyCount: registeredPolicies.length,
    registeredPolicies,
    governedPolicies,
    actualPolicyFiles,
    missingGoverned,
    unregisteredGovernedPolicies,
    unregisteredOnDisk,
    missingOnDisk,
    unsupportedPolicyEntries,
  };
}
