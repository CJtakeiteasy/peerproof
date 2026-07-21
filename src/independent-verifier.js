import { readFile } from "node:fs/promises";
import { linearRegression } from "./statistics.js";
import { verifyClaim } from "./verifier.js";
import { resolveWorkspacePath } from "./workspace-path.js";

export const AUTHOR_ARTIFACT_SCHEMA_VERSION = "lighthouse.author-result.v1";

export class ArtifactSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactSchemaError";
  }
}

export class DatasetResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatasetResolutionError";
  }
}

export class IndependentCrossCheckMismatch extends Error {
  constructor(message, { execution, comparison }) {
    super(message);
    this.name = "IndependentCrossCheckMismatch";
    this.execution = execution;
    this.comparison = comparison;
  }
}

const AUTHOR_ARTIFACT_FIELDS = Object.freeze([
  "schemaVersion",
  "n",
  "coefficient",
  "standardError",
  "pValue",
]);

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateAuthorArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("author artifact must be a JSON object");
  }
  const fields = Object.keys(value).sort();
  const expected = [...AUTHOR_ARTIFACT_FIELDS].sort();
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error(`author artifact fields must be exactly: ${AUTHOR_ARTIFACT_FIELDS.join(", ")}`);
  }
  if (value.schemaVersion !== AUTHOR_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`author artifact schemaVersion must be ${AUTHOR_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(value.n) || value.n < 3) {
    throw new Error("author artifact n must be an integer of at least 3");
  }
  if (!finiteNumber(value.coefficient)) {
    throw new Error("author artifact coefficient must be a finite number");
  }
  if (!finiteNumber(value.standardError) || value.standardError <= 0) {
    throw new Error("author artifact standardError must be a finite positive number");
  }
  if (!finiteNumber(value.pValue) || value.pValue < 0 || value.pValue > 1) {
    throw new Error("author artifact pValue must be a finite number from 0 to 1");
  }
  return value;
}

export function parseStudyCsv(csv, contract) {
  if (typeof csv !== "string") throw new Error("dataset must be UTF-8 text");
  const lines = csv.trim().split(/\r?\n/);
  const expectedHeader = [contract?.idColumn, contract?.predictors?.[0], contract?.outcome];
  if (expectedHeader.some((column) => typeof column !== "string")
    || lines[0]?.trim() !== expectedHeader.join(",")) {
    throw new Error(`dataset header must be exactly ${expectedHeader.join(",")}`);
  }
  if (lines.length < 4) throw new Error("dataset must contain at least three observations");
  const seen = new Set();
  return lines.slice(1).map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 3) throw new Error(`dataset row ${index + 2} must contain exactly three fields`);
    const [idRaw, predictorRaw, outcomeRaw] = fields;
    const id = idRaw.trim();
    const x = Number(predictorRaw);
    const y = Number(outcomeRaw);
    if (!id) throw new Error(`dataset row ${index + 2} has an empty id`);
    if (seen.has(id)) throw new Error(`dataset contains duplicate id ${id}`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`dataset row ${index + 2} contains a non-finite x or y value`);
    }
    seen.add(id);
    return { id, x, y };
  });
}

function fieldCrossCheck(authorValue, verifierValue, tolerance) {
  const absoluteDifference = Math.abs(authorValue - verifierValue);
  return {
    authorValue,
    verifierValue,
    absoluteDifference,
    tolerance,
    match: absoluteDifference <= tolerance,
  };
}

export function crossCheckAuthorArtifact(authorArtifact, independentBaseline, rowCount) {
  const fields = {
    n: {
      authorValue: authorArtifact.n,
      verifierValue: rowCount,
      absoluteDifference: Math.abs(authorArtifact.n - rowCount),
      tolerance: 0,
      match: authorArtifact.n === rowCount,
    },
    coefficient: fieldCrossCheck(authorArtifact.coefficient, independentBaseline.slope, 1e-6),
    standardError: fieldCrossCheck(authorArtifact.standardError, independentBaseline.standardError, 1e-6),
    pValue: fieldCrossCheck(authorArtifact.pValue, independentBaseline.pValue, 1e-8),
  };
  return {
    match: Object.values(fields).every((field) => field.match),
    fields,
    rule: "Author canonical artifact must match PeerProof's independent OLS recomputation within predeclared machine-precision tolerances.",
  };
}

export function recomputeIndependently(rows) {
  const baseline = linearRegression(rows);
  const leaveOneOut = rows.map((removed, index) => ({
    removedId: removed.id,
    ...linearRegression(rows.filter((_, rowIndex) => rowIndex !== index)),
  }));
  return { baseline, leaveOneOut };
}

export async function independentlyVerifyExecution({ claim, attempt, repoDirectory, dataApproval }) {
  let parsed;
  try {
    parsed = JSON.parse(attempt.stdout);
  } catch (error) {
    throw new ArtifactSchemaError(`stdout is not valid JSON: ${error.message}`);
  }
  let authorArtifact;
  try {
    authorArtifact = validateAuthorArtifact(parsed);
  } catch (error) {
    throw new ArtifactSchemaError(error.message);
  }
  if (dataApproval?.status !== "approved" || !dataApproval.approvedDataFile || !dataApproval.contract) {
    throw new DatasetResolutionError("repository data file has not crossed the independent data-path policy boundary");
  }
  let rows;
  try {
    const datasetPath = await resolveWorkspacePath(
      repoDirectory,
      dataApproval.approvedDataFile,
      "approved verifier dataset",
      { expectedType: "file" },
    );
    rows = parseStudyCsv(await readFile(datasetPath.resolved, "utf8"), dataApproval.contract);
  } catch (error) {
    throw new DatasetResolutionError(`approved dataset could not be parsed: ${error.message}`);
  }
  const independent = recomputeIndependently(rows);
  const crossCheck = crossCheckAuthorArtifact(authorArtifact, independent.baseline, rows.length);
  const execution = {
    authorPipeline: authorArtifact,
    independentVerifier: {
      datasetRows: rows.length,
      baseline: independent.baseline,
      crossCheck,
    },
    baseline: independent.baseline,
    leaveOneOut: independent.leaveOneOut,
  };
  if (!crossCheck.match) {
    const mismatchedFields = Object.entries(crossCheck.fields).filter(([, field]) => !field.match).map(([name]) => name);
    throw new IndependentCrossCheckMismatch(
      `author pipeline output differs from PeerProof independent recomputation: ${mismatchedFields.join(", ")}`,
      {
        execution,
        comparison: {
          kind: "pipeline-mismatch",
          reportedEffect: claim.evidence.reportedEffect,
          reportedEffectRaw: claim.evidence.reportedEffectRaw,
          authorPipelineEffect: authorArtifact.coefficient,
          independentVerifierEffect: independent.baseline.slope,
          authorVerifierCrossCheck: crossCheck,
        },
      },
    );
  }
  return { execution, verification: verifyClaim({ claim, execution }) };
}
