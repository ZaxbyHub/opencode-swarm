/**
 * Combined-origin (P1) coverage extracted from
 * snapshot-coordination-recovery-hardening.test.ts (FR-006 line-cap split —
 * the parent file grew past 500 lines when the PRR-012 feedback coverage
 * landed). These tests pin the COMBINED closing-origin shape
 * (pendingPriorAttempt AND closingReason='reset-cleanup-failed') on every
 * producer surface: the writer advisory, the command strand-time advisory,
 * and the status render (the latter lives in the parent file's F2 test).
 *
 * Origin model (see the approved plan for issue #2963): every closing entry
 * carries an explicit origin; the combined shape is the highest-precedence
 * contract and names BOTH the settle-wait and the reset re-run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	handleResetSessionCommand,
} from '../../../src/commands/reset-session';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_snapshotCoordinationInternals,
	beginSnapshotCoordinationReset,
	getSnapshotCoordinationStatus,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import { writeSnapshotRows } from '../../../src/session/snapshot-store.js';
import { writeSnapshot } from '../../../src/session/snapshot-writer.js';
import { resetSwarmState, swarmState } from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let testDir: string;

function seedRows(dir: string): void {
	writeSnapshotRows(dir, {
		version: 3,
		writtenAt: 1,
		toolAggregates: {},
		activeAgent: {},
		delegationChains: {},
		agentSessions: {},
	});
}

beforeEach(() => {
	resetSwarmState();
	testDir = canonicalMkdtemp('coord-recovery-combined-');
	mkdirSync(path.join(testDir, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	closeProjectDb(testDir);
	safeRmRecursive(testDir);
	clearDeferredWarnings();
	_snapshotCoordinationInternals.entries.clear();
});

describe('#2963 combined-origin (P1) coverage', () => {
	test('combined P1 writer advisory fires once and names both the settle-wait and the re-run', async () => {
		// PRR-012 (#3445 review): the combined shape (pendingPriorAttempt AND
		// stranded) previously had no coverage on the writer surface.
		seedRows(testDir);
		let releaseOriginal!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseOriginal = resolve;
		});
		const originalInternals = {
			timeoutMs: _snapshotCoordinationInternals.timeoutMs,
			initialize: _snapshotCoordinationInternals.initialize,
		};
		let underlying!: Promise<'succeeded'>;
		let guard!: Awaited<ReturnType<typeof beginSnapshotCoordinationReset>>;
		// Seam overrides inside the try whose finally restores them (PRR-014).
		try {
			_snapshotCoordinationInternals.timeoutMs = 5;
			_snapshotCoordinationInternals.initialize = () =>
				blocked.then(() => 'succeeded' as const);
			underlying = startSnapshotCoordinationInitialization(testDir);
			await new Promise((resolve) => setTimeout(resolve, 20));
			guard = await beginSnapshotCoordinationReset(testDir);
			expect(guard.markStranded()).toBe(true);
			clearDeferredWarnings();
			await writeSnapshot(testDir, swarmState);
			const combined = getDeferredWarnings().filter((w) =>
				/still settling/.test(w),
			);
			expect(combined).toHaveLength(1);
			expect(combined[0]).toMatch(/partially failed/);
			expect(combined[0]).toMatch(/wait for that attempt to settle/);
			expect(combined[0]).toMatch(/re-run \/swarm reset-session/);
			// Bounded: a second failed write does not re-announce.
			await writeSnapshot(testDir, swarmState);
			expect(
				getDeferredWarnings().filter((w) => /still settling/.test(w)),
			).toHaveLength(1);
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalInternals.timeoutMs;
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
			if (guard) guard.release();
			releaseOriginal();
			await underlying.catch(() => undefined);
		}
	});

	test('combined P1 strand-time advisory via the real command names settle-wait and re-run exactly once', async () => {
		// PRR-012: a command-driven strand while a prior initializer is still
		// settling — the re-entered guard inherits pending, the cleanup fails,
		// and the command's advisePersistenceStop selects the combined wording.
		seedRows(testDir);
		let releaseOriginal!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseOriginal = resolve;
		});
		const originalInternals = {
			timeoutMs: _snapshotCoordinationInternals.timeoutMs,
			initialize: _snapshotCoordinationInternals.initialize,
		};
		let underlying!: Promise<'succeeded'>;
		try {
			_snapshotCoordinationInternals.timeoutMs = 5;
			_snapshotCoordinationInternals.initialize = () =>
				blocked.then(() => 'succeeded' as const);
			underlying = startSnapshotCoordinationInitialization(testDir);
			await new Promise((resolve) => setTimeout(resolve, 20));
			// First reset aborts on the close timeout (priorUnsettled) and
			// leaves a closing+pending guard installed.
			const aborted = await handleResetSessionCommand(testDir, []);
			expect(aborted).toContain('Snapshot coordination close timed out');
			// Second reset re-enters (inherits pending), fails cleanup, and
			// strands its own guard: the combined strand-time advisory.
			const originalClear = _internals.clearSnapshotRows;
			_internals.clearSnapshotRows = () => {
				throw new Error('simulated SQLITE_BUSY');
			};
			clearDeferredWarnings();
			try {
				const result = await handleResetSessionCommand(testDir, []);
				expect(result).toContain('Failed to clear SQLite session snapshot');
			} finally {
				_internals.clearSnapshotRows = originalClear;
			}
			const combined = getDeferredWarnings().filter((w) =>
				/still settling/.test(w),
			);
			expect(combined).toHaveLength(1);
			expect(combined[0]).toMatch(/partially failed while a prior/);
			expect(combined[0]).toMatch(/re-run \/swarm reset-session/);
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalInternals.timeoutMs;
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
			releaseOriginal();
			await underlying.catch(() => undefined);
		}
	});
});
