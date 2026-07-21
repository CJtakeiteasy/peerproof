# Devpost submission draft

## Project name

PeerProof

## Category

Developer Tools

## Elevator pitch

A peer reviewer that runs the paper, not just reads it. PeerProof turns
computational claims into executable, auditable tests. This judge build runs two
checked-in evidence packages and compiles uploaded papers into structured
ClaimSpecs.

## Inspiration

Scientific papers make claims, but peer reviewers usually evaluate those claims
by reading—not by executing the underlying evidence. Even shared repositories
are blocked by missing dependencies, undocumented commands, or author-local
paths. Worse, code can run successfully while the conclusion still depends on
one fragile observation or analytical choice.

PeerProof began with one question: what if a computational claim could become an
executable test?

## What it does

PeerProof treats a claim, not an entire paper, as the unit of review. It:

1. uses GPT-5.6 to extract source-referenced reported evidence into a typed schema, then anchors text quotes when deterministic checks pass;
2. resolves one of two registered verifier contracts: a manifest-declared
   simple univariate OLS author-pipeline cross-check, or a strict descriptive
   summary-matrix independent-evidence audit;
3. uses Codex in a read-only sandbox to inspect files, identify the entry point,
   form an execution hypothesis, and propose a structured `RunPlan` and repair;
4. keeps the paper's `datasetLabel` separate from Codex's repository data-file
   proposal, which an independent manifest policy must approve;
5. independently validates and approves the exact `RunPlan`, then records the
   executed plan, exit code, stdout, stderr, and hashes;
6. independently matches an exact proposed repair candidate and patch to an allow-list and records
   the agent recommendation, policy classification, and match result;
7. applies only the exact approved proposal in a trusted-fixture executor over
   a per-audit working copy;
8. accepts only a strict author canonical artifact, then independently rereads
   the CSV and recomputes OLS to cross-check it;
9. records an Acorn AST-based bounded JavaScript lineage graph from the approved
   entry across actual literal imports, exports, `require`, and
   `import.meta.url` data references; comments and strings cannot forge edges,
   and computed-path and semantic limits remain disclosed;
10. independently computes every leave-one-out result and applies predeclared
   strict-significance, direction, and 20% scaled-effect thresholds;
11. treats a valid author artifact that contradicts independent recomputation as
    a `Failed` pipeline cross-check;
12. applies a deterministic four-way verdict;
13. streams real server timeline events and stores the same events in an Evidence Ledger.

The Lighthouse smoke test demonstrates failure → proposal → policy → approval →
repair → rerun → stress test. The coefficient reproduces, but removing P10
changes p from below .001 to .849, so PeerProof returns **Fragile**.

The Datasaurus Dozen adds a genuine public evidence audit: a CHI 2017 paper, pinned
MIT-licensed repository, and 1,846-row dataset. PeerProof records that the source
package runtime is not available as a standalone installation in this deployment,
preserves the source tree, and runs the separately registered Summary Matrix
runtime. Each of the eight files is read once; its raw SHA-256 is recorded, its
canonical identity must match the reviewed inventory, and all later parsing uses
those same captured bytes. The strict parser rejects
malformed fields, non-finite values, unknown or wrong-sized groups, extra columns,
and duplicate rows. The
paper claims equality at two printed decimals, so PeerProof compares formatted
values exactly. Only 20/65 checks match the pinned package/mirror CSV, producing
**Package snapshot mismatch**. The original publication data-generation
pipeline was not executed, so PeerProof does not call this a complete real-world
reproduction and explicitly does not treat the result as evidence that the paper
is false. Thirteen scatterplots and an accessible
summary table are rendered directly from the executed rows. This honest scope is
more useful than widening the rule until the case passes.

The public targets are stored in a hash-admitted reviewed source record with DOI,
retrieval date, page/section/figure pointers, reviewer, and licensing status. The
paper PDF is not redistributed or hashed, so PeerProof labels this evidence as a
reviewed transcription rather than source-verified artifact anchoring.

## How we built it

PeerProof is a Node.js web application with a pinned Codex SDK dependency and
deliberately separate layers:

- a GPT-5.6 Responses API reported-evidence extractor using file input and
  strict Structured Outputs;
- an opt-in Codex SDK repository investigator using model `gpt-5.6`, a
  read-only sandbox, no network, and a structured output schema;
- independent manifest-backed data-path, structured RunPlan, and exact-patch
  policies with explicit approval boundaries, plus versioned reviewed-case
  bundles that bind plans to full repository content hashes;
- an execution engine that stores commands, logs, results, hashes, and diffs;
- an executable verifier-runtime registry; its current plugin performs strict
  artifact validation, OLS/Student-t/influence analysis, a data canary, and
  deterministic verdict dispatch;
- an Evidence Ledger UI with explicit AI modes, source links, investigation
  reasoning, approval actors, and reproducibility artifacts;
- a `POST` SSE audit transport whose progress lines come from actual backend
  timeline events rather than a browser-authored animation.
- a real `peerproof` CLI for both checked-in judge cases, JSON ledger output,
  and launching the web application.

The credential-free judge path never pretends fixture reasoning is live. It
shows `Offline fixture mode` for the benchmark and `Recorded public-case
investigation` for the source-referenced case. Numerical execution and verdict rules
still run locally.

## How GPT-5.6 and Codex are used

GPT-5.6 reads paper inputs and extracts quantitative claims, source locations,
reported values, human-readable dataset labels, referenced evidence, and tests
into a strict schema. Markdown/text quotes and printed values are independently
anchored. Text-layer PDFs are parsed page by page in a bounded child process;
quote/value matching verifies the reported page, while scanned, ambiguous, timed
out, or unparsable PDFs remain explicitly unanchored. GPT does not choose
tolerances, paths, or stress tests. PeerProof attaches Simple Univariate OLS
Contract v3 with paper-printed precision, strict `p < 0.05`, and a hybrid
effect-stability scale as a separate policy layer. Unsupported claim types are
returned as `Extracted, but not executable by the current verifier.` Successful model calls are labeled
`GPT-5.6 · structured extraction`.

Codex investigates repositories without being told the expected entry point,
blocker, or patch. It lists inspected files, explains its entry-point hypothesis,
resolves the data dependency, proposes a typed RunPlan, decides whether the
repository is runnable as submitted, and suggests an exact repair only when
needed. Repository content is untrusted evidence, not agent instruction.
Successful current-run investigations are
labeled `Codex · live repository analysis`.

Codex cannot execute or modify the repository. Separate policies validate the
manifest-backed data proposal, exact RunPlan, and patch object before approval.
The executor receives those
approved objects instead of reconstructing a command or substituting a patch.

Codex also accelerated development. It helped:

- reduce a universal reproducibility platform to two judgeable vertical slices;
- design the reasoning-versus-evidence and proposal-versus-permission boundaries;
- implement the statistical, orchestration, and audit code;
- investigate the public paper, repository, license, data, and runtime obstacle;
- decide not to disguise a compatibility verifier as an original R rerun;
- build the responsive interface and 13-facet public-data visualization;
- run syntax, unit, API, desktop, and mobile verification.

## Challenges

The hardest problem was distinguishing repair from manipulation. An agent that
changes analysis code until it matches the paper is not a reproducibility tool.
PeerProof therefore runs the original first, classifies every proposal, records
approval separately, hashes both versions, and forbids silent analytical
changes.

The second challenge was provenance honesty. A polished fallback can look like
model intelligence. PeerProof exposes whether each reasoning stage was live,
fixture-backed, or recorded. It never displays internal fallback identifiers as
proof and never labels a recorded investigation as a current model call.

The third challenge was reproduction scope. The public R package provides a data
and visualization example, not a one-command numerical paper pipeline. We chose
an independently executed verifier with a narrower verdict instead of
overclaiming original-pipeline reproduction.

## Accomplishments

- A working proposal → classification → approval → execution audit.
- A transparent deterministic benchmark with a real failure and repair diff.
- A DOI-linked, MIT-licensed public case with 1,846 observations.
- Two registered verifier runtimes with distinct execution strategies.
- Single-read canonical-content public-evidence admission that rejects
  shape-preserving tampering and admission-to-use path replacement.
- AST-derived transitive closure admission from fixed product/evaluation roots,
  with every reachable first-party module governed and a complete unsigned
  build-manifest/observed-identity receipt embedded in every downloaded ledger.
- 65 regenerated public-case comparisons that honestly expose 45 printed-value
  mismatches in the pinned snapshot.
- Real OLS, Student-t, and leave-one-out influence calculations.
- An Evidence Ledger exposing files, hypotheses, commands, errors, diffs, rules,
  source links, commits, licenses, and hashes.
- Explicit live, partial, offline-fixture, and recorded-public-case provenance.
- A one-command judge path after reproducible `npm ci`, with no sign-in.
- Automated tests covering all verdicts, both end-to-end cases, GPT/Codex
  schemas, policy rejection, Unverifiable workflows, HTTP safeguards, SSE
  heartbeat/cancellation, redaction, concurrency, MIME inference, and LRU/TTL
  cleanup.
- A 6-fixture × 3-run live repository investigation evaluation covering nested
  working directories, package entry points, forbidden analytical changes,
  repository prompt injection, ambiguous-data abstention, and misleading
  monorepo documentation. Every run is persisted as a structured JSON report
  with model/thread/usage receipts and aggregate confidence intervals.

## What we learned

Reproducibility is most useful at claim level. One result can reproduce exactly
while another is fragile or impossible to verify. We also learned that “the code
ran” is not a verdict, and that repair authority must be independent from the
agent proposing the repair.

## What's next

Next steps are an authentic licensed public case that executes the original
author pipeline, disposable container workers for untrusted repositories,
Python/R/Jupyter adapters, dependency lockfile reconstruction, figure-level
image comparison, domain-specific robustness libraries, collaborative reviewer
annotations, and cryptographically signed reproduction bundles.

PeerProof's goal is not to replace reviewers. It gives them a capability they
rarely have: execute, inspect, and challenge the evidence behind a claim.

## Submission fields still requiring owner action

- Add the final public YouTube URL to Devpost after uploading the under-three-minute video.
- Add the final repository URL after publishing or sharing it with the judge accounts.
- Add a live demo URL if you deploy one.
- Run `/feedback` in the primary build task and paste the returned Session ID into Devpost.
