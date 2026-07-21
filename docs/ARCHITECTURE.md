# Architecture and audit contract

PeerProof separates reported evidence, repository reasoning, permission,
execution, independent recomputation, and judgment. Generated text is a
proposal, never its own proof.

## 1. Claim compiler

GPT-5.6 returns strict `ClaimSpec v5` structured output. Claims may be empty when
the paper contains no executable quantitative result. Missing source or evidence
fields remain nullable and p-value comparators are preserved structurally.

For Markdown and plain-text inputs, PeerProof normalizes Unicode minus signs,
whitespace, and comparator spacing, then checks a sufficiently contextual quote
with boundary-aware effect/p-value tokens. Normalized offsets, token spans, and
an excerpt hash enter the ledger. PDF.js runs in a bounded separate Node child
process and extracts page text and layout items. The child has a wall-clock
timeout, V8 heap limit, bounded IPC result, minimal environment, and abort
termination, while honestly recording that it lacks OS network isolation. PDF
anchoring checks all quote-matching pages and requires the model page label to
equal the selected matching text-layer page. Image-only/scanned PDFs and parser
failures are distinguished
and remain `not-independently-anchored` because OCR is outside this MVP.
The uploaded document is untrusted evidence: embedded instructions cannot change
the extractor's task or output schema.

The verifier registry maps a compatible `ClaimSpec` to an executable runtime
plugin through a base interface plus a strategy-specific interface. Both
strategies require claim matching, manifest/evidence-contract validation,
evidence loading, recomputation, robustness, verdict, normalized scientific
errors, runtime-owned execution records, presentation, and provenance. The
`author-pipeline-cross-check` strategy additionally requires strict author
artifact comparison and a data-dependency canary. The
`independent-evidence-audit` strategy requires comparison and visual-evidence
builders. Central orchestration dispatches through the selected strategy rather
than importing result shapes.

The registry contains two genuinely different contracts. Simple Univariate OLS
Contract v3 attaches only when `testFamily` is
`ols`, `effectType` is `regression_coefficient`, and the required numerical
evidence exists. The supported evidence manifest declares exactly one ID column,
one predictor, one outcome, an intercept, rejected missing values, a reviewed
paper-term → repository-column `claimMapping`, and a strict canonical JSON
artifact. That mapping is policy-approved metadata, not an independently proven
scientific fact. Covariates, transformations, weights, clustered errors,
missing-value handling, and arbitrary formulas are outside this verifier.
Summary Matrix Contract v3 attaches to a reviewed descriptive-summary matrix.
It enforces an exact three-column CSV, finite strict decimals, declared group
names and counts, no duplicate rows, and reviewed reported targets before
computing means, sample standard deviations, and Pearson correlations.

## 2. Repository investigator

Codex runs read-only with network disabled and returns:

- inspected files and entry-point reasoning;
- a structured `RunPlan` (`executable`, `args`, `cwd`, expected artifact,
  timeout);
- whether the repository is runnable as submitted and any blockers;
- the repository data dependency it resolved;
- an exact infrastructure-only repair candidate, but only when one is needed.
- an explicit `plan` or safe `abstain` decision. Ambiguous entry points or data
  files must produce a missing-evidence blocker rather than a guess.

The prompt does not reveal the expected entry point, blocker, or patch. Repository
files, comments, READMEs, and generated artifacts are treated as untrusted
evidence rather than instructions. Codex has no execution or write permission.

## Pre-execution integrity boundary

The server and CLI first load the build-admission and runtime-closure modules.
From fixed product and evaluation roots, an Acorn AST walk recursively resolves
static imports/exports, literal dynamic imports, literal CommonJS requires, and
`new URL(..., import.meta.url)` worker/file references. Admission fails if any
reachable first-party module is absent from `policies/build-integrity.v3.json`
or if the discovered closure identity differs. The generated manifest also
governs reviewed policies, fixtures, judge-facing assets, launch/deployment files,
metadata, and the dependency lockfile. The server rechecks after runtime loading;
each audit requires continuity with startup admission, and direct library entry
points repeat admission before reading audited artifacts.

Every loader specifier receives an explicit admission decision. Relative source
modules must be literal, use a supported JavaScript extension (or the documented
extensionless resolution rules), and contain no query, fragment, percent escape,
or backslash. Built-ins are admitted except `vm`; external packages must appear
in `package.json` runtime dependencies; package import maps, absolute paths, and
URL schemes such as `file:` and `data:` are rejected. A non-code `import.meta`
URL is admitted only when its normalized target is in the runtime asset registry.

Multi-pass analysis collects named, default, and namespace `node:module`
imports before tracing the bindings returned by `createRequire`, so tracing is
independent of statement order. `process.getBuiltinModule`, untraced namespace
`createRequire`, computed dynamic imports, computed CommonJS
`require`/`require.resolve`, computed `import.meta` URLs, `eval`, `Function`, and
all statically visible `vm` loaders fail closed. This is a bounded policy for the
patterns used by PeerProof, not full JavaScript scope analysis: obfuscated
computed properties, preload hooks, native extensions, and a hostile host loader
remain outside the trusted-runtime claim.

The ledger embeds the complete reviewed manifest, expected and observed file
identities, closure hashes/counts, and explicit null signature. This makes the
receipt portable for offline comparison. It remains an unsigned local drift
detector under a trusted runtime: the admission code runs before checking itself,
a hostile loader can defeat file-based checks, and `node_modules` contents are
not individually admitted. A reproducible `npm ci` is still a trusted setup step.

Non-code runtime assets use a second fail-closed boundary. Case-policy and
public-evidence policy loaders share `src/runtime-assets.js` with the manifest
generator and admission implementation. Every registered asset must be governed
with its declared role; every governed policy must be registered; and recursive
inventory of `policies/cases/` and `policies/public-cases/` rejects added,
missing, or symbolic-link entries. This is exact registry/inventory
correspondence, not scientific-origin authentication.

For public evidence, admission performs a single read of every file. It records
raw hashes, LF-canonicalizes valid UTF-8, checks canonical identities, validates
complete bundle/source/investigation schemas, and exposes only snapshot readers
over the captured bytes. The verifier therefore cannot reopen a changed path
after admission. This is canonical-content identity, not a byte-exact claim.

## 3. Independent permission boundaries

```text
Investigator suggests data file -> manifest policy -> approval -> verifier input
Investigator suggests RunPlan   -> run policy      -> approval -> exact execution
Investigator suggests repair    -> patch policy    -> approval -> exact application
```

The data-path policy requires the Codex proposal to match the checked-in
`peerproof.evidence.json` manifest exactly. A paper-facing `datasetLabel` can
never select a filesystem path. Manifest, dataset, RunPlan cwd, and patch target
paths pass both `lstat` and `realpath`; links and resolved paths outside the
per-audit repository are rejected before approval and checked again at use.

The run policy resolves a versioned structural profile and a separate versioned
reviewed-case policy bundle. Each bundle stores allowed plans and repairs, a
review record, an explicit origin/authority statement, and a SHA-256 manifest
of every file in the admitted repository. Exact hashes prove local snapshot
identity, not scientific origin. Approval is version-controlled maintainer
metadata, not a cryptographic identity proof; signatures are unsupported and a
non-null signature field is rejected.
UTF-8 text is LF-normalized before hashing for cross-platform Git checkouts;
binary content remains byte-exact.
Runtime approval repeats the full inventory, symlink, realpath, and content-hash
checks; any added, missing, changed, or linked file is rejected.
`NodeScriptPolicy v1` governs both the Lighthouse layout and a nested
`analysis/workflow/reproduce.mjs` evaluation layout, but only exact reviewed
case plans against admitted content can cross approval. The executor receives
the approved object,
not a reconstructed command string. The patch policy resolves case-scoped
reviewed rules and ignores the agent's candidate ID and classification, then
matches file, old text, and new text
exactly. A semantically similar but unreviewed change is rejected and the audit
becomes `Unverifiable`.

## 4. Execution and streaming

The trusted benchmark is copied to `.peerproof/runs/<id>/repo`. Commands, exit
codes, bounded stdout/stderr, hashes, exact approvals, and artifacts are stored.
SSE sends real orchestrator timeline events, heartbeats while pending, and
cancels work when the client disconnects.

Only reviewed included code runs. Uploaded papers can be claim-compiled, but
arbitrary uploaded repositories do not execute in this MVP.

The child process is not OS-contained: network isolation, host filesystem
isolation, descendant process termination, and non-root execution are not
guaranteed by this executor. Those limitations are recorded in the ledger and
health capability document. Arbitrary repositories require an ephemeral
container or microVM with read-only source, no network, quotas, and no secrets.

## 5. Independent statistical boundary

The author repository may emit only a strict canonical artifact: schema
version, sample size, coefficient, standard error, and p-value. Extra fields,
including author-supplied leave-one-out results, are rejected. PeerProof reads
and hashes the policy-approved CSV, independently recomputes the canonical
result, cross-checks it against the author artifact, and computes every
leave-one-out result with `src/statistics.js`.

After the canonical cross-check, PeerProof creates a second disposable working
copy, changes one approved outcome cell by a predeclared `+0.1`, independently
computes the expected result, and reruns the author pipeline. A canary mismatch
is `Failed`: it detects a script that prints the right baseline constants but is
numerically disconnected from the approved dataset.

Before the canary, a bounded deterministic Acorn AST lineage pass traces actual
literal relative ESM imports/exports, literal dynamic imports, literal CommonJS
`require`, and `new URL(..., import.meta.url)` references from the approved
entry point. Extensionless CommonJS paths use bounded `.js`/`.cjs`/`.mjs` and
`index.*` candidates with the chosen resolution rule recorded; ESM remains exact.
Comments and string contents cannot create edges. The resulting node/edge graph and source hashes can
partially confirm that the approved CSV is statically reachable. It deliberately
does not claim dynamic-path, preprocessing-semantic, or paper-term equivalence
proof; those limitations remain machine-readable in the ledger.

A valid author artifact that disagrees with the independent result is a
`Failed` pipeline cross-check, not an ambiguous `Unverifiable` result. Malformed
or missing author artifacts remain `Unverifiable`.

The coefficient contract is fixed before execution: the independent value must
round to the exact numeric text and decimals printed in the paper. Significance
uses the strict rule `p < 0.05`; for example, a report of `p <= 0.05` is
indeterminate under that contract. Robustness is also predeclared:

- statistical significance crosses the strict boundary;
- effect direction reverses; or
- scaled effect change reaches 20%, using
  `abs(loo - baseline) / max(abs(baseline), baseline standard error)`.

The hybrid denominator prevents a near-zero coefficient from producing a
misleadingly unbounded relative change.

## 6. Deterministic decision layer

```text
Unsupported or missing executable evidence            -> Unverifiable
Malformed or missing machine-readable artifact         -> Unverifiable
Valid author artifact vs independent result mismatch   -> Failed
Canonical match but data-dependency canary mismatch    -> Failed
Canonical result outside contract                      -> Failed
Canonical match + robustness threshold crossed         -> Fragile
Canonical match + robustness stable                    -> Reproduced
```

Lighthouse is `Fragile`. Datasaurus first crosses the reviewed public-evidence
bundle boundary: all eight files must match the complete inventory and expected
canonical identities before the same captured bytes are parsed. Raw SHA-256 and
canonical SHA-256/Git-blob values remain separately recorded. It then
dispatches the registered Summary Matrix runtime and uses exact equality after
formatting each observed statistic to the paper's two printed
decimals. The pinned snapshot matches 20/65 values, so its display verdict is
`Package snapshot mismatch`; no wider tolerance is substituted. This is scoped
to an independently pinned package/data-mirror CSV. The original publication
generation pipeline was not executed, so it is not claimed as a complete
real-world reproduction and the verdict is not a finding that the paper is
false.

The reported public targets come from a hash-admitted reviewed source record.
That record contains the DOI, retrieval date, page/section/figure pointers,
short source span, values, reviewer, and licensing status. It also records that
the paper PDF is not redistributed or hashed. The public case is therefore a
reviewed transcription, not deterministic paper-artifact anchoring and not a
source-verified claim. See `PUBLIC_EVIDENCE_ADMISSION.md`.

Expected scientific failures—including rejected plans/patches, timeouts,
missing data, non-zero reruns, and malformed artifacts—still complete an
Evidence Ledger. Only unexpected application faults are `system-error`.

## Evidence Ledger

Each ledger records mode disclosure, stage provenance, source-anchor status,
claim, Codex data proposal and manifest approval, inspected files, proposed and
approved RunPlans, execution attempts, proposal/policy/approval/application
records, author-versus-independent comparisons, hashes, robustness evidence,
verdict rule, and chronological timeline. Live OpenAI client/request/response
IDs and Codex thread IDs are included only when an actual call succeeds.
The application commit is a structured receipt containing the selected value,
resolution source, full-40-hex format result, and an explicit
`cryptographicallyVerified: false`. An invalid configured value stops startup;
a well-formed value alone is not a signed provenance assertion.
Public benchmark endpoints stay in fixture mode unless both the public-live
flag and judge token authorize model spend; a global daily AI-call budget
protects all authorized browser audits and direct paper extraction.

Live agent evaluations persist a redacted `peerproof.agent-eval-report.v1` JSON
artifact with one record per case/run, model/thread/usage receipts, decisions,
checks, errors, prompt/schema/SDK versions, aggregate rates, and Wilson 95%
confidence intervals. Their artifact metric executes only the test-owned exact
expected plan; it does not claim production reviewed-case admission, which is
covered separately by the deterministic policy evaluation. They remain opt-in because CI has no live model
credentials; PeerProof does not fabricate a checked-in live report.

The ledger also records an evidence-selection attestation chain and an execution
environment manifest. The former distinguishes reviewed manifest assertions
from independently proven scientific lineage. The latter includes runtime,
platform, architecture, locale, timezone, lockfile hashes, policy profile, and
case binding while explicitly recording the missing image digest and containment.
Audit lookup remains a one-process TTL index; durable queues, shared databases,
object storage, and signed permanent exports remain future production work.
Downloaded JSON does carry the full build admission and, for public cases, the
full reviewed evidence bundle plus expected/observed identities. Those portable
receipts improve reproducibility without claiming signature authenticity.
