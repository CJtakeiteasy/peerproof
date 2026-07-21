import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverRuntimeClosure,
  EVALUATION_RUNTIME_ENTRY_POINTS,
  PRODUCT_RUNTIME_ENTRY_POINTS,
} from "../src/runtime-closure.js";
import {
  CASE_POLICY_ASSETS,
  inspectRuntimeAssetClosure,
  runtimeAssetClosureDescriptor,
} from "../src/runtime-assets.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "policies", "build-integrity.v3.json");

function runtimeRole(relative, productModules, evaluationModules) {
  if (relative === "server.js") return "application-entry";
  if (relative === "bin/peerproof.js") return "cli-entry";
  if (relative === "public/app.js" || relative === "public/file-utils.js") return "judge-interface";
  if (relative === "src/pdf-worker.js") return "worker-runtime";
  if (relative === "src/build-integrity.js" || relative === "src/runtime-closure.js") return "admission-policy";
  if (relative === "src/audit-engine.js" || relative === "src/independent-evidence-audit.js") return "audit-orchestrator";
  if (relative === "src/verifier-registry.js") return "verifier-registry";
  if (relative.startsWith("src/verifiers/") || relative === "src/independent-verifier.js") return "verifier-runtime";
  if (relative === "src/verifier.js" || relative === "src/verification-policy.js") return "verdict-policy";
  if (relative === "src/statistics.js") return "statistical-helper";
  if (relative.startsWith("scripts/") && evaluationModules.has(relative)) return "policy-evaluation-entry";
  if (productModules.has(relative)) return "first-party-runtime";
  return "policy-evaluation-runtime";
}

function canonicalBytes(bytes) {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes)
    ? Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8")
    : bytes;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identityBytes(relative, bytes, settings) {
  if (settings.archiveSubstitution !== "git-format-commit") return bytes;
  const text = bytes.toString("utf8");
  const pattern = /const ARCHIVE_COMMIT = "(?:\$Format:%H\$|[a-f0-9]{40})";/i;
  if (!pattern.test(text)) throw new Error(`Git archive placeholder is absent from ${relative}`);
  return Buffer.from(text.replace(pattern, 'const ARCHIVE_COMMIT = "$Format:%H$";'), "utf8");
}

async function inventoryFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventoryFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported evaluation fixture entry: ${child}`);
  }
  return files;
}

const productClosure = await discoverRuntimeClosure(projectRoot, {
  entryPoints: PRODUCT_RUNTIME_ENTRY_POINTS,
});
const evaluationClosure = await discoverRuntimeClosure(projectRoot, {
  entryPoints: EVALUATION_RUNTIME_ENTRY_POINTS,
});
const productModules = new Set(productClosure.modules);
const evaluationModules = new Set(evaluationClosure.modules);
const assetClosure = runtimeAssetClosureDescriptor();
const files = Object.fromEntries(assetClosure.assets.map((entry) => [entry.path, entry.role]));
for (const relative of [...new Set([...productModules, ...evaluationModules])].sort()) {
  files[relative] = runtimeRole(relative, productModules, evaluationModules);
}

for (const policyAsset of CASE_POLICY_ASSETS.filter((entry) => entry.includeRepositoryFilesInBuild)) {
  const policy = JSON.parse(await readFile(path.join(projectRoot, ...policyAsset.path.split("/")), "utf8"));
  for (const relative of Object.keys(policy.repository.files)) {
    files[`${policy.repository.sourcePath}/${relative}`] = "reviewed-policy-evaluation-fixture";
  }
}
for (const relative of await inventoryFiles(path.join(projectRoot, "evals", "repositories"))) {
  files[`evals/repositories/${relative}`] = "agent-evaluation-fixture";
}

const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const identities = {};
for (const [relative, role] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
  const settings = {
    role,
    ...(relative === "src/build-info.js" ? { archiveSubstitution: "git-format-commit" } : {}),
  };
  identities[relative] = {
    canonicalSha256: sha256(identityBytes(
      relative,
      canonicalBytes(await readFile(path.join(projectRoot, ...relative.split("/")))),
      settings,
    )),
    role: settings.role,
  };
  if (settings.archiveSubstitution) identities[relative].archiveSubstitution = settings.archiveSubstitution;
}

const manifest = {
  schemaVersion: "peerproof.build-integrity-manifest.v3",
  application: { name: packageMetadata.name, version: packageMetadata.version },
  contentHashMode: "canonical-content-v1:utf8-newlines-to-lf-or-binary-raw",
  runtimeClosure: {
    schemaVersion: "peerproof.runtime-closure.v1",
    productEntryPoints: [...PRODUCT_RUNTIME_ENTRY_POINTS],
    evaluationEntryPoints: [...EVALUATION_RUNTIME_ENTRY_POINTS],
    modules: [...new Set([...productClosure.modules, ...evaluationClosure.modules])].sort(),
    productClosureSha256: productClosure.closureSha256,
    evaluationClosureSha256: evaluationClosure.closureSha256,
  },
  assetClosure,
  files: identities,
  review: {
    status: "reviewed-committed",
    approvedBy: "PeerProof maintainer review",
    approvedAt: "2026-07-20",
    signature: null,
  },
};
const inspectedAssets = await inspectRuntimeAssetClosure(projectRoot, manifest);
if (!inspectedAssets.match) {
  throw new Error(`Runtime asset registry is incomplete: ${JSON.stringify({
    missingGoverned: inspectedAssets.missingGoverned,
    unregisteredGovernedPolicies: inspectedAssets.unregisteredGovernedPolicies,
    unregisteredOnDisk: inspectedAssets.unregisteredOnDisk,
    missingOnDisk: inspectedAssets.missingOnDisk,
    unsupportedPolicyEntries: inspectedAssets.unsupportedPolicyEntries,
  })}`);
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write([
  `Wrote ${path.relative(projectRoot, manifestPath)} with ${Object.keys(files).length} governed files.`,
  `Product runtime closure: ${productClosure.modules.length} modules.`,
  `Policy-evaluation closure: ${evaluationClosure.modules.length} modules.`,
].join("\n") + "\n");
