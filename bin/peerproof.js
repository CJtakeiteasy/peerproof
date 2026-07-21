#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { admitApplicationBuild } from "../src/build-integrity.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startupApplicationAdmission = await admitApplicationBuild(projectRoot);
const [{ writeJson }, { VERSION }] = await Promise.all([
  import("../src/utils.js"),
  import("../src/version.js"),
]);
const args = process.argv.slice(2);

function help() {
  return `PeerProof ${VERSION}

Usage:
  peerproof audit samples/fragile-study [--json]
  peerproof verify samples/datasaurus-dozen --scope independent [--json]
  peerproof serve
  peerproof --help

Only the checked-in trusted cases are executable in this judge build.`;
}

async function persistAndPrint(audit, jsonOutput) {
  const ledgerPath = path.join(projectRoot, ".peerproof", "runs", audit.id, "audit.json");
  await writeJson(ledgerPath, audit);
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `Audit: ${audit.id}`,
    `Case: ${audit.case.title}`,
    `Verdict: ${audit.verdict.displayLabel || audit.verdict.label}`,
    `Scope: ${audit.verdict.scope || "Claim-level deterministic verdict"}`,
    `Ledger: ${path.relative(process.cwd(), ledgerPath)}`,
  ].join("\n") + "\n");
}

async function main() {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args[0] === "serve") {
    const { startServer } = await import("../server.js");
    startServer();
    return;
  }
  const jsonOutput = args.includes("--json");
  const trustedTarget = String(args[1] || "").replaceAll("\\", "/");
  if (args[0] === "audit" && trustedTarget === "samples/fragile-study") {
    const { runSampleAudit } = await import("../src/audit-engine.js");
    await persistAndPrint(await runSampleAudit(projectRoot, {
      expectedApplicationAdmission: startupApplicationAdmission,
    }), jsonOutput);
    return;
  }
  if (args[0] === "verify"
    && trustedTarget === "samples/datasaurus-dozen"
    && args.includes("--scope")
    && args[args.indexOf("--scope") + 1] === "independent") {
    const { runRealWorldAudit } = await import("../src/real-world-case.js");
    await persistAndPrint(await runRealWorldAudit(projectRoot, {
      expectedApplicationAdmission: startupApplicationAdmission,
    }), jsonOutput);
    return;
  }
  throw new Error(`Unsupported command.\n\n${help()}`);
}

main().catch((error) => {
  process.stderr.write(`PeerProof error: ${error.message}\n`);
  process.exitCode = 1;
});
