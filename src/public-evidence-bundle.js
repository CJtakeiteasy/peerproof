import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_EVIDENCE_POLICY_ASSETS } from "./runtime-assets.js";
import { sha256 } from "./utils.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "peerproof.public-evidence-bundle.v2";
export const PUBLIC_EVIDENCE_HASH_MODE = "canonical-content-v1:utf8-newlines-to-lf-or-binary-raw";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_BLOB_PATTERN = /^[a-f0-9]{40}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const PAPER_SOURCE_SCHEMA_VERSION = "peerproof.reviewed-paper-source.v1";
const INVESTIGATION_SCHEMA_VERSION = "peerproof.recorded-investigation.v2";
const SUMMARY_METRICS = Object.freeze(["meanX", "meanY", "sdX", "sdY", "correlation"]);

export class PublicEvidenceAdmissionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PublicEvidenceAdmissionError";
    this.code = "PUBLIC_EVIDENCE_ADMISSION_FAILED";
    this.details = details;
  }
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

function canonicalBytes(bytes) {
  return canonicalize(bytes).bytes;
}

function gitBlobSha1(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
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

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
}

function stringArray(value, label, { minimum = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minimum
    || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
}

function validFileEntry(relative, identity) {
  const normalized = relative.replaceAll("\\", "/");
  return relative === normalized
    && normalized === path.posix.normalize(normalized)
    && !path.posix.isAbsolute(normalized)
    && !normalized.startsWith("..")
    && identity
    && SHA256_PATTERN.test(identity.canonicalSha256)
    && (identity.canonicalGitBlobSha1 === undefined
      || GIT_BLOB_PATTERN.test(identity.canonicalGitBlobSha1))
    && Object.keys(identity).every((key) => ["canonicalSha256", "canonicalGitBlobSha1"].includes(key));
}

export function validatePublicEvidenceBundle(bundle) {
  exactKeys(bundle, [
    "schemaVersion",
    "id",
    "label",
    "scope",
    "verifierContractId",
    "contentHashMode",
    "sourcePath",
    "policyFile",
    "origin",
    "files",
    "sourceRecord",
    "investigationRecord",
    "evidenceManifest",
    "case",
    "claim",
    "upstreamExecution",
    "verdictScopeDisclosure",
    "review",
  ], "public-evidence bundle", ["bundleSha256"]);
  if (!bundle || bundle.schemaVersion !== PUBLIC_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("unsupported public-evidence bundle schemaVersion");
  }
  for (const field of [
    "id",
    "label",
    "scope",
    "verifierContractId",
    "sourcePath",
    "sourceRecord",
    "investigationRecord",
    "policyFile",
  ]) {
    if (typeof bundle[field] !== "string" || !bundle[field]) throw new Error(`public-evidence ${field} is required`);
  }
  if (bundle.contentHashMode !== PUBLIC_EVIDENCE_HASH_MODE) {
    throw new Error(`public-evidence contentHashMode must be ${PUBLIC_EVIDENCE_HASH_MODE}`);
  }
  if (bundle.bundleSha256 !== undefined && !SHA256_PATTERN.test(bundle.bundleSha256)) {
    throw new Error("public-evidence bundleSha256 must be a SHA-256 identity");
  }
  exactKeys(bundle.origin, [
    "type",
    "repository",
    "repositoryCommit",
    "dataMirror",
    "dataMirrorCommit",
    "doi",
    "license",
    "paperLicensingStatus",
    "authorityStatus",
    "originVerification",
  ], "public-evidence origin");
  if (bundle.origin.type !== "cross-source-public-snapshot") {
    throw new Error("public-evidence origin type is unsupported");
  }
  for (const field of ["repository", "dataMirror", "doi", "license", "paperLicensingStatus", "authorityStatus"]) {
    requiredString(bundle.origin[field], `public-evidence origin.${field}`);
  }
  if (!COMMIT_PATTERN.test(bundle.origin.repositoryCommit)
    || !COMMIT_PATTERN.test(bundle.origin.dataMirrorCommit)) {
    throw new Error("public-evidence origin commits must be full Git object identities");
  }
  exactKeys(bundle.origin.originVerification, [
    "status",
    "method",
    "receipt",
  ], "public-evidence originVerification");
  if (bundle.origin.originVerification.status !== "declared-not-cryptographically-verified"
    || bundle.origin.originVerification.method !== "version-controlled-maintainer-attestation"
    || bundle.origin.originVerification.receipt !== null) {
    throw new Error("public-evidence originVerification must disclose the absence of upstream cryptographic verification");
  }
  if (!bundle.files || Object.keys(bundle.files).length === 0) throw new Error("public-evidence files are required");
  for (const [relative, identity] of Object.entries(bundle.files)) {
    if (!validFileEntry(relative, identity)) throw new Error(`invalid public-evidence file identity: ${relative}`);
  }
  if (!bundle.files[bundle.sourceRecord]) throw new Error("public-evidence sourceRecord must be identity-pinned");
  if (!bundle.files[bundle.investigationRecord]) {
    throw new Error("public-evidence investigationRecord must be identity-pinned");
  }
  exactKeys(bundle.evidenceManifest, [
    "schemaVersion",
    "dataset",
    "columns",
    "expectedDatasets",
    "rowsPerDataset",
    "duplicateRows",
    "numericValues",
    "reportedTargetsSource",
    "artifact",
  ], "public-evidence evidenceManifest");
  if (bundle.evidenceManifest.schemaVersion !== "peerproof.summary-matrix-evidence.v1"
    || typeof bundle.evidenceManifest.dataset !== "string"
    || !bundle.files[bundle.evidenceManifest.dataset]
    || JSON.stringify(bundle.evidenceManifest.columns) !== JSON.stringify(["dataset", "x", "y"])
    || !Array.isArray(bundle.evidenceManifest.expectedDatasets)
    || bundle.evidenceManifest.expectedDatasets.length < 2
    || new Set(bundle.evidenceManifest.expectedDatasets).size !== bundle.evidenceManifest.expectedDatasets.length
    || bundle.evidenceManifest.expectedDatasets.some((item) => typeof item !== "string" || !item)
    || !Number.isInteger(bundle.evidenceManifest.rowsPerDataset)
    || bundle.evidenceManifest.rowsPerDataset < 2
    || bundle.evidenceManifest.duplicateRows !== "reject"
    || bundle.evidenceManifest.numericValues !== "finite-strict-decimal"
    || bundle.evidenceManifest.artifact !== "independent-read-only") {
    throw new Error("public-evidence evidenceManifest is invalid or unsupported");
  }
  if (bundle.evidenceManifest.reportedTargetsSource !== `${bundle.sourceRecord}#/anchor/reportedTargets`) {
    throw new Error("public-evidence reportedTargetsSource must reference the admitted sourceRecord");
  }

  exactKeys(bundle.case, [
    "kind", "title", "subtitle", "description", "reportedFigure", "repositoryEntryPoint",
    "paperUrl", "repositoryUrl", "package",
  ], "public-evidence case");
  for (const field of ["kind", "title", "subtitle", "description", "reportedFigure", "repositoryEntryPoint", "paperUrl", "repositoryUrl"]) {
    requiredString(bundle.case[field], `public-evidence case.${field}`);
  }
  exactKeys(bundle.case.package, ["paper", "repository", "dataset", "claim"], "public-evidence case.package");
  for (const field of ["paper", "repository", "dataset", "claim"]) {
    requiredString(bundle.case.package[field], `public-evidence case.package.${field}`);
  }

  exactKeys(bundle.claim, ["id", "text", "evidence"], "public-evidence claim");
  requiredString(bundle.claim.id, "public-evidence claim.id");
  requiredString(bundle.claim.text, "public-evidence claim.text");
  exactKeys(bundle.claim.evidence, [
    "testFamily", "effectType", "datasetLabel", "precisionRule", "statisticalTest",
  ], "public-evidence claim.evidence");
  for (const field of ["testFamily", "effectType", "datasetLabel", "precisionRule", "statisticalTest"]) {
    requiredString(bundle.claim.evidence[field], `public-evidence claim.evidence.${field}`);
  }

  exactKeys(bundle.upstreamExecution, ["status", "command", "stderr", "blocker"], "public-evidence upstreamExecution");
  for (const field of ["status", "command", "stderr"]) {
    requiredString(bundle.upstreamExecution[field], `public-evidence upstreamExecution.${field}`);
  }
  exactKeys(bundle.upstreamExecution.blocker, ["type", "file", "line", "description"], "public-evidence upstreamExecution.blocker");
  requiredString(bundle.upstreamExecution.blocker.type, "public-evidence upstreamExecution.blocker.type");
  requiredString(bundle.upstreamExecution.blocker.file, "public-evidence upstreamExecution.blocker.file");
  requiredString(bundle.upstreamExecution.blocker.description, "public-evidence upstreamExecution.blocker.description");
  if (!Number.isInteger(bundle.upstreamExecution.blocker.line) || bundle.upstreamExecution.blocker.line < 1) {
    throw new Error("public-evidence upstreamExecution.blocker.line must be a positive integer");
  }

  exactKeys(bundle.verdictScopeDisclosure, ["dataChain", "doesNotMean"], "public-evidence verdictScopeDisclosure");
  requiredString(bundle.verdictScopeDisclosure.dataChain, "public-evidence verdictScopeDisclosure.dataChain");
  requiredString(bundle.verdictScopeDisclosure.doesNotMean, "public-evidence verdictScopeDisclosure.doesNotMean");

  exactKeys(bundle.review, [
    "status", "approvedBy", "approvedAt", "approvalEvidence", "signature",
  ], "public-evidence review");
  if (bundle.review.status !== "reviewed-committed") {
    throw new Error("public-evidence bundle requires reviewed-committed status");
  }
  for (const field of ["approvedBy", "approvedAt", "approvalEvidence"]) {
    requiredString(bundle.review[field], `public-evidence review.${field}`);
  }
  if (bundle.review.signature !== null) {
    throw new Error("cryptographic public-evidence signatures are not supported or verified in this build");
  }
  return bundle;
}

export function validatePaperSourceRecord(record, bundle) {
  exactKeys(record, [
    "schemaVersion", "title", "doi", "publicationUrl", "retrievedAt", "documentArtifact", "anchor", "review",
  ], "paper-source record");
  if (record.schemaVersion !== PAPER_SOURCE_SCHEMA_VERSION) throw new Error("unsupported paper-source schemaVersion");
  for (const field of ["title", "doi", "publicationUrl", "retrievedAt"]) requiredString(record[field], `paper-source ${field}`);
  if (record.doi !== bundle.origin.doi) throw new Error("paper-source DOI must match bundle origin");
  exactKeys(record.documentArtifact, ["redistributed", "sha256", "reason"], "paper-source documentArtifact");
  if (record.documentArtifact.redistributed !== false || record.documentArtifact.sha256 !== null) {
    throw new Error("paper-source artifact must disclose that it is not redistributed or hash-anchored");
  }
  requiredString(record.documentArtifact.reason, "paper-source documentArtifact.reason");
  exactKeys(record.anchor, ["status", "pageLabel", "section", "figure", "quote", "reportedTargets"], "paper-source anchor");
  if (record.anchor.status !== "reviewed-transcription-not-artifact-anchored") {
    throw new Error("paper-source anchor status must disclose reviewed transcription without artifact anchoring");
  }
  for (const field of ["pageLabel", "section", "figure", "quote"]) requiredString(record.anchor[field], `paper-source anchor.${field}`);
  exactKeys(record.anchor.reportedTargets, SUMMARY_METRICS, "paper-source reportedTargets");
  for (const metric of SUMMARY_METRICS) {
    const target = record.anchor.reportedTargets[metric];
    exactKeys(target, ["value", "decimals"], `paper-source reportedTargets.${metric}`);
    if (typeof target.value !== "string" || !STRICT_NUMBER.test(target.value)
      || !Number.isFinite(Number(target.value))
      || !Number.isInteger(target.decimals) || target.decimals < 0 || target.decimals > 12) {
      throw new Error(`paper-source reportedTargets.${metric} is invalid`);
    }
  }
  exactKeys(record.review, ["status", "reviewedBy", "reviewedAt", "licensingStatus", "signature"], "paper-source review");
  if (record.review.status !== "reviewed-committed" || record.review.signature !== null) {
    throw new Error("paper-source review must be committed and unsigned-disclosed");
  }
  for (const field of ["reviewedBy", "reviewedAt", "licensingStatus"]) requiredString(record.review[field], `paper-source review.${field}`);
  return record;
}

export function validateRecordedInvestigationRecord(record, bundle) {
  exactKeys(record, [
    "schemaVersion", "recordedAt", "case", "mode", "currentRunModelCall", "displayLabel", "disclosure",
    "summary", "hypothesis", "entryPoint", "inspectedFiles", "proposedStrategy", "limitations", "review",
  ], "recorded-investigation record");
  if (record.schemaVersion !== INVESTIGATION_SCHEMA_VERSION
    || record.mode !== "recorded-public-case"
    || record.currentRunModelCall !== false) {
    throw new Error("recorded-investigation mode contract is invalid");
  }
  for (const field of ["recordedAt", "case", "displayLabel", "disclosure", "summary", "hypothesis", "entryPoint", "proposedStrategy"]) {
    requiredString(record[field], `recorded-investigation ${field}`);
  }
  if (record.case !== bundle.case.title) throw new Error("recorded-investigation case must match bundle case title");
  stringArray(record.inspectedFiles, "recorded-investigation inspectedFiles");
  stringArray(record.limitations, "recorded-investigation limitations");
  if (record.inspectedFiles.some((file) => !bundle.files[file])) {
    throw new Error("recorded-investigation inspectedFiles must reference admitted files");
  }
  exactKeys(record.review, ["status", "reviewedBy", "reviewedAt", "signature"], "recorded-investigation review");
  if (record.review.status !== "reviewed-committed" || record.review.signature !== null) {
    throw new Error("recorded-investigation review must be committed and unsigned-disclosed");
  }
  for (const field of ["reviewedBy", "reviewedAt"]) requiredString(record.review[field], `recorded-investigation review.${field}`);
  return record;
}

async function inventory(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  const symlinks = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) symlinks.push(child);
    else if (entry.isDirectory()) {
      const nested = await inventory(root, child);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    } else if (entry.isFile()) files.push(child);
  }
  return { files, symlinks };
}

async function inspectPublicEvidenceWorkspace(projectRoot, bundle) {
  validatePublicEvidenceBundle(bundle);
  const source = await resolveWorkspacePath(projectRoot, bundle.sourcePath, "public-evidence source", {
    expectedType: "directory",
  });
  const expectedFiles = Object.keys(bundle.files).sort();
  const observedInventory = await inventory(source.resolved);
  const actualFiles = observedInventory.files.map((file) => file.replaceAll("\\", "/")).sort();
  const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
  const extra = actualFiles.filter((file) => !expectedFiles.includes(file));
  const mismatched = [];
  const identities = {};
  const admittedBytes = new Map();
  for (const relative of expectedFiles.filter((file) => actualFiles.includes(file))) {
    const resolved = await resolveWorkspacePath(source.resolved, relative, "public-evidence artifact", {
      expectedType: "file",
    });
    const rawBytes = await readFile(resolved.resolved);
    const canonical = canonicalize(rawBytes);
    const observed = {
      rawSha256: sha256(rawBytes),
      canonicalSha256: sha256(canonical.bytes),
      canonicalGitBlobSha1: gitBlobSha1(canonical.bytes),
      canonicalization: canonical.canonicalization,
    };
    identities[relative] = observed;
    admittedBytes.set(relative, Buffer.from(canonical.bytes));
    const expected = bundle.files[relative];
    if (observed.canonicalSha256 !== expected.canonicalSha256
      || (expected.canonicalGitBlobSha1 !== undefined
        && observed.canonicalGitBlobSha1 !== expected.canonicalGitBlobSha1)) {
      mismatched.push({ file: relative, expected, observed });
    }
  }
  const structuralMatch = missing.length === 0
      && extra.length === 0
      && mismatched.length === 0
      && observedInventory.symlinks.length === 0;
  const semanticErrors = [];
  if (structuralMatch) {
    try {
      validatePaperSourceRecord(JSON.parse(admittedBytes.get(bundle.sourceRecord).toString("utf8")), bundle);
    } catch (error) {
      semanticErrors.push({ file: bundle.sourceRecord, message: error.message });
    }
    try {
      validateRecordedInvestigationRecord(
        JSON.parse(admittedBytes.get(bundle.investigationRecord).toString("utf8")),
        bundle,
      );
    } catch (error) {
      semanticErrors.push({ file: bundle.investigationRecord, message: error.message });
    }
  }
  return {
    result: {
    match: structuralMatch && semanticErrors.length === 0,
    schemaVersion: bundle.schemaVersion,
    bundleId: bundle.id,
    contentHashMode: bundle.contentHashMode,
    expectedFileCount: expectedFiles.length,
    actualFileCount: actualFiles.length,
    missing,
    extra,
    mismatched,
    symlinks: observedInventory.symlinks,
    semanticErrors,
    identities,
    sourcePath: bundle.sourcePath,
    },
    admittedBytes,
  };
}

export async function verifyPublicEvidenceWorkspace(projectRoot, bundle) {
  return (await inspectPublicEvidenceWorkspace(projectRoot, bundle)).result;
}

export async function admitPublicEvidenceWorkspace(projectRoot, bundle) {
  const { result: verification, admittedBytes } = await inspectPublicEvidenceWorkspace(projectRoot, bundle);
  if (!verification.match) {
    throw new PublicEvidenceAdmissionError(
      `Public evidence did not match reviewed bundle ${bundle.id}; statistics were not calculated.`,
      {
        bundleId: bundle.id,
        missing: verification.missing,
        extra: verification.extra,
        mismatched: verification.mismatched,
        symlinks: verification.symlinks,
        semanticErrors: verification.semanticErrors,
      },
    );
  }
  const receipt = deepFreeze({
    actor: "Reviewed public-evidence admission policy",
    status: "approved",
    approvalType: "version-controlled-maintainer-metadata",
    signed: false,
    signatureVerification: "unsupported",
    bundleId: bundle.id,
    bundleSha256: bundle.bundleSha256,
    origin: structuredClone(bundle.origin),
    sourcePath: verification.sourcePath,
    fileIdentities: verification.identities,
    fileCount: verification.expectedFileCount,
    contentHashMode: verification.contentHashMode,
    snapshotMode: "single-read-in-memory-canonical-bytes",
    scope: bundle.scope,
  });
  const readBytes = (relative) => {
    const bytes = admittedBytes.get(relative);
    if (!bytes) throw new PublicEvidenceAdmissionError(`Artifact is not present in admitted snapshot: ${relative}`);
    return Buffer.from(bytes);
  };
  return Object.freeze({
    receipt,
    readBytes,
    readText: (relative) => readBytes(relative).toString("utf8"),
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function loadBundle(asset) {
  const raw = readFileSync(path.join(applicationRoot, ...asset.path.split("/")), "utf8");
  const bundle = validatePublicEvidenceBundle(JSON.parse(raw));
  if (bundle.policyFile !== asset.path) {
    throw new Error(`public-evidence policyFile must match registered asset ${asset.path}`);
  }
  return deepFreeze({ ...bundle, bundleSha256: sha256(raw.replace(/\r\n?/g, "\n")) });
}

const bundles = PUBLIC_EVIDENCE_POLICY_ASSETS.map(loadBundle);
const registry = deepFreeze(Object.fromEntries(bundles.map((bundle) => [bundle.id, bundle])));

export function resolvePublicEvidenceBundle(id) {
  return registry[id] || null;
}

export function listPublicEvidenceBundles() {
  return Object.values(registry).map((bundle) => ({
    id: bundle.id,
    label: bundle.label,
    verifierContractId: bundle.verifierContractId,
    bundleSha256: bundle.bundleSha256,
    policyFile: bundle.policyFile,
    fileCount: Object.keys(bundle.files).length,
    contentHashMode: bundle.contentHashMode,
    origin: structuredClone(bundle.origin),
    signed: false,
    signatureVerification: "unsupported",
  }));
}

export { canonicalBytes, gitBlobSha1 };
