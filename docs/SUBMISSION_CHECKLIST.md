# Build Week submission checklist

## Required fields

- [x] Working project
- [x] Category selected: **Developer Tools**
- [x] Project description drafted in `docs/SUBMISSION.md`
- [ ] Public YouTube demo under three minutes
- [ ] Repository URL added to the submission
- [x] README includes setup, sample data, platforms, and judge test path
- [x] License included
- [x] GPT-5.6 and Codex usage explained
- [ ] `/feedback` Codex Session ID added

## Obtain the required Codex Session ID

This repository was built primarily in the current Codex task. After the core
work is complete:

1. In this same Codex task, enter `/feedback`.
2. Follow the feedback flow and copy the Session ID it returns.
3. Paste the returned Session ID into the Devpost submission form.

Do not use a different short cleanup task—the rules request the session where
the majority of core functionality was built.

## Repository preparation

- [ ] Add the published repository URL to Devpost
- [ ] Add the public YouTube URL and optional live-demo URL to Devpost
- [ ] Push the tested commit
- [ ] Confirm the repository is public with MIT licensing, or share the private
      repository with `testing@devpost.com` and `build-week-event@openai.com`
- [ ] Clone into a clean folder, run `npm ci`, then run `npm start`
- [ ] Run `npm test` in the clean clone
- [ ] Confirm `.env` and `.peerproof/` are not committed
- [ ] Confirm `Application commit` is a real Git hash in both downloaded ledgers
- [ ] Create the submission ZIP with `git archive` so entry separators are POSIX-compatible
- [ ] Run `npm run docker-smoke` from the clean clone on a Docker host

## Video proof

- [ ] Show the project working, not only slides
- [ ] Show a successful live GPT-5.6 call and narrate how it extracts reported evidence
- [ ] Show that PeerProof—not GPT-5.6—attaches printed-precision and stress-test policy
- [ ] Show deterministic text/Markdown anchoring or page-level PDF anchoring; disclose scanned, ambiguous, timed-out, or unparsable PDFs as unanchored
- [ ] Show a successful live Codex call and narrate how it investigates the repository
- [ ] Show Codex's data-file proposal and independent manifest approval
- [ ] Show agent recommendation, independent policy classification, and exact allow-list match
- [ ] Show the structured RunPlan, independent approval, and exact executed command
- [ ] Show the original execution failure
- [ ] Show the minimal patch diff
- [ ] Show the regenerated result
- [ ] Show author pipeline coefficient, independent verifier coefficient, and Match
- [ ] Show the robustness result and Fragile verdict
- [ ] Show the Datasaurus DOI, pinned repository, 1,846-row execution, 13 plots,
      exact two-decimal rule, 20/65 matches, and Package snapshot mismatch verdict
- [ ] State that the package/mirror CSV is cross-source and that the original
      publication generation pipeline was not run; do not imply the paper is false
- [ ] State clearly whether each GPT-5.6/Codex stage is live, offline fixture,
      or a recorded public-case investigation
- [ ] Mention how Codex accelerated development
- [ ] Briefly show `npm run agent-eval`, its 6-fixture × 3-run metrics, and the persisted JSON report
- [ ] Keep the public YouTube video below 3:00

## Final smoke test

```bash
npm run check
npm run coverage
npm run live-smoke
npm run docker-smoke
npm start
```

Open the app and run both buttons:

1. **Run benchmark audit** → `Fragile`, with `P10` as the influential observation.
2. **Explore a public evidence audit** → `Package snapshot mismatch`, with 20/65
   printed-value matches, 1,846 rows, and no source patch.

Download both JSON ledgers and confirm the AI-mode disclosure matches the actual
runtime configuration.

Then repeat from a fresh clone and run both CLI commands plus the Docker
build/run path documented in the README.

On the Docker host, confirm all of the following rather than relying only on a
successful image build:

- health status becomes `healthy`;
- both audit endpoints complete;
- `applicationCommit` equals the build argument;
- the non-root process can write `.peerproof/runs`;
- SSE returns `X-Accel-Buffering: no` and the deployment proxy does not buffer;
- with `PEERPROOF_DOCKER_LIVE=true`, live GPT and Codex authentication succeeds
  inside the container.
