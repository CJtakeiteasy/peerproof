import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSampleAudit } from "../src/audit-engine.js";
import { sha256, writeJson } from "../src/utils.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredClaimModel = "gpt-5.6";
const requiredCodexModel = "gpt-5.6";

function pass(label, value) {
  process.stdout.write(`${label.padEnd(36)} PASS  ${value || ""}\n`);
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  requireValue(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for a live smoke test");
  requireValue(process.env.PEERPROOF_USE_CODEX === "true", "PEERPROOF_USE_CODEX=true is required");
  requireValue((process.env.OPENAI_MODEL || requiredClaimModel) === requiredClaimModel, `OPENAI_MODEL must be ${requiredClaimModel}`);
  requireValue((process.env.CODEX_MODEL || requiredCodexModel) === requiredCodexModel, `CODEX_MODEL must be ${requiredCodexModel}`);

  const audit = await runSampleAudit(projectRoot, {
    extractionOptions: { requireLive: true },
    investigationOptions: { enabled: true, requireLive: true },
  });
  requireValue(audit.mode === "live", "Both AI stages did not complete live");
  requireValue(audit.provenance.actualClaimModel?.startsWith(requiredClaimModel), "The observed GPT model did not match gpt-5.6");
  requireValue(audit.provenance.openAiResponseId, "OpenAI response ID is missing");
  requireValue(audit.provenance.openAiRequestId, "OpenAI request ID is missing");
  requireValue(audit.provenance.codexThreadId, "Codex thread ID is missing");
  requireValue(audit.provenance.configuredCodexModel === requiredCodexModel, "The configured Codex model did not match gpt-5.6");
  requireValue(audit.provenance.applicationCommit, "PEERPROOF_COMMIT or a Git commit is required for provenance");

  pass("GPT structured extraction", audit.provenance.actualClaimModel);
  pass("OpenAI response ID received", audit.provenance.openAiResponseId);
  pass("OpenAI request ID received", audit.provenance.openAiRequestId);
  pass("Codex read-only investigation", audit.investigation.displayLabel);
  pass("Codex thread ID received", audit.provenance.codexThreadId);
  pass("Observed GPT model matched", audit.provenance.actualClaimModel);
  pass("Configured Codex model matched", audit.provenance.configuredCodexModel);

  const receipt = {
    receiptType: "historical-live-execution",
    disclosure: "Historical live execution receipt; not evidence that the current browser request was live.",
    timestamp: audit.completedAt,
    applicationVersion: audit.provenance.applicationVersion,
    applicationCommit: audit.provenance.applicationCommit,
    applicationCommitProvenance: audit.provenance.applicationCommitProvenance,
    claimExtraction: {
      mode: "live",
      model: audit.provenance.actualClaimModel,
      responseId: audit.provenance.openAiResponseId,
      requestId: audit.provenance.openAiRequestId,
      clientRequestId: audit.provenance.clientRequestId,
      promptVersion: audit.provenance.claimPromptVersion,
      schemaVersion: audit.provenance.claimSchemaVersion,
    },
    repositoryInvestigation: {
      mode: "live",
      configuredModel: audit.provenance.configuredCodexModel,
      observedModel: null,
      modelEvidence: "Configured request model; the current Codex SDK receipt does not expose a separately observed model identifier.",
      threadId: audit.provenance.codexThreadId,
      sdkVersion: audit.provenance.codexSdkVersion,
      proposalHash: sha256(JSON.stringify(audit.repairWorkflow.proposal)),
    },
    ledgerHash: sha256(JSON.stringify(audit)),
  };
  const receiptPath = path.join(projectRoot, "provenance", "live-lighthouse-audit.json");
  await writeJson(receiptPath, receipt);
  process.stdout.write(`Historical receipt written to ${path.relative(projectRoot, receiptPath)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Live smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
