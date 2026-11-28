/**
 * Directory-valued declared scope in background coder completion attribution
 * (src/background/stage-b-gates.ts, non-receipts branch).
 *
 * Regression pin for the task-1.13 background settlement wedge: an architect
 * may `declare_scope` with a DIRECTORY (files: ["context"]); the coder
 * write-scope guard treats that as covering everything beneath it, but the
 * completion-attribution filter matched declared entries by exact path only —
 * every file the coder changed fell out of `attributedFiles`, the completion
 * settled as `dispatch_no_mutation` despite real mutations, and the task
 * wedged at Stage A forever (no accepted mutation → stage_a_passed refused →
 * TASK_WORKFLOW_STAGE_A_REQUIRED on every Stage B dispatch).
 *
 * The non-receipts ingestion branch (the deployed configuration for the
 * affected project) must attribute files CONTAINED in a directory-valued
 * declared scope and record `accepted_mutation`, with the attributed SET
 * asserted exactly (PR 3918 review F-004). The receipts-enabled handoff
 * regressions (F-001/F-002/F-003/F-005) live in
 * stage-b-directory-scope-receipts.test.ts; shared fixtures live in
 * stage-b-directory-scope-fixtures.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { getModifiedFilesForTask } from '../../../src/state';
import {
	createDirectoryScopeFixture,
	type DirectoryScopeFixture,
} from './stage-b-directory-scope-fixtures';

let fixture: DirectoryScopeFixture;

beforeEach(() => {
	fixture = createDirectoryScopeFixture();
});

afterEach(() => {
	fixture.teardown();
});

describe('directory-valued declared scope attribution', () => {
	test('files under a directory scope are attributed and settle as accepted_mutation', async () => {
		const { directory, terminalResult, baseline, coderRecord, parentSession } =
			fixture;
		// The exact task-1.13 shape: declaredFiles is the directory "context",
		// the coder modified two files beneath it, and a sibling outside the
		// scope changed concurrently (must stay unattributed).
		const snapshot = baseline(['context/entry-a.md', 'context/entry-b.md']);
		const record = coderRecord({
			taskId: '1.13',
			callID: 'coder-dir-scope',
			baseline: snapshot,
			declaredFiles: ['context'],
		});
		fixture.writeFile('context/entry-a.md', 'entry a v2\n');
		fixture.writeFile('context/entry-b.md', 'entry b v2\n');
		fixture.writeFile('outside/x.ts', 'export const x = 2;\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.13'),
		);
		expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
		expect(snapshotAfter.lastTransitionId).toBe(
			'background-coder:child-coder-dir-scope',
		);
		// F-004: the attributed set is EXACTLY the in-scope dirty files — the
		// out-of-scope sibling (outside/x.ts) must not receive mutation credit.
		expect(
			[...getModifiedFilesForTask(parentSession(), '1.13')].sort(),
		).toEqual(['context/entry-a.md', 'context/entry-b.md']);
	});

	test('an exact-file declared scope still does not attribute sibling files', async () => {
		const { directory, terminalResult, baseline, coderRecord, parentSession } =
			fixture;
		// The directory-prefix match must not loosen exact-file scopes: a
		// declared FILE entry has no children, so nothing else matches it.
		const snapshot = baseline(['src/a.ts', 'src/b.ts']);
		const record = coderRecord({
			taskId: '1.14',
			callID: 'coder-exact-scope',
			baseline: snapshot,
			declaredFiles: ['src/a.ts'],
		});
		fixture.writeFile('src/a.ts', 'export const a = 2;\n');
		fixture.writeFile('src/b.ts', 'export const b = 2;\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.14'),
		);
		// F-004: src/a.ts is attributed (a real mutation) while the dirty
		// sibling src/b.ts must stay OUT of the attributed set — previously
		// only the workflow outcome was asserted, so attributing b.ts too
		// would have passed.
		expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
		expect(getModifiedFilesForTask(parentSession(), '1.14')).toEqual([
			'src/a.ts',
		]);
	});

	test('a coder with zero in-scope changes still settles as dispatch_no_mutation', async () => {
		const { directory, terminalResult, baseline, coderRecord } = fixture;
		const snapshot = baseline(['src/a.ts']);
		const record = coderRecord({
			taskId: '1.15',
			callID: 'coder-no-change',
			baseline: snapshot,
			declaredFiles: ['context'],
		});
		// Only an out-of-scope file changed: nothing to attribute.
		fixture.writeFile('src/a.ts', 'export const a = 2;\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.15'),
		);
		expect(snapshotAfter.lastOutcome).toBe('dispatch_no_mutation');
	});
});

describe('declared-scope casing — regression: win32 case-fold mismatch stranded permitted writes (F-003)', () => {
	test('a declared directory covers Git-reported descendants regardless of casing on win32', async () => {
		const { directory, terminalResult, baseline, coderRecord, parentSession } =
			fixture;
		// Previous code compared declared entries and observed files
		// case-sensitively while the write gate (isPathWithinDeclaredScope)
		// case-folds on win32: a declared "Context" let the coder write
		// "context/entry-a.md" (declare-scope.ts retains the authored
		// spelling), but attribution could not match the permitted write, so
		// the completion settled as dispatch_no_mutation and the task wedged
		// at Stage A on Windows.
		const snapshot = baseline(['context/entry-a.md']);
		const record = coderRecord({
			taskId: '1.21',
			callID: 'coder-case-fold',
			baseline: snapshot,
			declaredFiles: ['Context'],
		});
		fixture.writeFile('context/entry-a.md', 'entry a v2\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.21'),
		);
		if (process.platform === 'win32') {
			expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
			expect(getModifiedFilesForTask(parentSession(), '1.21')).toEqual([
				'context/entry-a.md',
			]);
		} else {
			// Case-sensitive platforms keep case-distinct paths distinct:
			// "Context" does not cover "context/entry-a.md" there.
			expect(snapshotAfter.lastOutcome).toBe('dispatch_no_mutation');
			expect(getModifiedFilesForTask(parentSession(), '1.21')).toEqual([]);
		}
	});
});
