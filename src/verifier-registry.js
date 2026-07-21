import {
  OLS_VERIFICATION_CONTRACT,
  simpleOlsVerifierRuntime,
  supportsSimpleUnivariateOls,
} from "./verifiers/simple-ols.js";
import {
  SUMMARY_MATRIX_CONTRACT,
  summaryMatrixVerifierRuntime,
  supportsSummaryMatrix,
} from "./verifiers/summary-matrix.js";

const REQUIRED_BASE_METHODS = Object.freeze([
  "matchClaim",
  "validateEvidenceManifest",
  "evaluateEvidenceContract",
  "loadEvidence",
  "recompute",
  "buildExecutionRecord",
  "runRobustnessSuite",
  "applyVerdict",
  "normalizeError",
]);
const STRATEGY_METHODS = Object.freeze({
  "author-pipeline-cross-check": Object.freeze([
    "validateAuthorArtifact",
    "compareAuthorArtifact",
    "verifyExecution",
    "runDataDependencyCanary",
  ]),
  "independent-evidence-audit": Object.freeze([
    "buildComparison",
    "buildVisualEvidence",
  ]),
});

function validateRuntime(runtime) {
  if (!runtime?.id || !runtime?.contract?.id) throw new Error("Verifier runtime requires id and contract");
  const strategyMethods = STRATEGY_METHODS[runtime.strategy];
  if (!strategyMethods) throw new Error(`Verifier runtime ${runtime.id} has an unsupported strategy`);
  for (const method of [...REQUIRED_BASE_METHODS, ...strategyMethods]) {
    if (typeof runtime[method] !== "function") throw new Error(`Verifier runtime ${runtime.id} is missing ${method}`);
  }
  if (!Array.isArray(runtime.runtimeSourceFiles) || runtime.runtimeSourceFiles.length === 0) {
    throw new Error(`Verifier runtime ${runtime.id} requires runtimeSourceFiles`);
  }
  if (!runtime.provenanceFiles || !runtime.evidenceContractDescription || !runtime.presentation) {
    throw new Error(`Verifier runtime ${runtime.id} requires provenance, evidence-contract, and presentation metadata`);
  }
  for (const method of ["comparisonSummary", "robustnessSummary"]) {
    if (typeof runtime.presentation[method] !== "function") {
      throw new Error(`Verifier runtime ${runtime.id} presentation is missing ${method}`);
    }
  }
  if (runtime.strategy === "author-pipeline-cross-check"
    && typeof runtime.presentation.canaryPreparationDetail !== "function") {
    throw new Error(`Verifier runtime ${runtime.id} presentation is missing canaryPreparationDetail`);
  }
  return runtime;
}

const registry = Object.freeze([
  validateRuntime(simpleOlsVerifierRuntime),
  validateRuntime(summaryMatrixVerifierRuntime),
]);

export function resolveVerifierRuntime(claim) {
  return registry.find((runtime) => runtime.matchClaim(claim)) || null;
}

export function resolveVerifierRuntimeByContractId(contractId) {
  return registry.find((runtime) => runtime.contract.id === contractId) || null;
}

export function matchVerifierContract(claim) {
  return resolveVerifierRuntime(claim)?.contract || null;
}

export function listVerifierContracts() {
  return registry.map((runtime) => ({
    id: runtime.contract.id,
    runtimeId: runtime.id,
    executionStrategy: runtime.strategy,
    policyLabel: runtime.contract.policyLabel,
    supportedClaim: runtime.contract.supportedClaim,
    claimSpecMatcher: runtime.contract.claimSpecMatcher,
    independentImplementation: runtime.contract.independentImplementation,
    robustnessSuite: runtime.contract.robustnessSuite,
    architectureStatus: "Registered executable runtime in a multi-contract registry with strategy-specific interfaces.",
    runtimeSourceFiles: [...runtime.runtimeSourceFiles],
    evidenceContractDescription: runtime.evidenceContractDescription.summary,
    executableInterface: [...REQUIRED_BASE_METHODS, ...STRATEGY_METHODS[runtime.strategy]],
  }));
}

export {
  OLS_VERIFICATION_CONTRACT,
  SUMMARY_MATRIX_CONTRACT,
  supportsSimpleUnivariateOls,
  supportsSummaryMatrix,
  validateRuntime,
};
