# Reviewed-case admission workflow

`NodeScriptPolicy v1` performs reusable structural checks, but it cannot grant
execution by itself. Every executable case must cross this reviewed admission
workflow before its plan is registered.

1. Codex investigates the repository read-only and proposes a RunPlan, data
   resolution, blockers, and any repair.
2. Structural policy checks the executable, literal arguments, repository-
   relative working directory and entry point, artifact type, and limits.
3. A reviewer checks the repository revision, evidence manifest, proposed plan,
   semantic mapping boundary, and exact repair candidates. Model output cannot
   approve itself.
4. The reviewer creates a versioned bundle under `policies/cases/` containing
   the structural profile, exact allowed plans and repairs, an exact SHA-256
   content manifest for every repository file, and an approval record. UTF-8
   text is normalized to LF before hashing so Git's platform line-ending
   conversion cannot invalidate the same committed content; binary files are
   hashed byte-for-byte.
5. The bundle records whether the case is project-authored or externally
   sourced, plus its scientific-authority status. Exact local hashes establish
   snapshot identity; they do not establish scientific origin or authorship.
6. The bundle and repository snapshot are committed together. Approval is
   version-controlled maintainer metadata, not a cryptographic identity proof.
   Cryptographic signatures are unsupported in this MVP: non-null signature
   fields are rejected, and `/api/health` exposes `signed: false` plus
   `signatureVerification: "unsupported"`.
7. `npm run policy-bundle-check` must pass. At audit time, PeerProof repeats the
   full file inventory, symlink, realpath, and SHA-256 checks before granting a
   RunPlan approval.

Any added, missing, changed, or linked file invalidates admission. Updating a
repository therefore requires a new reviewed bundle version. This workflow is
for checked-in trusted cases only; it does not make host execution safe for
arbitrary uploaded repositories.
