/**
 * Falsification probe: FB-001 / PR #1800
 *
 * Finding: When handleCloseCommand runs and the archive step fails
 * (EPERM/EACCES/EBUSY) for `spec-staleness.json` or `spec-snapshot.md`,
 * the file was preserved on disk because it was in ACTIVE_STATE_TO_CLEAN
 * but NOT in TERMINAL_STATE_FILES. Next session's enforceSpecDriftGate
 * would hard-block core write tools.
 *
 * Fix: spec-staleness.json and spec-snapshot.md were added to
 * TERMINAL_STATE_FILES at close.ts:372-382, so the unconditional
 * removal loop at close.ts:1524 removes them even when archiving failed.
 *
 * This probe exercises the archive-FAILURE path for both files and
 * asserts they are removed unconditionally.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type CloseStageContext, runCleanStage } from '../../../src/commands/close';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let dir: string;
let cleanupFn: () => void;

function swarmDir(): string {
	return path.join(dir, '.swarm');
}

function makeCtx(): CloseStageContext {
	return {
		directory: dir,
		swarmDir: swarmDir(),
		planData: { title: 'FB-001 Probe' },
		planExists: true,
		planAlreadyDone: true,
		config: {},
		projectName: 'FB-001 Probe',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [],
		inProgressPhases: [],
		curationSucceeded: false,
		curationResult: undefined,
		allLessons: [],
		explicitLessons: [],
		retroLessons: [],
		knowledgeSkillHint: '',
		skillReviewSummary: '',
		postMortemSummary: '',
		sessionReflection: undefined,
		hivePromoted: 0,
		sessionKnowledgeCreated: 0,
		fallbackKnowledgeCreated: 0,
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		// Simulate PARTIAL archive success: something was archived,
		// but spec-staleness.json and spec-snapshot.md failed.
		archivedActiveStateFiles: new Set<string>(['events.jsonl']),
		archivedActiveStateDirs: new Set<string>(),
		archiveFailureReasons: new Map<string, string>([
			['spec-staleness.json', 'EACCES'],
			['spec-snapshot.md', 'EBUSY'],
		]),
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	} as unknown as CloseStageContext;
}

describe('FB-001 falsification probe: spec-staleness.json and spec-snapshot.md', () => {
	beforeEach(() => {
		({ dir, cleanup: cleanupFn } = createSafeTestDir('fb001-probe-'));
		mkdirSync(swarmDir(), { recursive: true });
	});

	afterEach(() => {
		cleanupFn();
	});

	test(
		'FB-001: spec-staleness.json is removed even when archive fails with EACCES',
		async () => {
			const specStalenessPath = path.join(swarmDir(), 'spec-staleness.json');
			writeFileSync(specStalenessPath, '{"specHash":"abc","planHash":"def"}');

			const ctx = makeCtx();
			await runCleanStage(ctx);

			// The file must be GONE — this is the core of FB-001.
			// Before the fix: spec-staleness.json would be "Preserved" (not deleted)
			// because it was not in TERMINAL_STATE_FILES.
			// After the fix: it is in TERMINAL_STATE_FILES and the unconditional
			// removal loop (close.ts:1524) deletes it regardless of archive failure.
			expect(existsSync(specStalenessPath)).toBe(false);

			// Confirm we actually hit the archive-failure path (not silently skipped).
			const acccesWarning = ctx.warnings.find((w) =>
				w.includes('spec-staleness.json was not archived'),
			);
			expect(acccesWarning).toBeDefined();
			expect(acccesWarning).toContain('EACCES');
			expect(acccesWarning).toContain('resurrection'); // confirms it is the correct warning
		},
	);

	test(
		'FB-001: spec-snapshot.md is removed even when archive fails with EBUSY',
		async () => {
			const specSnapshotPath = path.join(swarmDir(), 'spec-snapshot.md');
			writeFileSync(specSnapshotPath, '# Snapshot\nSome spec content');

			const ctx = makeCtx();
			await runCleanStage(ctx);

			// The file must be GONE — same fix as spec-staleness.json.
			expect(existsSync(specSnapshotPath)).toBe(false);

			// Confirm we actually hit the archive-failure path.
			const busyWarning = ctx.warnings.find((w) =>
				w.includes('spec-snapshot.md was not archived'),
			);
			expect(busyWarning).toBeDefined();
			expect(busyWarning).toContain('EBUSY');
			expect(busyWarning).toContain('resurrection');
		},
	);

	test(
		'FB-001: NO "Preserved <spec file>" warning is emitted for spec-staleness.json or spec-snapshot.md',
		async () => {
			writeFileSync(
				path.join(swarmDir(), 'spec-staleness.json'),
				'{"specHash":"abc"}',
			);
			writeFileSync(path.join(swarmDir(), 'spec-snapshot.md'), '# Snapshot');

			const ctx = makeCtx();
			await runCleanStage(ctx);

			// The original bug emitted "Preserved spec-staleness.json because it was
			// not successfully archived: EACCES." — which was misleading because the
			// unconditional removal would delete it anyway.
			// The fix replaces this with the "was not archived; removing it anyway"
			// message, so no "Preserved" diagnostic should appear.
			const preservedWarnings = ctx.warnings.filter((w) =>
				/Preserved spec-(staleness|snapshot)/.test(w),
			);
			expect(preservedWarnings).toHaveLength(0);
		},
	);

	test(
		'FB-001: both spec files removed together in one close run',
		async () => {
			const specStalenessPath = path.join(swarmDir(), 'spec-staleness.json');
			const specSnapshotPath = path.join(swarmDir(), 'spec-snapshot.md');
			writeFileSync(specStalenessPath, '{"specHash":"abc"}');
			writeFileSync(specSnapshotPath, '# Snapshot');

			const ctx = makeCtx();
			await runCleanStage(ctx);

			// Both must be gone.
			expect(existsSync(specStalenessPath)).toBe(false);
			expect(existsSync(specSnapshotPath)).toBe(false);

			// Both warnings present.
			expect(ctx.warnings.some((w) => w.includes('spec-staleness.json'))).toBe(true);
			expect(ctx.warnings.some((w) => w.includes('spec-snapshot.md'))).toBe(true);
		},
	);
});
