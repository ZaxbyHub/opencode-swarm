/**
 * REGRESSION GUARD — issue #660 FR-004, finding F-05.
 *
 * Pins the fix that both Work-Complete-Council stores route their primary
 * writes through `atomicWriteFile` (temp-file + atomic rename) from
 * `src/evidence/task-file.ts`, instead of a raw `writeFileSync`.
 *
 * Prior buggy behavior (what the fix corrected): `criteria-store.writeCriteria`
 * and `council-evidence-writer.writeCouncilEvidence` wrote their JSON payloads
 * with a direct, non-atomic `writeFileSync`. A reader (e.g. council evaluation
 * reading criteria, or `check_gate_status` reading evidence) could observe a
 * torn/partial file mid-write, and a concurrent writer could clobber updates.
 * The fix switched both to `atomicWriteFile`, which writes to
 * `<target>.tmp.<n>` then `renameSync`s it over the target so readers only ever
 * see a complete file.
 *
 * How this guard works (and how it fails on revert):
 *   `atomicWriteFile` is the ONLY caller of `task-file._internals.renameSync`,
 *   and it reads that property at call time. So if — and only if — a store
 *   routes its write through `atomicWriteFile`, we observe a `renameSync` call
 *   whose destination is exactly the store's target file. We intercept the
 *   genuine `_internals.renameSync` DI seam (no `mock.module`, real I/O) and
 *   assert that exact destination was renamed.
 *
 *   Revert that breaks this guard: replacing `atomicWriteFile(target, json)`
 *   with `writeFileSync(target, json)` in either store. Then `renameSync` is
 *   never called for that target → the `some(... target === expected)`
 *   assertion fails.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	_internals as councilWriterInternals,
	writeCouncilEvidence,
} from '../../../src/council/council-evidence-writer';
import { writeCriteria } from '../../../src/council/criteria-store';
import type { CouncilSynthesis } from '../../../src/council/types';
import {
	taskEvidencePath,
	_internals as taskFileInternals,
} from '../../../src/evidence/task-file';

// The real renameSync, captured once at module load.
const realRenameSync = taskFileInternals.renameSync;
const realWithTaskEvidenceLock = councilWriterInternals.withTaskEvidenceLock;

let tempDir: string;
let renameCalls: Array<{ source: string; target: string }>;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'council-atomic-guard-'));
	renameCalls = [];
	// Record every renameSync that flows through atomicWriteFile, then call
	// through to the real implementation so the write actually completes.
	taskFileInternals.renameSync = ((source: unknown, target: unknown) => {
		renameCalls.push({ source: String(source), target: String(target) });
		return realRenameSync(source as string, target as string);
	}) as typeof taskFileInternals.renameSync;
});

afterEach(() => {
	taskFileInternals.renameSync = realRenameSync;
	councilWriterInternals.withTaskEvidenceLock = realWithTaskEvidenceLock;
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
});

describe('council stores — regression: primary writes are atomic (F-05)', () => {
	test('criteria-store.writeCriteria routes through atomicWriteFile (temp + rename)', async () => {
		// Before the fix, writeCriteria used a raw writeFileSync — no rename, so a
		// reader could observe a torn .swarm/council/<id>.json. The fix routes the
		// write through atomicWriteFile, which renames a temp file over the target.
		await writeCriteria(tempDir, '1.1', [
			{ id: 'C1', description: 'All tests pass', mandatory: true },
		]);

		// safeId('1.1') => '1_1' (dots become underscores for council filenames).
		const expectedTarget = path.join(tempDir, '.swarm', 'council', '1_1.json');

		const matching = renameCalls.find(
			(c) => path.resolve(c.target) === path.resolve(expectedTarget),
		);
		expect(matching).toBeDefined();
		// The atomic write renames a temp sentinel (…tmp.<ts>.<rand>) over the
		// target — proof it was NOT a direct in-place writeFileSync.
		expect(matching?.source).toContain('.tmp.');
	});

	test('council-evidence-writer.writeCouncilEvidence routes through atomicWriteFile (temp + rename)', async () => {
		// Before the fix, the council evidence write was non-atomic; a concurrent
		// gate writer reading-modifying-writing the same {taskId}.json could lose
		// updates or see a torn file (#978). The fix uses atomicWriteFile under the
		// shared evidence lock. We bypass the real lock via the writer's own
		// _internals seam so this test stays focused on the atomic-write routing.
		councilWriterInternals.withTaskEvidenceLock = (async (
			_directory: string,
			_taskId: string,
			_agent: string,
			fn: () => Promise<unknown>,
		) => fn()) as typeof councilWriterInternals.withTaskEvidenceLock;

		const synthesis: CouncilSynthesis = {
			taskId: '1.1',
			swarmId: 'test-swarm',
			timestamp: new Date().toISOString(),
			overallVerdict: 'APPROVE',
			vetoedBy: null,
			memberVerdicts: [],
			unresolvedConflicts: [],
			requiredFixes: [],
			advisoryFindings: [],
			unifiedFeedbackMd: '',
			roundNumber: 1,
			allCriteriaMet: true,
			quorumSize: 3,
			blockingConcernsCount: 0,
		};

		await writeCouncilEvidence(tempDir, synthesis);

		const expectedTarget = taskEvidencePath(tempDir, '1.1');
		const matching = renameCalls.find(
			(c) => path.resolve(c.target) === path.resolve(expectedTarget),
		);
		expect(matching).toBeDefined();
		expect(matching?.source).toContain('.tmp.');
	});
});
