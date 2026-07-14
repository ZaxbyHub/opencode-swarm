## Transactional hive promotion with preserved application lineage

Swarm→hive knowledge promotion is now atomic, identity-correct, and
evidence-preserving. Closes #1847 and the lost-update portion of #1604.

### Why
Hive promotion performed a read → N× append → batch rewrite → cap enforcement
sequence as four separate directory-lock acquisitions, with unlocked
read/validate/dedup windows between them. Because the hive store
(`shared-learnings.jsonl`) is a shared, cross-project, cross-process file, two
opencode-swarm sessions could each read the same snapshot and one's rewrite
silently dropped the other's entries (TOCTOU lost update). Cross-project
distinctness keyed on the un-normalized worktree `project_name` (sibling
worktrees and remote aliases counted as distinct projects), promoted entries got
a fresh UUID with no link back to their swarm origin, manual promotion bypassed
policy with no audit, and the frozen v1 `applied_count` was conflated with
application.

### What changed
- **One global hive promotion transaction** (`src/hooks/hive-transaction.ts`):
  every hive PROMOTION writer (auto + manual) is routed through
  `transactHiveStore`, which holds the directory lock across read → normalize →
  caller mutation → validate-before-commit → cap → staged audit/reject appends
  → atomic persist (temp + rename). Lock `stale` matches every other hive
  writer (5s) so a concurrent writer can never force-break this transaction
  mid-flight. (Counter-bump and escalation writers in `knowledge-application.ts`
  / `knowledge-escalator.ts` remain on `transactKnowledge`, which targets the
  SAME directory with the SAME stale — so all hive writers are mutually
  exclusive at the cross-process level; the lost-update bug was specific to the
  promoter's old multi-step read→append→rewrite→cap sequence, which is now
  atomic.)
- **Canonical cohort identity**: cross-project confirmations key on the
  canonical `cohort_id` from `resolveCohortId` (#1846, PR #1851). Sibling
  worktrees and SSH/HTTPS aliases of one repository now count as one project.
  Legacy `confirmed_by` records (no `cohort_id`) are not retroactively re-
  counted (no broad rewrite), consistent with the no-synthetic-credit non-goal.
- **Lineage**: promoted hive entries carry a `lineage` block (source entry id,
  source cohort id, source content revision, prior confidence/phases snapshot,
  promotion event id, actor). Near-duplicate promotions record the losing
  source entry id in `lineage.merged_from` so provenance is preserved rather
  than silently discarded; conflicting lessons are never auto-collapsed.
- **One policy evaluator + override**: `evaluatePromotionPolicy` is used by
  automatic promotion and the manual `/swarm promote` command. A policy failure
  blocks promotion unless `--force --reason "<why>"` is supplied, which records
  a durable, audited override (`lineage.actor = 'manual-override'` + failed
  gates). An exact entry id alone is never authorization to bypass policy.
- **Conservative application evidence**: the `validated_terminal_applications`
  gate counts only validated terminal receipts tied to a real retrieval trace +
  result membership. Legacy records get no synthetic credit; thresholds default
  to 0 (no behavior regression) until #1849 produces real receipts.
- **Centralized hive path resolution** (`src/knowledge/hive-paths.ts`): the
  duplicated platform branch across `knowledge-store.ts` and
  `knowledge-events.ts` is now one module.
- **Diagnostics** (`/swarm diagnose`) surfaces lineage presence and any
  manual-override promotions (with failed gates + reason) for AC9 visibility.

### Migration
Mixed old/new hive schemas normalize idempotently in-memory inside the
transaction; no disk rewrite occurs on a no-op. A validation failure leaves the
prior hive file intact (atomic write not performed). No migration or hive I/O
runs on the synchronous plugin-init path.

### Dependencies
Builds on PR #1851 (issue #1846 canonical cohort identity). #1849 (real host
traces / terminal receipts) merges after this and reuses this PR's
`PromotionEvidenceRecord` schema + `evaluatePromotionPolicy` contract.
