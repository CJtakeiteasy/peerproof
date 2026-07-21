import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  independentlyVerifyExecution,
  parseStudyCsv,
  validateAuthorArtifact,
} from "../src/independent-verifier.js";
import { sampleClaim } from "../src/sample-case.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDirectory = path.join(projectRoot, "samples", "fragile-study", "repo");
const validArtifact = {
  schemaVersion: "lighthouse.author-result.v1",
  n: 10,
  coefficient: 1.27619,
  standardError: 0.250786,
  pValue: 0.00094284,
};
const dataApproval = {
  status: "approved",
  approvedDataFile: "data/study.csv",
  contract: {
    schemaVersion: "peerproof.evidence-package.v1",
    dataset: "data/study.csv",
    idColumn: "id",
    outcome: "y",
    predictors: ["x"],
    includeIntercept: true,
    missingData: "reject",
    artifact: "stdout-json",
  },
};

test("independent verifier recomputes baseline and all leave-one-out results from CSV", async () => {
  const result = await independentlyVerifyExecution({
    claim: sampleClaim,
    repoDirectory,
    dataApproval,
    attempt: { stdout: JSON.stringify(validArtifact) },
  });
  assert.equal(result.execution.authorPipeline.coefficient, 1.27619);
  assert.equal(result.execution.independentVerifier.crossCheck.match, true);
  assert.equal(result.execution.leaveOneOut.length, 10);
  assert.equal(new Set(result.execution.leaveOneOut.map((row) => row.removedId)).size, 10);
  assert.equal(result.verification.verdict.label, "Fragile");
});

test("forged author pipeline result cannot pass independent cross-check", async () => {
  await assert.rejects(
    independentlyVerifyExecution({
      claim: sampleClaim,
      repoDirectory,
      dataApproval,
      attempt: { stdout: JSON.stringify({ ...validArtifact, coefficient: 9.99 }) },
    }),
    /differs from PeerProof independent recomputation/i,
  );
});

test("strict author artifact rejects invalid values and untrusted robustness fields", () => {
  assert.throws(() => validateAuthorArtifact({ ...validArtifact, pValue: -1 }), /from 0 to 1/i);
  assert.throws(() => validateAuthorArtifact({ ...validArtifact, pValue: "significant" }), /finite/i);
  assert.throws(() => validateAuthorArtifact({ ...validArtifact, standardError: 0 }), /positive/i);
  assert.throws(() => validateAuthorArtifact({ ...validArtifact, coefficient: null }), /finite/i);
  assert.throws(
    () => validateAuthorArtifact({ ...validArtifact, leaveOneOut: [] }),
    /fields must be exactly/i,
  );
});

test("author artifact sample size must match independently parsed dataset rows", async () => {
  await assert.rejects(
    independentlyVerifyExecution({
      claim: sampleClaim,
      repoDirectory,
      dataApproval,
      attempt: { stdout: JSON.stringify({ ...validArtifact, n: 9 }) },
    }),
    /differs.*n/i,
  );
});

test("strict dataset parser rejects duplicate IDs and non-finite values", () => {
  assert.throws(() => parseStudyCsv("id,x,y\nA,1,2\nA,2,3\nB,3,4", dataApproval.contract), /duplicate id A/i);
  assert.throws(() => parseStudyCsv("id,x,y\nA,1,2\nB,nope,3\nC,3,4", dataApproval.contract), /non-finite/i);
});
