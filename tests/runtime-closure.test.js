import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_MANIFEST_PATH,
  validateBuildIntegrityManifest,
} from "../src/build-integrity.js";
import {
  discoverRuntimeClosure,
  inspectRuntimeClosureCoverage,
  localModuleReferences,
} from "../src/runtime-closure.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("transitive runtime closure covers static imports, literal dynamic imports, and worker URLs", async () => {
  const manifest = validateBuildIntegrityManifest(JSON.parse(await readFile(
    path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")),
    "utf8",
  )));
  const coverage = await inspectRuntimeClosureCoverage(projectRoot, manifest);
  assert.equal(coverage.match, true);
  for (const required of [
    "src/real-world-case.js",
    "src/sample-case.js",
    "src/pdf-source.js",
    "src/pdf-worker.js",
    "src/version.js",
  ]) {
    assert.ok(coverage.product.modules.includes(required), `${required} must be in the product closure`);
    assert.ok(manifest.files[required], `${required} must be governed`);
  }
  assert.ok(coverage.product.edges.some((edge) => edge.from === "server.js"
    && edge.to === "src/real-world-case.js"
    && edge.kind === "literal-dynamic-import"));
  assert.ok(coverage.product.edges.some((edge) => edge.from === "src/pdf-source.js"
    && edge.to === "src/pdf-worker.js"
    && edge.kind === "literal-import-meta-url"));
  assert.ok(manifest.files["policies/cases/nested-node-policy-eval.v1.json"]);
  assert.ok(manifest.files["evals/policy-profiles/nested-node-study/analysis/workflow/reproduce.mjs"]);
});

test("closure coverage fails when a reachable wrapper is removed from the manifest", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")),
    "utf8",
  ));
  delete manifest.files["src/real-world-case.js"];
  manifest.runtimeClosure.modules = manifest.runtimeClosure.modules
    .filter((file) => file !== "src/real-world-case.js");
  const coverage = await inspectRuntimeClosureCoverage(projectRoot, manifest);
  assert.equal(coverage.match, false);
  assert.deepEqual(coverage.missingFromManifest, ["src/real-world-case.js"]);
  assert.deepEqual(coverage.undeclaredReachable, ["src/real-world-case.js"]);
});

test("manifest validation refuses narrowed product or evaluation roots", async () => {
  const original = JSON.parse(await readFile(
    path.join(projectRoot, ...BUILD_MANIFEST_PATH.split("/")),
    "utf8",
  ));
  for (const field of ["productEntryPoints", "evaluationEntryPoints"]) {
    const manifest = structuredClone(original);
    manifest.runtimeClosure[field].pop();
    assert.throws(
      () => validateBuildIntegrityManifest(manifest),
      new RegExp(`runtimeClosure\\.${field} must match the fixed admission roots`),
    );
  }
});

test("CommonJS extensionless directory references continue to index.js", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-cjs-directory-"));
  try {
    await mkdir(path.join(temporaryRoot, "lib"));
    await writeFile(path.join(temporaryRoot, "entry.cjs"), 'require("./lib");\n', "utf8");
    await writeFile(path.join(temporaryRoot, "lib", "index.js"), "export const value = 1;\n", "utf8");
    const closure = await discoverRuntimeClosure(temporaryRoot, { entryPoints: ["entry.cjs"] });
    assert.deepEqual(closure.modules, ["entry.cjs", "lib/index.js"]);
    assert.ok(closure.edges.some((edge) => edge.to === "lib/index.js" && edge.resolutionRule === "index-js"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("unrecognized computed loaders and generated-code mechanisms fail closed", () => {
  for (const [source, pattern] of [
    ['const target = "./module.js"; import(target);', /computed dynamic import/],
    ['const target = "./module.js"; require(target);', /computed CommonJS require/],
    ['new URL(getWorker(), import.meta.url);', /computed import\.meta URL/],
    ['eval("import(\\"./module.js\\")");', /eval identifier reference/],
    ['globalThis.eval("import(\\"./module.js\\")");', /eval member reference/],
    ['const execute = eval; execute("code");', /eval identifier reference/],
    ['globalThis["eval"]("code");', /eval member reference/],
    ['new Function("return import(\\"./module.js\\")");', /Function constructor reference/],
    ['Function("return import(\\"./module.js\\")")();', /Function constructor reference/],
    ['import vm from "node:vm";', /vm module/],
    ['await import("node:vm");', /vm module/],
    ['require("node:vm");', /vm module/],
    ['require.resolve("node:vm");', /vm module/],
    [`
      import { createRequire as makeRequire } from "node:module";
      const localRequire = makeRequire(import.meta.url);
      localRequire("node:vm");
    `, /vm module/],
    [`
      const moduleApi = process.getBuiltinModule("module");
      const localRequire = moduleApi.createRequire(import.meta.url);
      localRequire("./hidden.cjs");
    `, /process\.getBuiltinModule reference/],
    ['await import("data:text/javascript,export default 1");', /URL scheme/],
    ['await import("file:\/\/\/tmp\/hidden.js");', /URL scheme/],
    ['await import("file:\/\/\/C:\/reviewer\/hidden.js");', /URL scheme/],
    ['await import("https:\/\/example.invalid\/hidden.js");', /URL scheme/],
    ['import "C:/reviewer/hidden.js";', /absolute path/],
    ['import "./hidden.js?cache=1";', /relative URL suffix or escape/],
    ['import "./hidden.js#fragment";', /relative URL suffix or escape/],
    ['import "#hidden";', /package import-map specifier/],
    ['import "undeclared-package";', /unapproved external package/],
    ['require("./metadata.json");', /unsupported source extension/],
  ]) {
    assert.throws(
      () => localModuleReferences(source, "unsafe.js"),
      (error) => error?.code === "RUNTIME_CLOSURE_INVALID" && pattern.test(error.message),
    );
  }
});

test("namespace createRequire bindings are traced into the closure", async () => {
  const source = `
    import * as moduleApi from "node:module";
    const localRequire = moduleApi.createRequire(import.meta.url);
    localRequire("./hidden.cjs");
  `;
  assert.deepEqual(
    localModuleReferences(source, "entry.mjs"),
    [{ specifier: "./hidden.cjs", kind: "literal-commonjs-require" }],
  );
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-namespace-create-require-"));
  try {
    await writeFile(path.join(temporaryRoot, "entry.mjs"), source, "utf8");
    await writeFile(path.join(temporaryRoot, "hidden.cjs"), "module.exports = 1;\n", "utf8");
    const closure = await discoverRuntimeClosure(temporaryRoot, { entryPoints: ["entry.mjs"] });
    assert.deepEqual(closure.modules, ["entry.mjs", "hidden.cjs"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("external package imports require an explicit package admission", () => {
  assert.deepEqual(localModuleReferences('import "node:fs";', "entry.mjs"), []);
  assert.deepEqual(
    localModuleReferences('import "acorn";', "entry.mjs", { approvedPackages: ["acorn"] }),
    [],
  );
  assert.throws(
    () => localModuleReferences('import "acorn";', "entry.mjs"),
    /unapproved external package/,
  );
});

test("renamed createRequire bindings are traced independent of source order", async () => {
  const source = `
    const localRequire = makeRequire(import.meta.url);
    import { createRequire as makeRequire } from "node:module";
    localRequire("./hidden.cjs");
  `;
  assert.deepEqual(
    localModuleReferences(source, "entry.mjs"),
    [{ specifier: "./hidden.cjs", kind: "literal-commonjs-require" }],
  );
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "peerproof-create-require-order-"));
  try {
    await writeFile(path.join(temporaryRoot, "entry.mjs"), source, "utf8");
    await writeFile(path.join(temporaryRoot, "hidden.cjs"), "module.exports = 1;\n", "utf8");
    const closure = await discoverRuntimeClosure(temporaryRoot, { entryPoints: ["entry.mjs"] });
    assert.deepEqual(closure.modules, ["entry.mjs", "hidden.cjs"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
