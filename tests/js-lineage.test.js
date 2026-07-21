import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relativeReferenceTargets, traceJavaScriptEvidenceLineage } from "../src/js-lineage.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("static JavaScript lineage connects the approved entry to the repaired dataset URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "peerproof-lineage-"));
  try {
    await cp(path.join(projectRoot, "samples", "fragile-study", "repo"), directory, { recursive: true });
    const loaderPath = path.join(directory, "src", "load-study.js");
    const source = await readFile(loaderPath, "utf8");
    await writeFile(
      loaderPath,
      source.replace(
        'const DATA_PATH = "/Users/original-author/Desktop/lighthouse/data/study.csv";',
        'const DATA_PATH = new URL("../data/study.csv", import.meta.url);',
      ),
      "utf8",
    );
    const lineage = await traceJavaScriptEvidenceLineage({
      repoDirectory: directory,
      approvedPlan: { executable: "node", args: ["analysis.js"], cwd: "." },
      approvedDataFile: "data/study.csv",
    });
    assert.equal(lineage.status, "partial-static-confirmed");
    assert.equal(lineage.datasetReachable, true);
    assert.ok(lineage.edges.some((edge) => edge.from === "analysis.js" && edge.to === "src/load-study.js"));
    assert.ok(lineage.edges.some((edge) => edge.from === "src/load-study.js" && edge.to === "data/study.csv"));
    assert.ok(lineage.nodes.every((node) => node.sha256 === null || /^[a-f0-9]{64}$/.test(node.sha256)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dynamic paths are not promoted to independently verified lineage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "peerproof-lineage-dynamic-"));
  try {
    await writeFile(path.join(directory, "analysis.js"), 'const name = "data.csv"; new URL(name, import.meta.url);\n', "utf8");
    await writeFile(path.join(directory, "data.csv"), "x,y\n1,2\n", "utf8");
    const lineage = await traceJavaScriptEvidenceLineage({
      repoDirectory: directory,
      approvedPlan: { executable: "node", args: ["analysis.js"], cwd: "." },
      approvedDataFile: "data.csv",
    });
    assert.equal(lineage.status, "not-statically-confirmed");
    assert.equal(lineage.datasetReachable, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commented and string-literal fake imports cannot confirm dataset lineage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "peerproof-lineage-comment-"));
  try {
    await writeFile(
      path.join(directory, "analysis.js"),
      '// import "./data.csv";\nconst decoy = \'import "./data.csv"\';\n',
      "utf8",
    );
    await writeFile(path.join(directory, "data.csv"), "x,y\n1,2\n", "utf8");
    const lineage = await traceJavaScriptEvidenceLineage({
      repoDirectory: directory,
      approvedPlan: { executable: "node", args: ["analysis.js"], cwd: "." },
      approvedDataFile: "data.csv",
    });
    assert.equal(lineage.status, "not-statically-confirmed");
    assert.equal(lineage.datasetReachable, false);
    assert.deepEqual(lineage.edges, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lineage parser recognizes only literal relative references", () => {
  const references = relativeReferenceTargets(`
    import x from "./x.js";
    export { y } from "../y.mjs";
    import "package-name";
    new URL("./data.csv", import.meta.url);
    import("./lazy.js");
    import(dynamicPath);
    require("./legacy.cjs");
    require(dynamicPath);
    // import "./commented.js";
    const decoy = 'new URL("./string.csv", import.meta.url)';
  `);
  assert.deepEqual(references, [
    { reference: "./x.js", kind: "static-esm-import" },
    { reference: "../y.mjs", kind: "static-esm-export" },
    { reference: "./data.csv", kind: "static-import-meta-url" },
    { reference: "./lazy.js", kind: "literal-dynamic-import" },
    { reference: "./legacy.cjs", kind: "literal-commonjs-require" },
  ]);
});

test("bounded CommonJS resolution follows extensionless files and records the rule", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "peerproof-lineage-commonjs-"));
  try {
    await writeFile(path.join(directory, "analysis.cjs"), 'require("./loader"); require("./nested");\n', "utf8");
    await writeFile(path.join(directory, "loader.js"), 'require("./data.csv");\n', "utf8");
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "nested", "index.cjs"), 'require("../data.csv");\n', "utf8");
    await writeFile(path.join(directory, "data.csv"), "x,y\n1,2\n", "utf8");
    const lineage = await traceJavaScriptEvidenceLineage({
      repoDirectory: directory,
      approvedPlan: { executable: "node", args: ["analysis.cjs"], cwd: "." },
      approvedDataFile: "data.csv",
    });
    assert.equal(lineage.status, "partial-static-confirmed");
    assert.ok(lineage.edges.some((edge) => edge.to === "loader.js"
      && edge.resolutionRule === "commonjs-js-extension"));
    assert.ok(lineage.edges.some((edge) => edge.to === "nested/index.cjs"
      && edge.resolutionRule === "commonjs-index-cjs"));
    assert.ok(lineage.edges.some((edge) => edge.to === "data.csv"
      && edge.resolutionRule === "exact-literal"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ESM extensionless references remain strict and unresolved", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "peerproof-lineage-esm-strict-"));
  try {
    await writeFile(path.join(directory, "analysis.js"), 'import "./loader";\n', "utf8");
    await writeFile(path.join(directory, "loader.js"), 'new URL("./data.csv", import.meta.url);\n', "utf8");
    await writeFile(path.join(directory, "data.csv"), "x,y\n1,2\n", "utf8");
    const lineage = await traceJavaScriptEvidenceLineage({
      repoDirectory: directory,
      approvedPlan: { executable: "node", args: ["analysis.js"], cwd: "." },
      approvedDataFile: "data.csv",
    });
    assert.equal(lineage.status, "not-statically-confirmed");
    assert.ok(lineage.edges.some((edge) => edge.to === "loader"
      && edge.resolutionRule === "exact-literal-unresolved"));
    assert.equal(lineage.nodes.some((node) => node.file === "loader.js"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
