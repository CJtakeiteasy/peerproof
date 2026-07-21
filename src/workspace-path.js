import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function normalizeRepositoryPath(relativePath, label, { allowRoot = false } = {}) {
  if (typeof relativePath !== "string" || !relativePath
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized !== path.posix.normalize(normalized)
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || path.posix.isAbsolute(normalized)
    || (!allowRoot && normalized === ".")
  ) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return normalized;
}

export async function resolveWorkspacePath(rootDirectory, relativePath, label, {
  allowRoot = false,
  expectedType,
} = {}) {
  const normalized = normalizeRepositoryPath(relativePath, label, { allowRoot });
  const root = path.resolve(rootDirectory);
  const rootDetails = await lstat(root);
  if (rootDetails.isSymbolicLink()) throw new Error(`${label} workspace root must not be a symbolic link`);
  if (!rootDetails.isDirectory()) throw new Error(`${label} workspace root must be a directory`);
  const realRoot = await realpath(root);
  const segments = normalized === "." ? [] : normalized.split("/");
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links`);
    }
  }
  const realCandidate = await realpath(candidate);
  if (!isInside(realRoot, realCandidate)) {
    throw new Error(`${label} resolves outside the per-audit repository workspace`);
  }
  const details = await lstat(candidate);
  if (expectedType === "file" && !details.isFile()) throw new Error(`${label} must be a regular file`);
  if (expectedType === "directory" && !details.isDirectory()) throw new Error(`${label} must be a directory`);
  return {
    normalized,
    resolved: candidate,
    realRoot,
    realPath: realCandidate,
  };
}
