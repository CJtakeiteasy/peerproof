import test from "node:test";
import assert from "node:assert/strict";
import { anchorClaimSource, extractClaimsWithGpt, extractSampleClaim } from "../src/claim-extractor.js";
import { attachVerificationPolicy } from "../src/verification-policy.js";

const validClaim = {
  text: "Exposure predicts outcome (beta = 1.2, p < 0.001).",
  source: {
    pageLabel: "PDF p. 3",
    section: "Results",
    paragraph: "Results paragraph 2",
    quote: "Exposure predicts outcome (beta = 1.2, p < 0.001).",
  },
  evidence: {
    figure: "Figure 2",
    datasetLabel: "Study dataset",
    reportedEffect: 1.2,
    reportedEffectRaw: "1.2",
    reportedEffectDecimals: 1,
    reportedP: { operator: "<", value: 0.001, raw: "p < 0.001" },
    statisticalTest: "Ordinary least squares regression",
    testFamily: "ols",
    effectType: "regression_coefficient",
    expectedDirection: "positive",
    standardError: null,
    coefficientTerm: "exposure",
    sampleSize: null,
    confidenceInterval: null,
    outcome: "outcome",
    predictor: "exposure",
    modelFormula: null,
    missingEvidence: ["standard error", "sample size", "confidence interval", "model formula"],
  },
};

function response(payload, { ok = true, status = 200, requestId = "req_test_123" } = {}) {
  return { ok, status, headers: new Headers({ "x-request-id": requestId }), json: async () => payload };
}

function output(text) {
  return { status: "completed", output: [{ content: [{ type: "output_text", text }] }] };
}

const baseInput = {
  filename: "paper.txt",
  mimeType: "text/plain",
  bytes: Buffer.from("Results: Exposure predicts outcome (beta = 1.2, p < 0.001)."),
  apiKey: "test-key",
};

test("live GPT claim success attaches PeerProof policy separately", async () => {
  let requestBody;
  let requestHeaders;
  const result = await extractClaimsWithGpt({
    ...baseInput,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      requestHeaders = options.headers;
      return response(output(JSON.stringify({ claims: [validClaim], noClaimsReason: null })));
    },
  });
  assert.equal(result.mode, "live");
  assert.equal(result.claims[0].reportedEvidence.actor, "GPT-5.6");
  assert.equal(result.claims[0].verification.policyLabel, "PeerProof Simple Univariate OLS Contract v3");
  assert.equal(result.claims[0].executionSupport.status, "supported");
  assert.deepEqual(result.claims[0].evidence.reportedP, {
    operator: "<",
    value: 0.001,
    raw: "p < 0.001",
  });
  assert.match(requestBody.input[0].content, /Do not choose tolerances/);
  assert.match(requestBody.input[0].content, /untrusted source material/i);
  assert.match(requestBody.input[0].content, /never turn it into a repository path/i);
  assert.equal(requestBody.store, false);
  assert.match(requestHeaders["X-Client-Request-Id"], /^peerproof_/);
  assert.equal(result.requestId, "req_test_123");
  assert.equal(result.clientRequestId, requestHeaders["X-Client-Request-Id"]);
  assert.equal(result.claims[0].sourceAnchor.status, "anchored");
  assert.equal(result.claims[0].sourceAnchor.exactQuoteMatch, true);
  assert.equal(requestBody.input[1].content[0].type, "input_file");
  assert.equal("detail" in requestBody.input[1].content[0], false);
});

test("PDF extraction explicitly requests high-detail parsing", async () => {
  let requestBody;
  await extractClaimsWithGpt({
    ...baseInput,
    filename: "paper.pdf",
    mimeType: "application/pdf",
    pdfTextExtractor: async () => ({ status: "image-only-or-scanned", pageCount: 1, pages: [] }),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response(output(JSON.stringify({ claims: [validClaim], noClaimsReason: null })));
    },
  });
  assert.equal(requestBody.input[1].content[0].detail, "high");
});

test("PDF parser failures are disclosed as not independently anchored", async () => {
  const result = await extractClaimsWithGpt({
    ...baseInput,
    filename: "paper.pdf",
    mimeType: "application/pdf",
    pdfTextExtractor: async () => { throw new Error("malformed cross-reference table"); },
    fetchImpl: async () => response(output(JSON.stringify({ claims: [validClaim], noClaimsReason: null }))),
  });
  assert.equal(result.claims[0].sourceAnchor.status, "not-independently-anchored");
  assert.equal(result.claims[0].sourceAnchor.pdfTextLayerStatus, "parser-failed");
  assert.match(result.claims[0].sourceAnchor.reason, /PDF parsing failed/i);
});

test("PDF quotes and reported values are anchored to a deterministic page text layer", async () => {
  const result = await extractClaimsWithGpt({
    ...baseInput,
    filename: "paper.pdf",
    mimeType: "application/pdf",
    pdfTextExtractor: async () => ({
      parser: "pdfjs-dist",
      status: "text-layer-extracted",
      pageCount: 3,
      pages: [
        { pageNumber: 1, text: "Introduction", textSha256: "a".repeat(64), layoutBoxesSha256: "b".repeat(64) },
        { pageNumber: 2, text: "Methods", textSha256: "c".repeat(64), layoutBoxesSha256: "d".repeat(64) },
        {
          pageNumber: 3,
          text: `Results: ${validClaim.source.quote}`,
          textSha256: "e".repeat(64),
          layoutBoxesSha256: "f".repeat(64),
        },
      ],
    }),
    fetchImpl: async () => response(output(JSON.stringify({ claims: [validClaim], noClaimsReason: null }))),
  });
  const anchor = result.claims[0].sourceAnchor;
  assert.equal(anchor.status, "anchored");
  assert.equal(anchor.matchedPageNumber, 3);
  assert.equal(anchor.pageLabelVerified, true);
  assert.equal(anchor.pdfAnchorGranularity, "page-text-layer");
  assert.equal(anchor.pageTextSha256, "e".repeat(64));
});

test("PDF quote match does not verify a wrong model-provided page label", () => {
  const anchor = anchorClaimSource(validClaim, {
    status: "text-layer-extracted",
    pageCount: 1,
    pages: [{
      pageNumber: 1,
      text: validClaim.source.quote,
      textSha256: "a".repeat(64),
      layoutBoxesSha256: "b".repeat(64),
    }],
  }, "application/pdf");
  assert.equal(anchor.status, "not-independently-anchored");
  assert.equal(anchor.exactQuoteMatch, true);
  assert.equal(anchor.pageLabelVerified, false);
  assert.match(anchor.reason, /page 1.*page label/i);
});

test("PDF anchoring selects the occurrence matching the claimed page when a quote repeats", () => {
  const claim = structuredClone(validClaim);
  claim.source.pageLabel = "PDF p. 3";
  const repeatedText = validClaim.source.quote;
  const anchor = anchorClaimSource(claim, {
    status: "text-layer-extracted",
    pageCount: 3,
    pages: [
      { pageNumber: 1, text: repeatedText, textSha256: "a".repeat(64), layoutBoxesSha256: "b".repeat(64) },
      { pageNumber: 3, text: repeatedText, textSha256: "c".repeat(64), layoutBoxesSha256: "d".repeat(64) },
    ],
  }, "application/pdf");
  assert.equal(anchor.status, "anchored");
  assert.equal(anchor.matchedPageNumber, 3);
  assert.equal(anchor.matchingPdfPageCount, 2);
  assert.equal(anchor.pageTextSha256, "c".repeat(64));
});

test("image-only PDFs are explicitly distinguished from text-layer PDFs", () => {
  const anchor = anchorClaimSource(validClaim, {
    status: "image-only-or-scanned",
    pageCount: 4,
    pages: [],
  }, "application/pdf");
  assert.equal(anchor.status, "not-independently-anchored");
  assert.equal(anchor.pdfTextLayerStatus, "image-only-or-scanned");
  assert.match(anchor.reason, /OCR is not implemented/i);
});

test("text quote and reported values must be anchored in the uploaded document", async () => {
  const result = await extractClaimsWithGpt({
    ...baseInput,
    bytes: Buffer.from("The uploaded text does not contain the model-provided quotation."),
    fetchImpl: async () => response(output(JSON.stringify({ claims: [validClaim], noClaimsReason: null }))),
  });
  assert.equal(result.claims[0].sourceAnchor.status, "not-independently-anchored");
  assert.equal(result.claims[0].sourceAnchor.exactQuoteMatch, false);
  assert.match(result.claims[0].sourceAnchor.label, /not independently anchored/i);
});

test("text anchoring normalizes Unicode minus, comparator spacing, and records offsets and hashes", () => {
  const claim = structuredClone(validClaim);
  claim.source.quote = "The adjusted exposure effect was −1.2 in the primary model (p < 0.001).";
  claim.evidence.reportedEffect = -1.2;
  claim.evidence.reportedEffectRaw = "-1.2";
  claim.evidence.reportedP.raw = "p<0.001";
  const anchor = anchorClaimSource(
    claim,
    "Results\nThe adjusted exposure effect was -1.2 in the primary model (p< 0.001).",
    "text/plain",
  );
  assert.equal(anchor.status, "anchored");
  assert.equal(anchor.contextSufficient, true);
  assert.ok(Number.isInteger(anchor.normalizedExcerptStart));
  assert.ok(anchor.normalizedExcerptEnd > anchor.normalizedExcerptStart);
  assert.match(anchor.normalizedExcerptSha256, /^[a-f0-9]{64}$/);
  assert.equal(anchor.effectTokenSpan.text, "-1.2");
  assert.equal(anchor.pValueTokenSpan.text.toLowerCase(), "p<0.001");
});

test("text anchoring uses numeric boundaries and rejects values embedded in longer numbers", () => {
  const claim = structuredClone(validClaim);
  claim.source.quote = "The adjusted exposure coefficient was 11.2 in the primary model, with p < 0.001.";
  const anchor = anchorClaimSource(claim, claim.source.quote, "text/plain");
  assert.equal(anchor.exactQuoteMatch, true);
  assert.equal(anchor.reportedEffectPresent, false);
  assert.equal(anchor.status, "not-independently-anchored");
});

test("text anchoring rejects a value-only quote without enough surrounding context", () => {
  const claim = structuredClone(validClaim);
  claim.source.quote = "1.2, p < 0.001";
  const anchor = anchorClaimSource(claim, `Results: ${claim.source.quote}`, "text/plain");
  assert.equal(anchor.exactQuoteMatch, true);
  assert.equal(anchor.reportedEffectPresent, true);
  assert.equal(anchor.reportedPValuePresent, true);
  assert.equal(anchor.contextSufficient, false);
  assert.equal(anchor.status, "not-independently-anchored");
});

test("required-live GPT mode refuses fixture fallback", async () => {
  await assert.rejects(
    extractSampleClaim(process.cwd(), { requireLive: true, apiKey: null }),
    /required.*OPENAI_API_KEY/i,
  );
  await assert.rejects(
    extractSampleClaim(process.cwd(), {
      requireLive: true,
      apiKey: "test-key",
      extractor: async () => { throw new Error("temporary outage"); },
    }),
    /required: temporary outage/i,
  );
});

test("live GPT may honestly return no executable claims", async () => {
  const result = await extractClaimsWithGpt({
    ...baseInput,
    fetchImpl: async () => response(output(JSON.stringify({
      claims: [],
      noClaimsReason: "The document contains no quantitative result with executable evidence.",
    }))),
  });
  assert.equal(result.mode, "live");
  assert.deepEqual(result.claims, []);
  assert.match(result.noClaimsReason, /no quantitative result/i);
});

test("sample audit selects a supported claim even when GPT returns an unsupported claim first", async () => {
  const unsupported = attachVerificationPolicy({
    ...structuredClone(validClaim),
    id: "claim_unsupported",
    evidence: { ...structuredClone(validClaim.evidence), testFamily: "survival", effectType: "hazard_ratio" },
  });
  const supported = attachVerificationPolicy({ ...structuredClone(validClaim), id: "claim_supported" });
  const result = await extractSampleClaim(process.cwd(), {
    apiKey: "test-key",
    extractor: async () => ({
      mode: "live",
      displayLabel: "GPT-5.6 · structured extraction",
      disclosure: "Test extraction",
      claims: [unsupported, supported],
      noClaimsReason: null,
    }),
  });
  assert.equal(result.claim.id, "claim_supported");
  assert.equal(result.selectedClaimId, "claim_supported");
});

test("live GPT refusal is explicit", async () => {
  await assert.rejects(
    extractClaimsWithGpt({
      ...baseInput,
      fetchImpl: async () => response({
        status: "completed",
        output: [{ content: [{ type: "refusal", refusal: "Cannot process this file" }] }],
      }),
    }),
    /refused claim extraction: Cannot process this file/,
  );
});

test("malformed GPT structured output is rejected", async () => {
  await assert.rejects(
    extractClaimsWithGpt({
      ...baseInput,
      fetchImpl: async () => response(output("{not-json")),
    }),
    /malformed structured output/,
  );
});

test("incomplete GPT response is rejected", async () => {
  await assert.rejects(
    extractClaimsWithGpt({
      ...baseInput,
      fetchImpl: async () => response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    }),
    /response was incomplete: max_output_tokens/,
  );
});
