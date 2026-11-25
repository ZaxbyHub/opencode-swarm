---
issue:3820
issue:3822
issue:3836
---

## Security hardening: residue quarantine containment, hive promotion provenance, and external-skill approval identity

Three guardrail hardenings land together (collated #3820 + #3822 + #3836, Workstream S slots 3/5/18).

### Residue quarantine rollback + render consistency (#3836, transfers #3596)

- `rollbackResidueQuarantine` no longer aborts an entire batch because one manifest entry carries control characters in its recorded path. Such entries are now **skipped and reported** (`status: 'skipped'`, reason `unsafe-name`), the batch is retained (`drained: false`), and every valid sibling still restores. Previously one poisoned entry threw away the whole rollback and stranded the batch permanently — every retry re-selected it and re-threw, making the stored copies unrecoverable through the tool.
- Tampering stays a hard reject: traversal (`..`), empty segments, absolute paths, and root escapes abort the whole call exactly as before (including when only the stored path is traversal-shaped).
- `validateRelPath` now rejects the full Unicode Cc class (C0 + DEL + C1); previously C1 and DEL passed validation and reached raw output.
- All quarantine/residue-derived names rendered by `swarm config doctor`, the close command (operator warnings and the persisted `.swarm/close-summary.md`), close dry-run, close archive, and the curator post-mortem briefing are neutralized through one shared helper (`neutralizeResidueName`), matching the #3542 renderer treatment.
- The quarantine MOVE path validates each eligible entry's name **before** renaming; unsafe-named residue is preserved in place with reason `unsafe-name` instead of being written raw into a manifest that would later poison rollback.

### Hive promotion is bound to independent provenance (#3820)

- The application-evidence gate is **active by default**: `knowledge.promotion_min_terminal_applications` now defaults to **1** (was 0, which left the gate inert). A lesson is no longer promotable to the cross-project hive on age alone, on a caller-supplied tag, or on retrieval-only phase confirmations without at least one independent terminal receipt.
- Independence is an explicit allowlist — only `reviewer`, `architect`, and `test_engineer` receipts count. `delegate` self-report, `architect_marker` acknowledgments, application-gate release records, `manual`, `migration`, `phase_override`, and legacy `unknown` sources are all refused.
- The privileged `hive-fast-track` route is no longer armed by the entry's `tags` array (which any writer could set); it requires a dedicated `hive_fast_track_authorized` field that only the manual promotion path writes, and `knowledge_add` strips the tag from caller input as defense in depth.
- **Compatibility:** ordinary direct-text promotion (`/swarm promote "<text>"`) now requires the audited override (`--force --reason`); `promoteFromSwarm` promotes when the swarm entry has a qualifying independent receipt. Operators who need the old behavior can set `promotion_min_terminal_applications: 0` explicitly.

### External-skill approval is bound to verified content (#3822)

- Promoted external skills are now **digest-bound**: promotion records a canonical content digest (the artifact's own digest line replaced by a fixed placeholder before hashing), and the skill propagation gate recomputes it at discovery/injection time, failing closed on any mismatch — including after an attacker rewrites both body and frontmatter digest, strips provenance fields, or substitutes the candidate id. Legacy already-promoted skills remain loadable (ASK-2 legacy rule).
- `external_skill_revoke` targets the structured `target_path` + recorded hash instead of regex-scraping a slug from prose, refuses targets outside the project's generated-skill root (including traversal and symlink/junction escapes), and refuses to delete when the on-disk bytes no longer match the recorded hash.
- Promotion refuses slugs that collide with bundled project skills (`reserved`), preventing a same-name external skill from shadowing a bundled one in a different root.
- `external_skill_promote` accepts an optional `expected_sha256` argument (backward-compatible): when provided, promotion refuses with a stale-base error if the candidate content changed since it was reviewed.
