## Retrieval-quality and graph integrity (#2489, #2490)

- Reuse bounded repository-graph indexes and reject incompatible graph schemas
  while preserving safe fallback behavior.
- Add deterministic, content-addressed multilingual retrieval-quality fixtures,
  production-wired lexical/hybrid/rerank profiles, explicit provenance and
  resource caps, and a blocking two-run regression gate.
