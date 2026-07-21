import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeApprovedRunPlan } from "../src/audit-engine.js";
import {
  LIGHTHOUSE_POLICY_CONTEXT,
  NESTED_NODE_POLICY_CONTEXT,
  listExecutionPolicyProfiles,
  listTrustedPolicyCases,
} from "../src/policy-registry.js";
import { approveRunPlan, classifyRunPlanWorkspace } from "../src/run-policy.js";
import { validateCasePolicyBundle } from "../src/case-policy-bundle.js";
import { resolvePolicyContext } from "../src/policy-registry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("one versioned Node profile has two separately registered trusted case bindings", () => {
  assert.deepEqual(listExecutionPolicyProfiles().map(({ id }) => id), ["peerproof.node-script.v1"]);
  assert.deepEqual(
    listTrustedPolicyCases().map(({ id }) => id).sort(),
    [LIGHTHOUSE_POLICY_CONTEXT.trustedCaseId, NESTED_NODE_POLICY_CONTEXT.trustedCaseId].sort(),
  );
  for (const trustedCase of listTrustedPolicyCases()) {
    assert.equal(trustedCase.signed, false);
    assert.equal(trustedCase.signatureVerification, "unsupported");
    assert.equal(trustedCase.approvalType, "version-controlled-maintainer-metadata");
    assert.equal(trustedCase.origin.type, "project-authored-synthetic-fixture");
    assert.match(trustedCase.origin.authorityStatus, /no upstream scientific authority/i);
  }
});

test("case bundles require explicit origin identity and reject unverified signature claims", () => {
  const bundle = structuredClone(resolvePolicyContext(LIGHTHOUSE_POLICY_CONTEXT).trustedCase);
  delete bundle.bundleSha256;

  const missingOrigin = structuredClone(bundle);
  delete missingOrigin.origin;
  assert.throws(() => validateCasePolicyBundle(missingOrigin), /origin type/i);

  const fakeSignature = structuredClone(bundle);
  fakeSignature.review.signature = "self-attested-signature";
  assert.throws(() => validateCasePolicyBundle(fakeSignature), /signatures are not supported or verified/i);
});

test("nested repository layout crosses policy and executes its exact artifact", async () => {
  const repoDirectory = path.join(projectRoot, "evals", "policy-profiles", "nested-node-study");
  const plan = {
    executable: "node",
    args: ["workflow/reproduce.mjs"],
    cwd: "analysis",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  };
  const classification = await classifyRunPlanWorkspace(repoDirectory, plan, NESTED_NODE_POLICY_CONTEXT);
  assert.equal(classification.status, "eligible-for-approval");
  assert.equal(classification.checks.entryRealpathSafe, true);
  const attempt = await executeApprovedRunPlan(repoDirectory, approveRunPlan(classification, plan));
  assert.equal(attempt.exitCode, 0);
  assert.deepEqual(JSON.parse(attempt.stdout), {
    schemaVersion: "nested-node-result.v1",
    rows: 4,
    mean: 5,
  });
});
