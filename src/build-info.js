import { execFileSync } from "node:child_process";

const ARCHIVE_COMMIT = "98e85df800ba00e82eec5bf1d320fce4b9ac36a4";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export class ApplicationCommitConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApplicationCommitConfigurationError";
    this.code = "APPLICATION_COMMIT_CONFIGURATION_INVALID";
  }
}

function commitReceipt(value, source) {
  return Object.freeze({
    value,
    source,
    formatValid: value === null ? null : COMMIT_PATTERN.test(value),
    cryptographicallyVerified: false,
    trustBoundary: value === null
      ? "No application commit was available."
      : "The value has full Git-object syntax but is not authenticated by a signed release manifest or deployment attestation.",
  });
}

function resolveApplicationCommitProvenance(projectRoot, {
  environment = process.env,
  archiveCommit = ARCHIVE_COMMIT,
  execGit = execFileSync,
} = {}) {
  const configured = String(environment.PEERPROOF_COMMIT || "").trim();
  if (configured) {
    if (!COMMIT_PATTERN.test(configured)) {
      throw new ApplicationCommitConfigurationError(
        "PEERPROOF_COMMIT must be a full 40-character hexadecimal Git commit ID.",
      );
    }
    return commitReceipt(configured.toLowerCase(), "configured-environment");
  }
  if (COMMIT_PATTERN.test(archiveCommit)) {
    return commitReceipt(archiveCommit.toLowerCase(), "git-archive-substitution");
  }
  try {
    const commit = String(execGit("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })).trim();
    return COMMIT_PATTERN.test(commit)
      ? commitReceipt(commit.toLowerCase(), "git-repository")
      : commitReceipt(null, "unavailable");
  } catch {
    return commitReceipt(null, "unavailable");
  }
}

function resolveApplicationCommit(projectRoot, options) {
  return resolveApplicationCommitProvenance(projectRoot, options).value;
}

export { ARCHIVE_COMMIT, resolveApplicationCommit, resolveApplicationCommitProvenance };
