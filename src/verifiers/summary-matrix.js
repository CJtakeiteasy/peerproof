import path from "node:path";
import { round } from "../utils.js";

const MANIFEST_SCHEMA_VERSION = "peerproof.summary-matrix-evidence.v1";
const SOURCE_SCHEMA_VERSION = "peerproof.reviewed-paper-source.v1";
const METRICS = Object.freeze(["meanX", "meanY", "sdX", "sdY", "correlation"]);
const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export class SummaryMatrixEvidenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SummaryMatrixEvidenceError";
    this.code = "SUMMARY_MATRIX_EVIDENCE_INVALID";
    this.details = details;
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new SummaryMatrixEvidenceError(`${label} fields must be exactly: ${required.join(", ")}`);
  }
}

export function validateSummaryMatrixManifest(manifest) {
  exactKeys(manifest, [
    "schemaVersion",
    "dataset",
    "columns",
    "expectedDatasets",
    "rowsPerDataset",
    "duplicateRows",
    "numericValues",
    "reportedTargetsSource",
    "artifact",
  ], "summary-matrix manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new SummaryMatrixEvidenceError(`summary-matrix schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof manifest.dataset !== "string" || !manifest.dataset) {
    throw new SummaryMatrixEvidenceError("summary-matrix dataset is required");
  }
  if (JSON.stringify(manifest.columns) !== JSON.stringify(["dataset", "x", "y"])) {
    throw new SummaryMatrixEvidenceError("summary-matrix columns must be exactly dataset,x,y");
  }
  if (!Array.isArray(manifest.expectedDatasets) || manifest.expectedDatasets.length < 2
    || manifest.expectedDatasets.some((name) => typeof name !== "string" || !name)
    || new Set(manifest.expectedDatasets).size !== manifest.expectedDatasets.length) {
    throw new SummaryMatrixEvidenceError("summary-matrix expectedDatasets must contain unique non-empty names");
  }
  if (!Number.isInteger(manifest.rowsPerDataset) || manifest.rowsPerDataset < 2) {
    throw new SummaryMatrixEvidenceError("summary-matrix rowsPerDataset must be an integer of at least two");
  }
  if (manifest.duplicateRows !== "reject"
    || manifest.numericValues !== "finite-strict-decimal"
    || manifest.artifact !== "independent-read-only"
    || typeof manifest.reportedTargetsSource !== "string"
    || !manifest.reportedTargetsSource.endsWith("#/anchor/reportedTargets")) {
    throw new SummaryMatrixEvidenceError("summary-matrix evidence controls are unsupported");
  }
  return manifest;
}

function validateSourceRecord(sourceRecord, manifest) {
  if (sourceRecord?.schemaVersion !== SOURCE_SCHEMA_VERSION) {
    throw new SummaryMatrixEvidenceError(`paper source schemaVersion must be ${SOURCE_SCHEMA_VERSION}`);
  }
  if (sourceRecord.documentArtifact?.redistributed !== false
    || sourceRecord.documentArtifact.sha256 !== null
    || sourceRecord.anchor?.status !== "reviewed-transcription-not-artifact-anchored") {
    throw new SummaryMatrixEvidenceError("paper source must disclose reviewed transcription without artifact anchoring");
  }
  const targets = sourceRecord.anchor.reportedTargets;
  exactKeys(targets, METRICS, "reported targets");
  for (const metric of METRICS) {
    exactKeys(targets[metric], ["value", "decimals"], `reported target ${metric}`);
    if (typeof targets[metric].value !== "string"
      || !STRICT_NUMBER.test(targets[metric].value)
      || !Number.isFinite(Number(targets[metric].value))
      || !Number.isInteger(targets[metric].decimals)
      || targets[metric].decimals < 0
      || targets[metric].decimals > 12) {
      throw new SummaryMatrixEvidenceError(`reported target ${metric} is invalid`);
    }
  }
  const expectedReference = `${path.posix.basename(manifest.reportedTargetsSource.split("#")[0])}#/anchor/reportedTargets`;
  if (!manifest.reportedTargetsSource.endsWith(expectedReference)) {
    throw new SummaryMatrixEvidenceError("reported target source reference is inconsistent");
  }
  return targets;
}

function parseStrictNumber(raw, lineNumber, column) {
  if (!STRICT_NUMBER.test(raw)) {
    throw new SummaryMatrixEvidenceError(`line ${lineNumber} ${column} must be a strict finite decimal`, {
      lineNumber,
      column,
    });
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new SummaryMatrixEvidenceError(`line ${lineNumber} ${column} must be finite`, { lineNumber, column });
  }
  return value;
}

export function parseSummaryMatrixCsv(text, manifest) {
  validateSummaryMatrixManifest(manifest);
  if (typeof text !== "string" || !text) throw new SummaryMatrixEvidenceError("summary-matrix CSV is empty");
  const normalized = text.replace(/\r\n?/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = withoutFinalNewline.split("\n");
  if (lines[0] !== manifest.columns.join(",")) {
    throw new SummaryMatrixEvidenceError("summary-matrix CSV header must be exactly dataset,x,y");
  }
  const expectedNames = new Set(manifest.expectedDatasets);
  const counts = new Map(manifest.expectedDatasets.map((name) => [name, 0]));
  const duplicates = new Set();
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (!line) throw new SummaryMatrixEvidenceError(`line ${lineNumber} is blank or malformed`, { lineNumber });
    const fields = line.split(",");
    if (fields.length !== 3) {
      throw new SummaryMatrixEvidenceError(`line ${lineNumber} must contain exactly three fields`, { lineNumber });
    }
    const [dataset, rawX, rawY] = fields;
    if (!dataset || dataset.trim() !== dataset) {
      throw new SummaryMatrixEvidenceError(`line ${lineNumber} dataset label must be non-empty and canonical`, { lineNumber });
    }
    if (!expectedNames.has(dataset)) {
      throw new SummaryMatrixEvidenceError(`line ${lineNumber} contains unexpected dataset ${dataset}`, { lineNumber });
    }
    const x = parseStrictNumber(rawX, lineNumber, "x");
    const y = parseStrictNumber(rawY, lineNumber, "y");
    const duplicateKey = `${dataset}\u0000${x}\u0000${y}`;
    if (duplicates.has(duplicateKey)) {
      throw new SummaryMatrixEvidenceError(`line ${lineNumber} duplicates an earlier evidence row`, { lineNumber });
    }
    duplicates.add(duplicateKey);
    rows.push({ dataset, x, y });
    counts.set(dataset, counts.get(dataset) + 1);
  }
  const wrongCounts = [...counts].filter(([, count]) => count !== manifest.rowsPerDataset);
  if (wrongCounts.length > 0 || rows.length !== manifest.expectedDatasets.length * manifest.rowsPerDataset) {
    throw new SummaryMatrixEvidenceError("summary-matrix row counts do not match the declared evidence contract", {
      expectedRows: manifest.expectedDatasets.length * manifest.rowsPerDataset,
      observedRows: rows.length,
      wrongCounts: Object.fromEntries(wrongCounts),
    });
  }
  return rows;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(dataset, rows) {
  const xs = rows.map((row) => row.x);
  const ys = rows.map((row) => row.y);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    sumX2 += dx ** 2;
    sumY2 += dy ** 2;
    sumXY += dx * dy;
  }
  if (!(sumX2 > 0) || !(sumY2 > 0)) {
    throw new SummaryMatrixEvidenceError(`dataset ${dataset} has zero variance`);
  }
  return {
    dataset,
    n: rows.length,
    meanX,
    meanY,
    sdX: Math.sqrt(sumX2 / (rows.length - 1)),
    sdY: Math.sqrt(sumY2 / (rows.length - 1)),
    correlation: sumXY / Math.sqrt(sumX2 * sumY2),
  };
}

function matchesReportedPrecision(observed, reported) {
  return observed.toFixed(reported.decimals) === reported.value;
}

export function verifySummaryMatrix(rows, targets) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.dataset)) groups.set(row.dataset, []);
    groups.get(row.dataset).push(row);
  }
  const summaries = [...groups.entries()]
    .map(([dataset, group]) => summarize(dataset, group))
    .sort((left, right) => left.dataset.localeCompare(right.dataset));
  const checks = [];
  for (const summary of summaries) {
    for (const metric of METRICS) {
      const reported = targets[metric];
      const observed = summary[metric];
      checks.push({
        dataset: summary.dataset,
        metric,
        observed,
        formattedObserved: observed.toFixed(reported.decimals),
        reportedValue: reported.value,
        decimals: reported.decimals,
        absoluteDifference: Math.abs(observed - Number(reported.value)),
        matched: matchesReportedPrecision(observed, reported),
      });
    }
  }
  return {
    summaries,
    checks,
    maxAbsoluteDifference: Math.max(...checks.map((check) => check.absoluteDifference)),
    matchedChecks: checks.filter((check) => check.matched).length,
    mismatches: checks.filter((check) => !check.matched),
  };
}

export function supportsSummaryMatrix(claim) {
  return claim?.evidence?.testFamily === "descriptive_summary_matrix"
    && claim?.evidence?.effectType === "summary_matrix"
    && claim?.evidence?.precisionRule === "reported-print-precision";
}

export const SUMMARY_MATRIX_CONTRACT = Object.freeze({
  id: "peerproof.summary-matrix.v3",
  policyLabel: "PeerProof Summary Matrix Contract v3",
  supportedClaim: "A manifest-declared matrix of group means, sample standard deviations, and Pearson correlations compared at reported print precision",
  claimSpecMatcher: "descriptive_summary_matrix + summary_matrix + reported-print-precision",
  independentImplementation: "peerproof.summary-matrix.strict-csv.v1",
  robustnessSuite: "printed-precision mismatch diagnostics",
  effectComparison: "reported-print-precision",
  effectComparisonRule: "Every independently regenerated statistic must format to the exact text and decimals in the reviewed paper-source record.",
});

const EVIDENCE_DESCRIPTION = Object.freeze({
  classification: "strict-summary-matrix-evidence-package",
  rejectedClassification: "invalid-or-unadmitted-summary-matrix-evidence",
  summary: "An identity-admitted three-column CSV with exact group names/counts, finite strict decimals, no duplicate rows, and reviewed reported targets.",
});

async function loadEvidence({ readEvidenceText, manifest, sourceRecord }) {
  validateSummaryMatrixManifest(manifest);
  const targets = validateSourceRecord(sourceRecord, manifest);
  if (typeof readEvidenceText !== "function") {
    throw new SummaryMatrixEvidenceError("summary-matrix verifier requires an admitted evidence snapshot reader");
  }
  const rows = parseSummaryMatrixCsv(readEvidenceText(manifest.dataset), manifest);
  return { rows, targets, datasetFile: manifest.dataset };
}

function applyVerdict({ verification }) {
  const allChecksPass = verification.matchedChecks === verification.checks.length;
  return allChecksPass
    ? {
        label: "Reproduced",
        displayLabel: "Package snapshot reproduced",
        tone: "success",
        scope: `${verification.matchedChecks} / ${verification.checks.length} printed values matched · admitted package/mirror only`,
        reason: `All ${verification.checks.length} statistics from the admitted dataset round to the reviewed reported values at the declared precision.`,
        rule: "Every formatted observation equals the reviewed reported value -> package snapshot reproduced",
      }
    : {
        label: "Failed",
        displayLabel: "Package snapshot mismatch",
        tone: "danger",
        scope: `${verification.matchedChecks} / ${verification.checks.length} printed values matched · admitted package/mirror only`,
        reason: `${verification.matchedChecks} of ${verification.checks.length} printed-value checks matched. This admitted package/mirror snapshot does not reproduce every reviewed reported value. The original publication data-generation pipeline was not executed, so this result does not establish that the paper is false.`,
        rule: "Any formatted mismatch -> package snapshot mismatch; no paper-level conclusion without the original generation pipeline",
      };
}

function buildComparison({ evidence, verification }) {
  return {
    kind: "printed-precision-matrix",
    rowCount: evidence.rows.length,
    datasetCount: verification.summaries.length,
    targetStats: evidence.targets,
    precision: "reviewed reported-value equality at declared decimals",
    expectedChecks: verification.checks.length,
    passedChecks: verification.matchedChecks,
    failedChecks: verification.mismatches.length,
    maxAbsoluteDifference: round(verification.maxAbsoluteDifference, 9),
    effectMatches: verification.mismatches.length === 0,
    mismatchExamples: verification.mismatches.slice(0, 8).map((check) => ({
      dataset: check.dataset,
      metric: check.metric,
      observed: round(check.observed, 9),
      formattedObserved: check.formattedObserved,
      reportedValue: check.reportedValue,
    })),
    datasetSummaries: verification.summaries.map((summary) => Object.fromEntries(
      Object.entries(summary).map(([key, value]) => [key, typeof value === "number" ? round(value, 6) : value]),
    )),
  };
}

function runRobustnessSuite({ verification }) {
  return {
    kind: "printed-precision-diagnostics",
    check: "Exact equality after formatting to reviewed reported precision",
    matchedChecks: verification.matchedChecks,
    mismatchedChecks: verification.mismatches.length,
    totalChecks: verification.checks.length,
    possibleDatasetVersionMismatch: verification.mismatches.length > 0,
    fragile: false,
  };
}

function buildVisualEvidence({ evidence, verification }) {
  return {
    type: "scatter-facets",
    title: "Same summaries. Different shapes.",
    caption: "Rendered directly from the admitted 1,846-row CSV used by the verifier.",
    groups: verification.summaries.map((summary) => ({
      dataset: summary.dataset,
      points: evidence.rows
        .filter((row) => row.dataset === summary.dataset)
        .map((row) => [round(row.x, 4), round(row.y, 4)]),
    })),
  };
}

function normalizeError(error) {
  if (!(error instanceof SummaryMatrixEvidenceError)) return null;
  return {
    category: "evidence-validation",
    stage: "evidence-contract",
    reason: error.message,
    rule: "Malformed summary-matrix evidence -> admission failure before scientific verdict",
    code: error.code,
    details: error.details,
  };
}

export const summaryMatrixVerifierRuntime = Object.freeze({
  id: "peerproof.verifier-runtime.summary-matrix.v1",
  strategy: "independent-evidence-audit",
  contract: SUMMARY_MATRIX_CONTRACT,
  runtimeSourceFiles: Object.freeze(["src/verifiers/summary-matrix.js"]),
  provenanceFiles: Object.freeze({
    verifierRuntimeSourceSha256: "src/verifiers/summary-matrix.js",
  }),
  evidenceContractDescription: EVIDENCE_DESCRIPTION,
  presentation: Object.freeze({
    verificationPolicyDetail: "PeerProof independently computes group summaries and applies reviewed print-precision targets without relaxing them after execution.",
    dataPolicyDescription: "Complete public-case identity admission precedes strict CSV parsing and all statistics.",
    comparisonSummary: ({ verification }) => ({
      title: "Reviewed summary statistics regenerated",
      detail: `${verification.matchedChecks}/${verification.checks.length} formatted values matched; ${verification.mismatches.length} differed.`,
    }),
    robustnessSummary: ({ verification }) => ({
      title: verification.mismatches.length ? "Dataset-version mismatch evidence disclosed" : "Printed-precision diagnostics completed",
      detail: verification.mismatches.length
        ? `${verification.mismatches[0].dataset}.${verification.mismatches[0].metric} formats as ${verification.mismatches[0].formattedObserved}, not ${verification.mismatches[0].reportedValue}.`
        : "Every observed statistic equals the reviewed reported value at declared precision.",
    }),
    verdictScope: "Admitted package/data-mirror snapshot only; not the original publication data-generation pipeline.",
  }),
  matchClaim: supportsSummaryMatrix,
  validateEvidenceManifest: validateSummaryMatrixManifest,
  evaluateEvidenceContract: ({ manifest }) => {
    validateSummaryMatrixManifest(manifest);
    return {
      classification: EVIDENCE_DESCRIPTION.classification,
      checks: {
        strictColumns: true,
        exactGroupNamesAndCounts: true,
        finiteStrictDecimals: true,
        duplicateRowsRejected: true,
        reviewedTargetSource: true,
      },
    };
  },
  loadEvidence,
  recompute: (evidence) => verifySummaryMatrix(evidence.rows, evidence.targets),
  buildComparison,
  buildExecutionRecord: ({ evidence, verification }) => ({
    command: "PeerProof registered summary-matrix verifier runtime",
    exitCode: 0,
    rowCount: evidence.rows.length,
    datasetCount: verification.summaries.length,
  }),
  runRobustnessSuite,
  applyVerdict,
  buildVisualEvidence,
  normalizeError,
});

export { matchesReportedPrecision };
