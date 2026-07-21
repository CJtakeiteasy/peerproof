import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeApprovedRunPlan } from "../src/audit-engine.js";
import { NESTED_NODE_POLICY_CONTEXT } from "../src/policy-registry.js";
import { approveRunPlan, classifyRunPlanWorkspace } from "../src/run-policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDirectory = path.join(projectRoot, "evals", "policy-profiles", "nested-node-study");
const plan = {
  executable: "node",
  args: ["workflow/reproduce.mjs"],
  cwd: "analysis",
  expectedArtifact: "stdout-json",
  timeoutMs: 10_000,
};

async function main() {
  const classification = await classifyRunPlanWorkspace(
    repoDirectory,
    plan,
    NESTED_NODE_POLICY_CONTEXT,
  );
  const approval = approveRunPlan(classification, plan);
  const attempt = await executeApprovedRunPlan(repoDirectory, approval);
  if (attempt.exitCode !== 0) throw new Error(attempt.stderr || "nested fixture execution failed");
  const artifact = JSON.parse(attempt.stdout);
  if (artifact.schemaVersion !== "nested-node-result.v1" || artifact.rows !== 4 || artifact.mean !== 5) {
    throw new Error("nested fixture returned an unexpected artifact");
  }
  process.stdout.write("Policy profile execution evaluations: 1/1 passed\n");
  process.stdout.write(`Profile: ${classification.profileId}\n`);
  process.stdout.write(`Case binding: ${classification.trustedCaseId}\n`);
  process.stdout.write("Layout: cwd analysis · entry workflow/reproduce.mjs\n");
}

main().catch((error) => {
  process.stderr.write(`Policy profile evaluation failed: ${error.message}\n`);
  process.exitCode = 1;
});
