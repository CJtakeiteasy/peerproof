import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationCommitConfigurationError,
  resolveApplicationCommit,
  resolveApplicationCommitProvenance,
} from "../src/build-info.js";

const archiveHash = "a".repeat(40);
const gitHash = "b".repeat(40);

test("configured deployment commit takes precedence", () => {
  assert.equal(resolveApplicationCommit(".", {
    environment: { PEERPROOF_COMMIT: gitHash.toUpperCase() },
    archiveCommit: archiveHash,
  }), gitHash);
  assert.deepEqual(resolveApplicationCommitProvenance(".", {
    environment: { PEERPROOF_COMMIT: gitHash },
    archiveCommit: archiveHash,
  }), {
    value: gitHash,
    source: "configured-environment",
    formatValid: true,
    cryptographicallyVerified: false,
    trustBoundary: "The value has full Git-object syntax but is not authenticated by a signed release manifest or deployment attestation.",
  });
});

test("invalid configured deployment commit is a configuration error", () => {
  assert.throws(
    () => resolveApplicationCommit(".", {
      environment: { PEERPROOF_COMMIT: "not-a-git-commit" },
      archiveCommit: archiveHash,
    }),
    (error) => error instanceof ApplicationCommitConfigurationError
      && error.code === "APPLICATION_COMMIT_CONFIGURATION_INVALID",
  );
});

test("git archive substitution provides a real source commit", () => {
  assert.equal(resolveApplicationCommit(".", {
    environment: {},
    archiveCommit: archiveHash.toUpperCase(),
  }), archiveHash);
  assert.equal(resolveApplicationCommitProvenance(".", {
    environment: {},
    archiveCommit: archiveHash,
  }).source, "git-archive-substitution");
});

test("a checkout falls back to git rev-parse", () => {
  assert.equal(resolveApplicationCommit("C:/repo", {
    environment: {},
    archiveCommit: "$Format:%H$",
    execGit: () => `${gitHash}\n`,
  }), gitHash);
  assert.equal(resolveApplicationCommitProvenance("C:/repo", {
    environment: {},
    archiveCommit: "$Format:%H$",
    execGit: () => `${gitHash}\n`,
  }).source, "git-repository");
});
