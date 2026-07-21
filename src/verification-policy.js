import {
  OLS_VERIFICATION_CONTRACT,
  matchVerifierContract,
  supportsSimpleUnivariateOls,
} from "./verifier-registry.js";

export function supportsOlsVerification(claim) {
  return supportsSimpleUnivariateOls(claim);
}

export function attachVerificationPolicy(claim, {
  reportedEvidenceLabel = "GPT-5.6 · structured extraction",
} = {}) {
  const reportedEvidence = {
    actor: reportedEvidenceLabel.startsWith("GPT-5.6") ? "GPT-5.6" : "Reviewed source",
    label: reportedEvidenceLabel,
    responsibility: "Extracted the paper's reported values and source location; did not choose the verifier rule.",
  };
  const contract = matchVerifierContract(claim);

  if (!contract) {
    return {
      ...claim,
      reportedEvidence,
      verification: null,
      executionSupport: {
        status: "extracted-only",
        message: "Extracted, but not executable by any registered verifier contract.",
        supportedScope: OLS_VERIFICATION_CONTRACT.supportedClaim,
      },
    };
  }

  return {
    ...claim,
    reportedEvidence,
    verification: { ...contract },
    executionSupport: {
      status: "supported",
      message: "Matched the registered simple univariate OLS verifier; execution still requires the declared intercept-bearing id, predictor, outcome evidence-package format.",
      supportedScope: contract.supportedClaim,
    },
  };
}

export { OLS_VERIFICATION_CONTRACT };
