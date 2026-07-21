import { inferMimeType } from "./file-utils.js";

const byId = (id) => document.getElementById(id);
const state = {
  audit: null,
  timer: null,
  seconds: 0,
  activeCase: "benchmark",
  streamedEvents: 0,
  expectedEvents: 1,
};

const caseProfiles = {
  benchmark: {
    title: "The Lighthouse Study",
    subtitle: "Deterministic smoke-test benchmark",
    paper: "paper.md",
    repository: "Node.js · reviewed repository",
    dataset: "study.csv · 10 rows",
    claim: "1 selected claim",
  },
  "real-world": {
    title: "The Datasaurus Dozen",
    subtitle: "Public evidence audit · CHI 2017",
    paper: "CHI 2017 · DOI-linked",
    repository: "R package · pinned commit",
    dataset: "datasaurus.csv · 1,846 rows",
    claim: "1 numerical claim",
  },
};

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    const pill = byId("mode-pill");
    if (health.aiRuntimeConfigured) {
      pill.classList.add("live");
      pill.innerHTML = "<i></i> AI runtime configured";
    } else {
      pill.innerHTML = "<i></i> Live demo · no sign-in";
    }
  } catch {
    byId("mode-pill").innerHTML = "<i></i> Runtime unavailable";
  }
}

function setCaseProfile(kind, auditCase = null) {
  state.activeCase = kind;
  const profile = auditCase?.package ? { ...caseProfiles[kind], ...auditCase.package, ...auditCase } : caseProfiles[kind];
  byId("case-title").textContent = profile.title;
  byId("case-subtitle").textContent = profile.subtitle;
  byId("package-paper").textContent = profile.paper ?? profile.package?.paper;
  byId("package-repository").textContent = profile.repository ?? profile.package?.repository;
  byId("package-dataset").textContent = profile.dataset ?? profile.package?.dataset;
  byId("package-claim").textContent = profile.claim ?? profile.package?.claim;
  byId("rerun-sidebar").textContent = kind === "benchmark" ? "Run benchmark audit" : "Re-run public verifier";
  byId("switch-case").textContent = kind === "benchmark" ? "Explore a public evidence audit" : "Return to benchmark";
}

function setRunning(kind) {
  setCaseProfile(kind);
  byId("empty-ledger").classList.add("is-hidden");
  byId("audit-result").classList.add("is-hidden");
  byId("running-ledger").classList.remove("is-hidden");
  byId("running-eyebrow").textContent = "Audit in progress";
  byId("running-title").textContent = "Waiting for the first server event";
  byId("terminal-output").textContent = "";
  byId("progress-bar").style.width = "2%";
  state.streamedEvents = 0;
  state.expectedEvents = 1;
  document.querySelectorAll("#run-demo, #run-real-world, #run-empty, #run-real-empty, #rerun-sidebar, #switch-case").forEach((button) => {
    button.disabled = true;
  });
  state.seconds = 0;
  byId("elapsed").textContent = "00:00";
  state.timer = window.setInterval(() => {
    state.seconds += 1;
    const minutes = Math.floor(state.seconds / 60);
    const seconds = state.seconds % 60;
    byId("elapsed").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }, 1000);
}

function stopRunning() {
  window.clearInterval(state.timer);
  document.querySelectorAll("#run-demo, #run-real-world, #run-empty, #run-real-empty, #rerun-sidebar, #switch-case").forEach((button) => {
    button.disabled = false;
  });
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.replaceAll("\r", "").split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.length ? JSON.parse(data.join("\n")) : null };
}

function appendServerEvent(event) {
  state.streamedEvents += 1;
  const terminal = byId("terminal-output");
  const index = String(state.streamedEvents).padStart(2, "0");
  const total = String(state.expectedEvents).padStart(2, "0");
  const symbol = event.status === "blocked" ? "!" : "✓";
  const command = event.command ? `\n       command: ${event.command}` : "";
  byId("running-title").textContent = event.title;
  terminal.textContent += `\n[${index}/${total}] ${event.stage.toUpperCase()} · ${event.title}\n       ${symbol} ${event.detail}${command}\n`;
  terminal.scrollTop = terminal.scrollHeight;
  const percent = Math.min(96, (state.streamedEvents / state.expectedEvents) * 100);
  byId("progress-bar").style.width = `${percent}%`;
}

async function consumeAuditStream(endpoint) {
  const judgeToken = byId("judge-token")?.value.trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      ...(judgeToken ? { "X-PeerProof-Token": judgeToken } : {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Audit request failed (${response.status})`);
  }
  if (!response.body) throw new Error("Streaming response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let audit = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const normalized = buffer.replaceAll("\r\n", "\n");
    const blocks = normalized.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks.filter(Boolean)) {
      const message = parseSseBlock(block);
      if (message.event === "audit-start") {
        state.expectedEvents = message.data.expectedEvents;
        byId("terminal-output").textContent = `${message.data.command}\n\n# Events below are emitted by the server as each audit stage completes.\n`;
      } else if (message.event === "timeline") {
        appendServerEvent(message.data);
      } else if (message.event === "audit-complete") {
        audit = message.data;
        byId("progress-bar").style.width = "100%";
      } else if (message.event === "audit-error") {
        throw new Error(message.data.error || "Audit failed");
      }
    }
    if (done) break;
  }
  if (!audit) throw new Error("Audit stream ended without a completed evidence ledger");
  return audit;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatP(value) {
  if (value < 0.001) return "< 0.001";
  return `= ${Number(value).toFixed(3)}`;
}

function renderEvidenceChain(nodes) {
  byId("evidence-chain").innerHTML = nodes
    .map((node) => `<div class="chain-node ${escapeHtml(node.tone || "neutral")}" title="${escapeHtml(`${node.value} · ${node.status}`)}"><small>${escapeHtml(node.label)}</small><strong>${escapeHtml(node.value)}</strong><em>${escapeHtml(node.status)}</em></div>`)
    .join("");
}

function renderTimeline(events) {
  byId("timeline").innerHTML = events
    .map((event, index) => `<li>
      <span class="timeline-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="timeline-stage">${escapeHtml(event.stage)}</span>
      <div class="timeline-copy"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.detail)}</span></div>
      <i class="status-dot ${event.status === "blocked" ? "blocked" : ""}" title="${escapeHtml(event.status)}"></i>
    </li>`)
    .join("");
}

function renderModeDisclosure(disclosure) {
  const panel = byId("mode-disclosure");
  panel.className = `mode-disclosure ${disclosure.status}`;
  byId("mode-title").textContent = disclosure.title;
  byId("mode-message").textContent = disclosure.message;
  byId("mode-detail").textContent = disclosure.detail;
}

function renderStageProvenance(stages) {
  byId("stage-provenance").innerHTML = stages.map((stage) => `<div class="stage-card ${escapeHtml(stage.mode)}">
    <small>${escapeHtml(stage.stage)}</small><strong>${escapeHtml(stage.label)}</strong><p>${escapeHtml(stage.detail)}</p>
  </div>`).join("");
}

function renderProvenance(provenance) {
  const labels = {
    paperSha256: "Paper SHA-256",
    paperDoi: "Paper DOI",
    repositoryCommit: "Repository commit",
    dataMirrorCommit: "Data mirror commit",
    sourceLicense: "Source license",
    sourceDescriptionSha256: "DESCRIPTION SHA-256",
    sourceExampleSha256: "Source example SHA-256",
    investigationArtifactSha256: "Investigation artifact SHA-256",
    verifierSourceSha256: "Verifier source SHA-256",
    independentVerifierSourceSha256: "Independent verifier SHA-256",
    statisticsSourceSha256: "Statistics engine SHA-256",
    dataResolutionPolicySourceSha256: "Data-path policy SHA-256",
    javascriptLineageSourceSha256: "Static lineage checker SHA-256",
    policyRegistrySourceSha256: "Policy registry SHA-256",
    casePolicyBundleSourceSha256: "Reviewed case bundle SHA-256",
    verifierRegistrySourceSha256: "Verifier registry SHA-256",
    verifierRuntimeSourceSha256: "Verifier runtime SHA-256",
    evidenceManifestSha256: "Evidence manifest SHA-256",
    evidencePackageContractSha256: "Evidence-package contract SHA-256",
    verificationContractId: "Verification contract",
    datasetProvenanceStatus: "Dataset provenance boundary",
    applicationCommit: "Application commit",
    applicationCommitSource: "Application commit source",
    applicationCommitFormatValid: "Application commit format valid",
    applicationCommitCryptographicallyVerified: "Application commit authenticated",
    applicationAdmissionStatus: "Application admission",
    buildManifestSha256: "Build manifest SHA-256",
    buildManifestFileCount: "Build manifest files",
    buildManifestVerifierFilesMatched: "Verifier files admitted",
    buildManifestSignatureStatus: "Build-manifest signature status",
    applicationVersion: "Application version",
    analysisSha256AsSubmitted: "Original script SHA-256",
    repairedFileSha256AsSubmitted: "Original repaired-file SHA-256",
    repairedFileSha256Repaired: "Approved repaired-file SHA-256",
    datasetRawSha256: "Dataset raw SHA-256",
    datasetSha256: "Dataset canonical SHA-256",
    datasetCanonicalSha256: "Dataset canonical SHA-256",
    datasetCanonicalization: "Dataset canonicalization",
    verdictEngine: "Verdict engine",
    runtime: "Runtime",
    executionRuntime: "Execution runtime",
    executionPlatform: "Execution platform",
    executionArchitecture: "Execution architecture",
    executionLocale: "Execution locale",
    executionTimeZone: "Execution time zone",
    applicationLockSha256: "Application lockfile SHA-256",
    auditedProjectLockSha256: "Audited-project lockfile SHA-256",
    containerImageDigest: "Execution image digest",
    executionEnvironmentSha256: "Environment manifest SHA-256",
    executionPolicyProfile: "Execution policy profile",
    executionCaseBinding: "Trusted case binding",
    casePolicyBundleSha256: "Reviewed case bundle SHA-256",
    verifierRuntimeId: "Verifier runtime",
    publicEvidenceBundleId: "Public evidence bundle",
    publicEvidenceBundleSha256: "Public evidence bundle SHA-256",
    publicEvidenceAdmissionStatus: "Public evidence admission",
    datasetGitBlob: "Dataset canonical Git blob SHA-1",
    datasetCanonicalGitBlobSha1: "Dataset canonical Git blob SHA-1",
    publicEvidenceSnapshotMode: "Public evidence snapshot",
    paperSourceRecordRawSha256: "Paper-source record raw SHA-256",
    paperSourceRecordSha256: "Reviewed paper-source record SHA-256",
    investigationRecordRawSha256: "Investigation record raw SHA-256",
    investigationRecordSha256: "Reviewed investigation record SHA-256",
    paperAnchorStatus: "Paper anchor status",
  };
  byId("hash-grid").innerHTML = Object.entries(labels)
    .filter(([key]) => provenance[key] !== undefined && provenance[key] !== null)
    .filter(([key]) => !(key === "datasetSha256" && provenance.datasetCanonicalSha256 !== undefined))
    .filter(([key]) => !(key === "datasetGitBlob" && provenance.datasetCanonicalGitBlobSha1 !== undefined))
    .map(([key, label]) => `<div class="hash-item"><small>${label}</small><code title="${escapeHtml(provenance[key])}">${escapeHtml(provenance[key])}</code></div>`)
    .join("");

  const receiptLabels = {
    actualClaimModel: "Observed claim model",
    clientRequestId: "PeerProof client request ID",
    openAiRequestId: "OpenAI request ID",
    openAiResponseId: "OpenAI response ID",
    claimPromptVersion: "Claim prompt version",
    claimSchemaVersion: "Claim schema version",
    configuredCodexModel: "Configured Codex model",
    codexThreadId: "Codex thread ID",
    codexSdkVersion: "Codex SDK version",
    codexPromptVersion: "Codex prompt version",
    codexSchemaVersion: "Codex schema version",
    applicationCommit: "Application commit",
  };
  byId("ai-receipt-grid").innerHTML = Object.entries(receiptLabels).map(([key, label]) => {
    const present = provenance[key] !== undefined && provenance[key] !== null && provenance[key] !== "";
    const value = present ? provenance[key] : "Not present — fixture mode or deployment value not configured";
    return `<div class="hash-item ${present ? "" : "missing"}"><small>${label}</small><code title="${escapeHtml(value)}">${escapeHtml(value)}</code></div>`;
  }).join("");
}

function renderVerdictScope(disclosure) {
  const panel = byId("verdict-scope-disclosure");
  if (!disclosure) {
    panel.classList.add("is-hidden");
    return;
  }
  panel.classList.remove("is-hidden");
  byId("verdict-scope-means").textContent = disclosure.means;
  byId("verdict-scope-does-not-mean").textContent = disclosure.doesNotMean;
  byId("verdict-scope-data-chain").textContent = disclosure.dataChain;
}

function renderInvestigation(investigation) {
  byId("investigation-mode").textContent = investigation.displayLabel;
  byId("inspected-files").innerHTML = investigation.inspectedFiles.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("");
  byId("investigation-hypothesis").textContent = investigation.hypothesis;
  byId("investigation-suggested-command").textContent = investigation.suggestedCommand || "No RunPlan proposed";
  byId("investigation-command-label").textContent = investigation.commandAttempt?.status === "not-available"
    ? "Original runtime command status"
    : "Policy-approved command actually executed";
  byId("investigation-command").textContent = investigation.commandAttempt?.command || investigation.approvedCommand || "No command executed";
  const attempt = investigation.commandAttempt;
  const result = attempt?.status === "not-available"
    ? attempt.stderr
    : attempt?.exitCode === 0
      ? (attempt.stdout || "Exit code 0 · no stdout")
      : `Exit code ${attempt?.exitCode ?? "unknown"}\n${attempt?.stderr || "No error log captured"}`;
  byId("investigation-result").textContent = result.trim().slice(0, 2400);
  byId("investigation-repair").textContent = investigation.proposedRepair.description;
}

function renderDataResolution(audit) {
  const workflow = audit.dataResolutionWorkflow;
  const paperLabel = audit.claim?.evidence?.datasetLabel || audit.claim?.evidence?.dataset || "Not reported";
  byId("paper-dataset-label").textContent = paperLabel;
  if (!workflow) {
    byId("resolved-data-file").textContent = audit.case.kind === "real-world" ? "Pinned public data mirror" : "Not resolved";
    byId("data-resolution-actor").textContent = audit.case.kind === "real-world" ? "Recorded public-case policy" : "Not run";
    byId("data-resolution-status").textContent = audit.case.kind === "real-world" ? "Scoped independent verifier" : "Not approved";
    byId("predictor-column-mapping").textContent = "Not declared";
    byId("outcome-column-mapping").textContent = "Not declared";
    byId("claim-mapping-authority").textContent = "Not applicable";
    return;
  }
  if (workflow.kind === "public-evidence-admission") {
    byId("resolved-data-file").textContent = workflow.approval.approvedDataFile;
    byId("data-resolution-actor").textContent = workflow.approval.actor;
    byId("data-resolution-status").textContent = `Approved · ${workflow.approval.bundleId}`;
    byId("predictor-column-mapping").textContent = "x · strict finite decimal";
    byId("outcome-column-mapping").textContent = "y · strict finite decimal";
    byId("claim-mapping-authority").textContent = workflow.approval.mappingAssertion;
    return;
  }
  byId("resolved-data-file").textContent = workflow.approval.approvedDataFile || workflow.proposal.resolvedDataFile || "Not approved";
  byId("data-resolution-actor").textContent = `${workflow.proposal.resolvedBy || workflow.proposal.actor}${workflow.proposal.currentRunModelCall ? " · current run model call" : " · no current run model call"}`;
  byId("data-resolution-status").textContent = workflow.approval.status === "approved"
    ? `Approved · ${workflow.approval.contract.schemaVersion}`
    : workflow.classification.status;
  const mapping = workflow.approval.claimMapping;
  byId("predictor-column-mapping").textContent = mapping
    ? `${mapping.predictor.paperTerm} → ${mapping.predictor.column}`
    : "Not approved";
  byId("outcome-column-mapping").textContent = mapping
    ? `${mapping.outcome.paperTerm} → ${mapping.outcome.column}`
    : "Not approved";
  byId("claim-mapping-authority").textContent = workflow.approval.mappingAssertion || "Not approved";
}

function renderRunFlow(workflow) {
  const section = byId("runplan-section");
  if (!workflow) {
    section.classList.add("is-hidden");
    return;
  }
  section.classList.remove("is-hidden");
  const plan = workflow.proposal.plan;
  const checks = Object.entries(workflow.classification.checks || {})
    .map(([name, passed]) => `${name}: ${passed ? "pass" : "fail"}`)
    .join(" · ") || "Policy not reached";
  const attempts = workflow.attempts || [];
  const cards = [
    ["01 · Run proposal", workflow.proposal.actor, plan ? `${plan.executable} ${plan.args.join(" ")} · cwd ${plan.cwd}` : "No RunPlan proposed"],
    ["02 · Run policy", workflow.classification.actor, `${workflow.classification.status} · ${checks}`],
    ["03 · Run approval", workflow.approval.actor, `${workflow.approval.status} · ${workflow.approval.scope}`],
    ["04 · Exact execution", "Trusted fixture executor", attempts.length ? attempts.map((attempt) => `${attempt.command}: ${attempt.status}`).join(" · ") : "No command executed"],
  ];
  byId("run-approval-flow").innerHTML = cards.map(([step, actor, detail]) => `<div class="approval-card">
    <small>${escapeHtml(step)}</small><strong>${escapeHtml(actor)}</strong><p>${escapeHtml(detail)}</p>
  </div>`).join("");
  byId("runplan-view").textContent = JSON.stringify({
    proposed: plan,
    policy: workflow.classification,
    approved: workflow.approval.approvedPlan,
    attempts: attempts.map(({ status, command, exitCode }) => ({ status, command, exitCode })),
  }, null, 2);
}

function renderApprovalFlow(workflow, patch) {
  const policyDetail = workflow.classification.allowListMatch === null
    ? `${workflow.classification.rationale} · No source patch requested.`
    : `Agent recommendation: ${workflow.classification.agentRecommendation}. Policy classification: ${workflow.classification.policyClassification}. Exact allow-list match: ${workflow.classification.allowListMatch ? "passed" : "failed"}. ${workflow.classification.rationale}`;
  const applicationDetail = workflow.application.file
    || (workflow.application.verifierFile && workflow.application.evidenceFile
      ? `${workflow.application.verifierFile} over ${workflow.application.evidenceFile}`
      : "");
  const cards = [
    ["01 · Investigator", workflow.proposal.actor, workflow.proposal.description],
    ["02 · Independent policy", workflow.classification.actor, policyDetail],
    ["03 · Approval", workflow.approval.actor, `${workflow.approval.mechanism} · ${workflow.approval.scope}`],
    ["04 · Executor", workflow.application.actor, `${workflow.application.status}${applicationDetail ? ` · ${applicationDetail}` : ""}`],
  ];
  byId("approval-flow").innerHTML = cards.map(([step, actor, detail]) => `<div class="approval-card">
    <small>${escapeHtml(step)}</small><strong>${escapeHtml(actor)}</strong><p>${escapeHtml(detail)}</p>
  </div>`).join("");
  byId("diff-view").textContent = patch.diff;
  byId("repair-heading").textContent = patch.file
    ? "Proposal, policy, approval, execution"
    : "No source patch: scoped verifier approval";
  byId("repair-badge").textContent = patch.file ? "Analytical logic unchanged" : "Source tree unchanged";
}

function renderComparison(audit) {
  const dependency = audit.dataDependencyCheck;
  if (audit.case.kind === "real-world") {
    byId("dependency-check").className = "dependency-check is-hidden";
  } else {
    byId("dependency-check").className = `dependency-check ${dependency?.confirmed ? "confirmed" : "unconfirmed"}`;
  }
  byId("dependency-check-status").textContent = dependency?.confirmed
    ? "Confirmed"
    : dependency?.status === "disconnected"
      ? "Disconnected"
      : "Not confirmed";
  byId("dependency-check-copy").textContent = dependency
    ? `${dependency.perturbation.observation}.${dependency.perturbation.repositoryColumn} ${dependency.perturbation.originalValue} → ${dependency.perturbation.perturbedValue}. ${dependency.reason}`
    : "No data-dependency canary was completed for this audit.";
  if (audit.comparison?.kind === "unverifiable") {
    byId("comparison-kicker").textContent = "Verification blocked";
    byId("reported-label").textContent = "Reported evidence";
    byId("regenerated-label").textContent = "Executable artifact";
    byId("reported-effect").textContent = "kept";
    byId("regenerated-effect").textContent = "none";
    byId("match-copy").textContent = audit.comparison.reason;
    return;
  }
  if (audit.case.kind === "real-world") {
    byId("comparison-kicker").textContent = "Printed-value verification";
    byId("reported-label").textContent = "Paper values checked";
    byId("regenerated-label").textContent = "Exact printed matches";
    byId("reported-effect").textContent = String(audit.comparison.expectedChecks);
    byId("regenerated-effect").textContent = String(audit.comparison.passedChecks);
    byId("match-copy").textContent = `${audit.comparison.failedChecks} mismatches · rule: observed.toFixed(2) equals the printed value`;
    return;
  }
  const pipelineMatch = audit.comparison.authorVerifierCrossCheck?.match === true;
  byId("comparison-kicker").textContent = audit.comparison.kind === "pipeline-mismatch"
    ? "Pipeline cross-check failed"
    : "Independent recomputation";
  byId("reported-label").textContent = "Author pipeline coefficient";
  byId("regenerated-label").textContent = "Independent verifier coefficient";
  byId("reported-effect").textContent = audit.comparison.authorPipelineEffect.toFixed(6);
  byId("regenerated-effect").textContent = audit.comparison.independentVerifierEffect.toFixed(6);
  byId("match-copy").textContent = pipelineMatch
    ? `Cross-check Match · independent result rounds to the paper's printed ${audit.comparison.reportedEffectRaw}`
    : `Cross-check Mismatch · author pipeline ${audit.comparison.authorPipelineEffect} versus independent verifier ${audit.comparison.independentVerifierEffect}`;
}

function renderRobustness(audit) {
  if (audit.robustness?.kind === "unverifiable") {
    byId("robustness-title").textContent = "No robustness claim was manufactured.";
    byId("robustness-visual").innerHTML = "";
    byId("robustness-copy").textContent = audit.robustness.reason;
    return;
  }
  if (audit.case.kind === "real-world") {
    const example = audit.comparison.mismatchExamples[0];
    byId("robustness-title").textContent = example
      ? "The pinned dataset does not reproduce every printed value."
      : "Every printed value matches at the declared precision.";
    byId("robustness-visual").innerHTML = `<div class="real-metrics">
      <div><small>Rows executed</small><strong>${audit.comparison.rowCount.toLocaleString("en-US")}</strong></div>
      <div><small>Datasets</small><strong>${audit.comparison.datasetCount}</strong></div>
      <div><small>Printed matches</small><strong>${audit.comparison.passedChecks}/${audit.comparison.expectedChecks}</strong></div>
      <div><small>Mismatches</small><strong>${audit.comparison.failedChecks}</strong></div>
    </div>`;
    byId("robustness-copy").textContent = example
      ? `${example.dataset}.${example.metric} is ${example.observed}, which formats as ${example.formattedObserved}, not the paper’s ${example.reportedValue}. The pinned package snapshot may differ from the publication dataset; PeerProof does not widen the rule to manufacture a pass.`
      : "All observed statistics equal the paper's values after formatting to two decimals.";
    return;
  }
  byId("robustness-title").textContent = audit.robustness.fragile
    ? "One observation crosses a predeclared robustness threshold."
    : "The conclusion remains stable under leave-one-out checks.";
  byId("robustness-visual").innerHTML = `<div class="effect-plot">
    <div class="axis"><span>0</span><span>0.5</span><span>1.0</span><span>1.5 β</span></div>
    <div class="plot-row"><small>All data</small><div class="rail"><i id="baseline-dot"></i></div><b>${audit.robustness.baselineEffect.toFixed(3)}</b></div>
    <div class="plot-row"><small>Without ${escapeHtml(audit.robustness.removedObservation)}</small><div class="rail"><i id="perturbed-dot"></i></div><b>${audit.robustness.perturbedEffect.toFixed(3)}</b></div>
  </div>`;
  const changed = [
    audit.robustness.significanceChanged ? "statistical significance" : null,
    audit.robustness.directionChanged ? "effect direction" : null,
    audit.robustness.effectStabilityChanged
      ? `scaled effect magnitude (${(audit.robustness.effectStabilityChange * 100).toFixed(1)}% ≥ ${(audit.robustness.relativeEffectChangeThreshold * 100).toFixed(0)}%; ${audit.robustness.effectStabilityScaleBasis})`
      : null,
  ].filter(Boolean);
  byId("robustness-copy").textContent = changed.length
    ? `p ${formatP(audit.robustness.baselinePValue)} → p ${formatP(audit.robustness.perturbedPValue)}. ${changed.join(" and ")} changed.`
    : `p ${formatP(audit.robustness.baselinePValue)} → p ${formatP(audit.robustness.perturbedPValue)}. Scaled coefficient change ${(audit.robustness.effectStabilityChange * 100).toFixed(1)}%; no predeclared threshold was crossed.`;
  requestAnimationFrame(() => {
    byId("baseline-dot").style.left = `${Math.min(100, (audit.robustness.baselineEffect / 1.5) * 100)}%`;
    byId("perturbed-dot").style.left = `${Math.max(0, Math.min(100, (audit.robustness.perturbedEffect / 1.5) * 100))}%`;
  });
}

function renderVisualEvidence(audit) {
  const section = byId("public-results-section");
  if (!audit.visualEvidence) {
    section.classList.add("is-hidden");
    byId("summary-table-body").innerHTML = "";
    return;
  }
  section.classList.remove("is-hidden");
  byId("visual-evidence-title").textContent = audit.visualEvidence.title;
  byId("visual-evidence-caption").textContent = audit.visualEvidence.caption;
  byId("summary-table-body").innerHTML = (audit.comparison.datasetSummaries || []).map((summary) => `<tr>
    <th scope="row">${escapeHtml(summary.dataset)}</th>
    <td>${summary.n}</td><td>${summary.meanX}</td><td>${summary.meanY}</td>
    <td>${summary.sdX}</td><td>${summary.sdY}</td><td>${summary.correlation}</td>
  </tr>`).join("");
  const canvas = byId("visual-evidence-canvas");
  const context = canvas.getContext("2d");
  const columns = 4;
  const rows = 4;
  const margin = 20;
  const gap = 14;
  const cardWidth = (canvas.width - margin * 2 - gap * (columns - 1)) / columns;
  const cardHeight = (canvas.height - margin * 2 - gap * (rows - 1)) / rows;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "middle";
  audit.visualEvidence.groups.forEach((group, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = margin + column * (cardWidth + gap);
    const top = margin + row * (cardHeight + gap);
    context.fillStyle = "#fbfaf6";
    context.strokeStyle = "rgba(24, 34, 29, 0.15)";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(left, top, cardWidth, cardHeight, 10);
    context.fill();
    context.stroke();
    context.fillStyle = "#245945";
    context.font = "700 13px system-ui, sans-serif";
    context.fillText(group.dataset.replaceAll("_", " "), left + 13, top + 18);
    const plotLeft = left + 16;
    const plotTop = top + 34;
    const plotWidth = cardWidth - 32;
    const plotHeight = cardHeight - 48;
    context.fillStyle = "rgba(23, 63, 49, 0.57)";
    for (const [x, y] of group.points) {
      const px = plotLeft + (x / 100) * plotWidth;
      const py = plotTop + (1 - y / 100) * plotHeight;
      context.beginPath();
      context.arc(px, py, 1.45, 0, Math.PI * 2);
      context.fill();
    }
  });
}

function renderSourceLinks(auditCase) {
  const links = byId("source-links");
  if (!auditCase.paperUrl && !auditCase.repositoryUrl) {
    links.classList.add("is-hidden");
    links.innerHTML = "";
    return;
  }
  links.classList.remove("is-hidden");
  links.innerHTML = [
    auditCase.paperUrl ? `<a href="${escapeHtml(auditCase.paperUrl)}" target="_blank" rel="noreferrer">Open paper ↗</a>` : "",
    auditCase.repositoryUrl ? `<a href="${escapeHtml(auditCase.repositoryUrl)}" target="_blank" rel="noreferrer">Inspect pinned repository ↗</a>` : "",
  ].filter(Boolean).join("");
}

function renderAudit(audit) {
  state.audit = audit;
  setCaseProfile(audit.case.kind, audit.case);
  byId("running-ledger").classList.add("is-hidden");
  byId("audit-result").classList.remove("is-hidden");
  byId("audit-id").textContent = `${audit.id} · ${audit.aiDisclosure.title}`;
  byId("verdict-label").textContent = audit.verdict.displayLabel || audit.verdict.label;
  byId("verdict-scope").textContent = audit.verdict.scope || "Claim-level deterministic verdict";
  byId("verdict-badge").className = `verdict-badge ${audit.verdict.tone}`;
  byId("result-claim").textContent = `“${audit.claim.text}”`;
  const pageLabel = audit.claim.source.pageLabel || "page not reported";
  byId("source-quote").textContent = `Source: ${audit.claim.source.section || "section not reported"}, ${pageLabel} — “${audit.claim.source.quote}”`;
  byId("reported-evidence-label").textContent = audit.claim.reportedEvidence?.label || "Source-locked evidence";
  byId("source-anchor-status").textContent = audit.claim.sourceAnchor?.label || "Not independently anchored";
  byId("verification-policy-label").textContent = audit.claim.verification?.policyLabel || "No compatible verifier contract";
  byId("verdict-reason").textContent = audit.verdict.reason;
  byId("verdict-rule").textContent = audit.verdict.rule;
  renderSourceLinks(audit.case);
  renderModeDisclosure(audit.aiDisclosure);
  renderVerdictScope(audit.verdictScopeDisclosure);
  renderStageProvenance(audit.stageProvenance);
  renderComparison(audit);
  renderRobustness(audit);
  renderVisualEvidence(audit);
  renderEvidenceChain(audit.evidenceGraph);
  renderDataResolution(audit);
  renderInvestigation(audit.investigation);
  renderTimeline(audit.timeline);
  renderRunFlow(audit.runWorkflow);
  renderApprovalFlow(audit.repairWorkflow, audit.patch);
  renderProvenance(audit.provenance);
  byId("ledger").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runAudit(kind) {
  if (byId("run-demo").disabled) return;
  setRunning(kind);
  byId("ledger").scrollIntoView({ behavior: "smooth", block: "start" });
  const endpoint = kind === "benchmark" ? "/api/audits/demo/stream" : "/api/audits/real-world/stream";
  try {
    const audit = await consumeAuditStream(endpoint);
    renderAudit(audit);
  } catch (error) {
    byId("terminal-output").textContent += `\nERROR: ${error.message}\n`;
    byId("running-title").textContent = "Audit needs attention";
  } finally {
    stopRunning();
  }
}

function downloadAudit() {
  if (!state.audit) return;
  const blob = new Blob([`${JSON.stringify(state.audit, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.audit.id}-evidence-ledger.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function extractPaper() {
  const file = byId("paper-input").files[0];
  const result = byId("extract-result");
  if (!file) {
    result.classList.remove("is-hidden");
    result.textContent = "Choose a paper first.";
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    result.classList.remove("is-hidden");
    result.textContent = "This paper exceeds the 15 MB input limit.";
    return;
  }
  if (!byId("privacy-consent").checked) {
    result.classList.remove("is-hidden");
    result.textContent = "Confirm the upload privacy disclosure before sending the paper.";
    return;
  }
  const button = byId("extract-paper");
  button.disabled = true;
  button.textContent = "Compiling claim…";
  result.classList.remove("is-hidden");
  result.textContent = "Sending the paper to GPT-5.6 with a strict reported-evidence schema…";
  try {
    const judgeToken = byId("judge-token").value.trim();
    const response = await fetch("/api/claims/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(judgeToken ? { "X-PeerProof-Token": judgeToken } : {}),
      },
      body: JSON.stringify({
        paper: {
          name: file.name,
          mimeType: inferMimeType(file),
          base64: await fileToBase64(file),
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Claim extraction failed");
    const claims = payload.claims || [];
    if (!claims.length) {
      result.innerHTML = `<strong>No executable quantitative claim identified</strong><p>${escapeHtml(payload.noClaimsReason || "The paper did not contain a claim supported by the extraction schema.")}</p>`;
      return;
    }
    const selectedClaimId = payload.selectedClaimId
      || claims.find((claim) => claim.executionSupport?.status === "supported")?.id
      || claims[0].id;
    result.innerHTML = claims.map((claim, index) => {
      const supportClass = claim.executionSupport?.status === "supported" ? "supported" : "unsupported";
      const sourceLocation = [claim.source.section, claim.source.pageLabel, claim.source.paragraph]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ") || "Source location not reported";
      const selection = claim.id === selectedClaimId ? " · selected by current verifier" : "";
      return `<article class="extracted-claim ${claim.id === selectedClaimId ? "selected" : ""}">
        <small>Claim ${index + 1}${selection}</small><strong>${escapeHtml(claim.text)}</strong>
        <p>${sourceLocation} · ${escapeHtml(claim.evidence.statisticalTest || "Statistical test not reported")}</p>
        <dl class="extraction-boundary">
          <div><dt>Reported evidence</dt><dd>${escapeHtml(claim.reportedEvidence?.label)}</dd></div>
          <div><dt>Source anchor</dt><dd>${escapeHtml(claim.sourceAnchor?.label || "Not independently anchored")}</dd></div>
          <div><dt>Verification policy</dt><dd>${escapeHtml(claim.verification?.policyLabel || "No compatible current contract")}</dd></div>
        </dl>
        <p class="support-message ${supportClass}">${escapeHtml(claim.executionSupport?.message)}</p>
      </article>`;
    }).join("");
  } catch (error) {
    result.innerHTML = `<strong>Could not compile this paper</strong><p>${escapeHtml(error.message)}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "Extract ClaimSpecs";
  }
}

byId("run-demo").addEventListener("click", () => runAudit("benchmark"));
byId("run-empty").addEventListener("click", () => runAudit("benchmark"));
byId("run-real-world").addEventListener("click", () => runAudit("real-world"));
byId("run-real-empty").addEventListener("click", () => runAudit("real-world"));
byId("rerun-sidebar").addEventListener("click", () => runAudit(state.activeCase));
byId("switch-case").addEventListener("click", () => runAudit(state.activeCase === "benchmark" ? "real-world" : "benchmark"));
byId("download-audit").addEventListener("click", downloadAudit);
byId("open-upload").addEventListener("click", () => byId("upload-dialog").showModal());
byId("paper-input").addEventListener("change", (event) => {
  byId("paper-label").textContent = event.target.files[0]?.name || "Choose a PDF, Markdown, or text file";
});
byId("extract-paper").addEventListener("click", extractPaper);
loadHealth();
