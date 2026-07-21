import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveRepair, classifyRepairProposal, classifyRepairProposalForWorkspace } from "../src/repair-policy.js";
import { LIGHTHOUSE_POLICY_CONTEXT, NESTED_NODE_POLICY_CONTEXT } from "../src/policy-registry.js";
import { fallbackInvestigation } from "../src/sample-case.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDirectory = path.join(projectRoot, "samples", "fragile-study", "repo");

test("independent policy accepts only the exact allow-listed patch", () => {
  const result = classifyRepairProposal(fallbackInvestigation.proposedRepair, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(result.allowListMatch, true);
  assert.equal(result.policyClassification, "infrastructure");
  assert.equal(result.agentRecommendation, "infrastructure");
});

test("allow-list matching alone cannot grant patch approval without a realpath check", () => {
  const result = classifyRepairProposal(fallbackInvestigation.proposedRepair, LIGHTHOUSE_POLICY_CONTEXT);
  assert.throws(() => approveRepair(result, fallbackInvestigation.proposedRepair), /rejected/i);
});

test("Codex analytical change is rejected even when advisory says infrastructure", () => {
  const result = classifyRepairProposal({
    ...fallbackInvestigation.proposedRepair,
    classificationAdvisory: "infrastructure",
    newText: "const significanceThreshold = 0.5;",
  }, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(result.agentRecommendation, "infrastructure");
  assert.equal(result.policyClassification, "analytical-or-unapproved");
  assert.equal(result.allowListMatch, false);
  assert.equal(result.status, "rejected");
});

test("semantically similar but unreviewed path repair is rejected", () => {
  const result = classifyRepairProposal({
    ...fallbackInvestigation.proposedRepair,
    newText: 'const DATA_PATH = new URL("data/study.csv", import.meta.url).pathname;',
  }, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(result.status, "rejected");
  assert.equal(result.allowListChecks.repairCandidateId, true);
  assert.equal(result.allowListChecks.exactPatch, false);
});

test("patch policy rejects a target symbolic link that resolves outside the repository", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peerproof-patch-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await cp(repoDirectory, repo, { recursive: true });
  const target = path.join(repo, "src", "load-study.js");
  const external = path.join(root, "outside-load-study.js");
  await writeFile(external, await readFile(target));
  await unlink(target);
  try {
    await symlink(external, target, "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    await rm(path.join(repo, "src"), { recursive: true, force: true });
    const externalDirectory = path.join(root, "outside-src");
    await mkdir(externalDirectory);
    await copyFile(external, path.join(externalDirectory, "load-study.js"));
    await symlink(externalDirectory, path.join(repo, "src"), "junction");
  }
  const classification = await classifyRepairProposalForWorkspace(
    repo,
    fallbackInvestigation.proposedRepair,
    LIGHTHOUSE_POLICY_CONTEXT,
  );
  assert.equal(classification.status, "rejected");
  assert.equal(classification.allowListChecks.targetRealpathSafe, false);
  assert.match(classification.rationale, /symbolic link/i);
});

test("repair rules are scoped to one registered trusted case", () => {
  const classification = classifyRepairProposal(
    fallbackInvestigation.proposedRepair,
    NESTED_NODE_POLICY_CONTEXT,
  );
  assert.equal(classification.status, "rejected");
  assert.equal(classification.allowListChecks.policyContextRegistered, true);
  assert.equal(classification.allowListMatch, false);
});

test("repair policy rejects proposals without a registered policy context", () => {
  const classification = classifyRepairProposal(fallbackInvestigation.proposedRepair);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.allowListChecks.policyContextRegistered, false);
});
