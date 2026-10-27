/**
 * #2963 hardening tests for the closing-origin recovery contract (plan D7;
 * NOT part of the frozen acceptance spec — the frozen contract lives in
 * snapshot-coordination-recovery-contract.test.ts, and the combined-origin
 * (P1) coverage lives in snapshot-coordination-recovery-combined-origin
 * .test.ts). These pin the scenarios the plan critic demanded across five
 * review rounds: guard ownership, settlement lifecycle, F2/F3/F4 origins,
 * and the bounded writer advisory. Consumers never infer "stranded" from
 * `settled` alone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover';
import {
	_internals,
	handleResetSessionCommand,
} from '../../../src/commands/reset-session';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	formatStatusMarkdown,
	type StatusData,
} from '../../../src/services/status-service.js';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_snapshotCoordinationInternals,
	beginSnapshotCoordinationReset,
	getSnapshotCoordinationStatus,
	markSnapshotCoordinationClosing,
	retrySnapshotCoordinationInitialization,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import { writeSnapshotRows } from '../../../src/session/snapshot-store.js';
import {
	SNAPSHOT_PROJECTION_FILE,
	writeSnapshot,
} from '../../../src/session/snapshot-writer.js';
import { resetSwarmState, swarmState } from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let testDir: string;

// PRR-013 (#3445 review): conjunctive filter — an advisory counts as a stop
// advisory only when it names reset-session AND the persistence/snapshot
// topic AND a stop verb, so unrelated 'snapshot'-mentioning advisories
// (e.g. the projection-write warning) cannot satisfy an exact count.
const NAMES_RESET_SESSION_RE = /reset-session/;
const STOP_TOPIC_RE = /persistence|snapshot/i;
const STOP_VERB_RE = /stop/i;

function stopAdvisoryCount(): number {
	return getDeferredWarnings().filter(
		(w) =>
			NAMES_RESET_SESSION_RE.test(w) &&
			STOP_TOPIC_RE.test(w) &&
			STOP_VERB_RE.test(w),
	).length;
}

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

/** Strand the closing guard via the real command + clearSnapshotRows seam. */
async function strandViaCommand(dir: string): Promise<string> {
	seedRows(dir);
	const originalClear = _internals.clearSnapshotRows;
	_internals.clearSnapshotRows = () => {
		throw new Error('simulated SQLite failure');
	};
	try {
		return await handleResetSessionCommand(dir, []);
	} finally {
		_internals.clearSnapshotRows = originalClear;
	}
}

function baseStatus(): StatusData {
	return {
		hasPlan: true,
		currentPhase: 'Phase 1',
		completedTasks: 0,
		totalTasks: 1,
		agentCount: 1,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		compactionCount: 0,
		lastSnapshotAt: null,
	};
}

beforeEach(() => {
	resetSwarmState();
	testDir = canonicalMkdtemp('coord-recovery-hardening-');
	mkdirSync(path.join(testDir, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	closeProjectDb(testDir);
	// PRR-014 (#3445 review / Copilot): the repo's bounded teardown helper
	// (EBUSY/EPERM retry + tmpdir containment) instead of a swallowed
	// rmSync — this suite opens SQLite coordination DBs, exactly the
	// Windows locking family that leaks temp dirs.
	safeRmRecursive(testDir);
	clearDeferredWarnings();
	_snapshotCoordinationInternals.entries.clear();
});

describe('#2963 closing-origin hardening', () => {
	test('closeError guard whose cleanup succeeds is released with no advisory and no stranded marking', async () => {
		seedRows(testDir);
		let released = 0;
		let strandedMarks = 0;
		const originalBegin = _internals.beginSnapshotCoordinationReset;
		_internals.beginSnapshotCoordinationReset = async () => ({
			release: () => {
				released += 1;
			},
			markStranded: () => {
				strandedMarks += 1;
				return true;
			},
			closeError: new Error('coordination close failed'),
		});
		try {
			clearDeferredWarnings();
			const result = await handleResetSessionCommand(testDir, []);
			expect(result).toContain('Snapshot coordination close failed');
			expect(result).toContain('authoritative session snapshot row');
			expect(released).toBe(1);
			expect(strandedMarks).toBe(0);
			expect(stopAdvisoryCount()).toBe(0);
		} finally {
			_internals.beginSnapshotCoordinationReset = originalBegin;
		}
	});

	test('older reset cannot strand a newer guard: markStranded returns false and no advisory fires', async () => {
		const realBegin = _internals.beginSnapshotCoordinationReset;
		const originalBegin = _internals.beginSnapshotCoordinationReset;
		// The command's begin installs guard A, then a concurrent reset
		// installs guard B on top of it before A's cleanup runs.
		_internals.beginSnapshotCoordinationReset = async (dir: string) => {
			const guardA = await realBegin(dir);
			await realBegin(dir);
			return guardA;
		};
		try {
			clearDeferredWarnings();
			const result = await strandViaCommand(testDir);
			expect(result).toContain('Failed to clear SQLite session snapshot');
			// A's marking is an identity no-op (B is live); emission is gated
			// on the boolean, so no persistence-stop advisory may fire for
			// B's window, and B carries no stranded origin.
			expect(stopAdvisoryCount()).toBe(0);
			const status = getSnapshotCoordinationStatus(testDir);
			expect(status.state).toBe('closing');
			expect(status.closingReason).toBeUndefined();
		} finally {
			_internals.beginSnapshotCoordinationReset = originalBegin;
		}
	});

	test('multi-failure reset (SQLite + projection + state.json all failing) emits exactly one advisory', async () => {
		seedRows(testDir);
		const projectionPath = path.join(
			testDir,
			'.swarm',
			SNAPSHOT_PROJECTION_FILE,
		);
		const statePath = path.join(testDir, '.swarm', 'session', 'state.json');
		// Directories at the file paths make the real unlinkSync steps fail
		// (EPERM/EISDIR) — no DI seam exists for those steps by design.
		mkdirSync(projectionPath);
		mkdirSync(statePath);
		const originalClear = _internals.clearSnapshotRows;
		_internals.clearSnapshotRows = () => {
			throw new Error('simulated SQLITE_BUSY');
		};
		try {
			clearDeferredWarnings();
			const result = await handleResetSessionCommand(testDir, []);
			expect(result).toContain('Failed to clear SQLite session snapshot');
			expect(result).toContain(`Failed to delete ${SNAPSHOT_PROJECTION_FILE}`);
			expect(result).toContain('Failed to delete state.json');
			expect(stopAdvisoryCount()).toBe(1);
			const status = getSnapshotCoordinationStatus(testDir);
			expect(status.state).toBe('closing');
			expect(status.closingReason).toBe('reset-cleanup-failed');
		} finally {
			_internals.clearSnapshotRows = originalClear;
		}
	});

	test('concurrent writeSnapshot calls during a strand emit exactly one writer advisory', async () => {
		await strandViaCommand(testDir);
		clearDeferredWarnings();
		await Promise.all([
			writeSnapshot(testDir, swarmState),
			writeSnapshot(testDir, swarmState),
		]);
		expect(stopAdvisoryCount()).toBe(1);
	});

	test('a second strand after recovery re-arms the writer advisory exactly once', async () => {
		await strandViaCommand(testDir);
		clearDeferredWarnings();
		const retry = await handleResetSessionCommand(testDir, []);
		expect(retry).toContain('authoritative session snapshot row');
		await writeSnapshot(testDir, swarmState);
		expect(
			existsSync(path.join(testDir, '.swarm', SNAPSHOT_PROJECTION_FILE)),
		).toBe(true);

		await strandViaCommand(testDir);
		clearDeferredWarnings();
		await writeSnapshot(testDir, swarmState);
		await writeSnapshot(testDir, swarmState);
		expect(stopAdvisoryCount()).toBe(1);
	});

	test('in-flight reset (F4): writer stays silent, status shows the in-progress line, retry names the running reset', async () => {
		seedRows(testDir);
		const guard = await beginSnapshotCoordinationReset(testDir);
		try {
			clearDeferredWarnings();
			await writeSnapshot(testDir, swarmState);
			expect(stopAdvisoryCount()).toBe(0);
			expect(() => retrySnapshotCoordinationInitialization(testDir)).toThrow(
				/in-flight \/swarm reset-session/,
			);
			const output = await handleRecoverCommand(testDir, ['--coordination']);
			expect(output).toContain('is in progress');
			expect(output).not.toContain('partially-failed');
			const status = getSnapshotCoordinationStatus(testDir);
			expect(status.closingReason).toBeUndefined();
			const md = formatStatusMarkdown({
				...baseStatus(),
				coordination: status,
			});
			expect(md).toContain('is in progress');
			expect(md).not.toContain('re-run `/swarm reset-session`');
		} finally {
			guard.release();
		}
	});

	test('F2 priorUnsettled keeps the settle-wait contract; re-entry inherits pending; settlement flips to the stranded contract', async () => {
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
		let guardA!: Awaited<ReturnType<typeof beginSnapshotCoordinationReset>>;
		// PRR-014 (#3445 review): the seam overrides are installed INSIDE the
		// try whose finally restores them — a throw in the setup region must
		// not leak a 5ms coordination timeout to later suites.
		try {
			_snapshotCoordinationInternals.timeoutMs = 5;
			_snapshotCoordinationInternals.initialize = () =>
				blocked.then(() => 'succeeded' as const);
			underlying = startSnapshotCoordinationInitialization(testDir);
			await new Promise((resolve) => setTimeout(resolve, 20));
			guardA = await beginSnapshotCoordinationReset(testDir);
			// Direct F2: pending prior, settle-wait everywhere.
			let status = getSnapshotCoordinationStatus(testDir);
			expect(status.pendingPriorAttempt).toBe(true);
			expect(() => retrySnapshotCoordinationInitialization(testDir)).toThrow(
				/still settling/,
			);
			// PRR-013 companion: the P2 status branch must NOT claim the
			// combined "Once it settles" re-run line (that text is exclusive
			// to the combined pending+stranded shape).
			let recoverOut = await handleRecoverCommand(testDir, ['--coordination']);
			expect(recoverOut).toContain(
				'wait for that underlying attempt to settle',
			);
			expect(recoverOut).not.toContain('partially-failed');
			expect(recoverOut).not.toContain('Once it settles');
			let md = formatStatusMarkdown({
				...baseStatus(),
				coordination: status,
			});
			expect(md).toContain(
				'an unsettled timed-out attempt must finish before retry',
			);

			// Re-entry before the original settles: guard B inherits pending.
			const guardB = await beginSnapshotCoordinationReset(testDir);
			status = getSnapshotCoordinationStatus(testDir);
			expect(status.pendingPriorAttempt).toBe(true);
			// Stranding B creates the COMBINED shape (P1).
			expect(guardB.markStranded()).toBe(true);
			expect(() => retrySnapshotCoordinationInitialization(testDir)).toThrow(
				/still settling; guard stranded/,
			);
			recoverOut = await handleRecoverCommand(testDir, ['--coordination']);
			expect(recoverOut).toContain(
				'wait for that underlying attempt to settle',
			);
			expect(recoverOut).toContain('Once it settles');

			// PRR-012: the combined (P1) STATUS branch — the highest-precedence
			// origin — renders its own line while both markers are set. Re-read
			// the status AFTER markStranded (the pre-strand snapshot lacks the
			// closingReason marker).
			status = getSnapshotCoordinationStatus(testDir);
			md = formatStatusMarkdown({
				...baseStatus(),
				coordination: status,
			});
			expect(md).toContain(
				'wait for the settling initialization attempt, then re-run',
			);
			expect(md).not.toContain(
				'an unsettled timed-out attempt must finish before retry',
			);

			// The original settles: the live guard's pending flag clears in
			// place and the entry falls back to the stranded (P3) contract.
			releaseOriginal();
			await underlying;
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = getSnapshotCoordinationStatus(testDir);
			expect(status.pendingPriorAttempt).toBeUndefined();
			expect(status.closingReason).toBe('reset-cleanup-failed');
			expect(() => retrySnapshotCoordinationInitialization(testDir)).toThrow(
				/settled\): re-run \/swarm reset-session/,
			);
			md = formatStatusMarkdown({
				...baseStatus(),
				coordination: status,
			});
			expect(md).toContain('re-run `/swarm reset-session`');
			guardB.release();
			expect(getSnapshotCoordinationStatus(testDir).state).toBe('idle');
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalInternals.timeoutMs;
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
			if (guardA) guardA.release();
			releaseOriginal();
			await underlying.catch(() => undefined);
		}
	});

	test('F2 writer advisory says paused (not the stranded stop contract)', async () => {
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
		// PRR-014: seam overrides inside the try that restores them.
		try {
			_snapshotCoordinationInternals.timeoutMs = 5;
			_snapshotCoordinationInternals.initialize = () =>
				blocked.then(() => 'succeeded' as const);
			underlying = startSnapshotCoordinationInitialization(testDir);
			await new Promise((resolve) => setTimeout(resolve, 20));
			guard = await beginSnapshotCoordinationReset(testDir);
			clearDeferredWarnings();
			await writeSnapshot(testDir, swarmState);
			await writeSnapshot(testDir, swarmState);
			const paused = getDeferredWarnings().filter((w) => /paused/.test(w));
			expect(paused).toHaveLength(1);
			expect(paused[0]).toMatch(/reset-session/);
			expect(paused[0]).not.toMatch(/partially failed/);
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalInternals.timeoutMs;
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
			if (guard) guard.release();
			releaseOriginal();
			await underlying.catch(() => undefined);
		}
	});

	test('F3 shutdown-marked closing renders the restart contract, never a reset re-run claim', async () => {
		seedRows(testDir);
		const originalInternals = {
			initialize: _snapshotCoordinationInternals.initialize,
		};
		_snapshotCoordinationInternals.initialize = async () =>
			'succeeded' as const;
		try {
			await startSnapshotCoordinationInitialization(testDir);
		} finally {
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
		}
		markSnapshotCoordinationClosing(testDir);
		const status = getSnapshotCoordinationStatus(testDir);
		expect(status.state).toBe('closing');
		expect(status.closingReason).toBe('shutdown');
		const md = formatStatusMarkdown({
			...baseStatus(),
			coordination: status,
		});
		expect(md).toContain('host shutdown');
		expect(md).not.toContain('re-run `/swarm reset-session`');
		const recoverOut = await handleRecoverCommand(testDir, ['--coordination']);
		expect(recoverOut).toContain('restart the host');
		expect(recoverOut).not.toContain('re-run /swarm reset-session');
		clearDeferredWarnings();
		await writeSnapshot(testDir, swarmState);
		const shutdownAdvisories = getDeferredWarnings().filter((w) =>
			/host shutdown/.test(w),
		);
		expect(shutdownAdvisories).toHaveLength(1);
	});

	test('an ordinary (non-closing) writeSnapshot failure emits no closing advisory', async () => {
		seedRows(testDir);
		// A settled failed entry makes readiness fail with a non-closing
		// error: the writer catch must stay silent for that class.
		// (PRR-013: the previous version's `entries.get(testDir)` lookup was
		// vacuous — the map is keyed by canonicalProjectKey, not the raw
		// path, and ran before any write could create an entry.)
		const originalInternals = {
			initialize: _snapshotCoordinationInternals.initialize,
		};
		_snapshotCoordinationInternals.initialize = async () => {
			throw new Error('import corrupt');
		};
		try {
			clearDeferredWarnings();
			await writeSnapshot(testDir, swarmState);
			expect(stopAdvisoryCount()).toBe(0);
		} finally {
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
		}
	});

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
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalInternals.timeoutMs;
			_snapshotCoordinationInternals.initialize = originalInternals.initialize;
			if (guard) guard.release();
			releaseOriginal();
			await underlying.catch(() => undefined);
		}
	});

	test('stranded (P3) retry message names the reset re-run recovery', async () => {
		await strandViaCommand(testDir);
		expect(() => retrySnapshotCoordinationInitialization(testDir)).toThrow(
			/settled\): re-run \/swarm reset-session to completion, or restart the host/,
		);
	});
});
