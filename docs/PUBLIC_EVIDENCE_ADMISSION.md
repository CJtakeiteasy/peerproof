# Reviewed public-evidence admission

Public evidence is not trusted merely because PeerProof computes and records its
current hash. Every public case must have a reviewed bundle under
`policies/public-cases/` containing:

- the complete file inventory;
- expected canonical SHA-256 identities;
- a canonical Git blob identity where snapshot reconciliation matters;
- repository, data-mirror, DOI, license, and authority-status metadata;
- a verifier contract ID and strict evidence manifest;
- a hash-admitted paper-source record;
- version-controlled maintainer review metadata.

At runtime PeerProof performs, in order:

1. source-root `lstat`/`realpath` containment;
2. complete inventory and symlink rejection;
3. one read of every file, raw SHA-256 recording, and explicit UTF-8 newline
   canonicalization;
4. expected canonical SHA-256 and declared canonical Git-blob comparisons;
5. complete schema validation of the bundle, paper source, and investigation
   record;
6. creation of an in-memory admitted snapshot over those same bytes;
7. registered verifier-contract resolution;
8. strict evidence parsing from the admitted snapshot;
9. deterministic recomputation and verdict.

Any mismatch raises `PublicEvidenceAdmissionError` before the source record is
trusted, the CSV is parsed, or a statistic is calculated. A shape-preserving
numeric edit therefore cannot silently receive a scientific verdict.

`rawSha256` identifies the bytes physically read. `canonicalSha256` identifies
UTF-8 content after CRLF/CR newlines are converted to LF; binary content is not
transformed. User-facing provenance therefore says **canonical-content
identity admission**, not byte-exact admission. The verifier never reopens an
admitted path, so the bytes used in calculation are the bytes that were hashed.

The current approval record is version-controlled maintainer metadata, not a
cryptographic reviewer identity. Non-null signature fields are rejected.
Repository/data-mirror commits and DOI metadata are declared origins; PeerProof
does not inspect upstream Git objects or publication artifacts in this build.

Datasaurus includes `PAPER_SOURCE.json`, a reviewed transcription containing
the DOI, retrieval date, page/section/figure pointers, short source span,
reported targets, reviewer, and licensing status. Because the paper PDF is not
redistributed or hashed, its status is
`reviewed-transcription-not-artifact-anchored`; PeerProof does not call it
source-verified.
