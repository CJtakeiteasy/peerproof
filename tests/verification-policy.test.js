import test from "node:test";
import assert from "node:assert/strict";
import { attachVerificationPolicy } from "../src/verification-policy.js";

test("unsupported extracted claims are labeled but not given an executable contract", () => {
  const claim = attachVerificationPolicy({
    text: "The intervention improved survival.",
    evidence: {
      datasetLabel: "Trial cohort",
      reportedEffect: 0.8,
      reportedPValue: 0.03,
      statisticalTest: "Cox proportional hazards model",
    },
  });
  assert.equal(claim.verification, null);
  assert.equal(claim.executionSupport.status, "extracted-only");
  assert.equal(claim.executionSupport.message, "Extracted, but not executable by any registered verifier contract.");
});

test("free-text OLS wording cannot bypass structured verifier enums", () => {
  const claim = attachVerificationPolicy({
    text: "An OLS regression reports a coefficient.",
    evidence: {
      datasetLabel: "Trial cohort",
      reportedEffect: 0.8,
      reportedP: { operator: "<", value: 0.05, raw: "p < 0.05" },
      statisticalTest: "Ordinary least squares regression",
      testFamily: "other",
      effectType: "other",
    },
  });
  assert.equal(claim.verification, null);
  assert.equal(claim.executionSupport.status, "extracted-only");
});
