import { spawnSync } from "node:child_process";

const port = Number(process.env.PEERPROOF_DOCKER_SMOKE_PORT || 4176);
const live = process.env.PEERPROOF_DOCKER_LIVE === "true";
const name = `peerproof-smoke-${process.pid}`;

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return (result.stdout || "").trim();
}

async function waitForHealthy(baseUrl) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("container health endpoint did not become ready within 90 seconds");
}

async function waitForContainerHealthy() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = run("docker", ["inspect", "--format={{.State.Health.Status}}", name], { allowFailure: true });
    if (status === "healthy") return status;
    if (status === "unhealthy") throw new Error("Docker health check reported unhealthy");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Docker health status did not become healthy within 90 seconds");
}

async function postJson(url) {
  const response = await fetch(url, { method: "POST" });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} failed (${response.status}): ${payload.error || "unknown error"}`);
  return payload;
}

async function main() {
  run("docker", ["version"]);
  const commit = run("git", ["rev-parse", "HEAD"]);
  const image = `peerproof:smoke-${commit.slice(0, 12)}`;
  process.stdout.write(`Building ${image} at ${commit}\n`);
  run("docker", ["build", "--build-arg", `PEERPROOF_COMMIT=${commit}`, "-t", image, "."]);

  const runArgs = ["run", "--rm", "-d", "--name", name, "-p", `127.0.0.1:${port}:4173`];
  if (live) {
    if (!process.env.OPENAI_API_KEY) throw new Error("PEERPROOF_DOCKER_LIVE=true requires OPENAI_API_KEY");
    runArgs.push(
      "-e", "OPENAI_API_KEY",
      ...(process.env.CODEX_API_KEY ? ["-e", "CODEX_API_KEY"] : []),
      "-e", "OPENAI_MODEL=gpt-5.6",
      "-e", "CODEX_MODEL=gpt-5.6",
      "-e", "PEERPROOF_USE_CODEX=true",
      "-e", "PEERPROOF_REQUIRE_LIVE_GPT=true",
      "-e", "PEERPROOF_REQUIRE_LIVE_CODEX=true",
    );
  }
  runArgs.push(image);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    run("docker", runArgs);
    const health = await waitForHealthy(baseUrl);
    const containerHealth = await waitForContainerHealthy();
    if (health.applicationCommit !== commit) throw new Error(`health applicationCommit ${health.applicationCommit} did not match ${commit}`);

    const benchmark = await postJson(`${baseUrl}/api/audits/demo`);
    const publicAudit = await postJson(`${baseUrl}/api/audits/real-world`);
    if (benchmark.verdict.label !== "Fragile") throw new Error(`unexpected benchmark verdict ${benchmark.verdict.label}`);
    if (publicAudit.verdict.displayLabel !== "Package snapshot mismatch") {
      throw new Error(`unexpected public audit verdict ${publicAudit.verdict.displayLabel || publicAudit.verdict.label}`);
    }
    if (benchmark.provenance.applicationCommit !== commit || publicAudit.provenance.applicationCommit !== commit) {
      throw new Error("one or more container ledgers did not preserve the build commit");
    }
    if (live && (benchmark.mode !== "live" || !benchmark.provenance.codexThreadId)) {
      throw new Error("live container audit did not record both required AI stages");
    }

    const stream = await fetch(`${baseUrl}/api/audits/demo/stream`, { method: "POST" });
    if (stream.headers.get("x-accel-buffering") !== "no") throw new Error("SSE response did not disable proxy buffering");
    await stream.body?.cancel();

    process.stdout.write([
      `Docker health: ${containerHealth}`,
      `Application commit: ${commit}`,
      "Non-root audit workspace write: PASS (both audits persisted)",
      `Benchmark: ${benchmark.verdict.label}`,
      `Public evidence audit: ${publicAudit.verdict.displayLabel}`,
      "SSE anti-buffering header: PASS",
      live ? "Live GPT/Codex container authentication: PASS" : "Live GPT/Codex container authentication: NOT REQUESTED",
    ].join("\n") + "\n");
  } finally {
    run("docker", ["rm", "-f", name], { allowFailure: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Docker smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
