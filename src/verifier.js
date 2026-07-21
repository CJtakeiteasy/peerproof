import { round } from "./utils.js";

function reportedSignificance(reportedP, threshold) {
  if (!reportedP) return null;
  if (reportedP.operator === "<") return reportedP.value <= threshold ? true : null;
  if (reportedP.operator === "<=") return reportedP.value < threshold ? true : null;
  if (reportedP.operator === "=") return reportedP.value < threshold;
  if ((reportedP.operator === ">" || reportedP.operator === ">=") && reportedP.value >= threshold) {
    return false;
  }
  return null;
}

function scaledEffectChange(perturbed, baseline, baselineStandardError) {
  if (!Number.isFinite(baselineStandardError) || baselineStandardError <= 0) return null;
  const scale = Math.max(Math.abs(baseline), baselineStandardError);
  return {
    value: Math.abs(perturbed - baseline) / scale,
    scale,
    scaleBasis: Math.abs(baseline) >= baselineStandardError ? "absolute baseline coefficient" : "baseline standard error",
  };
}

export function verifyClaim({ claim, execution }) {
  if (!execution?.baseline) {
    return {
      comparison: null,
      robustness: null,
      verdict: {
        label: "Unverifiable",
        tone: "neutral",
        reason: "The independent verifier did not produce a machine-readable result.",
        rule: "No independent execution artifact -> Unverifiable",
      },
    };
  }

  const threshold = claim.verification.significanceThreshold;
  const relativeThreshold = claim.verification.relativeEffectChangeThreshold;
  const reportedEffect = claim.evidence.reportedEffect;
  const reportedEffectRaw = claim.evidence.reportedEffectRaw;
  const reportedEffectDecimals = claim.evidence.reportedEffectDecimals;
  const regeneratedEffect = execution.baseline.slope;
  const regeneratedEffectAtReportedPrecision = regeneratedEffect.toFixed(reportedEffectDecimals);
  const absoluteDifference = Math.abs(regeneratedEffect - reportedEffect);
  const effectMatches = regeneratedEffectAtReportedPrecision === reportedEffectRaw;
  const directionMatches =
    claim.evidence.expectedDirection == null
    || claim.evidence.expectedDirection === "none"
    || (claim.evidence.expectedDirection === "positive" && regeneratedEffect > 0)
    || (claim.evidence.expectedDirection === "negative" && regeneratedEffect < 0);
  const baselineSignificant = execution.baseline.pValue < threshold;
  const reportedSignificant = reportedSignificance(claim.evidence.reportedP, threshold);
  if (reportedSignificant === null || !Array.isArray(execution.leaveOneOut) || execution.leaveOneOut.length === 0) {
    return {
      comparison: null,
      robustness: null,
      verdict: {
        label: "Unverifiable",
        tone: "neutral",
        reason: "The reported p-value semantics or independent leave-one-out artifact were insufficient for the current verifier.",
        rule: "Incomplete verification inputs -> Unverifiable",
      },
    };
  }
  const baselineSupportsClaim = effectMatches && directionMatches && baselineSignificant === reportedSignificant;

  const diagnostics = execution.leaveOneOut.map((result) => {
    const stability = scaledEffectChange(result.slope, regeneratedEffect, execution.baseline.standardError);
    return {
      ...result,
      significanceChanged: (result.pValue < threshold) !== baselineSignificant,
      directionChanged: Math.sign(result.slope) !== Math.sign(regeneratedEffect),
      effectChange: Math.abs(result.slope - regeneratedEffect),
      effectStabilityChange: stability?.value ?? null,
      effectStabilityScale: stability?.scale ?? null,
      effectStabilityScaleBasis: stability?.scaleBasis ?? null,
      effectStabilityChanged: stability !== null && stability.value >= relativeThreshold,
    };
  });
  const thresholdCrossings = diagnostics.filter(
    (result) => result.significanceChanged || result.directionChanged || result.effectStabilityChanged,
  );
  const candidatePool = thresholdCrossings.length > 0 ? thresholdCrossings : diagnostics;
  const influential = [...candidatePool].sort((a, b) => (
    (b.effectStabilityChange ?? -1) - (a.effectStabilityChange ?? -1) || b.effectChange - a.effectChange
  ))[0];
  const fragile = thresholdCrossings.length > 0;

  const comparison = {
    reportedEffect,
    reportedEffectRaw,
    reportedEffectDecimals,
    regeneratedEffect: round(regeneratedEffect, 6),
    regeneratedEffectAtReportedPrecision,
    absoluteDifference: round(absoluteDifference, 6),
    comparisonRule: claim.verification.effectComparisonRule,
    effectMatches,
    directionMatches,
    reportedP: claim.evidence.reportedP,
    regeneratedPValue: execution.baseline.pValue,
    baselineSupportsClaim,
    authorPipelineEffect: execution.authorPipeline?.coefficient ?? null,
    independentVerifierEffect: regeneratedEffect,
    authorVerifierCrossCheck: execution.independentVerifier?.crossCheck ?? null,
  };
  const robustness = {
    check: "Independent leave-one-observation-out decision-boundary and effect-stability test",
    rule: claim.verification.robustnessRule,
    removedObservation: influential.removedId,
    baselineEffect: round(regeneratedEffect, 6),
    perturbedEffect: round(influential.slope, 6),
    baselinePValue: execution.baseline.pValue,
    perturbedPValue: influential.pValue,
    significanceChanged: influential.significanceChanged,
    directionChanged: influential.directionChanged,
    effectStabilityChange: influential.effectStabilityChange === null ? null : round(influential.effectStabilityChange, 6),
    effectStabilityScale: influential.effectStabilityScale === null ? null : round(influential.effectStabilityScale, 6),
    effectStabilityScaleBasis: influential.effectStabilityScaleBasis,
    relativeEffectChangeThreshold: relativeThreshold,
    effectStabilityChanged: influential.effectStabilityChanged,
    thresholdCrossingCount: thresholdCrossings.length,
    diagnostics: diagnostics.map((diagnostic) => ({
      removedId: diagnostic.removedId,
      slope: round(diagnostic.slope, 6),
      pValue: diagnostic.pValue,
      effectChange: round(diagnostic.effectChange, 6),
      effectStabilityChange: diagnostic.effectStabilityChange === null ? null : round(diagnostic.effectStabilityChange, 6),
      effectStabilityScale: diagnostic.effectStabilityScale === null ? null : round(diagnostic.effectStabilityScale, 6),
      effectStabilityScaleBasis: diagnostic.effectStabilityScaleBasis,
      significanceChanged: diagnostic.significanceChanged,
      directionChanged: diagnostic.directionChanged,
      effectStabilityChanged: diagnostic.effectStabilityChanged,
    })),
    fragile,
  };

  if (!baselineSupportsClaim) {
    return {
      comparison,
      robustness,
      verdict: {
        label: "Failed",
        tone: "danger",
        reason: "The independently regenerated canonical result does not satisfy the predeclared reported-precision comparison rule.",
        rule: "Independent canonical result mismatch -> Failed",
      },
    };
  }
  if (fragile) {
    const changedConclusion = [
      influential.significanceChanged ? "statistical significance" : null,
      influential.directionChanged ? "effect direction" : null,
      influential.effectStabilityChanged
        ? `scaled effect magnitude (${(influential.effectStabilityChange * 100).toFixed(1)}% >= ${(relativeThreshold * 100).toFixed(0)}%; scale: ${influential.effectStabilityScaleBasis})`
        : null,
    ].filter(Boolean).join(", ");
    return {
      comparison,
      robustness,
      verdict: {
        label: "Fragile",
        tone: "warning",
        reason: `The canonical result reproduces, but independently removing ${influential.removedId} changes ${changedConclusion}.`,
        rule: "Canonical result matches + predeclared robustness threshold crossed -> Fragile",
      },
    };
  }
  return {
    comparison,
    robustness,
    verdict: {
      label: "Reproduced",
      tone: "success",
      reason: "The independent canonical result matches and no predeclared leave-one-out threshold is crossed.",
      rule: "Canonical result matches + robustness stable -> Reproduced",
    },
  };
}
