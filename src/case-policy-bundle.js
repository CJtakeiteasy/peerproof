import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./utils.js";
import { resolveWorkspacePath } from "./workspace-path.js";

export const CASE_POLICY_SCHEMA_VERSION = "peerproof.reviewed-case-policy.v1";
export const CASE_POLICY_CONTENT_HASH_MODE = "utf8-lf-normalized-or-binary-raw-sha256";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ORIGIN_FIELDS = ["repository", "commit", "doi", "retrievedAt", "archiveSha256"];

function validPlan(plan) {
  return plan?.executable === "node"
    && Array.isArray(plan.args) && plan.args.length > 0
    && typeof plan.cwd === "string"
    && plan.expectedArtifact === "stdout-json"
    && Number.isInteger(plan.timeoutMs);
}

export function validateCasePolicyBundle(bundle) {
  if (!bundle || bundle.schemaVersion !== CASE_POLICY_SCHEMA_VERSION) throw new Error("unsupported case-policy schemaVersion");
  for (const field of ["id", "label", "profileId", "scope"]) {
    if (typeof bundle[field] !== "string" || !bundle[field]) throw new Error(`case-policy ${field} is required`);
  }
  if (bundle.origin?.type !== "project-authored-synthetic-fixture") {
    throw new Error("case-policy origin type must explicitly identify the project-authored synthetic fixture");
  }
  if (typeof bundle.origin.authorityStatus !== "string" || !bundle.origin.authorityStatus) {
    throw new Error("case-policy origin authorityStatus is required");
  }
  for (const field of ORIGIN_FIELDS) {
    if (!(field in bundle.origin) || (bundle.origin[field] !== null && typeof bundle.origin[field] !== "string")) {
      throw new Error(`case-policy origin ${field} must be a string or null`);
    }
  }
  if (bundle.repository?.revisionType !== "exact-content-manifest-sha256") {
    throw new Error("case-policy repository revisionType must be exact-content-manifest-sha256");
  }
  if (bundle.repository?.contentHashMode !== CASE_POLICY_CONTENT_HASH_MODE) {
    throw new Error(`case-policy repository contentHashMode must be ${CASE_POLICY_CONTENT_HASH_MODE}`);
  }
  const files = bundle.repository?.files;
  if (!files || Object.keys(files).length === 0) throw new Error("case-policy repository files are required");
  for (const [file, hash] of Object.entries(files)) {
    const normalized = file.replaceAll("\\", "/");
    if (file !== normalized || path.posix.isAbsolute(file) || normalized.startsWith("..") || !SHA256_PATTERN.test(hash)) {
      throw new Error(`invalid case-policy repository file entry: ${file}`);
    }
  }
  if (!Array.isArray(bundle.allowedPlans) || bundle.allowedPlans.length === 0 || !bundle.allowedPlans.every(validPlan)) {
    throw new Error("case-policy requires at least one valid allowed plan");
  }
  if (!Array.isArray(bundle.repairRules)) throw new Error("case-policy repairRules must be an array");
  if (bundle.review?.status !== "reviewed-committed" || !bundle.review.approvedBy || !bundle.review.approvedAt) {
    throw new Error("case-policy must contain a committed reviewer approval record");
  }
  if (bundle.review.signature !== null) {
    throw new Error("cryptographic case-policy signatures are not supported or verified in this build");
  }
  return bundle;
}

async function inventoryWorkspace(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  const symlinks = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) symlinks.push(child);
    else if (entry.isDirectory()) {
      const nested = await inventoryWorkspace(root, child);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    } else if (entry.isFile()) files.push(child);
  }
  return { files, symlinks };
}

export async function sha256CasePolicyFile(file) {
  const bytes = await readFile(file);
  const text = bytes.toString("utf8");
  const validUtf8 = Buffer.from(text, "utf8").equals(bytes);
  return validUtf8 ? sha256(text.replace(/\r\n?/g, "\n")) : sha256(bytes);
}

export async function verifyCasePolicyWorkspace(repoDirectory, bundle) {
  validateCasePolicyBundle(bundle);
  const expectedFiles = Object.keys(bundle.repository.files).sort();
  const inventory = await inventoryWorkspace(repoDirectory);
  const actualFiles = inventory.files.map((file) => file.replaceAll("\\", "/")).sort();
  const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
  const extra = actualFiles.filter((file) => !expectedFiles.includes(file));
  const mismatched = [];
  for (const file of expectedFiles.filter((candidate) => actualFiles.includes(candidate))) {
    const resolved = await resolveWorkspacePath(repoDirectory, file, "case-policy repository file", { expectedType: "file" });
    const observed = await sha256CasePolicyFile(resolved.resolved);
    if (observed !== bundle.repository.files[file]) mismatched.push({ file, expected: bundle.repository.files[file], observed });
  }
  const match = missing.length === 0 && extra.length === 0 && mismatched.length === 0 && inventory.symlinks.length === 0;
  return {
    match,
    schemaVersion: bundle.schemaVersion,
    caseId: bundle.id,
    origin: structuredClone(bundle.origin),
    repositoryContentManifestSha256: sha256(JSON.stringify(bundle.repository.files)),
    contentHashMode: bundle.repository.contentHashMode,
    expectedFileCount: expectedFiles.length,
    actualFileCount: actualFiles.length,
    missing,
    extra,
    mismatched,
    symlinks: inventory.symlinks,
  };
}
