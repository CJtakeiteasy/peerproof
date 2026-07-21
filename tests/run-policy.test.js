import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveRunPlan, classifyRunPlan, classifyRunPlanWorkspace } from "../src/run-policy.js";
import { LIGHTHOUSE_POLICY_CONTEXT, NESTED_NODE_POLICY_CONTEXT } from "../src/policy-registry.js";
import { fallbackInvestigation } from "../src/sample-case.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDirectory = path.join(projectRoot, "samples", "fragile-study", "repo");
const nestedRepoDirectory = path.join(projectRoot, "evals", "policy-profiles", "nested-node-study");

test("independent run policy approves and preserves the exact structured RunPlan", async () => {
  const plan = fallbackInvestigation.runPlan;
  const classification = await classifyRunPlanWorkspace(repoDirectory, plan, LIGHTHOUSE_POLICY_CONTEXT);
  const approval = approveRunPlan(classification, plan);
  assert.equal(classification.status, "eligible-for-approval");
  assert.deepEqual(approval.approvedPlan, plan);
  assert.notEqual(approval.approvedPlan, plan);
  assert.equal(approval.resourceLimits.maxOutputBytes, 1024 * 1024);
  assert.equal(approval.resourceLimits.maxWallClockMs, 30_000);
});

test("run policy rejects shell syntax even when executable is allow-listed", () => {
  const classification = classifyRunPlan({
    ...fallbackInvestigation.runPlan,
    args: ["analysis.js", ";", "whoami"],
  }, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.argsAreLiteral, false);
});

test("structural RunPlan classification alone cannot grant execution approval", () => {
  const classification = classifyRunPlan(fallbackInvestigation.runPlan, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(classification.status, "eligible-for-approval");
  assert.throws(() => approveRunPlan(classification, fallbackInvestigation.runPlan), /rejected/i);
});

test("run policy rejects repository escape", () => {
  const classification = classifyRunPlan({
    ...fallbackInvestigation.runPlan,
    cwd: "../outside",
  }, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.cwdRepositoryRelative, false);
});

test("run policy rejects a cwd symbolic link that resolves outside the repository", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peerproof-cwd-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(repo);
  await mkdir(path.join(outside, "workflow"), { recursive: true });
  await writeFile(path.join(outside, "workflow", "reproduce.mjs"), "process.stdout.write('{}\\n');\n");
  try {
    await symlink(outside, path.join(repo, "analysis"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("This Windows account cannot create directory links");
    throw error;
  }
  const classification = await classifyRunPlanWorkspace(repo, {
    executable: "node",
    args: ["workflow/reproduce.mjs"],
    cwd: "analysis",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  }, NESTED_NODE_POLICY_CONTEXT);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.cwdRealpathSafe, false);
  assert.match(classification.rationale, /symbolic link|outside/i);
});

test("run policy rejects a structurally valid plan without a registered case context", () => {
  const classification = classifyRunPlan(fallbackInvestigation.runPlan);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.policyContextRegistered, false);
});

test("run policy rejects a different entry point even under the Node script profile", () => {
  const classification = classifyRunPlan({
    ...fallbackInvestigation.runPlan,
    args: ["other.js"],
  }, LIGHTHOUSE_POLICY_CONTEXT);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.trustedCasePlanMatch, false);
});

test("registered plan is rejected when repository content differs from its reviewed case bundle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peerproof-case-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await cp(nestedRepoDirectory, repo, { recursive: true });
  await writeFile(path.join(repo, "unreviewed-extra.txt"), "extra repository content\n");
  const classification = await classifyRunPlanWorkspace(repo, {
    executable: "node",
    args: ["workflow/reproduce.mjs"],
    cwd: "analysis",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  }, NESTED_NODE_POLICY_CONTEXT);
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.cwdRealpathSafe, true);
  assert.equal(classification.checks.entryRealpathSafe, true);
  assert.equal(classification.checks.repositoryBundleMatch, false);
  assert.match(classification.rationale, /reviewed case bundle/i);
});

test("reviewed text content remains admitted across Git LF and CRLF checkouts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peerproof-case-eol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await cp(nestedRepoDirectory, repo, { recursive: true });
  const readmePath = path.join(repo, "README.md");
  const readme = await readFile(readmePath, "utf8");
  const lfReadme = readme.replace(/\r\n?/g, "\n");
  await writeFile(readmePath, lfReadme.replaceAll("\n", "\r\n"), "utf8");
  const plan = {
    executable: "node",
    args: ["workflow/reproduce.mjs"],
    cwd: "analysis",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  };
  const classification = await classifyRunPlanWorkspace(repo, plan, NESTED_NODE_POLICY_CONTEXT);
  assert.equal(classification.status, "eligible-for-approval");
  assert.equal(classification.checks.repositoryBundleMatch, true);
  assert.equal(
    classification.repositoryBundle.contentHashMode,
    "utf8-lf-normalized-or-binary-raw-sha256",
  );
  assert.equal(classification.repositoryBundle.signed, false);
  assert.equal(classification.repositoryBundle.signatureVerification, "unsupported");
  assert.equal(classification.repositoryBundle.origin.type, "project-authored-synthetic-fixture");
});
