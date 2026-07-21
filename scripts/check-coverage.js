import { spawnSync } from "node:child_process";

const thresholds = Object.freeze({ lines: 90, branches: 75, functions: 85 });
const productionScope = Object.freeze([
  "src/**/*.js",
  "server.js",
  "bin/**/*.js",
  "public/file-utils.js",
]);
const result = spawnSync(process.execPath, [
  "--test",
  "--experimental-test-coverage",
  ...productionScope.map((pattern) => `--test-coverage-include=${pattern}`),
  "--test-coverage-exclude=.peerproof/**",
  "--test-coverage-exclude=tests/**",
  "--test-coverage-exclude=samples/**",
  "--test-coverage-exclude=evals/**",
], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
  env: process.env,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.status !== 0) process.exit(result.status || 1);

const match = (result.stdout || "").match(/all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/);
if (!match) {
  process.stderr.write("Could not parse Node's all-files coverage summary.\n");
  process.exit(1);
}
const observed = { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) };
const failures = Object.entries(thresholds).filter(([name, minimum]) => observed[name] < minimum);
process.stdout.write(`Coverage scope: ${productionScope.join(", ")} (tests, run artifacts, samples, and eval fixtures excluded)\n`);
process.stdout.write(`Coverage gate: lines ${observed.lines}%/${thresholds.lines}%, branches ${observed.branches}%/${thresholds.branches}%, functions ${observed.functions}%/${thresholds.functions}%\n`);
if (failures.length) {
  process.stderr.write(`Coverage threshold failed: ${failures.map(([name, minimum]) => `${name} ${observed[name]}% < ${minimum}%`).join(", ")}\n`);
  process.exit(1);
}
