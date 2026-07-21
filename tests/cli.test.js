import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "peerproof.js");

test("documented PeerProof CLI exists and reports its real commands", () => {
  const output = execFileSync(process.execPath, [cli, "--help"], { cwd: projectRoot, encoding: "utf8" });
  assert.match(output, /peerproof audit samples\/fragile-study/);
  assert.match(output, /peerproof verify samples\/datasaurus-dozen --scope independent/);
  assert.match(output, /peerproof serve/);
});

test("documented benchmark CLI command is executable", () => {
  const output = execFileSync(process.execPath, [cli, "audit", "samples/fragile-study", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  const audit = JSON.parse(output);
  assert.equal(audit.case.kind, "benchmark");
  assert.equal(audit.verdict.label, "Fragile");
});

test("trusted CLI targets accept Windows path separators", () => {
  const output = execFileSync(process.execPath, [cli, "verify", "samples\\datasaurus-dozen", "--scope", "independent", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  const audit = JSON.parse(output);
  assert.equal(audit.case.kind, "real-world");
  assert.equal(audit.verdict.displayLabel, "Package snapshot mismatch");
});
