import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveDataResolution,
  classifyDataResolution,
} from "../src/data-resolution-policy.js";
import { validateManifest } from "../src/verifiers/simple-ols.js";
import { fallbackInvestigation, sampleClaim } from "../src/sample-case.js";
import { resolveVerifierRuntime } from "../src/verifier-registry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDirectory = path.join(projectRoot, "samples", "fragile-study", "repo");
const verifierRuntime = resolveVerifierRuntime(sampleClaim);

test("data policy approves the exact manifest-backed repository file", async () => {
  const classification = await classifyDataResolution(repoDirectory, fallbackInvestigation.repositoryResolution, sampleClaim, verifierRuntime);
  assert.equal(classification.status, "eligible-for-approval");
  assert.equal(classification.checks.proposedFileMatchesManifest, true);
  const approval = approveDataResolution(classification, fallbackInvestigation.repositoryResolution);
  assert.equal(approval.approvedDataFile, "data/study.csv");
  assert.deepEqual(approval.contract.predictors, ["x"]);
  assert.equal(approval.claimMapping.predictor.paperTerm, "exposure");
  assert.match(approval.mappingAssertion, /not an independently proven/i);
});

test("paper labels and unapproved repository paths cannot select verifier input", async () => {
  const classification = await classifyDataResolution(repoDirectory, {
    ...fallbackInvestigation.repositoryResolution,
    resolvedDataFile: "Lighthouse study dataset",
  }, sampleClaim, verifierRuntime);
  assert.equal(classification.status, "rejected");
  assert.match(classification.rationale, /could not be validated/i);
  assert.throws(() => approveDataResolution(classification, fallbackInvestigation.repositoryResolution), /rejected/i);
});

test("reviewed claim mapping must match the paper-facing predictor and outcome terms", async () => {
  const mismatchedClaim = structuredClone(sampleClaim);
  mismatchedClaim.evidence.predictor = "different exposure definition";
  const classification = await classifyDataResolution(
    repoDirectory,
    fallbackInvestigation.repositoryResolution,
    mismatchedClaim,
    verifierRuntime,
  );
  assert.equal(classification.status, "rejected");
  assert.equal(classification.checks.claimMappingMatchesReportedTerms, false);
});

test("evidence manifest rejects broader OLS features outside current scope", () => {
  const manifest = {
    schemaVersion: "peerproof.evidence-package.v1",
    dataset: "data/study.csv",
    idColumn: "id",
    outcome: "y",
    predictors: ["x", "covariate"],
    includeIntercept: true,
    missingData: "reject",
    artifact: "stdout-json",
    claimMapping: {
      predictor: { paperTerm: "exposure", column: "x" },
      outcome: { paperTerm: "outcome", column: "y" },
      coefficientTerm: "x",
    },
  };
  assert.throws(() => validateManifest(manifest), /exactly one predictor/i);
});

test("evidence manifest rejects every unsupported contract dimension", () => {
  const base = {
    schemaVersion: "peerproof.evidence-package.v1",
    dataset: "data/study.csv",
    idColumn: "id",
    outcome: "y",
    predictors: ["x"],
    includeIntercept: true,
    missingData: "reject",
    artifact: "stdout-json",
    claimMapping: {
      predictor: { paperTerm: "exposure", column: "x" },
      outcome: { paperTerm: "outcome", column: "y" },
      coefficientTerm: "x",
    },
  };
  const cases = [
    [(manifest) => { manifest.extra = true; }, /fields must be exactly/i],
    [(manifest) => { manifest.schemaVersion = "future"; }, /schemaVersion/i],
    [(manifest) => { manifest.dataset = ""; }, /dataset is required/i],
    [(manifest) => { manifest.idColumn = ""; }, /idColumn is required/i],
    [(manifest) => { manifest.outcome = ""; }, /outcome is required/i],
    [(manifest) => { manifest.predictors = [""]; }, /exactly one predictor/i],
    [(manifest) => { manifest.predictors = ["y"]; }, /must be distinct/i],
    [(manifest) => { manifest.includeIntercept = false; }, /requires an intercept/i],
    [(manifest) => { manifest.missingData = "drop"; }, /missingData=reject/i],
    [(manifest) => { manifest.artifact = "file-json"; }, /stdout-json/i],
  ];
  for (const [mutate, pattern] of cases) {
    const manifest = structuredClone(base);
    mutate(manifest);
    assert.throws(() => validateManifest(manifest), pattern);
  }
});

test("data policy rejects path traversal, absolute paths, and missing manifests", async () => {
  for (const resolution of [
    { ...fallbackInvestigation.repositoryResolution, resolvedDataFile: "../study.csv" },
    { ...fallbackInvestigation.repositoryResolution, resolvedDataFile: path.resolve(repoDirectory, "data", "study.csv") },
    { ...fallbackInvestigation.repositoryResolution, manifestFile: "missing.evidence.json" },
  ]) {
    const classification = await classifyDataResolution(repoDirectory, resolution, sampleClaim, verifierRuntime);
    assert.equal(classification.status, "rejected");
    assert.match(classification.rationale, /could not be validated/i);
  }
});

test("data policy rejects a dataset link that resolves outside the repository", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peerproof-data-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await cp(repoDirectory, repo, { recursive: true });
  const external = path.join(root, "outside.csv");
  await writeFile(external, await readFile(path.join(repo, "data", "study.csv")));
  const datasetLink = path.join(repo, "data", "study.csv");
  await unlink(datasetLink);
  try {
    await symlink(external, datasetLink, "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    await rm(path.join(repo, "data"), { recursive: true, force: true });
    const externalDirectory = path.join(root, "outside-data");
    await mkdir(externalDirectory);
    await copyFile(external, path.join(externalDirectory, "study.csv"));
    await symlink(externalDirectory, path.join(repo, "data"), "junction");
  }
  const classification = await classifyDataResolution(repo, fallbackInvestigation.repositoryResolution, sampleClaim, verifierRuntime);
  assert.equal(classification.status, "rejected");
  assert.match(classification.rationale, /symbolic link/i);
});

test("data policy rejects a manifest link that resolves outside the repository", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peerproof-manifest-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await cp(repoDirectory, repo, { recursive: true });
  const external = path.join(root, "outside-manifest.json");
  await writeFile(external, await readFile(path.join(repo, "peerproof.evidence.json")));
  const manifestLink = path.join(repo, "peerproof.evidence.json");
  await unlink(manifestLink);
  let resolution = fallbackInvestigation.repositoryResolution;
  try {
    await symlink(external, manifestLink, "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    const externalDirectory = path.join(root, "outside-manifest");
    await mkdir(externalDirectory);
    await copyFile(external, path.join(externalDirectory, "outside-manifest.json"));
    await symlink(externalDirectory, path.join(repo, "manifest-link"), "junction");
    resolution = { ...fallbackInvestigation.repositoryResolution, manifestFile: "manifest-link/outside-manifest.json" };
  }
  const classification = await classifyDataResolution(repo, resolution, sampleClaim, verifierRuntime);
  assert.equal(classification.status, "rejected");
  assert.match(classification.rationale, /symbolic link/i);
});

test("data policy cannot validate evidence without an executable verifier runtime", async () => {
  const classification = await classifyDataResolution(
    repoDirectory,
    fallbackInvestigation.repositoryResolution,
    sampleClaim,
    null,
  );
  assert.equal(classification.status, "rejected");
  assert.match(classification.rationale, /executable verifier runtime is required/i);
});
