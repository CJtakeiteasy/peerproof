# PeerProof demo video script

Target duration: **2 minutes 50 seconds**. Keep the public YouTube video below
the required three minutes.

Narrative balance: spend roughly 65% on Lighthouse and the core product, 25% on
Datasaurus as the inconvenient-result credibility check, and 10% on the future
vision and how Codex accelerated development. Datasaurus demonstrates contract
discipline; it is not presented as R support or a complete real-world
reproduction.

When showing Datasaurus, briefly expose its reviewed seven-file identity bundle,
the distinct registered Summary Matrix runtime, and the label “Reviewed
transcription · paper artifact not anchored.” This proves multi-contract dispatch
without overstating paper-source anchoring.

## 0:00–0:20 — Problem and product

**Screen:** Hero, two audit buttons, and the five-step method.

**Narration:**

> Scientific papers make claims, but peer reviewers usually evaluate them by
> reading—not by executing the evidence. PeerProof turns one reported claim into
> a typed test, runs the linked code and data, independently challenges the
> result, and returns an Evidence Ledger you can audit.

## 0:20–0:45 — Live GPT-5.6 evidence extraction and policy boundary

**Screen:** Claim card, source-anchor status, then click **Run benchmark audit**.
Pause on the mode disclosure and per-stage provenance.

**Narration:**

> GPT-5.6 extracts the paper's reported evidence into a strict schema: source,
> statistic, value, human-readable dataset label, and test. For this text input,
> PeerProof independently anchors the quote and printed values. GPT does not
> invent the audit rule. PeerProof separately attaches Simple Univariate OLS
> Contract v3: exactly one declared predictor and outcome, an intercept,
> printed-precision matching, strict p below .05, and independent leave-one-out
> thresholds. This run says “GPT-5.6 · structured extraction” because the model
> call happened live for this audit.

For the final competition video, configure `OPENAI_API_KEY` and show a successful
live extraction at least once. Fixture mode is suitable for rehearsal, but the
video must not imply a fixture is a current model call.

## 0:45–1:25 — Codex investigation and permission boundaries

**Screen:** Expand **Codex investigation**. Show inspected files, entry-point
reasoning, resolved repository data file, and manifest approval. Then show
**RunPlan governance** before the failure log and repair governance.

**Narration:**

> Codex receives only the task and safety boundaries—not the expected file,
> blocker, or answer. It identifies which files matter, finds the entry point,
> resolves the repository's data dependency, and proposes a typed RunPlan. An
> independent manifest policy approves the data path, and a run policy approves
> that exact plan before the executor captures the author-local path failure.
> Codex is read-only: it can propose an exact repair but cannot apply it. The
> policy engine ignores Codex's self-classification and independently matches
> the exact patch to an allow-list. Only then does the fixture executor apply it
> to this audit's working copy. Repository content is treated as untrusted
> evidence, so comments cannot rewrite the agent's task.

For the final video, set `PEERPROOF_USE_CODEX=true` and show `Codex · live
repository analysis` at least once. If that call fails, stop and fix the runtime
instead of recording the fallback as live proof.

## 1:25–1:53 — Independent reproduction and robustness surprise

**Screen:** Author/independent comparison, robustness plot, Fragile verdict, and
timeline.

**Narration:**

> The author pipeline reports beta 1.276190. It does not report the stress test.
> PeerProof rereads and hashes the approved CSV, independently regenerates the
> same coefficient, and then runs every leave-one-out case itself. A bounded
> static trace also connects the approved JavaScript entry point to the CSV;
> it is partial, so the ledger keeps dynamic-path and semantic limits visible.
> The value
> rounds to the paper's printed 1.276, but removing P10 changes the coefficient
> to .033 and p to .849, crossing significance and the predeclared 20% scaled
> effect-stability rule. A deterministic rule—not model prose—returns Fragile.
> If a well-formed author artifact disagreed with PeerProof's recomputation, the
> pipeline cross-check would return Failed.

## 1:53–2:28 — Public evidence audit

**Screen:** Click **Explore a public evidence audit**. Show DOI/repository links,
20/65, 13 scatterplots, original-runtime limitation, no-source-patch decision,
and **Package snapshot mismatch**.

**Narration:**

> Lighthouse is the deterministic smoke test. This public evidence audit uses a
> real CHI paper, a pinned MIT-licensed repository, and 1,846 observations. The
> package example visualizes the data but is not a standalone command that
> reproduces the paper's five statistics, so PeerProof refuses to call an
> independent CSV check an original-pipeline rerun. The declared contract is
> exact equality at the paper's two printed decimals. Only 20 of 65 values match
> this independently pinned package and mirror snapshot, so the honest result is
> Package snapshot mismatch. That is not a claim that the paper is false; it is
> proof that PeerProof preserves an inconvenient contract instead of forcing a
> green result.

## 2:28–2:50 — How Codex accelerated the build

**Screen:** Show `evals/repositories/`, `scripts/agent-eval.js`, tests, then
return to the Evidence Ledger.

**Narration:**

> I built PeerProof with Codex using GPT-5.6. Codex helped scope the verifier,
> design the agent-policy boundaries, implement the statistical and audit
> pipeline, and test the app. Six adversarial repositories, repeated three times,
> measure whether Codex finds working directories, package entry points, and
> analytical changes that policy must reject. Each live run produces a
> structured receipt with confidence intervals. Reviewed case-policy bundles
> separately bind executable plans to exact repository hashes. PeerProof asks
> not only “did the
> code run?” but “does independently executed evidence support the claim?”

## Recording checklist

- Record at 1080p or higher and keep terminal text readable.
- Run `npm run live-smoke` immediately before recording; do not record unless
  live GPT extraction, response/request IDs, live Codex investigation, thread
  ID, required models, and application commit all pass.
- Show source-anchor status and keep each stage's live/fixture label visible.
- Do not cut away during data proposal → manifest approval, RunPlan proposal →
  policy → approval → execution, or repair proposal → policy → approval → apply.
- Show the author pipeline and independent verifier coefficient side by side.
- Show the real paper and pinned repository links, while calling Datasaurus a
  public evidence audit—not a complete original-pipeline reproduction.
- Mention `npm run agent-eval` and how Codex accelerated development.
- End on the Evidence Ledger and keep the video below 3:00.
