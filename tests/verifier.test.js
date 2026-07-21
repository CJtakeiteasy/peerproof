import test from "node:test";
import assert from "node:assert/strict";
import { sampleClaim } from "../src/sample-case.js";
import { verifyClaim } from "../src/verifier.js";

const baseline = {
  n: 10,
  slope: 1.27619,
  standardError: 0.250786,
  pValue: 0.000943,
};

test("matching but unstable evidence is Fragile", () => {
  const result = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P10", slope: 0.0333, pValue: 0.8489 }],
    },
  });
  assert.equal(result.verdict.label, "Fragile");
  assert.equal(result.robustness.removedObservation, "P10");
});

test("matching and stable evidence is Reproduced", () => {
  const result = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P01", slope: 1.21, pValue: 0.002 }],
    },
  });
  assert.equal(result.verdict.label, "Reproduced");
});

test("any significance crossing is Fragile even when another point has a larger effect change", () => {
  const result = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline: { ...baseline, pValue: 0.01 },
      leaveOneOut: [
        { removedId: "A", slope: 1.2, pValue: 0.06 },
        { removedId: "B", slope: 1.5, pValue: 0.001 },
      ],
    },
  });
  assert.equal(result.verdict.label, "Fragile");
  assert.equal(result.robustness.removedObservation, "A");
  assert.equal(result.robustness.thresholdCrossingCount, 1);
});

test("a predeclared 20 percent scaled coefficient change is Fragile without a significance crossing", () => {
  const result = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P04", slope: 0.8, pValue: 0.003 }],
    },
  });
  assert.equal(result.verdict.label, "Fragile");
  assert.equal(result.robustness.significanceChanged, false);
  assert.equal(result.robustness.directionChanged, false);
  assert.equal(result.robustness.effectStabilityChanged, true);
  assert.equal(result.robustness.relativeEffectChangeThreshold, 0.2);
  assert.equal(result.robustness.effectStabilityScaleBasis, "absolute baseline coefficient");
});

test("near-zero coefficients use standard error as the effect-stability scale", () => {
  const claim = structuredClone(sampleClaim);
  claim.evidence.reportedEffect = 0.0001;
  claim.evidence.reportedEffectRaw = "0.0001";
  claim.evidence.reportedEffectDecimals = 4;
  claim.evidence.expectedDirection = "positive";
  const result = verifyClaim({
    claim,
    execution: {
      baseline: { n: 10, slope: 0.0001, standardError: 0.01, pValue: 0.001 },
      leaveOneOut: [{ removedId: "P02", slope: 0.0002, standardError: 0.01, pValue: 0.001 }],
    },
  });
  assert.equal(result.robustness.effectStabilityScaleBasis, "baseline standard error");
  assert.equal(result.robustness.effectStabilityChange, 0.01);
  assert.equal(result.robustness.effectStabilityChanged, false);
  assert.equal(result.verdict.label, "Reproduced");
});

test("effect comparison follows the paper's printed precision", () => {
  const withinPrintedPrecision = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline: { ...baseline, slope: 1.27649 },
      leaveOneOut: [{ removedId: "P01", slope: 1.25, pValue: 0.002 }],
    },
  });
  const outsidePrintedPrecision = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline: { ...baseline, slope: 1.27651 },
      leaveOneOut: [{ removedId: "P01", slope: 1.25, pValue: 0.002 }],
    },
  });
  assert.equal(withinPrintedPrecision.comparison.effectMatches, true);
  assert.equal(outsidePrintedPrecision.comparison.effectMatches, false);
  assert.equal(outsidePrintedPrecision.verdict.label, "Failed");
});

test("missing expected direction does not force a matching claim to Failed", () => {
  const claim = structuredClone(sampleClaim);
  claim.evidence.expectedDirection = null;
  const result = verifyClaim({
    claim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P01", slope: 1.21, pValue: 0.002 }],
    },
  });
  assert.equal(result.comparison.directionMatches, true);
  assert.equal(result.verdict.label, "Reproduced");
});

test("p < .10 at alpha .05 is indeterminate and therefore Unverifiable", () => {
  const claim = structuredClone(sampleClaim);
  claim.evidence.reportedP = { operator: "<", value: 0.1, raw: "p < .10" };
  claim.verification.significanceThreshold = 0.05;
  const result = verifyClaim({
    claim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P01", slope: 1.21, pValue: 0.002 }],
    },
  });
  assert.equal(result.verdict.label, "Unverifiable");
});

test("p <= .05 is indeterminate under the strict p < .05 contract", () => {
  const claim = structuredClone(sampleClaim);
  claim.evidence.reportedP = { operator: "<=", value: 0.05, raw: "p <= .05" };
  const result = verifyClaim({
    claim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P01", slope: 1.21, pValue: 0.002 }],
    },
  });
  assert.equal(result.verdict.label, "Unverifiable");
});

test("p <= .01 is significant under the strict p < .05 contract", () => {
  const claim = structuredClone(sampleClaim);
  claim.evidence.reportedP = { operator: "<=", value: 0.01, raw: "p <= .01" };
  const result = verifyClaim({
    claim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P01", slope: 1.21, pValue: 0.002 }],
    },
  });
  assert.equal(result.verdict.label, "Reproduced");
});

test("p > .01 at alpha .05 is indeterminate and therefore Unverifiable", () => {
  const claim = structuredClone(sampleClaim);
  claim.evidence.reportedP = { operator: ">", value: 0.01, raw: "p > .01" };
  claim.verification.significanceThreshold = 0.05;
  const result = verifyClaim({
    claim,
    execution: {
      baseline,
      leaveOneOut: [{ removedId: "P01", slope: 1.21, pValue: 0.002 }],
    },
  });
  assert.equal(result.verdict.label, "Unverifiable");
});

test("canonical mismatch is Failed", () => {
  const result = verifyClaim({
    claim: sampleClaim,
    execution: {
      baseline: { ...baseline, slope: -0.4, pValue: 0.01 },
      leaveOneOut: [{ removedId: "P01", slope: -0.35, pValue: 0.02 }],
    },
  });
  assert.equal(result.verdict.label, "Failed");
});

test("missing machine-readable evidence is Unverifiable", () => {
  const result = verifyClaim({ claim: sampleClaim, execution: null });
  assert.equal(result.verdict.label, "Unverifiable");
});
