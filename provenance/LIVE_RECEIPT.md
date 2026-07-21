# Historical live audit receipt

`npm run live-smoke` refuses every AI fixture fallback, runs the Lighthouse
audit with live GPT-5.6 and Codex stages, validates their non-sensitive IDs,
checks the observed GPT model and configured Codex request model separately,
and writes `provenance/live-lighthouse-audit.json`. The current Codex SDK
receipt is not described as an observed-model receipt when it exposes only the
configured request model.

That JSON is a historical execution receipt. It is never presented as evidence
that a later browser request was live. Run the command in the final recording
environment, inspect the receipt for sensitive data, and commit it only after a
successful live run. The repository does not ship a fabricated receipt.
