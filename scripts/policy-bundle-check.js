import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCasePolicyWorkspace } from "../src/case-policy-bundle.js";
import {
  LIGHTHOUSE_POLICY_CONTEXT,
  NESTED_NODE_POLICY_CONTEXT,
  resolvePolicyContext,
} from "../src/policy-registry.js";
import {
  listPublicEvidenceBundles,
  resolvePublicEvidenceBundle,
  verifyPublicEvidenceWorkspace,
} from "../src/public-evidence-bundle.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contexts = [LIGHTHOUSE_POLICY_CONTEXT, NESTED_NODE_POLICY_CONTEXT];

for (const context of contexts) {
  const { trustedCase } = resolvePolicyContext(context);
  const repository = path.join(projectRoot, trustedCase.repository.sourcePath);
  const result = await verifyCasePolicyWorkspace(repository, trustedCase);
  if (!result.match) throw new Error(`${trustedCase.id} repository content did not match its reviewed bundle`);
  process.stdout.write(`PASS ${trustedCase.id} · ${result.actualFileCount} files · ${trustedCase.bundleSha256}\n`);
}

process.stdout.write(`Reviewed case-policy bundles: ${contexts.length}/${contexts.length} passed\n`);

const publicBundles = listPublicEvidenceBundles();
for (const metadata of publicBundles) {
  const bundle = resolvePublicEvidenceBundle(metadata.id);
  const result = await verifyPublicEvidenceWorkspace(projectRoot, bundle);
  if (!result.match) throw new Error(`${bundle.id} public evidence did not match its reviewed bundle`);
  process.stdout.write(`PASS ${bundle.id} · ${result.actualFileCount} files · ${bundle.bundleSha256}\n`);
}
process.stdout.write(`Reviewed public-evidence bundles: ${publicBundles.length}/${publicBundles.length} passed\n`);
