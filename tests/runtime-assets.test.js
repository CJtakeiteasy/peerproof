import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_MANIFEST_PATH,
  validateBuildIntegrityManifest,
} from "../src/build-integrity.js";
import { listTrustedPolicyCases } from "../src/policy-registry.js";
import { listPublicEvidenceBundles } from "../src/public-evidence-bundle.js";
import {
  CASE_POLICY_ASSETS,
  inspectRuntimeAssetClosure,
  PUBLIC_EVIDENCE_POLICY_ASSETS,
} from "../src/runtime-assets.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadManifest() {
  return JSON.parse(await readFile(path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")), "utf8"));
}

test("registered policy and public-evidence assets exactly match governed policy files", async () => {
  const manifest = validateBuildIntegrityManifest(await loadManifest());
  const inspection = await inspectRuntimeAssetClosure(projectRoot, manifest);
  assert.equal(inspection.match, true);
  const registeredPolicies = [...CASE_POLICY_ASSETS, ...PUBLIC_EVIDENCE_POLICY_ASSETS]
    .map((entry) => entry.path)
    .sort();
  assert.deepEqual(inspection.registeredPolicies, registeredPolicies);
  assert.deepEqual(inspection.governedPolicies, registeredPolicies);
  assert.deepEqual(
    listTrustedPolicyCases().map((entry) => entry.policyFile).sort(),
    CASE_POLICY_ASSETS.map((entry) => entry.path).sort(),
  );
  assert.deepEqual(
    listPublicEvidenceBundles().map((entry) => entry.policyFile).sort(),
    PUBLIC_EVIDENCE_POLICY_ASSETS.map((entry) => entry.path).sort(),
  );
});

test("manifest validation rejects missing registered assets and unregistered governed policies", async () => {
  const original = await loadManifest();
  const missing = structuredClone(original);
  delete missing.files[CASE_POLICY_ASSETS[0].path];
  assert.throws(() => validateBuildIntegrityManifest(missing), /registered runtime asset is not governed/i);

  const extra = structuredClone(original);
  extra.files["policies/cases/unregistered.v1.json"] = {
    canonicalSha256: "a".repeat(64),
    role: "trusted-case-policy",
  };
  assert.throws(() => validateBuildIntegrityManifest(extra), /governed policy is not registered/i);
});

test("an unregistered policy file on disk makes asset closure fail closed", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-asset-closure-"));
  try {
    for (const entry of [...CASE_POLICY_ASSETS, ...PUBLIC_EVIDENCE_POLICY_ASSETS]) {
      const target = path.join(temporaryRoot, ...entry.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(projectRoot, ...entry.path.split("/")), target);
    }
    const extra = path.join(temporaryRoot, "policies", "cases", "unregistered.v1.json");
    await writeFile(extra, "{}\n", "utf8");
    const inspection = await inspectRuntimeAssetClosure(temporaryRoot, await loadManifest());
    assert.equal(inspection.match, false);
    assert.deepEqual(inspection.unregisteredOnDisk, ["policies/cases/unregistered.v1.json"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
