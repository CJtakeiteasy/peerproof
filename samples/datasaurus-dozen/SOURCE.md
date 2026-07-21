# Datasaurus Dozen public case

This case is pinned to `jumpingrivers/datasauRus` commit
`0496ac15208e9ee4a58ea81a5de46912f095aa15`.

- Paper: Justin Matejka and George Fitzmaurice (2017), “Same Stats,
  Different Graphs: Generating Datasets with Varied Appearance and Identical
  Statistics through Simulated Annealing.” DOI: 10.1145/3025453.3025912.
- Repository: https://github.com/jumpingrivers/datasauRus
- Code and package license: MIT (`source/LICENSE.md`).
- Data: 1,846 observations from the R4DS TidyTuesday CSV mirror at commit
  `7489888351e5cc61e04ae6ad300884a4c7f37166`, described upstream as Datasaurus
  package data. This is a separately pinned source and is not represented as a
  same-commit export of the package's `.rda` object.
- LF-canonical CSV Git blob SHA-1: `10ad97cd8ac1862e128448a2a4bf94f1bf5f3a2f`.
- LF-canonical CSV SHA-256: `febad7f618c51699815060a075ba80f13f6f1474e24e11d52ad5599ee269cc51`.

Runtime admission records each file's raw SHA-256, canonicalizes UTF-8 newlines
to LF, and compares the canonical identities against
`policies/public-cases/datasaurus-dozen.v1.json` before parsing or calculating
statistics. The canonical Git blob identifies the reviewed content; it is not
claimed to be the raw bytes of every checkout or a same-commit package export.

The source snapshot is deliberately small: metadata, license, the published
example entry point, its dataset shape test, and the paper-linked data. The
PeerProof verifier never rewrites these source files.
