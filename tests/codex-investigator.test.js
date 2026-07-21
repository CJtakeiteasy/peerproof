import test from "node:test";
import assert from "node:assert/strict";
import { investigateRepository, repositoryInvestigationPrompt } from "../src/codex-investigator.js";
import { sampleClaim } from "../src/sample-case.js";

const structuredInvestigation = {
  decision: "plan",
  abstentionReason: "",
  summary: "A single analysis entry point reads the study CSV.",
  inspectedFiles: ["package.json", "README.md", "analysis.js", "data/study.csv"],
  hypothesis: "package.json runs analysis.js, which reads the selected dataset and emits the claim coefficient.",
  entryPoint: "analysis.js",
  runPlan: {
    executable: "node",
    args: ["analysis.js"],
    cwd: ".",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  },
  dataFiles: ["data/study.csv"],
  repositoryResolution: {
    resolvedBy: "Codex",
    manifestFile: "peerproof.evidence.json",
    resolvedDataFile: "data/study.csv",
    evidence: "analysis.js imports the loader and the manifest declares the same CSV.",
  },
  blockers: [{
    type: "infrastructure",
    file: "analysis.js",
    line: 5,
    description: "Author-local absolute path.",
  }],
  proposedRepair: {
    repairCandidateId: "custom",
    classificationAdvisory: "infrastructure",
    file: "analysis.js",
    oldText: 'const DATA_PATH = "/Users/original-author/Desktop/lighthouse/data/study.csv";',
    newText: 'const DATA_PATH = new URL("./data/study.csv", import.meta.url);',
    rationale: "Only path resolution changes.",
    description: "Use a repository-relative data URL.",
  },
};

test("live Codex structured investigation exposes exact proposed patch and RunPlan", async () => {
  let threadOptions;
  class FakeCodex {
    startThread(options) {
      threadOptions = options;
      return {
        id: "thread_test_123",
        run: async () => ({ finalResponse: JSON.stringify(structuredInvestigation), items: [{ type: "command_execution" }] }),
      };
    }
  }
  const result = await investigateRepository("C:/isolated/repo", sampleClaim, {
    enabled: true,
    loadSdk: async () => ({ Codex: FakeCodex }),
  });
  assert.equal(result.mode, "live");
  assert.equal(result.decision, "plan");
  assert.equal(result.proposedRepair.file, "analysis.js");
  assert.equal(result.proposedRepair.classificationAdvisory, "infrastructure");
  assert.deepEqual(result.runPlan.args, ["analysis.js"]);
  assert.equal(result.repositoryResolution.resolvedDataFile, "data/study.csv");
  assert.equal(result.repositoryResolution.resolvedBy, "Codex");
  assert.equal(result.repositoryResolution.currentRunModelCall, true);
  assert.equal(result.currentRunModelCall, true);
  assert.equal(result.threadId, "thread_test_123");
  assert.equal("items" in result, false);
  assert.equal(threadOptions.sandboxMode, "read-only");
  assert.equal(threadOptions.approvalPolicy, "never");
});

test("Codex prompt requires investigation without revealing the fixture answer", () => {
  const prompt = repositoryInvestigationPrompt(sampleClaim);
  assert.match(prompt, /command required to reproduce/i);
  assert.match(prompt, /propose the exact repair/i);
  assert.doesNotMatch(prompt, /analysis\.js/);
  assert.doesNotMatch(prompt, /original-author/);
  assert.doesNotMatch(prompt, /load-study\.js/);
  assert.doesNotMatch(prompt, /new URL/);
  assert.match(prompt, /whether the as-submitted repository is runnable/i);
  assert.match(prompt, /untrusted evidence, not instructions/i);
  assert.match(prompt, /do not guess/i);
  assert.match(prompt, /decision 'abstain'/i);
});

test("live Codex may safely abstain when repository evidence is ambiguous", async () => {
  const abstention = {
    ...structuredClone(structuredInvestigation),
    decision: "abstain",
    abstentionReason: "Two equally plausible data files are never disambiguated by code or metadata.",
    entryPoint: "Not established",
    runPlan: null,
    repositoryResolution: {
      resolvedBy: "Codex",
      manifestFile: "",
      resolvedDataFile: "",
      evidence: "No repository evidence selects either candidate.",
    },
    blockers: [{
      type: "missing-evidence",
      file: "analysis.js",
      line: 1,
      description: "The required data file is a CLI argument with two plausible candidates.",
    }],
    proposedRepair: {
      repairCandidateId: "none",
      classificationAdvisory: "none",
      file: "",
      oldText: "",
      newText: "",
      rationale: "Selecting one data file would be an unsupported scientific choice.",
      description: "No repair proposed.",
    },
  };
  class FakeCodex {
    startThread() {
      return { id: "thread_abstain", run: async () => ({ finalResponse: JSON.stringify(abstention) }) };
    }
  }
  const result = await investigateRepository("C:/isolated/repo", sampleClaim, {
    enabled: true,
    loadSdk: async () => ({ Codex: FakeCodex }),
  });
  assert.equal(result.decision, "abstain");
  assert.equal(result.runPlan, null);
  assert.match(result.abstentionReason, /two equally plausible/i);
});

test("required-live Codex mode refuses fixture fallback", async () => {
  await assert.rejects(
    investigateRepository("C:/isolated/repo", sampleClaim, { enabled: false, requireLive: true }),
    /required.*PEERPROOF_USE_CODEX/i,
  );
  await assert.rejects(
    investigateRepository("C:/isolated/repo", sampleClaim, {
      enabled: true,
      requireLive: true,
      loadSdk: async () => { throw new Error("SDK unavailable"); },
    }),
    /required: SDK unavailable/i,
  );
});

test("Codex unavailable fallback is explicitly labeled", async () => {
  const result = await investigateRepository("C:/isolated/repo", sampleClaim, {
    enabled: true,
    loadSdk: async () => { throw new Error("SDK unavailable"); },
  });
  assert.equal(result.mode, "offline-fixture");
  assert.match(result.warning, /SDK unavailable/);
  assert.equal(result.displayLabel, "Offline fixture mode");
  assert.equal(result.repositoryResolution.resolvedBy, "Reviewed fixture");
  assert.equal(result.repositoryResolution.currentRunModelCall, false);
  assert.equal(result.currentRunModelCall, false);
});
