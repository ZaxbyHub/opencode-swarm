## Test coverage: knowledge-store caps, promoted-entry deletion guard, and comment accuracy

Closes three review items from issue #1219 / PR #1207: adds unit tests for `appendKnowledgeWithCapEnforcement`, the promoted-entry deletion guard, and corrects a stale comment in `knowledge-reader.ts`.

- **What**: (1) Added 9 direct unit tests for `appendKnowledgeWithCapEnforcement` in `tests/unit/hooks/knowledge-store-caps.test.ts` covering FIFO cap behavior, atomicity, and concurrency. (2) Added 4 tests for the promoted-entry deletion guard in `tests/unit/tools/knowledge-remove.test.ts` covering guard behavior, sibling non-blocking, idempotency, and non-promoted status selectivity. (3) Replaced a stale comment at `src/hooks/knowledge-reader.ts:461-467` that referenced removed `same_project_weight`/`cross_project_weight` config values with an accurate description of the post-PR-#1207 constant `HIVE_TIER_BOOST = 0.05`, noting the config weights' surviving usage in `hive-promoter.ts`.
- **Why**: Addresses Issue #1219 PR-#1207 review feedback — closes F-002, F-003, F-004 by improving test coverage and comment accuracy for the knowledge tier enforcement and promotion subsystem
- **Migration**: None
- **Known caveats**: This is a test/comment-only follow-up with no runtime behavior change
