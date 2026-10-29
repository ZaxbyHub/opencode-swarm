import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_internals,
	completeCoderSettlementCleanup,
	recoverCoderSettlement,
	recoverStaleCoderSettlements,
} from '../../../src/workflow/coder-settlement';
import {
	fixture,
	git,
	interrupted,
	readWal,
	removeLane,
	TASK,
	walPath,
} from '../../helpers/coder-settlement-3409';
import { freezeClock } from '../../helpers/test-clock';

const CLOCK_NOW = Date.parse('2026-10-25T12:00:00.000Z');
const roots: string[] = [];
beforeEach(() => {
	clearDeferredWarnings();
	_internals.historicalOrphanAdvisoryAt.clear();
});
afterEach(() => {
	_internals.liveDispatches.clear();
	_internals.historicalOrphanAdvisoryAt.clear();
	clearDeferredWarnings();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function orphanAdvisories(source: string): string[] {
	return getDeferredWarnings().filter(
		(warning) =>
			warning.includes('RECOVERABLE_ORPHAN_COMMIT') && warning.includes(source),
	);
}

/** Rewrites the interrupted settlement as a pre-upgrade false self-heal. */
function legacySelfHealedAbort(f: ReturnType<typeof fixture>) {
	const aborted = {
		...readWal(f),
		state: 'ABORTED',
		abortReason:
			'CODER_SETTLEMENT_SELF_HEALED_MISSING_WORKTREE: legacy false absence',
	};
	fs.writeFileSync(walPath(f), JSON.stringify(aborted));
	return aborted;
}

function backupRef(repo: string, source: string): string {
	return git(repo, ['rev-parse', `refs/swarm/coder-settlements/${source}`]);
}

describe('#3409 historical terminal recovery and source certainty', () => {
	for (const entry of ['direct', 'scan', 'terminal-cleanup'] as const) {
		test(`false self-heal preserves source through ${entry} without reviving generation`, async () => {
			const f = fixture(`historical-${entry}`);
			roots.push(f.root);
			const source = await interrupted(f);
			removeLane(f);
			const aborted = legacySelfHealedAbort(f);
			const before = getTaskWorkflowSnapshot(
				await readTaskEvidence(f.repo, TASK),
			);
			// The orphan report is advisory: no entry point rejects, so task status,
			// re-dispatch and close are never wedged by a terminal settlement.
			if (entry === 'terminal-cleanup') {
				await expect(
					completeCoderSettlementCleanup(f.repo, TASK, f.transitionId),
				).resolves.toBeUndefined();
			} else if (entry === 'direct') {
				await expect(recoverCoderSettlement(f.repo, TASK)).resolves.toBeNull();
			} else {
				const scan = await recoverStaleCoderSettlements(f.repo);
				expect(scan.results).toEqual([
					{ taskId: TASK, outcome: 'already_terminal', state: 'ABORTED' },
				]);
			}
			expect(orphanAdvisories(source)).toHaveLength(1);
			expect(orphanAdvisories(source)[0]).toContain(
				`refs/swarm/coder-settlements/${source}`,
			);
			expect(readWal(f)).toEqual(aborted);
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(f.repo, TASK)),
			).toEqual(before);
			expect(backupRef(f.repo, source)).toBe(source);
			expect(fs.readFileSync(path.join(f.repo, 'source.txt'), 'utf8')).toBe(
				'base\n',
			);
		});
	}
	test('repeated recovery of a historical orphan never blocks and keeps the backup', async () => {
		const f = fixture('historical-repeat');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = legacySelfHealedAbort(f);
		for (let call = 0; call < 3; call++) {
			await expect(recoverCoderSettlement(f.repo, TASK)).resolves.toBeNull();
			await expect(
				completeCoderSettlementCleanup(f.repo, TASK, f.transitionId),
			).resolves.toBeUndefined();
			expect(readWal(f)).toEqual(aborted);
			expect(backupRef(f.repo, source)).toBe(source);
		}
		// Cooldown: six non-blocking passes produce one advisory, not six.
		expect(orphanAdvisories(source)).toHaveLength(1);
		const [advisory] = orphanAdvisories(source);
		expect(advisory).toContain(`refs/swarm/coder-settlements/${source}`);
		expect(advisory).toContain('The settlement remains ABORTED');
		expect(advisory).toContain('not blocked');
		// An expired cooldown entry re-surfaces the report on the next pass.
		const restoreClock = freezeClock({ fixedNow: CLOCK_NOW });
		try {
			for (const key of _internals.historicalOrphanAdvisoryAt.keys())
				_internals.historicalOrphanAdvisoryAt.set(key, CLOCK_NOW - 11 * 60_000);
			await expect(recoverCoderSettlement(f.repo, TASK)).resolves.toBeNull();
		} finally {
			restoreClock();
		}
		expect(orphanAdvisories(source)).toHaveLength(2);
		expect(backupRef(f.repo, source)).toBe(source);
	});
	test('the advisory cooldown ledger stays bounded with FIFO eviction', async () => {
		const f = fixture('historical-bounded');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		legacySelfHealedAbort(f);
		const ledger = _internals.historicalOrphanAdvisoryAt;
		const restoreClock = freezeClock({ fixedNow: CLOCK_NOW });
		try {
			for (let index = 0; index < 256; index++)
				ledger.set(`dummy-${index}`, CLOCK_NOW);
			await expect(recoverCoderSettlement(f.repo, TASK)).resolves.toBeNull();
		} finally {
			restoreClock();
		}
		expect(ledger.size).toBe(256);
		expect(ledger.has('dummy-0')).toBe(false);
		expect(ledger.has('dummy-1')).toBe(true);
		expect([...ledger.keys()].at(-1)).toContain(source);
		expect(orphanAdvisories(source)).toHaveLength(1);
	});
	test('a historical source already landed by an ancestry merge releases its backup silently', async () => {
		const f = fixture('historical-landed');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = legacySelfHealedAbort(f);
		git(f.repo, ['merge', '-s', 'ours', '--no-edit', source]);
		git(f.repo, [
			'update-ref',
			`refs/swarm/coder-settlements/${source}`,
			source,
		]);
		await expect(recoverCoderSettlement(f.repo, TASK)).resolves.toBeNull();
		expect(readWal(f)).toEqual(aborted);
		expect(orphanAdvisories(source)).toEqual([]);
		expect(
			git(f.repo, [
				'for-each-ref',
				'--format=%(refname)',
				'refs/swarm/coder-settlements/',
			]),
		).toBe('');
	});
	test('ordinary explicit abort does not resurrect or pin historical source', async () => {
		const f = fixture('explicit-abort');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = {
			...readWal(f),
			state: 'ABORTED',
			abortReason: 'user cancelled dispatch',
		};
		fs.writeFileSync(walPath(f), JSON.stringify(aborted));
		expect(await recoverCoderSettlement(f.repo, TASK)).toBeNull();
		expect(readWal(f)).toEqual(aborted);
		expect(
			git(f.repo, [
				'for-each-ref',
				'--format=%(refname)',
				'refs/swarm/coder-settlements/',
			]),
		).toBe('');
		expect(git(f.repo, ['cat-file', '-t', source])).toBe('commit');
	});
	test('definitely absent source can terminalize a missing lane', async () => {
		const f = fixture('absent-source');
		roots.push(f.root);
		await interrupted(f);
		removeLane(f);
		const wal = readWal(f);
		if (!wal.mergeProvenance) throw new Error('fixture missing provenance');
		wal.mergeProvenance.sourceHead = 'f'.repeat(40);
		fs.writeFileSync(walPath(f), JSON.stringify(wal));
		_internals.liveDispatches.clear();
		expect(await recoverCoderSettlement(f.repo, TASK)).toBeNull();
		expect(readWal(f).state).toBe('ABORTED');
		expect(readWal(f).abortReason).toContain(
			'CODER_SETTLEMENT_SELF_HEALED_MISSING_WORKTREE',
		);
	});
	test('a corrupt source object remains pending rather than becoming absent', async () => {
		const f = fixture('corrupt-source');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const objectPath = path.join(
			f.repo,
			'.git',
			'objects',
			source.slice(0, 2),
			source.slice(2),
		);
		fs.chmodSync(objectPath, 0o600);
		fs.writeFileSync(objectPath, 'corrupt loose object');
		_internals.liveDispatches.clear();
		await expect(recoverCoderSettlement(f.repo, TASK)).rejects.toThrow(
			'CODER_SETTLEMENT_SOURCE_UNCERTAIN',
		);
		expect(readWal(f).state).toBe('DISPATCHED');
		expect(readWal(f).abortReason).toBeUndefined();
	});
});

function listBackupRefs(repo: string): string {
	return git(repo, [
		'for-each-ref',
		'--format=%(refname)',
		'refs/swarm/coder-settlements/',
	]);
}

function corruptLooseObject(repo: string, oid: string): void {
	const objectPath = path.join(
		repo,
		'.git',
		'objects',
		oid.slice(0, 2),
		oid.slice(2),
	);
	fs.chmodSync(objectPath, 0o600);
	fs.writeFileSync(objectPath, 'corrupt loose object');
}

// The orphan itself is advisory, but REAL failures on the ABORTED route must
// still propagate (preserveHistoricalSelfHealedSource contract): work that
// cannot be proven safe is never silently dropped.
describe('#3409 historical ABORTED route still rejects real failures', () => {
	test('an occupied backup ref rejects with the occupied-ref error and leaves the ABORTED WAL and ref untouched', async () => {
		const f = fixture('abort-occupied-direct');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = legacySelfHealedAbort(f);
		const ref = `refs/swarm/coder-settlements/${source}`;
		const foreign = git(f.repo, ['rev-parse', 'main']);
		expect(foreign).not.toBe(source);
		git(f.repo, ['update-ref', ref, foreign]);
		await expect(recoverCoderSettlement(f.repo, TASK)).rejects.toThrow(
			`RECOVERABLE_ORPHAN_COMMIT: ${source}; occupied ref ${ref}`,
		);
		expect(readWal(f)).toEqual(aborted);
		expect(readWal(f).state).toBe('ABORTED');
		// The occupant is never overwritten and no advisory pretends success.
		expect(git(f.repo, ['rev-parse', ref])).toBe(foreign);
		expect(orphanAdvisories(source)).toEqual([]);
		expect(_internals.historicalOrphanAdvisoryAt.size).toBe(0);
	});
	test('an occupied backup ref rejects terminal cleanup instead of reporting a clean no-op', async () => {
		const f = fixture('abort-occupied-cleanup');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = legacySelfHealedAbort(f);
		const ref = `refs/swarm/coder-settlements/${source}`;
		const foreign = git(f.repo, ['rev-parse', 'main']);
		git(f.repo, ['update-ref', ref, foreign]);
		await expect(
			completeCoderSettlementCleanup(f.repo, TASK, f.transitionId),
		).rejects.toThrow(
			`RECOVERABLE_ORPHAN_COMMIT: ${source}; occupied ref ${ref}`,
		);
		expect(readWal(f)).toEqual(aborted);
		expect(git(f.repo, ['rev-parse', ref])).toBe(foreign);
		expect(orphanAdvisories(source)).toEqual([]);
	});
	test('an occupied backup ref surfaces as an error outcome in the stale-settlement scan', async () => {
		const f = fixture('abort-occupied-scan');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = legacySelfHealedAbort(f);
		const ref = `refs/swarm/coder-settlements/${source}`;
		git(f.repo, ['update-ref', ref, git(f.repo, ['rev-parse', 'main'])]);
		const scan = await recoverStaleCoderSettlements(f.repo);
		expect(scan.results).toEqual([
			{
				taskId: TASK,
				outcome: 'error',
				message: expect.stringContaining(
					`RECOVERABLE_ORPHAN_COMMIT: ${source}; occupied ref ${ref}`,
				),
			},
		]);
		expect(readWal(f)).toEqual(aborted);
	});
	test('a symbolic backup ref is uncertain and rejects with CODER_SETTLEMENT_REF_UNCERTAIN', async () => {
		const f = fixture('abort-symbolic-ref');
		roots.push(f.root);
		const source = await interrupted(f);
		removeLane(f);
		const aborted = legacySelfHealedAbort(f);
		const ref = `refs/swarm/coder-settlements/${source}`;
		git(f.repo, ['symbolic-ref', ref, 'refs/heads/main']);
		await expect(recoverCoderSettlement(f.repo, TASK)).rejects.toThrow(
			`CODER_SETTLEMENT_REF_UNCERTAIN: symbolic or unreadable ref ${ref}`,
		);
		expect(readWal(f)).toEqual(aborted);
		// The symbolic ref is left exactly as found, never dereferenced or replaced.
		expect(git(f.repo, ['symbolic-ref', ref])).toBe('refs/heads/main');
		expect(orphanAdvisories(source)).toEqual([]);
	});
	for (const entry of ['direct', 'terminal-cleanup'] as const) {
		test(`a corrupt source object on the ABORTED route rejects with CODER_SETTLEMENT_SOURCE_UNCERTAIN via ${entry}`, async () => {
			const f = fixture(`abort-corrupt-${entry}`);
			roots.push(f.root);
			const source = await interrupted(f);
			removeLane(f);
			const aborted = legacySelfHealedAbort(f);
			corruptLooseObject(f.repo, source);
			const attempt =
				entry === 'direct'
					? recoverCoderSettlement(f.repo, TASK)
					: completeCoderSettlementCleanup(f.repo, TASK, f.transitionId);
			await expect(attempt).rejects.toThrow(
				`CODER_SETTLEMENT_SOURCE_UNCERTAIN: ${source}`,
			);
			// An unreadable source is not "absent": the WAL stays ABORTED, no backup
			// ref is minted for an object that cannot be verified, and nothing is
			// reported as a recoverable orphan.
			expect(readWal(f)).toEqual(aborted);
			expect(listBackupRefs(f.repo)).toBe('');
			expect(orphanAdvisories(source)).toEqual([]);
		});
	}
});
