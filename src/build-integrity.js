import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  EVALUATION_RUNTIME_ENTRY_POINTS,
  inspectRuntimeClosureCoverage,
  PRODUCT_RUNTIME_ENTRY_POINTS,
} from "./runtime-closure.js";
import {
  inspectRuntimeAssetClosure,
  validateRuntimeAssetClosureDescriptor,
} from "./runtime-assets.js";

export const BUILD_MANIFEST_SCHEMA_VERSION = "peerproof.build-integrity-manifest.v3";
export const BUILD_MANIFEST_PATH = "policies/build-integrity.v3.json";
export const BUILD_HASH_MODE = "canonical-content-v1:utf8-newlines-to-lf-or-binary-raw";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class BuildIntegrityAdmissionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BuildIntegrityAdmissionError";
    this.code = "BUILD_INTEGRITY_ADMISSION_FAILED";
    this.details = details;
  }
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(bytes) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes)) {
    return {
      bytes: Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8"),
      canonicalization: "utf8-newlines-to-lf",
    };
  }
  return { bytes: Buffer.from(bytes), canonicalization: "binary-raw" };
}

function exactKeys(value, required, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) {
    throw new Error(`${label} fields must be exactly: ${required.join(", ")}${optional.length ? `; optional: ${optional.join(", ")}` : ""}`);
  }
}

function safeRelativePath(relative) {
  const normalized = String(relative).replaceAll("\\", "/");
  return normalized === relative
    && normalized === path.posix.normalize(normalized)
    && !path.posix.isAbsolute(normalized)
    && !normalized.startsWith("..")
    && normalized !== ".";
}

export function validateBuildIntegrityManifest(manifest) {
  exactKeys(manifest, [
    "schemaVersion", "application", "contentHashMode", "runtimeClosure", "assetClosure", "files", "review",
  ], "build-integrity manifest");
  if (manifest.schemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`build-integrity schemaVersion must be ${BUILD_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.contentHashMode !== BUILD_HASH_MODE) {
    throw new Error(`build-integrity contentHashMode must be ${BUILD_HASH_MODE}`);
  }
  exactKeys(manifest.application, ["name", "version"], "build-integrity application");
  if (manifest.application.name !== "peerproof"
    || typeof manifest.application.version !== "string"
    || !manifest.application.version) {
    throw new Error("build-integrity application identity is invalid");
  }
  exactKeys(manifest.runtimeClosure, [
    "schemaVersion",
    "productEntryPoints",
    "evaluationEntryPoints",
    "modules",
    "productClosureSha256",
    "evaluationClosureSha256",
  ], "build-integrity runtimeClosure");
  if (manifest.runtimeClosure.schemaVersion !== "peerproof.runtime-closure.v1") {
    throw new Error("build-integrity runtimeClosure schemaVersion is unsupported");
  }
  for (const field of ["productEntryPoints", "evaluationEntryPoints", "modules"]) {
    const values = manifest.runtimeClosure[field];
    if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== "string" || !safeRelativePath(value))
      || new Set(values).size !== values.length) {
      throw new Error(`build-integrity runtimeClosure.${field} must contain unique safe paths`);
    }
  }
  for (const [field, required] of [
    ["productEntryPoints", PRODUCT_RUNTIME_ENTRY_POINTS],
    ["evaluationEntryPoints", EVALUATION_RUNTIME_ENTRY_POINTS],
  ]) {
    const observed = [...manifest.runtimeClosure[field]].sort();
    const expected = [...required].sort();
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error(`build-integrity runtimeClosure.${field} must match the fixed admission roots`);
    }
  }
  if (!SHA256_PATTERN.test(manifest.runtimeClosure.productClosureSha256)
    || !SHA256_PATTERN.test(manifest.runtimeClosure.evaluationClosureSha256)) {
    throw new Error("build-integrity runtimeClosure hashes must be SHA-256 identities");
  }
  validateRuntimeAssetClosureDescriptor(manifest.assetClosure);
  if (!manifest.files || Object.keys(manifest.files).length < 10) {
    throw new Error("build-integrity files must contain the governed application surface");
  }
  for (const [relative, identity] of Object.entries(manifest.files)) {
    if (!safeRelativePath(relative)) throw new Error(`build-integrity path is unsafe: ${relative}`);
    exactKeys(
      identity,
      ["canonicalSha256", "role"],
      `build-integrity file ${relative}`,
      ["archiveSubstitution"],
    );
    if (!SHA256_PATTERN.test(identity.canonicalSha256)
      || typeof identity.role !== "string"
      || !identity.role) {
      throw new Error(`build-integrity identity is invalid: ${relative}`);
    }
    if (identity.archiveSubstitution !== undefined
      && identity.archiveSubstitution !== "git-format-commit") {
      throw new Error(`build-integrity archiveSubstitution is unsupported: ${relative}`);
    }
  }
  for (const relative of manifest.runtimeClosure.modules) {
    if (!manifest.files[relative]) {
      throw new Error(`build-integrity runtime closure module is not governed: ${relative}`);
    }
  }
  const registeredAssets = new Map(manifest.assetClosure.assets.map((entry) => [entry.path, entry]));
  for (const entry of manifest.assetClosure.assets) {
    if (manifest.files[entry.path]?.role !== entry.role) {
      throw new Error(`build-integrity registered runtime asset is not governed with its declared role: ${entry.path}`);
    }
  }
  for (const [relative, identity] of Object.entries(manifest.files)) {
    if (["trusted-case-policy", "public-evidence-policy"].includes(identity.role)
      && registeredAssets.get(relative)?.role !== identity.role) {
      throw new Error(`build-integrity governed policy is not registered: ${relative}`);
    }
  }
  const roles = new Set(Object.values(manifest.files).map((identity) => identity.role));
  for (const requiredRole of [
    "application-entry",
    "cli-entry",
    "dependency-lock",
    "admission-policy",
    "audit-orchestrator",
    "verifier-registry",
    "verifier-runtime",
    "statistical-helper",
    "verdict-policy",
  ]) {
    if (!roles.has(requiredRole)) throw new Error(`build-integrity files require role ${requiredRole}`);
  }
  exactKeys(manifest.review, ["status", "approvedBy", "approvedAt", "signature"], "build-integrity review");
  if (manifest.review.status !== "reviewed-committed"
    || typeof manifest.review.approvedBy !== "string"
    || !manifest.review.approvedBy
    || typeof manifest.review.approvedAt !== "string"
    || !manifest.review.approvedAt
    || manifest.review.signature !== null) {
    throw new Error("build-integrity review must be committed and explicitly unsigned");
  }
  return manifest;
}

function identityBytes(canonical, identity, relative) {
  if (identity.archiveSubstitution !== "git-format-commit") return canonical;
  const text = canonical.toString("utf8");
  const pattern = /const ARCHIVE_COMMIT = "(?:\$Format:%H\$|[a-f0-9]{40})";/i;
  if (!pattern.test(text)) {
    throw new BuildIntegrityAdmissionError(`Expected Git archive commit placeholder is absent: ${relative}`, {
      file: relative,
      reason: "archive-substitution-shape",
    });
  }
  return Buffer.from(
    text.replace(pattern, 'const ARCHIVE_COMMIT = "$Format:%H$";'),
    "utf8",
  );
}

async function resolveGovernedFile(root, rootRealPath, relative) {
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new BuildIntegrityAdmissionError(`Governed build path is a symbolic link: ${relative}`, {
        file: relative,
        reason: "symbolic-link",
      });
    }
  }
  const resolved = await realpath(current);
  const relativeToRoot = path.relative(rootRealPath, resolved);
  if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new BuildIntegrityAdmissionError(`Governed build path escaped the application root: ${relative}`, {
      file: relative,
      reason: "realpath-outside-root",
    });
  }
  const details = await lstat(resolved);
  if (!details.isFile()) {
    throw new BuildIntegrityAdmissionError(`Governed build path is not a file: ${relative}`, {
      file: relative,
      reason: "not-file",
    });
  }
  return resolved;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export async function inspectApplicationBuild(projectRoot, {
  manifestPath = BUILD_MANIFEST_PATH,
} = {}) {
  const root = path.resolve(projectRoot);
  const rootRealPath = await realpath(root);
  const manifestFile = await resolveGovernedFile(root, rootRealPath, manifestPath);
  const manifestRawBytes = await readFile(manifestFile);
  const manifestCanonical = canonicalize(manifestRawBytes);
  let manifest;
  try {
    manifest = validateBuildIntegrityManifest(JSON.parse(manifestCanonical.bytes.toString("utf8")));
  } catch (error) {
    throw new BuildIntegrityAdmissionError(`Build-integrity manifest is invalid: ${error.message}`, {
      manifestPath,
      reason: "invalid-manifest",
    });
  }
  let runtimeClosure;
  try {
    runtimeClosure = await inspectRuntimeClosureCoverage(root, manifest);
  } catch (error) {
    throw new BuildIntegrityAdmissionError(`Runtime closure could not be validated: ${error.message}`, {
      manifestPath,
      reason: "runtime-closure-validation-failed",
      closureDetails: error.details || null,
    });
  }
  if (!runtimeClosure.match) {
    throw new BuildIntegrityAdmissionError(
      "Reachable first-party runtime closure is not completely governed by the build manifest.",
      {
        manifestPath,
        reason: "runtime-closure-incomplete",
        missingFromManifest: runtimeClosure.missingFromManifest,
        undeclaredReachable: runtimeClosure.undeclaredReachable,
        staleDeclared: runtimeClosure.staleDeclared,
      },
    );
  }
  let assetClosure;
  try {
    assetClosure = await inspectRuntimeAssetClosure(root, manifest);
  } catch (error) {
    throw new BuildIntegrityAdmissionError(`Runtime asset closure could not be validated: ${error.message}`, {
      manifestPath,
      reason: "runtime-asset-closure-validation-failed",
    });
  }
  if (!assetClosure.match) {
    throw new BuildIntegrityAdmissionError(
      "Registered runtime assets and governed policy inventories are not in exact correspondence.",
      {
        manifestPath,
        reason: "runtime-asset-closure-incomplete",
        missingGoverned: assetClosure.missingGoverned,
        unregisteredGovernedPolicies: assetClosure.unregisteredGovernedPolicies,
        unregisteredOnDisk: assetClosure.unregisteredOnDisk,
        missingOnDisk: assetClosure.missingOnDisk,
        unsupportedPolicyEntries: assetClosure.unsupportedPolicyEntries,
      },
    );
  }
  const mismatched = [];
  const missing = [];
  const fileIdentities = {};
  const canonicalFileBytes = new Map();
  for (const [relative, expected] of Object.entries(manifest.files)) {
    try {
      const resolved = await resolveGovernedFile(root, rootRealPath, relative);
      const rawBytes = await readFile(resolved);
      const canonical = canonicalize(rawBytes);
      const governedBytes = identityBytes(canonical.bytes, expected, relative);
      const observed = {
        role: expected.role,
        expectedCanonicalSha256: expected.canonicalSha256,
        rawSha256: hash(rawBytes),
        canonicalSha256: hash(governedBytes),
        canonicalization: expected.archiveSubstitution
          ? `${canonical.canonicalization}+${expected.archiveSubstitution}`
          : canonical.canonicalization,
      };
      fileIdentities[relative] = observed;
      canonicalFileBytes.set(relative, governedBytes);
      if (observed.canonicalSha256 !== expected.canonicalSha256) {
        mismatched.push({ file: relative, expected: expected.canonicalSha256, observed: observed.canonicalSha256 });
      }
    } catch (error) {
      if (error?.code === "ENOENT") missing.push(relative);
      else if (error instanceof BuildIntegrityAdmissionError) throw error;
      else throw new BuildIntegrityAdmissionError(`Could not inspect governed build file ${relative}: ${error.message}`, {
        file: relative,
        reason: "inspection-failed",
      });
    }
  }
  if (canonicalFileBytes.has("package.json")) {
    try {
      const packageMetadata = JSON.parse(canonicalFileBytes.get("package.json").toString("utf8"));
      if (packageMetadata.name !== manifest.application.name
        || packageMetadata.version !== manifest.application.version) {
        mismatched.push({
          file: "package.json#/name,version",
          expected: manifest.application,
          observed: { name: packageMetadata.name, version: packageMetadata.version },
        });
      }
    } catch (error) {
      mismatched.push({ file: "package.json", expected: "valid JSON application metadata", observed: error.message });
    }
  }
  return {
    match: missing.length === 0 && mismatched.length === 0,
    manifest,
    manifestPath,
    manifestRawSha256: hash(manifestRawBytes),
    manifestCanonicalSha256: hash(manifestCanonical.bytes),
    manifestCanonicalization: manifestCanonical.canonicalization,
    runtimeClosure,
    assetClosure,
    missing,
    mismatched,
    fileIdentities,
  };
}

export async function admitApplicationBuild(projectRoot, options) {
  const inspection = await inspectApplicationBuild(projectRoot, options);
  if (!inspection.match) {
    throw new BuildIntegrityAdmissionError(
      "Application build did not match the reviewed integrity manifest; audit execution was refused.",
      {
        manifestPath: inspection.manifestPath,
        missing: inspection.missing,
        mismatched: inspection.mismatched,
      },
    );
  }
  const verifierFiles = Object.entries(inspection.fileIdentities)
    .filter(([, identity]) => identity.role === "verifier-runtime");
  return deepFreeze({
    schemaVersion: "peerproof.application-admission-receipt.v1",
    actor: "PeerProof build-integrity admission",
    status: "exact-match",
    contentHashMode: inspection.manifest.contentHashMode,
    manifestFile: inspection.manifestPath,
    buildManifestRawSha256: inspection.manifestRawSha256,
    buildManifestSha256: inspection.manifestCanonicalSha256,
    buildManifestCanonicalization: inspection.manifestCanonicalization,
    application: structuredClone(inspection.manifest.application),
    reviewedManifest: structuredClone(inspection.manifest),
    fileCount: Object.keys(inspection.fileIdentities).length,
    fileIdentities: inspection.fileIdentities,
    runtimeClosure: {
      schemaVersion: inspection.runtimeClosure.product.schemaVersion,
      productClosureSha256: inspection.runtimeClosure.product.closureSha256,
      evaluationClosureSha256: inspection.runtimeClosure.evaluations.closureSha256,
      productModuleCount: inspection.runtimeClosure.product.modules.length,
      evaluationModuleCount: inspection.runtimeClosure.evaluations.modules.length,
      allReachableModulesGoverned: true,
    },
    assetClosure: {
      schemaVersion: inspection.assetClosure.schemaVersion,
      registrySha256: inspection.assetClosure.registrySha256,
      registeredAssetCount: inspection.assetClosure.registeredAssetCount,
      registeredPolicyCount: inspection.assetClosure.registeredPolicyCount,
      allRegisteredAssetsGoverned: true,
      policyInventoryExact: true,
    },
    verifierFilesMatched: verifierFiles.length > 0,
    signatureStatus: "unsigned-version-controlled-manifest",
    signed: false,
    trustBoundary: "PeerProof detects drift from its version-controlled reviewed manifest under a trusted local runtime; it is not hostile-runtime attestation or a signed release guarantee.",
  });
}

export function assertApplicationAdmissionContinuity(expected, observed) {
  if (!expected) return observed;
  if (expected.status !== "exact-match"
    || observed.status !== "exact-match"
    || expected.buildManifestSha256 !== observed.buildManifestSha256) {
    throw new BuildIntegrityAdmissionError(
      "Application admission changed after audit runtimes were loaded; execution was refused.",
      {
        expectedBuildManifestSha256: expected.buildManifestSha256,
        observedBuildManifestSha256: observed.buildManifestSha256,
        reason: "runtime-load-admission-discontinuity",
      },
    );
  }
  return observed;
}
