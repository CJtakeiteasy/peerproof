import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";
import { sha256 } from "./utils.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const MAX_SOURCE_FILES = 100;
const MAX_SOURCE_BYTES = 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function posixPath(value) {
  return value.replaceAll("\\", "/");
}

function relativeReferenceTargets(source) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const references = [];
  const literalRelative = (node) => typeof node?.value === "string" && node.value.startsWith(".")
    ? node.value
    : null;
  const importMetaUrl = (node) => node?.type === "MemberExpression"
    && node.computed === false
    && node.property?.type === "Identifier"
    && node.property.name === "url"
    && node.object?.type === "MetaProperty"
    && node.object.meta?.name === "import"
    && node.object.property?.name === "meta";
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    let reference = null;
    let kind = null;
    if (node.type === "ImportDeclaration") {
      reference = literalRelative(node.source);
      kind = "static-esm-import";
    } else if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) {
      reference = literalRelative(node.source);
      kind = "static-esm-export";
    } else if (node.type === "ImportExpression") {
      reference = literalRelative(node.source);
      kind = "literal-dynamic-import";
    } else if (node.type === "NewExpression"
      && node.callee?.type === "Identifier"
      && node.callee.name === "URL"
      && node.arguments.length === 2
      && importMetaUrl(node.arguments[1])) {
      reference = literalRelative(node.arguments[0]);
      kind = "static-import-meta-url";
    } else if (node.type === "CallExpression"
      && node.callee?.type === "Identifier"
      && node.callee.name === "require"
      && node.arguments.length === 1) {
      reference = literalRelative(node.arguments[0]);
      kind = "literal-commonjs-require";
    }
    if (reference) references.push({ reference, kind });
    for (const [key, child] of Object.entries(node)) {
      if (key === "start" || key === "end") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(ast);
  return references;
}

function resolveRelativeReference(fromFile, reference) {
  return posixPath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), posixPath(reference))));
}

async function resolveReferenceTarget(repoDirectory, fromFile, reference) {
  const exact = resolveRelativeReference(fromFile, reference.reference);
  const hasExtension = path.posix.extname(exact) !== "";
  const candidates = reference.kind === "literal-commonjs-require" && !hasExtension
    ? [
        [exact, "commonjs-exact-file"],
        [`${exact}.js`, "commonjs-js-extension"],
        [`${exact}.cjs`, "commonjs-cjs-extension"],
        [`${exact}.mjs`, "commonjs-mjs-extension"],
        [`${exact}/index.js`, "commonjs-index-js"],
        [`${exact}/index.cjs`, "commonjs-index-cjs"],
        [`${exact}/index.mjs`, "commonjs-index-mjs"],
      ]
    : [[exact, "exact-literal"]];
  for (const [candidate, resolutionRule] of candidates) {
    try {
      await resolveWorkspacePath(repoDirectory, candidate, "JavaScript lineage reference", { expectedType: "file" });
      return { target: candidate, resolutionRule };
    } catch {
      // A missing or unsafe candidate is not promoted to a lineage edge target.
    }
  }
  return {
    target: exact,
    resolutionRule: reference.kind === "literal-commonjs-require" && !hasExtension
      ? "commonjs-bounded-resolution-unresolved"
      : "exact-literal-unresolved",
  };
}

export async function traceJavaScriptEvidenceLineage({
  repoDirectory,
  approvedPlan,
  approvedDataFile,
}) {
  const entryArgument = approvedPlan?.args?.[0];
  if (!entryArgument || !SOURCE_EXTENSIONS.has(path.extname(entryArgument).toLowerCase())) {
    return {
      schemaVersion: "peerproof.javascript-lineage.v1",
      status: "not-applicable",
      reason: "The approved plan does not expose a supported JavaScript entry file.",
      limitations: ["Only parsed literal relative ESM, dynamic-import, CommonJS require, and import.meta.url references are traced."],
    };
  }
  const entry = posixPath(path.posix.normalize(path.posix.join(approvedPlan.cwd || ".", posixPath(entryArgument))));
  const dataset = posixPath(path.posix.normalize(approvedDataFile));
  const queue = [entry];
  const visited = new Set();
  const nodes = [];
  const edges = [];
  while (queue.length > 0 && visited.size < MAX_SOURCE_FILES) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let resolved;
    try {
      resolved = await resolveWorkspacePath(repoDirectory, file, "JavaScript lineage source", { expectedType: "file" });
    } catch {
      nodes.push({ file, type: "unresolved", sha256: null });
      continue;
    }
    const source = await readFile(resolved.resolved, "utf8");
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
      nodes.push({ file, type: "source-limit-exceeded", sha256: sha256(source) });
      continue;
    }
    nodes.push({ file, type: SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) ? "javascript" : "data", sha256: sha256(source) });
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    let references;
    try {
      references = relativeReferenceTargets(source);
    } catch (error) {
      nodes[nodes.length - 1].type = "javascript-parse-error";
      nodes[nodes.length - 1].parseError = error.message;
      continue;
    }
    for (const reference of references) {
      const { target, resolutionRule } = await resolveReferenceTarget(repoDirectory, file, reference);
      edges.push({
        from: file,
        to: target,
        kind: reference.kind,
        literal: reference.reference,
        resolutionRule,
      });
      if (!visited.has(target)) queue.push(target);
    }
  }
  const datasetReachable = edges.some((edge) => edge.to === dataset)
    && nodes.some((node) => node.file === dataset && node.type === "data");
  return {
    schemaVersion: "peerproof.javascript-lineage.v1",
    status: datasetReachable ? "partial-static-confirmed" : "not-statically-confirmed",
    entryFile: entry,
    approvedDataFile: dataset,
    datasetReachable,
    inspectedFileCount: visited.size,
    sourceFileLimitReached: queue.length > 0,
    nodes,
    edges,
    reason: datasetReachable
      ? "A parsed literal JavaScript reference path connects the approved entry point to the approved dataset."
      : "No supported parsed literal JavaScript reference path connected the approved entry point to the approved dataset.",
    limitations: [
      "This partial AST trace applies exact ESM paths and bounded CommonJS file/index candidates; it does not execute code or resolve computed paths, package exports, preprocessing semantics, or paper-term equivalence.",
      "The independent perturbation canary separately tests numerical dependence on the approved dataset.",
    ],
  };
}

export { relativeReferenceTargets, resolveReferenceTarget };
