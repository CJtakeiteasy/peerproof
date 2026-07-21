import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactSchemaError,
  crossCheckAuthorArtifact,
  DatasetResolutionError,
  independentlyVerifyExecution,
  IndependentCrossCheckMismatch,
  parseStudyCsv,
  recomputeIndependently,
  validateAuthorArtifact,
} from "../independent-verifier.js";
import { sha256, sha256File } from "../utils.js";
import { verifyClaim } from "../verifier.js";
import { resolveWorkspacePath } from "../workspace-path.js";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export const EVIDENCE_PACKAGE_SCHEMA_VERSION = "peerproof.evidence-package.v1";

export function validateManifest(manifest) {
  const exactFields = [
    "schemaVersion",
    "dataset",
    "idColumn",
    "outcome",
    "predictors",
    "includeIntercept",
    "missingData",
    "artifact",
    "claimMapping",
  ].sort();
  const actualFields = Object.keys(manifest || {}).sort();
  if (actualFields.length !== exactFields.length
    || actualFields.some((field, index) => field !== exactFields[index])) {
    throw new Error(`evidence manifest fields must be exactly: ${exactFields.join(", ")}`);
  }
  if (manifest.schemaVersion !== EVIDENCE_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`evidence manifest schemaVersion must be ${EVIDENCE_PACKAGE_SCHEMA_VERSION}`);
  }
  if (typeof manifest.dataset !== "string" || !manifest.dataset) throw new Error("manifest dataset is required");
  if (typeof manifest.idColumn !== "string" || !manifest.idColumn) throw new Error("manifest idColumn is required");
  if (typeof manifest.outcome !== "string" || !manifest.outcome) throw new Error("manifest outcome is required");
  if (!Array.isArray(manifest.predictors) || manifest.predictors.length !== 1
    || typeof manifest.predictors[0] !== "string" || !manifest.predictors[0]) {
    throw new Error("current verifier requires exactly one predictor");
  }
  if (new Set([manifest.idColumn, manifest.outcome, ...manifest.predictors]).size !== 3) {
    throw new Error("manifest id, outcome, and predictor columns must be distinct");
  }
  if (manifest.includeIntercept !== true) throw new Error("current verifier requires an intercept");
  if (manifest.missingData !== "reject") throw new Error("current verifier requires missingData=reject");
  if (manifest.artifact !== "stdout-json") throw new Error("current verifier requires stdout-json artifacts");
  const mapping = manifest.claimMapping;
  if (!mapping || Object.keys(mapping).sort().join(",") !== "coefficientTerm,outcome,predictor") {
    throw new Error("manifest claimMapping must contain exactly predictor, outcome, and coefficientTerm");
  }
  for (const role of ["predictor", "outcome"]) {
    if (!mapping[role] || Object.keys(mapping[role]).sort().join(",") !== "column,paperTerm"
      || typeof mapping[role].paperTerm !== "string" || !mapping[role].paperTerm
      || typeof mapping[role].column !== "string" || !mapping[role].column) {
      throw new Error(`manifest claimMapping.${role} must declare paperTerm and column`);
    }
  }
  if (mapping.predictor.column !== manifest.predictors[0]
    || mapping.outcome.column !== manifest.outcome
    || mapping.coefficientTerm !== manifest.predictors[0]) {
    throw new Error("manifest claimMapping columns must match the declared predictor and outcome contract");
  }
  return manifest;
}

export function supportsSimpleUnivariateOls(claim) {
  return Boolean(
    claim?.evidence?.testFamily === "ols"
      && claim?.evidence?.effectType === "regression_coefficient"
      && claim?.evidence?.datasetLabel
      && isFiniteNumber(claim?.evidence?.reportedEffect)
      && typeof claim?.evidence?.reportedEffectRaw === "string"
      && /^-?\d+(?:\.\d+)?$/.test(claim.evidence.reportedEffectRaw)
      && Number.isInteger(claim?.evidence?.reportedEffectDecimals)
      && claim.evidence.reportedEffectDecimals >= 0
      && claim.evidence.reportedEffectDecimals <= 12
      && Number(claim.evidence.reportedEffectRaw) === claim.evidence.reportedEffect
      && isFiniteNumber(claim?.evidence?.reportedP?.value)
      && ["<", "<=", "=", ">=", ">"].includes(claim?.evidence?.reportedP?.operator),
  );
}

export const OLS_VERIFICATION_CONTRACT = Object.freeze({
  id: "peerproof.simple-univariate-ols.v3",
  policyLabel: "PeerProof Simple Univariate OLS Contract v3",
  supportedClaim: "Simple univariate OLS coefficient with an intercept under PeerProof's manifest-declared three-column evidence-package format",
  claimSpecMatcher: "ols + regression_coefficient + exact printed effect and p-value",
  independentImplementation: "peerproof.statistics.simpleOls.v1",
  robustnessSuite: "peerproof.robustness.leave-one-out.v2",
  effectComparison: "reported-print-precision",
  effectComparisonRule: "The independently regenerated coefficient must round to the exact coefficient text and decimal precision printed in the paper.",
  significanceThreshold: 0.05,
  significanceRule: "p < 0.05",
  relativeEffectChangeThreshold: 0.2,
  effectStabilityMetric: "absolute coefficient change divided by max(abs(baseline coefficient), baseline standard error)",
  robustnessRule: "If deleting one observation changes strict p < 0.05 significance, reverses effect direction, or produces a scaled coefficient change of at least 20%, mark Fragile.",
});

const EVIDENCE_CONTRACT_DESCRIPTION = Object.freeze({
  classification: "canonical-simple-univariate-ols-evidence-package",
  rejectedClassification: "ambiguous-or-unsupported-verifier-evidence",
  summary: "A strict manifest-declared UTF-8 CSV with one ID, one predictor, one outcome, an intercept, rejected missing values, and stdout JSON.",
  approvalActor: "Trusted benchmark data policy",
  approvalScope: "One repository-relative CSV under the declared simple-univariate OLS evidence contract",
  mappingAssertion: "Declared and policy-approved mapping; not an independently proven scientific fact",
  preprocessingStatement: "No preprocessing is declared by this verifier contract; upstream transformations are not independently attested.",
});

function evaluateEvidenceContract({ manifest, claim }) {
  const claimMappingMatches = Boolean(claim)
    && manifest.claimMapping.predictor.paperTerm === claim.evidence?.predictor
    && manifest.claimMapping.outcome.paperTerm === claim.evidence?.outcome;
  const checks = {
    manifestShapeSupported: true,
    onePredictor: manifest.predictors.length === 1,
    interceptRequired: manifest.includeIntercept === true,
    missingValuesRejected: manifest.missingData === "reject",
    artifactAllowListed: manifest.artifact === "stdout-json",
    claimMappingDeclared: true,
    claimMappingMatchesReportedTerms: claimMappingMatches,
  };
  return {
    checks,
    classification: EVIDENCE_CONTRACT_DESCRIPTION.classification,
    rejectedClassification: EVIDENCE_CONTRACT_DESCRIPTION.rejectedClassification,
    approvedRationale: "The proposal matches the Simple Univariate OLS evidence contract and its reviewed claim mapping.",
    rejectedRationale: "The proposal did not satisfy every Simple Univariate OLS evidence-contract check.",
    approval: {
      actor: EVIDENCE_CONTRACT_DESCRIPTION.approvalActor,
      scope: EVIDENCE_CONTRACT_DESCRIPTION.approvalScope,
      mappingAssertion: EVIDENCE_CONTRACT_DESCRIPTION.mappingAssertion,
      evidenceAttestation: {
        preprocessing: EVIDENCE_CONTRACT_DESCRIPTION.preprocessingStatement,
        analysisReadyFields: {
          id: manifest.idColumn,
          predictor: manifest.predictors[0],
          outcome: manifest.outcome,
        },
      },
    },
  };
}

function comparisonSummary({ execution, source }) {
  return {
    title: source === "as-submitted"
      ? "As-submitted analysis artifact verified"
      : "Canonical analysis reproduced after repair",
    detail: `The author pipeline and independent verifier matched at beta = ${execution.baseline.slope.toFixed(3)} with p = ${execution.baseline.pValue.toPrecision(3)}.`,
  };
}

function robustnessSummary({ verification }) {
  return {
    title: "PeerProof independent leave-one-out test completed",
    detail: `${verification.robustness.check}: removing ${verification.robustness.removedObservation} changed p from ${verification.robustness.baselinePValue.toPrecision(3)} to ${verification.robustness.perturbedPValue.toPrecision(3)}.`,
  };
}

function buildExecutionRecord({ attempt, execution, includeRobustness = true }) {
  return {
    ...attempt,
    baseline: execution.baseline,
    leaveOneOut: includeRobustness ? execution.leaveOneOut : undefined,
    authorPipeline: execution.authorPipeline,
    independentVerifier: execution.independentVerifier,
    stdout: undefined,
  };
}

function normalizeError(error) {
  if (error instanceof IndependentCrossCheckMismatch) {
    return {
      category: "pipeline-mismatch",
      stage: "pipeline-cross-check",
      title: "Author pipeline and independent verifier disagreed",
      detail: error.message,
      reason: "The author pipeline produced a valid artifact, but its canonical values did not match PeerProof's independent recomputation.",
      rule: "Valid author artifact + independent canonical mismatch -> Failed",
      scope: "Author pipeline output contradicted the independently recomputed canonical result",
      execution: error.execution,
      comparison: error.comparison,
    };
  }
  if (error instanceof DatasetResolutionError) {
    return {
      category: "dataset",
      stage: "dataset",
      reason: `The approved repository dataset could not be resolved or parsed: ${error.message}`,
      rule: "Dataset resolution or schema failure -> Unverifiable",
    };
  }
  if (error instanceof ArtifactSchemaError) {
    return {
      category: "artifact",
      stage: "artifact",
      reason: `The analysis completed but did not produce the expected machine-readable artifact: ${error.message}`,
      rule: "Missing or malformed stdout JSON -> Unverifiable",
    };
  }
  return null;
}

function serializeStudyRows(rows, contract) {
  const header = [contract.idColumn, contract.predictors[0], contract.outcome].join(",");
  return `${header}\n${rows.map((row) => `${row.id},${row.x},${row.y}`).join("\n")}\n`;
}

async function loadEvidence({ repoDirectory, dataApproval }) {
  const datasetPath = await resolveWorkspacePath(
    repoDirectory,
    dataApproval.approvedDataFile,
    "approved verifier dataset",
    { expectedType: "file" },
  );
  return parseStudyCsv(await readFile(datasetPath.resolved, "utf8"), dataApproval.contract);
}

async function runDataDependencyCanary({
  runDirectory,
  repoDirectory,
  dataApproval,
  runApproval,
  executor,
  signal,
}) {
  const canaryRepoDirectory = path.join(runDirectory, "canary-repo");
  await cp(repoDirectory, canaryRepoDirectory, { recursive: true });
  const datasetPath = await resolveWorkspacePath(
    canaryRepoDirectory,
    dataApproval.approvedDataFile,
    "canary dataset",
    { expectedType: "file" },
  );
  const rows = parseStudyCsv(await readFile(datasetPath.resolved, "utf8"), dataApproval.contract);
  const selectedIndex = Math.min(2, rows.length - 1);
  const original = rows[selectedIndex];
  const perturbed = { ...original, y: original.y + 0.1 };
  const canaryRows = rows.map((row, index) => (index === selectedIndex ? perturbed : row));
  const canaryCsv = serializeStudyRows(canaryRows, dataApproval.contract);
  await writeFile(datasetPath.resolved, canaryCsv, "utf8");
  const independent = recomputeIndependently(canaryRows);
  const attempt = await executor(canaryRepoDirectory, runApproval, { signal });
  if (attempt.status === "aborted") signal?.throwIfAborted();
  const base = {
    method: "deterministic single-cell outcome perturbation in a disposable working copy",
    verifierRuntimeId: simpleOlsVerifierRuntime.id,
    perturbation: {
      observation: original.id,
      paperVariable: dataApproval.claimMapping.outcome.paperTerm,
      repositoryColumn: dataApproval.claimMapping.outcome.column,
      originalValue: original.y,
      perturbedValue: perturbed.y,
      delta: 0.1,
    },
    canonicalDatasetSha256: await sha256File(path.join(repoDirectory, dataApproval.approvedDataFile)),
    canaryDatasetSha256: sha256(canaryCsv),
    expectedIndependent: independent.baseline,
    attempt: { ...attempt, stdout: undefined },
  };
  if (attempt.exitCode !== 0) {
    return { ...base, status: "indeterminate", confirmed: false, reason: "The author pipeline did not produce a successful artifact for the canary dataset." };
  }
  let authorArtifact;
  try {
    authorArtifact = validateAuthorArtifact(JSON.parse(attempt.stdout));
  } catch (error) {
    throw new ArtifactSchemaError(`canary stdout artifact failed schema validation: ${error.message}`);
  }
  const crossCheck = crossCheckAuthorArtifact(authorArtifact, independent.baseline, canaryRows.length);
  return {
    ...base,
    status: crossCheck.match ? "confirmed" : "disconnected",
    confirmed: crossCheck.match,
    authorPipeline: authorArtifact,
    crossCheck,
    reason: crossCheck.match
      ? "The author pipeline changed with the approved dataset and matched the independent expected canary result."
      : "The author pipeline did not match the independent result after the approved dataset was perturbed; numerical data dependency was not confirmed.",
  };
}

export const simpleOlsVerifierRuntime = Object.freeze({
  id: "peerproof.verifier-runtime.simple-ols.v1",
  strategy: "author-pipeline-cross-check",
  contract: OLS_VERIFICATION_CONTRACT,
  runtimeSourceFiles: Object.freeze([
    "src/verifiers/simple-ols.js",
    "src/independent-verifier.js",
    "src/statistics.js",
    "src/verifier.js",
  ]),
  provenanceFiles: Object.freeze({
    verifierRuntimeSourceSha256: "src/verifiers/simple-ols.js",
    independentVerifierSourceSha256: "src/independent-verifier.js",
    statisticsSourceSha256: "src/statistics.js",
    verifierSourceSha256: "src/verifier.js",
  }),
  evidenceContractDescription: EVIDENCE_CONTRACT_DESCRIPTION,
  presentation: Object.freeze({
    verificationPolicyDetail: "PeerProof - not GPT-5.6 - attached printed-precision comparison, strict significance, and independent leave-one-out rules.",
    dataPolicyDescription: "Separates the paper dataset label from a verifier-owned evidence contract and an exact repository file approval.",
    canaryPreparationTitle: "Disposable OLS data-dependency canary prepared",
    canaryPreparationDetail: ({ dataApproval }) => `PeerProof changed ${dataApproval.claimMapping.outcome.column} by +0.1 for one observation in a separate working copy and independently calculated the expected OLS result.`,
    comparisonSummary,
    robustnessSummary,
    verdictScope: "Printed coefficient and p-value independently verified for the declared univariate predictor-to-outcome model. Covariates, transformations, weights, clustering, and the full model specification were not verified.",
  }),
  matchClaim: supportsSimpleUnivariateOls,
  validateEvidenceManifest: validateManifest,
  evaluateEvidenceContract,
  validateAuthorArtifact,
  loadEvidence,
  recompute: recomputeIndependently,
  compareAuthorArtifact: crossCheckAuthorArtifact,
  buildExecutionRecord,
  runRobustnessSuite: verifyClaim,
  applyVerdict: verifyClaim,
  verifyExecution: independentlyVerifyExecution,
  runDataDependencyCanary,
  normalizeError,
});
