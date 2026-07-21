# PeerProof security model

## Current executable scope

Only the included reviewed Lighthouse benchmark executes as a child process.
Before either audit runtime is dynamically loaded by the server or CLI, an AST
walker discovers the transitive first-party closure from fixed product and
evaluation roots. Every reachable module and the reviewed non-module assets must
match the generated build-integrity manifest. Direct library calls repeat
admission before audit artifacts are read.

Runtime-loaded policy assets are declared once in `src/runtime-assets.js`, which
is consumed by the loaders, manifest generator, and admission check. Admission
requires both directions: every registered asset is governed, every governed
policy is registered, and the recursive on-disk policy-directory inventory has
no unregistered, missing, or symbolic-link entries.
Datasaurus uses a registered read-only verifier only after all eight public-case
files pass complete inventory, realpath, symlink, and canonical-content
admission. Admission reads each file once; parsing and computation consume those
same captured bytes. Raw and LF-canonical SHA-256 identities remain distinct.
Its strict parser rejects malformed or non-finite evidence; an identity mismatch
stops before statistics. Uploaded papers
are sent only to claim extraction; uploaded repositories are not executed.
`npm run policy-eval` can additionally execute one checked-in reviewed nested
Node fixture to test policy generalization; it is not reachable through the
public web audit endpoint.

The trusted executor accepts a structured, policy-approved RunPlan, maps the
allow-listed `node` executable to the current runtime, uses literal arguments,
supplies a minimal environment, caps output at one megabyte, and enforces a
timeout. It runs only checked-in reviewed fixtures in a per-audit working copy.
It is a host child process and does **not** provide OS-level filesystem or
network isolation. Setting
`PEERPROOF_ALLOW_TRUSTED_DEMO_EXECUTION=false` disables it.

`NodeScriptPolicy v1` is declarative and reusable, but it is never sufficient by
itself to authorize execution. A separately reviewed, versioned case-policy
bundle must exactly match the plan and the SHA-256 inventory of every repository
file. UTF-8 text is normalized to LF before hashing to survive Git checkout
line-ending conversion; binary files are byte-exact. Added, missing, materially
changed, or symbolic-link entries invalidate admission.
The checked-in approval record is version-controlled maintainer metadata, not
a cryptographic identity proof. Signatures are unsupported and any non-null
signature field is rejected rather than displayed as trusted. Every bundle also
labels its origin and authority status: an exact local hash proves snapshot
identity, not scientific provenance. See `docs/CASE_ADMISSION.md`. This
preserves the current security claim: multiple reviewed layouts are supported;
arbitrary repositories are not.

The Datasaurus paper PDF is not redistributed or hashed. Its canonical-content admitted
source record is a reviewed transcription labeled
`reviewed-transcription-not-artifact-anchored`; it is not presented as
source-verified. See `docs/PUBLIC_EVIDENCE_ADMISSION.md`.

The build manifest and public-evidence policy are version-controlled maintainer
metadata, not signatures. Build admission detects drift from that reviewed
manifest only under a trusted local runtime. The admission module executes before
it can check itself, already-loaded modules are not reconstituted from the later
file check, and installed `node_modules` are represented only by the admitted
lockfile—not individually hashed at runtime. Therefore this is not hostile-runtime
attestation, dependency admission, or publisher authentication. `npm ci` from
the reviewed lockfile remains a trusted judge/deployment step. A production
release should verify upstream objects during onboarding and sign a release
manifest or container digest, with dependency attestations.

## OpenAI boundaries

The GPT call has input/output/time limits. The Codex SDK uses a temporary
`CODEX_HOME`, a minimal environment, a read-only sandbox, network and web search
disabled, approval `never`, and cancellation. `OPENAI_MODEL` and `CODEX_MODEL`
are configured independently. Raw Codex turn items are not exposed in ledgers.

The extraction endpoint supports an optional judge token, per-client rate
limits with bounded bookkeeping, strict JSON/Base64 validation, extension/MIME
matching, PDF magic-byte validation, and bounded input sizes. Every audit
endpoint is rate-limited and shares a two-run concurrency gate by default.

Public benchmark requests stay in reviewed fixture mode by default, even when
server credentials exist. Live browser audits require both
`PEERPROOF_PUBLIC_LIVE_AUDITS=true` and a valid `PEERPROOF_JUDGE_TOKEN`; a global
daily AI-call budget covers authorized demo audits and direct paper extraction.

`PEERPROOF_TRUST_PROXY=true` makes rate limiting trust the first
`X-Forwarded-For` value. Enable it only behind a trusted reverse proxy that
overwrites, rather than appends untrusted, forwarding headers. Enabling it on a
directly reachable server lets clients spoof their apparent address and bypass
per-client limits.

Public execution logs and Evidence Ledgers redact application/run-directory
absolute paths and API-key-like strings before SSE delivery or persistence.
Static responses also set a restrictive CSP with framing, base-URI, and object
embedding disabled, plus no-referrer, feature-denial, and same-origin opener
policies.

## Patch policy

Only exact reviewed infrastructure candidates may be automatically applied.
Analytical, ambiguous, semantically similar but unreviewed, or stale patches are
rejected. Rejection yields `Unverifiable`; it is never treated as reproduction.

## PDF and evidence-selection boundaries

PDF.js runs in a separate Node child process and provides deterministic
page-level text extraction and hashes of page text and layout-box evidence. The
worker uses a 15-second timeout, a 256 MB V8 heap limit, bounded IPC output, a
minimal environment, and termination on abort or failure. This reduces parser
impact on the server but is not a container: OS-enforced filesystem and network
isolation are not provided. Quote/value/page matching can ground text-layer
PDFs. It does not perform OCR, reconstruct table semantics, or prove that a
paper term is scientifically equivalent to a repository column.

The evidence manifest is a reviewed, integrity-protected assertion. Policy can
verify its path, schema, hash, row/column contract, and consistency with the
investigator proposal; it cannot independently establish publication lineage
or upstream preprocessing. Ambiguous mappings require abstention or future
human attestation.

For the current JavaScript benchmark, a bounded deterministic trace follows
literal relative ESM references and `new URL(..., import.meta.url)` file
references from the approved entry point. It records nodes, edges, and hashes
and can partially confirm reachability of the approved CSV. It does not resolve
dynamic imports or paths, package exports, preprocessing semantics, or paper-
term equivalence; the ledger retains those limitations and the numerical canary
remains a separate check.

## Storage and environment boundaries

Audit lookup state and limits are single-process and in memory. Local artifacts
have a TTL and are not a durable queue, shared database, immutable object store,
or signed permanent audit URL. Downloaded ledgers do embed the complete reviewed
build/public-evidence manifests and observed identities needed for offline
comparison, while explicitly recording null signatures and unsigned trust
boundaries. The execution-environment manifest records known runtime facts and
leaves the container image digest null. Before a durability or authenticity
claim, add persisted state, content-addressed artifacts, signed releases, and
tamper-evident exports.

## Production requirements for arbitrary repositories

Before enabling user-supplied repository execution, add:

- a disposable container or microVM per audit;
- networking disabled by default;
- read-only source/data mounts and a separate artifact mount;
- no API keys, cloud credentials, SSH agent, home mount, or Docker socket;
- CPU, memory, process, disk, output, and wall-clock limits;
- seccomp/AppArmor or equivalent system-call policy;
- pinned images and dependency provenance;
- complete process-tree termination and external audit logs.

Do not enable arbitrary execution on the host process.
