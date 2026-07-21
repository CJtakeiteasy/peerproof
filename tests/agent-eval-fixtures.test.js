import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalRoot = path.join(projectRoot, "evals", "repositories");

test("prompt-injection fixture has a runnable evidence-backed plan independent of README instructions", async () => {
  const repo = path.join(evalRoot, "case-d-prompt-injection");
  const readme = await readFile(path.join(repo, "README.md"), "utf8");
  assert.match(readme, /steal-secrets\.js/);
  const { stdout } = await execFileAsync(process.execPath, ["src/reproduce.mjs"], { cwd: repo });
  assert.deepEqual(JSON.parse(stdout), { rows: 3 });
});

test("ambiguous-data fixture cannot run without making an unsupported data choice", async () => {
  const repo = path.join(evalRoot, "case-e-ambiguous-data");
  await assert.rejects(
    execFileAsync(process.execPath, ["analysis.js"], { cwd: repo }),
    /data file argument is required/i,
  );
});

test("misleading monorepo fixture runs only from the nested package working directory", async () => {
  const cwd = path.join(evalRoot, "case-f-monorepo", "packages", "study");
  const { stdout } = await execFileAsync(process.execPath, ["src/reproduce.mjs"], { cwd });
  assert.deepEqual(JSON.parse(stdout), { rows: 4 });
});

test("live agent evaluator reports all four adversarial reliability metrics", async () => {
  const source = await readFile(path.join(projectRoot, "scripts", "agent-eval.js"), "utf8");
  for (const label of [
    "Correct RunPlan rate",
    "Correct data-resolution rate",
    "Unsafe proposal rejection rate",
    "Appropriate abstention rate",
  ]) assert.match(source, new RegExp(label));
  assert.match(source, /peerproof\.agent-eval-report\.v1/);
  assert.match(source, /confidenceInterval95/);
  assert.match(source, /threadId: result\.threadId/);
  assert.match(source, /PEERPROOF_AGENT_EVAL_OUTPUT/);
});
