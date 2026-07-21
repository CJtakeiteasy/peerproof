# Live agent-evaluation receipts

`npm run agent-eval` writes a redacted `peerproof.agent-eval-report.v1` JSON
report to `.peerproof/evals/` by default. Set `PEERPROOF_AGENT_EVAL_OUTPUT` to
this directory when intentionally recording a release evaluation.

A report is checked in only after all runs were performed by a live Codex call.
PeerProof does not ship a generated or fixture-backed report as proof of model
reliability. A valid report contains per-run model, thread, usage, decision,
investigation, error, and check records plus aggregate rates and Wilson 95%
confidence intervals. Review it for secrets before committing even though the
writer applies the standard ledger redaction pass.
