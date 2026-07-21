# PeerProof contributor guidance

## Product invariant

Model output is a hypothesis until an execution artifact or deterministic rule
supports it. Never let GPT-5.6 or Codex directly assign the final verdict.

## Patch invariant

Do not change the fixture's scientific analysis to make it match the paper.
Infrastructure repairs must be minimal, classified, hashed, and shown as diffs.

## Required checks

Run before handing off a change:

```bash
npm run check
```

For interface changes, also start the app, run the Lighthouse audit in a browser,
and inspect the initial, running, and result states at desktop and mobile widths.

## Scope

Keep the Build Week path reliable. New language support, arbitrary repository
execution, and additional statistical tests belong on the roadmap unless they
improve the one audited claim without weakening safety or explainability.
