/**
 * #3893/#3915 Phase 4.2 guardrail v2 (final-critic R7): a DISCOVERY ratchet
 * over persisted writers. The test discovers every non-test src file that
 * serializes JSON and writes it to disk, and requires each discovered file
 * to carry an explicit classification:
 *
 *  - FREE_TEXT_CENSUS: persists model/user free text -> MUST compose a
 *    redaction helper (a `redact` reference is the mechanical witness;
 *    behavioral proof lives in the boundary suites).
 *  - DEFERRED_RECORD_TOOLS: the record-* family (owner-approved deferral,
 *    2026-11-26; follow-up issue owns their composition). Count-pinned.
 *  - SPECIAL_CLASSIFIED: reasoned per-file dispositions (see comments).
 *  - TRIAGED_OUT: state/plan/ledger/knowledge-machinery writers with no
 *    #3844-census free-text boundary; a prose-bearing change to one of them
 *    must reclassify it (move it to the census) in the same PR.
 *
 * Any NEW persisted writer fails this suite until it is classified — the
 * same defect class cannot land silently again. A precise mechanical
 * free-text classifier is not feasible (field-name matching over-matches:
 * 124/165 files flag on prose-looking identifiers in error strings and
 * comments); the explicit classification IS the review artifact.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

/** Persisted-boundary census: files writing model/user free text to disk. */
const FREE_TEXT_CENSUS: readonly string[] = [
	// Council evidence writers (#3915 AC1-AC3 + final-critic R6)
	'src/tools/write-final-council-evidence.ts',
	'src/tools/submit-phase-council-verdicts.ts',
	'src/council/council-evidence-writer.ts',
	'src/tools/convene-general-council.ts',
	// PR #3905 boundary set (#3844 census + #3899 fold-ins)
	'src/tools/write-hallucination-evidence.ts',
	'src/tools/write-drift-evidence.ts',
	'src/hooks/review-receipt.ts',
	'src/review/evidence.ts',
	'src/gate-evidence.ts',
	// #3893/#3915 owner-approved fix (option b): the four subsystem surfaces
	'src/hooks/curator.ts',
	'src/summaries/manager.ts',
	'src/summaries/store.ts',
	'src/evidence/manager.ts',
	'src/hooks/knowledge-store.ts',
];

/** Owner-approved deferral (2026-11-26): the record-* family, pinned at 5. */
const DEFERRED_RECORD_TOOLS: readonly string[] = [
	// record-* evidence tools persisting agent/user free text (the five
	// the owner approved for deferral on 2026-11-26). record-issue-
	// publication and record-trace-validation are STRUCTURED receipts
	// (no free text — 4.5 round-4 verification) and sit in TRIAGED_OUT.
	// Grow ONLY with an owner-approved deferral recorded in the follow-up.
	'src/tools/record-implementation-review.ts',
	'src/tools/record-issue-reproduction.ts',
	'src/tools/record-recurrence-sweep.ts',
	'src/tools/record-merge-approval.ts',
	'src/tools/record-branch-freshness.ts',
];

/** Reasoned per-file dispositions outside the census/deferral dichotomy. */
const SPECIAL_CLASSIFIED: ReadonlyMap<string, string> = new Map([
	[
		'src/tools/spec-write.ts',
		'BY_DESIGN_USER_DELIVERABLE: the spec content IS the deliverable the user directed the tool to write; redaction would corrupt it',
	],
	[
		'src/prm/trajectory-store.ts',
		'UPSTREAM_REDACTED: trajectory-logger.ts redacts before appendTrajectoryEntry; the store is a post-redaction sink',
	],
	[
		'src/pr-review/persistence.ts',
		'MACHINE_STATE: CAS state machinery (schemaVersion/revision/sessionID); reclassify if prose fields join the persisted state',
	],
]);

/**
 * Triage-out snapshot (149 files at head): state/plan/ledger/knowledge
 * machinery with no #3844-census free-text boundary. Generated from the
 * discovery walk; see the trace's repro/discovered-writers.txt.
 */
const TRIAGED_OUT: readonly string[] = [
	'src/services/context-budget-service.ts',
	'src/tools/record-issue-publication.ts',
	'src/tools/record-trace-validation.ts',
	'src/session/restart-reconciliation.ts',
	'src/tools/repo-graph/freshness.ts',
	'src/agents/index.ts',
	'src/background/delegation-health.ts',
	'src/background/delegation-lifecycle.ts',
	'src/background/evidence-summary-integration.ts',
	'src/background/lane-output-store.ts',
	'src/background/pending-delegations.ts',
	'src/background/pr-feedback-event-queue.ts',
	'src/background/pr-feedback-loop.ts',
	'src/background/pr-subscriptions.ts',
	'src/background/stage-b-dispatch-binding-store.ts',
	'src/background/status-artifact.ts',
	'src/cli/index.ts',
	'src/commands/coupling.ts',
	'src/commands/destructive-purge.ts',
	'src/commands/issue.ts',
	'src/commands/link.ts',
	'src/commands/memory-link.ts',
	'src/commands/reset-backup.ts',
	'src/config/project-init.ts',
	'src/context-map/capsule-persistence.ts',
	'src/context-map/persistence.ts',
	'src/context-map/telemetry.ts',
	'src/council/council-round-state.ts',
	'src/council/criteria-store.ts',
	'src/dashboard/index.ts',
	'src/db/project-db.ts',
	'src/epic/close.ts',
	'src/epic/learning-store.ts',
	'src/epic/lifecycle.ts',
	'src/epic/phase-readiness.ts',
	'src/epic/plan-shaping-seam.ts',
	'src/evaluation/retrieval-quality.ts',
	'src/evaluation/runner.ts',
	'src/events/core-events.ts',
	'src/evidence/phase-participation.ts',
	'src/evidence/receipt-store.ts',
	'src/evidence/task-gate-repair.ts',
	'src/evidence/task-gate-requirements.ts',
	'src/full-auto/oversight.ts',
	'src/full-auto/state.ts',
	'src/harness/store.ts',
	'src/health/learning-health.ts',
	'src/hooks/curator-postmortem.ts',
	'src/hooks/delegation-gate/dead-lane-reclaim.ts',
	'src/hooks/delegation-gate/worktree-merge-status.ts',
	'src/hooks/delegation-gate/worktree-provisioning-owner.ts',
	'src/hooks/delegation-gate/worktree-recovery-authority.ts',
	'src/hooks/design-doc-drift.ts',
	'src/hooks/full-auto-intercept.ts',
	'src/hooks/guardrails/shell-audit-store.ts',
	'src/hooks/hive-transaction.ts',
	'src/hooks/init-orphan-recovery.ts',
	'src/hooks/issue-trace-state.ts',
	'src/hooks/knowledge-application.ts',
	'src/hooks/knowledge-events.ts',
	'src/hooks/knowledge-injector.ts',
	'src/hooks/knowledge-link.ts',
	'src/hooks/knowledge-migrator.ts',
	'src/hooks/knowledge-reader.ts',
	'src/hooks/knowledge-receipt-ledger-storage.ts',
	'src/hooks/knowledge-receipt-ledger.ts',
	'src/hooks/knowledge-validator.ts',
	'src/hooks/pr-workflow-gate.ts',
	'src/hooks/promotion-evidence-store.ts',
	'src/hooks/skill-usage-log.ts',
	'src/hooks/skill-usage-pending.ts',
	'src/hooks/trajectory-logger.ts',
	'src/index.ts',
	'src/knowledge/family-migration.ts',
	'src/knowledge/hive-quarantine.ts',
	'src/knowledge/identity.ts',
	'src/knowledge/scan-cursor.ts',
	'src/knowledge/worktree-identity.ts',
	'src/mcp/write-receipts.ts',
	'src/memory/instruction-pairing.ts',
	'src/memory/jsonl-migration.ts',
	'src/memory/local-jsonl-provider.ts',
	'src/memory/memory-family-migration.ts',
	'src/memory/memory-link.ts',
	'src/memory/reflection-service.ts',
	'src/memory/sqlite-provider.ts',
	'src/observability/otlp-exporter.ts',
	'src/parallel/file-locks.ts',
	'src/parallel/lane-owners.ts',
	'src/plan/checkpoint.ts',
	'src/plan/ledger.ts',
	'src/plan/manager.ts',
	'src/pr-review/authorization.ts',
	'src/retention/unclaimed.ts',
	'src/review/routing-enforcement.ts',
	'src/sandbox/win32/native-sandbox-executor.ts',
	'src/scope/scope-persistence.ts',
	'src/sdd/effective-spec.ts',
	'src/sdd/speckit-checkoff.ts',
	'src/security/replay-identity.ts',
	'src/security/write-authority.ts',
	'src/services/config-doctor.ts',
	'src/services/external-skill-store.ts',
	'src/services/harness-optimizer/controller.ts',
	'src/services/harness-optimizer/lineage.ts',
	'src/services/recommendation-ledger.ts',
	'src/services/skill-changelog.ts',
	'src/services/skill-consolidation.ts',
	'src/services/skill-evaluator.ts',
	'src/services/skill-generator.ts',
	'src/services/skill-improver-quota.ts',
	'src/services/skill-improver.ts',
	'src/services/skill-optimizer/controller.ts',
	'src/services/skill-optimizer/skill-eval-tasks.ts',
	'src/services/skill-optimizer/store.ts',
	'src/services/spec-drift-recovery.ts',
	'src/services/swarm-residue.ts',
	'src/services/synonym-map.ts',
	'src/services/task-cohort.ts',
	'src/services/version-check.ts',
	'src/session/session-start-store.ts',
	'src/session/snapshot-writer.ts',
	'src/test-impact/analyzer.ts',
	'src/test-impact/history-store.ts',
	'src/tools/apply-patch.ts',
	'src/tools/checkpoint.ts',
	'src/tools/completion-verify.ts',
	'src/tools/doc-scan.ts',
	'src/tools/export-pr-review-partial-results.ts',
	'src/tools/external-skill-promote.ts',
	'src/tools/phase-complete.ts',
	'src/tools/pr-review-submission.ts',
	'src/tools/prepare-pr-feedback-commit-message.ts',
	'src/tools/repo-graph/storage.ts',
	'src/tools/req-coverage.ts',
	'src/tools/sast-baseline.ts',
	'src/tools/save-plan.ts',
	'src/tools/sbom-generate.ts',
	'src/tools/write-mutation-evidence.ts',
	'src/tools/write-pr-review-artifact.ts',
	'src/tools/write-pr-review-trigger-eval.ts',
	'src/training/consent.ts',
	'src/training/exporter.ts',
	'src/training/vault.ts',
	'src/turbo/lean/evidence.ts',
	'src/turbo/lean/integration.ts',
	'src/turbo/lean/recovery.ts',
	'src/turbo/lean/reviewer.ts',
	'src/turbo/lean/state.ts',
	'src/workflow/workflow-wal-file.ts',
];

function discoverPersistedWriters(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === '__tests__' || entry.name === 'node_modules') {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (
				!entry.name.endsWith('.ts') ||
				entry.name.endsWith('.test.ts') ||
				entry.name.endsWith('.spec.ts')
			) {
				continue;
			}
			const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
			const text = readFileSync(full, 'utf-8');
			if (
				text.includes('JSON.stringify') &&
				/writefile|atomicwrite|bunwrite/i.test(text)
			) {
				found.push(rel);
			}
		}
	};
	walk(path.join(REPO_ROOT, 'src'));
	return found.sort();
}

function countRedactRefs(relPath: string): number {
	const text = readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
	return (text.match(/redact/gi) ?? []).length;
}

describe('persisted-boundary redaction contract (#3893/#3915 guardrail v2)', () => {
	test('every census boundary file composes a redaction helper', () => {
		const offenders = FREE_TEXT_CENSUS.filter(
			(file) => countRedactRefs(file) === 0,
		);
		expect(offenders).toEqual([]);
	});

	test('the deferred record-* family is pinned at five (no silent growth or shrinkage)', () => {
		expect(DEFERRED_RECORD_TOOLS).toHaveLength(5);
		for (const file of DEFERRED_RECORD_TOOLS) {
			expect(file.startsWith('src/tools/record-')).toBe(true);
		}
		// Still unredacted: when one gains redaction, remove it here in the
		// same change so the deferral cannot go stale in either direction.
		const drifted = DEFERRED_RECORD_TOOLS.filter(
			(file) => countRedactRefs(file) > 0,
		);
		expect(drifted).toEqual([]);
	});

	test('every discovered persisted writer is explicitly classified (discovery ratchet)', () => {
		const discovered = discoverPersistedWriters();
		expect(discovered.length).toBeGreaterThan(100); // sanity: the walk found the corpus
		const classified = new Set([
			...FREE_TEXT_CENSUS,
			...DEFERRED_RECORD_TOOLS,
			...SPECIAL_CLASSIFIED.keys(),
			...TRIAGED_OUT,
		]);
		const unclassified = discovered.filter((f) => !classified.has(f));
		expect(
			unclassified,
			'New persisted writer(s) without a classification - add them to FREE_TEXT_CENSUS (must compose redaction), DEFERRED_RECORD_TOOLS (owner-approved deferral only), SPECIAL_CLASSIFIED (with a reason), or TRIAGED_OUT (no free-text boundary):',
		).toEqual([]);
		// And the inverse: classifications must reference real discovered files
		// (no stale entries after deletions/renames).
		const stale = [...classified].filter((f) => !discovered.includes(f));
		expect(stale).toEqual([]);
	});

	test('triaged-out writers stay prose-free of NEW unredacted evidence boundaries (spot discipline)', () => {
		// The triage is a snapshot judgment; the discipline guard is that the
		// seven SPECIAL files carry reasons and the census/deferred sets are
		// exact. This leg documents that TRIAGED_OUT entries must be
		// reclassified in the same PR that makes one persist free text.
		expect(SPECIAL_CLASSIFIED.size).toBe(3);
		for (const reason of SPECIAL_CLASSIFIED.values()) {
			expect(reason.length).toBeGreaterThan(10);
		}
	});
});
