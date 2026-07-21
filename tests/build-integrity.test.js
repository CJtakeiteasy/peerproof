import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitApplicationBuild,
  assertApplicationAdmissionContinuity,
  BuildIntegrityAdmissionError,
  BUILD_MANIFEST_PATH,
  validateBuildIntegrityManifest,
} from "../src/build-integrity.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reviewed application build is admitted with verifier identities before audit execution", async () => {
  const receipt = await admitApplicationBuild(projectRoot);
  assert.equal(receipt.status, "exact-match");
  assert.equal(receipt.verifierFilesMatched, true);
  assert.equal(receipt.signed, false);
  assert.match(receipt.buildManifestSha256, /^[a-f0-9]{64}$/);
  assert.match(
    receipt.fileIdentities["src/verifiers/summary-matrix.js"].canonicalSha256,
    /^[a-f0-9]{64}$/,
  );
});

test("runtime-load admission continuity rejects a replaced manifest identity", async () => {
  const receipt = await admitApplicationBuild(projectRoot);
  const replaced = structuredClone(receipt);
  replaced.buildManifestSha256 = "f".repeat(64);
  assert.throws(
    () => assertApplicationAdmissionContinuity(receipt, replaced),
    (error) => error instanceof BuildIntegrityAdmissionError
      && error.details.reason === "runtime-load-admission-discontinuity",
  );
});

test("governed verifier modification is rejected before an audit can run", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-build-integrity-"));
  try {
    const manifest = validateBuildIntegrityManifest(JSON.parse(
      await readFile(path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")), "utf8"),
    ));
    await mkdir(path.join(temporaryRoot, "policies"), { recursive: true });
    await cp(
      path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")),
      path.join(temporaryRoot, ...BUILD_MANIFEST_PATH.split("/")),
    );
    for (const relative of Object.keys(manifest.files)) {
      const target = path.join(temporaryRoot, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(projectRoot, ...relative.split("/")), target);
    }
    const verifier = path.join(temporaryRoot, "src", "verifiers", "summary-matrix.js");
    await writeFile(verifier, `${await readFile(verifier, "utf8")}\n// tampered\n`, "utf8");
    await assert.rejects(
      admitApplicationBuild(temporaryRoot),
      (error) => error instanceof BuildIntegrityAdmissionError
        && error.code === "BUILD_INTEGRITY_ADMISSION_FAILED"
        && error.details.mismatched.some((item) => item.file === "src/verifiers/summary-matrix.js"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("every formerly omitted reachable runtime file is governed against fabricated-verdict bypasses", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-runtime-closure-tamper-"));
  try {
    const manifest = validateBuildIntegrityManifest(JSON.parse(
      await readFile(path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")), "utf8"),
    ));
    await mkdir(path.join(temporaryRoot, "policies"), { recursive: true });
    await cp(
      path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")),
      path.join(temporaryRoot, ...BUILD_MANIFEST_PATH.split("/")),
    );
    for (const relative of Object.keys(manifest.files)) {
      const target = path.join(temporaryRoot, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(projectRoot, ...relative.split("/")), target);
    }
    for (const relative of [
      "src/real-world-case.js",
      "src/sample-case.js",
      "src/pdf-source.js",
      "src/pdf-worker.js",
      "src/version.js",
    ]) {
      const target = path.join(temporaryRoot, ...relative.split("/"));
      const original = await readFile(target, "utf8");
      await writeFile(target, `${original}\n// fabricated-runtime-bypass\n`, "utf8");
      await assert.rejects(
        admitApplicationBuild(temporaryRoot),
        (error) => error instanceof BuildIntegrityAdmissionError
          && error.code === "BUILD_INTEGRITY_ADMISSION_FAILED"
          && error.details.mismatched?.some((item) => item.file === relative),
        `${relative} modification must fail admission`,
      );
      await writeFile(target, original, "utf8");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
