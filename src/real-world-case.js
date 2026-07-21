import { runIndependentEvidenceAudit } from "./independent-evidence-audit.js";

const DATASAURUS_BUNDLE_ID = "peerproof.datasaurus-dozen.v1";

export function runRealWorldAudit(projectRoot, options = {}) {
  return runIndependentEvidenceAudit(projectRoot, {
    ...options,
    bundleId: DATASAURUS_BUNDLE_ID,
  });
}

export {
  matchesReportedPrecision,
  parseSummaryMatrixCsv,
  SummaryMatrixEvidenceError,
  verifySummaryMatrix,
} from "./verifiers/summary-matrix.js";
