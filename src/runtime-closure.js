import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { parse } from "acorn";
import { REGISTERED_RUNTIME_ASSETS } from "./runtime-assets.js";

export const PRODUCT_RUNTIME_ENTRY_POINTS = Object.freeze([
  "server.js",
  "bin/peerproof.js",
  "public/app.js",
]);
export const EVALUATION_RUNTIME_ENTRY_POINTS = Object.freeze([
  "scripts/agent-eval.js",
  "scripts/docker-smoke.js",
  "scripts/live-smoke.js",
  "scripts/policy-bundle-check.js",
  "scripts/policy-profile-eval.js",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const MAX_MODULES = 250;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => specifier.startsWith("node:") ? specifier : `node:${specifier}`),
]);

export class RuntimeClosureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RuntimeClosureError";
    this.code = "RUNTIME_CLOSURE_INVALID";
    this.details = details;
  }
}

function posix(value) {
  return String(value).replaceAll("\\", "/");
}

function safeRelativeFile(relative) {
  const normalized = posix(relative);
  return normalized === relative
    && normalized === path.posix.normalize(normalized)
    && !path.posix.isAbsolute(normalized)
    && normalized !== "."
    && !normalized.startsWith("..");
}

function literalString(node) {
  return typeof node?.value === "string" ? node.value : null;
}

function isImportMetaUrl(node) {
  return node?.type === "MemberExpression"
    && node.computed === false
    && node.property?.type === "Identifier"
    && node.property.name === "url"
    && node.object?.type === "MetaProperty"
    && node.object.meta?.name === "import"
    && node.object.property?.name === "meta";
}

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    if (Array.isArray(child)) child.forEach((item) => walkAst(item, visitor));
    else if (child && typeof child === "object") walkAst(child, visitor);
  }
}

function isVmSpecifier(value) {
  return value === "vm" || value === "node:vm";
}

function forbiddenMemberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return node.computed ? literalString(node.property) : null;
}

function externalPackageName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : null;
  }
  return specifier.split("/")[0] || null;
}

export function localModuleReferences(source, sourceFile = "module.js", {
  approvedPackages = [],
  approvedAssets = [],
} = {}) {
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
  } catch (error) {
    throw new RuntimeClosureError(`Could not parse first-party runtime module ${sourceFile}: ${error.message}`, {
      file: sourceFile,
      reason: "parse-failed",
    });
  }
  const references = [];
  const createRequireFactories = new Set();
  const moduleNamespaces = new Set();
  const requireBindings = new Set(["require"]);
  const recognizedNamespaceCreateRequire = new WeakSet();
  const approvedPackageSet = new Set(approvedPackages);
  const approvedAssetSet = new Set(approvedAssets);
  const unsupported = (reason, nodeType) => {
    throw new RuntimeClosureError(`Unsupported first-party code-loading pattern in ${sourceFile}: ${reason}`, {
      file: sourceFile,
      reason: "unsupported-code-loading-pattern",
      pattern: reason,
      nodeType,
    });
  };
  const classifySpecifier = (value, nodeType, loader) => {
    if (typeof value !== "string" || !value) unsupported(`non-literal ${loader} specifier`, nodeType);
    if (isVmSpecifier(value)) unsupported(`${loader} vm module`, nodeType);
    if (value === "module" || value === "node:module") {
      if (loader !== "static import") unsupported(`${loader} of module builtin`, nodeType);
      return null;
    }
    if (value.startsWith(".")) {
      if (/[?#%\\]/.test(value)) unsupported(`${loader} relative URL suffix or escape`, nodeType);
      const extension = path.posix.extname(posix(value)).toLowerCase();
      if (extension && !SOURCE_EXTENSIONS.has(extension)) {
        const assetPath = posix(path.posix.normalize(path.posix.join(
          path.posix.dirname(posix(sourceFile)),
          posix(value),
        )));
        if (loader === "import.meta URL" && approvedAssetSet.has(assetPath)) return null;
        unsupported(`${loader} relative loader targets unsupported source extension`, nodeType);
      }
      return value;
    }
    if (value.startsWith("#")) unsupported(`${loader} package import-map specifier`, nodeType);
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
      unsupported(`${loader} absolute path`, nodeType);
    }
    if (BUILTIN_SPECIFIERS.has(value)) return null;
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) unsupported(`${loader} URL scheme`, nodeType);
    const packageName = externalPackageName(value);
    if (!packageName || !approvedPackageSet.has(packageName)) {
      unsupported(`${loader} unapproved external package`, nodeType);
    }
    return null;
  };

  // Collection passes deliberately run before call analysis. JavaScript permits
  // import declarations after other statements, so source-order discovery would
  // otherwise miss an earlier createRequire initializer.
  walkAst(ast, (node) => {
    if (node.type === "ImportDeclaration"
      && ["module", "node:module"].includes(literalString(node.source))) {
      for (const imported of node.specifiers || []) {
        if (imported.type === "ImportSpecifier" && imported.imported?.name === "createRequire") {
          createRequireFactories.add(imported.local.name);
        } else if (imported.type === "ImportNamespaceSpecifier"
          || imported.type === "ImportDefaultSpecifier"
          || (imported.type === "ImportSpecifier" && imported.imported?.name === "default")) {
          moduleNamespaces.add(imported.local.name);
        }
      }
    }
  });
  walkAst(ast, (node) => {
    const target = node.type === "VariableDeclarator" ? node.id : node.left;
    const initializer = node.type === "VariableDeclarator" ? node.init : node.right;
    const namespaceFactory = initializer?.callee?.type === "MemberExpression"
      && initializer.callee.object?.type === "Identifier"
      && moduleNamespaces.has(initializer.callee.object.name)
      && forbiddenMemberName(initializer.callee) === "createRequire";
    if ((node.type === "VariableDeclarator" || node.type === "AssignmentExpression")
      && target?.type === "Identifier"
      && initializer?.type === "CallExpression"
      && ((initializer.callee?.type === "Identifier" && createRequireFactories.has(initializer.callee.name))
        || namespaceFactory)) {
      requireBindings.add(target.name);
      if (namespaceFactory) recognizedNamespaceCreateRequire.add(initializer.callee);
    }
  });

  walkAst(ast, (node) => {
    let specifier = null;
    let kind = null;
    if (node.type === "Identifier" && node.name === "eval") {
      unsupported("eval identifier reference", node.type);
    }
    if (node.type === "Identifier" && node.name === "Function") {
      unsupported("Function constructor reference", node.type);
    }
    if (node.type === "Identifier" && node.name === "getBuiltinModule") {
      unsupported("process.getBuiltinModule reference", node.type);
    }
    if (["eval", "Function"].includes(forbiddenMemberName(node))) {
      unsupported(`${forbiddenMemberName(node)} member reference`, node.type);
    }
    if (forbiddenMemberName(node) === "getBuiltinModule") {
      unsupported("process.getBuiltinModule reference", node.type);
    }
    if (forbiddenMemberName(node) === "createRequire"
      && node.object?.type === "Identifier"
      && moduleNamespaces.has(node.object.name)
      && !recognizedNamespaceCreateRequire.has(node)) {
      unsupported("untraced namespace createRequire reference", node.type);
    }
    if (node.type === "ImportDeclaration") {
      specifier = classifySpecifier(literalString(node.source), node.type, "static import");
      kind = "static-esm-import";
    } else if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) {
      specifier = classifySpecifier(literalString(node.source), node.type, "static export");
      kind = "static-esm-export";
    } else if (node.type === "ImportExpression") {
      if (literalString(node.source) === null) unsupported("computed dynamic import", node.type);
      specifier = classifySpecifier(literalString(node.source), node.type, "dynamic import");
      kind = "literal-dynamic-import";
    } else if (node.type === "CallExpression"
      && node.callee?.type === "Identifier"
      && requireBindings.has(node.callee.name)) {
      if (node.arguments.length !== 1 || literalString(node.arguments[0]) === null) {
        unsupported("computed CommonJS require", node.type);
      }
      specifier = classifySpecifier(literalString(node.arguments[0]), node.type, "CommonJS require");
      kind = "literal-commonjs-require";
    } else if (node.type === "CallExpression"
      && node.callee?.type === "MemberExpression"
      && node.callee.computed === false
      && node.callee.object?.type === "Identifier"
      && requireBindings.has(node.callee.object.name)
      && node.callee.property?.name === "resolve") {
      if (node.arguments.length !== 1 || literalString(node.arguments[0]) === null) {
        unsupported("computed CommonJS require.resolve", node.type);
      }
      specifier = classifySpecifier(literalString(node.arguments[0]), node.type, "CommonJS require.resolve");
      kind = "literal-commonjs-resolve";
    } else if (node.type === "NewExpression"
      && node.callee?.type === "Identifier"
      && node.callee.name === "URL"
      && node.arguments.length === 2
      && isImportMetaUrl(node.arguments[1])) {
      if (literalString(node.arguments[0]) === null) unsupported("computed import.meta URL", node.type);
      specifier = classifySpecifier(literalString(node.arguments[0]), node.type, "import.meta URL");
      kind = "literal-import-meta-url";
    }
    if (specifier) references.push({ specifier, kind });
  });
  return references;
}

async function resolveContainedFile(projectRoot, rootRealPath, relative) {
  if (!safeRelativeFile(relative)) {
    throw new RuntimeClosureError(`Runtime closure path is unsafe: ${relative}`, {
      file: relative,
      reason: "unsafe-relative-path",
    });
  }
  const candidate = path.join(projectRoot, ...relative.split("/"));
  const details = await lstat(candidate);
  if (details.isSymbolicLink()) {
    throw new RuntimeClosureError(`Runtime closure path is a symbolic link: ${relative}`, {
      file: relative,
      reason: "symbolic-link",
    });
  }
  const resolved = await realpath(candidate);
  const relativeToRoot = path.relative(rootRealPath, resolved);
  if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new RuntimeClosureError(`Runtime closure path escaped the project root: ${relative}`, {
      file: relative,
      reason: "realpath-outside-root",
    });
  }
  const resolvedDetails = await lstat(resolved);
  if (!resolvedDetails.isFile()) {
    throw new RuntimeClosureError(`Runtime closure path is not a file: ${relative}`, {
      file: relative,
      reason: "not-file",
    });
  }
  return resolved;
}

function referenceCandidates(fromFile, reference) {
  const exact = posix(path.posix.normalize(path.posix.join(
    path.posix.dirname(fromFile),
    posix(reference.specifier),
  )));
  const extension = path.posix.extname(exact).toLowerCase();
  if (extension) return [[exact, "exact-literal"]];
  return [
    [exact, "exact-file"],
    [`${exact}.js`, "js-extension"],
    [`${exact}.mjs`, "mjs-extension"],
    [`${exact}.cjs`, "cjs-extension"],
    [`${exact}/index.js`, "index-js"],
    [`${exact}/index.mjs`, "index-mjs"],
    [`${exact}/index.cjs`, "index-cjs"],
  ];
}

async function resolveModuleReference(projectRoot, rootRealPath, fromFile, reference) {
  const candidates = referenceCandidates(fromFile, reference);
  if (candidates.length === 0) return null;
  for (const [candidate, resolutionRule] of candidates) {
    try {
      await resolveContainedFile(projectRoot, rootRealPath, candidate);
      return { target: candidate, resolutionRule };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.details?.reason !== "not-file") throw error;
    }
  }
  throw new RuntimeClosureError(
    `Literal first-party runtime reference could not be resolved: ${fromFile} -> ${reference.specifier}`,
    { file: fromFile, specifier: reference.specifier, kind: reference.kind, reason: "unresolved-local-module" },
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function declaredRuntimePackages(projectRoot, rootRealPath) {
  let packageFile;
  try {
    packageFile = await resolveContainedFile(projectRoot, rootRealPath, "package.json");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(packageFile, "utf8"));
  } catch (error) {
    throw new RuntimeClosureError(`Could not read package.json for runtime closure: ${error.message}`, {
      file: "package.json",
      reason: "invalid-package-metadata",
    });
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (metadata[field] !== undefined
      && (!metadata[field] || typeof metadata[field] !== "object" || Array.isArray(metadata[field]))) {
      throw new RuntimeClosureError(`package.json ${field} must be an object`, {
        file: "package.json",
        reason: "invalid-package-metadata",
      });
    }
  }
  return [...new Set([
    ...Object.keys(metadata.dependencies || {}),
    ...Object.keys(metadata.optionalDependencies || {}),
  ])].sort();
}

export async function discoverRuntimeClosure(projectRoot, { entryPoints, approvedPackages } = {}) {
  const roots = [...new Set((entryPoints || PRODUCT_RUNTIME_ENTRY_POINTS).map(posix))].sort();
  const root = path.resolve(projectRoot);
  const rootRealPath = await realpath(root);
  if (approvedPackages !== undefined && !Array.isArray(approvedPackages)) {
    throw new RuntimeClosureError("approvedPackages must be an array", {
      reason: "invalid-package-admission",
    });
  }
  const runtimePackages = approvedPackages === undefined
    ? await declaredRuntimePackages(root, rootRealPath)
    : [...new Set(approvedPackages)].sort();
  const approvedAssets = REGISTERED_RUNTIME_ASSETS.map((entry) => entry.path);
  const queue = [...roots];
  const visited = new Set();
  const edges = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    if (visited.size >= MAX_MODULES) {
      throw new RuntimeClosureError(`Runtime closure exceeded ${MAX_MODULES} modules`, {
        reason: "module-limit",
      });
    }
    const resolved = await resolveContainedFile(root, rootRealPath, current);
    const bytes = await readFile(resolved);
    if (bytes.length > MAX_SOURCE_BYTES) {
      throw new RuntimeClosureError(`Runtime module exceeded ${MAX_SOURCE_BYTES} bytes: ${current}`, {
        file: current,
        reason: "source-size-limit",
      });
    }
    visited.add(current);
    for (const reference of localModuleReferences(bytes.toString("utf8"), current, {
      approvedPackages: runtimePackages,
      approvedAssets,
    })) {
      const resolution = await resolveModuleReference(root, rootRealPath, current, reference);
      if (!resolution) continue;
      edges.push({
        from: current,
        to: resolution.target,
        kind: reference.kind,
        specifier: reference.specifier,
        resolutionRule: resolution.resolutionRule,
      });
      if (!visited.has(resolution.target)) queue.push(resolution.target);
    }
  }
  const modules = [...visited].sort();
  const sortedEdges = edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const identity = { entryPoints: roots, modules, edges: sortedEdges };
  return {
    schemaVersion: "peerproof.runtime-closure.v1",
    ...identity,
    closureSha256: digest(identity),
  };
}

export async function inspectRuntimeClosureCoverage(projectRoot, manifest) {
  const product = await discoverRuntimeClosure(projectRoot, {
    entryPoints: manifest.runtimeClosure.productEntryPoints,
  });
  const evaluations = await discoverRuntimeClosure(projectRoot, {
    entryPoints: manifest.runtimeClosure.evaluationEntryPoints,
  });
  const observedModules = [...new Set([...product.modules, ...evaluations.modules])].sort();
  const declaredModules = [...manifest.runtimeClosure.modules].sort();
  const manifestFiles = new Set(Object.keys(manifest.files));
  const missingFromManifest = observedModules.filter((file) => !manifestFiles.has(file));
  const undeclaredReachable = observedModules.filter((file) => !declaredModules.includes(file));
  const staleDeclared = declaredModules.filter((file) => !observedModules.includes(file));
  return {
    match: missingFromManifest.length === 0
      && undeclaredReachable.length === 0
      && staleDeclared.length === 0
      && product.closureSha256 === manifest.runtimeClosure.productClosureSha256
      && evaluations.closureSha256 === manifest.runtimeClosure.evaluationClosureSha256,
    product,
    evaluations,
    observedModules,
    missingFromManifest,
    undeclaredReachable,
    staleDeclared,
  };
}
