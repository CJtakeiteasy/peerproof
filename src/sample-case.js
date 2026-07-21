import { attachVerificationPolicy } from "./verification-policy.js";

const extractedSampleClaim = {
  id: "claim_primary",
  text: "Higher exposure is associated with a positive outcome (β = 1.276, p < 0.001).",
  source: {
    pageLabel: "Markdown · Results section",
    section: "Results",
    paragraph: "Results paragraph 1",
    quote: "Exposure was positively associated with outcome (β = 1.276, SE = 0.251, p < 0.001; Figure 1).",
  },
  evidence: {
    figure: "Figure 1",
    datasetLabel: "Lighthouse study dataset",
    reportedEffect: 1.276,
    reportedEffectRaw: "1.276",
    reportedEffectDecimals: 3,
    reportedP: { operator: "<", value: 0.001, raw: "p < 0.001" },
    statisticalTest: "Ordinary least squares regression",
    testFamily: "ols",
    effectType: "regression_coefficient",
    expectedDirection: "positive",
    standardError: 0.251,
    coefficientTerm: "exposure",
    sampleSize: null,
    confidenceInterval: null,
    outcome: "outcome",
    predictor: "exposure",
    modelFormula: null,
    missingEvidence: ["sample size", "confidence interval", "complete model formula"],
  },
  sourceAnchor: {
    status: "reviewed-fixture",
    label: "Reviewed fixture source reference · deterministic anchoring pending",
    reason: "extractSampleClaim applies deterministic text anchoring against paper.md before this fixture enters an audit.",
    exactQuoteMatch: null,
    reportedEffectPresent: null,
    reportedPValuePresent: null,
    pageLabelVerified: false,
  },
};

export const sampleClaim = attachVerificationPolicy(extractedSampleClaim, {
  reportedEvidenceLabel: "Reviewed benchmark fixture · reported evidence",
});

export const sampleCaseMetadata = {
  kind: "benchmark",
  title: "The Lighthouse Study",
  subtitle: "Deterministic smoke-test benchmark",
  description:
    "Nine observations contain no meaningful linear association. A tenth influential point makes the full-sample result appear highly significant.",
  repositoryEntryPoint: "analysis.js",
  reportedFigure: "Figure 1",
  package: {
    paper: "paper.md",
    repository: "Node.js · reviewed repository",
    dataset: "study.csv · 10 rows",
    claim: "1 selected claim",
  },
};

export const fallbackInvestigation = {
  decision: "plan",
  abstentionReason: "",
  mode: "offline-fixture",
  currentRunModelCall: false,
  displayLabel: "Offline fixture mode",
  disclosure: "This repository investigation was loaded from the reviewed benchmark fixture.",
  summary:
    "The package script identifies analysis.js as the entry point. Its imported loader contains an author-local data path that blocks execution.",
  inspectedFiles: ["package.json", "README.md", "analysis.js", "src/load-study.js", "scripts/preview.js", "docs/example.js", "data/study.csv"],
  hypothesis:
    "analysis.js is the primary entry point because package.json invokes it, it imports src/load-study.js, and it emits the canonical coefficient referenced by the selected claim.",
  entryPoint: "analysis.js",
  command: "node analysis.js",
  dataFiles: ["data/study.csv"],
  repositoryResolution: {
    resolvedBy: "Reviewed fixture",
    currentRunModelCall: false,
    manifestFile: "peerproof.evidence.json",
    resolvedDataFile: "data/study.csv",
    evidence: "analysis.js imports src/load-study.js, whose repaired repository-relative URL resolves to data/study.csv; the evidence manifest declares the same file and columns.",
  },
  blockers: [
    {
      type: "infrastructure",
      file: "src/load-study.js",
      line: 3,
      description: "DATA_PATH points to an author-local absolute path.",
    },
  ],
  proposedRepair: {
    repairCandidateId: "relative-data-url-v1",
    classificationAdvisory: "infrastructure",
    file: "src/load-study.js",
    oldText: 'const DATA_PATH = "/Users/original-author/Desktop/lighthouse/data/study.csv";',
    newText: 'const DATA_PATH = new URL("../data/study.csv", import.meta.url);',
    rationale:
      "The replacement changes only path resolution and leaves every statistical expression unchanged.",
    description:
      "Replace the author-local absolute path with a repository-relative URL. No statistical expression is modified.",
  },
  runPlan: {
    executable: "node",
    args: ["analysis.js"],
    cwd: ".",
    expectedArtifact: "stdout-json",
    timeoutMs: 10_000,
  },
};
