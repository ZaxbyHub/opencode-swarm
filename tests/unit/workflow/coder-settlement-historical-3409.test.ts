import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
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

const roots: string[] = [];
afterEach(() => {
	_internals.liveDispatches.clear();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('#3409 historical terminal recovery and source certainty', () => {
	for (const entry of ['direct', 'scan', 'terminal-cleanup'] as const) {
		test(`false self-heal preserves source through ${entry} without reviving generation`, async () => {
			const f = fixture(`historical-${entry}`);
			roots.push(f.root);
			const source = await interrupted(f);
			removeLane(f);
			const aborted = {
				...readWal(f),
				state: 'ABORTED',
				abortReason:
					'CODER_SETTLEMENT_SELF_HEALED_MISSING_WORKTREE: legacy false absence',
			};
			fs.writeFileSync(walPath(f), JSON.stringify(aborted));
			const before = getTaskWorkflowSnapshot(
				await readTaskEvidence(f.repo, TASK),
			);
			if (entry === 'terminal-cleanup') {
				await expect(
					completeCoderSettlementCleanup(f.repo, TASK, f.transitionId),
				).rejects.toThrow('RECOVERABLE_ORPHAN_COMMIT');
			} else if (entry === 'direct') {
				await expect(recoverCoderSettlement(f.repo, TASK)).rejects.toThrow(
					`RECOVERABLE_ORPHAN_COMMIT`,
				);
			} else {
				const scan = await recoverStaleCoderSettlements(f.repo);
				expect(scan.results).toContainEqual(
					expect.objectContaining({
						taskId: TASK,
						outcome: 'error',
						message: expect.stringContaining(source),
					}),
				);
			}
			expect(readWal(f)).toEqual(aborted);
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(f.repo, TASK)),
			).toEqual(before);
			expect(
				git(f.repo, ['rev-parse', `refs/swarm/coder-settlements/${source}`]),
			).toBe(source);
			expect(fs.readFileSync(path.join(f.repo, 'source.txt'), 'utf8')).toBe(
				'base\n',
			);
		});
	}
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
		await expect(recoverCoderSettlement(f.repo, TASK)).rejects.toThrow();
		expect(readWal(f).state).toBe('DISPATCHED');
		expect(readWal(f).abortReason).toBeUndefined();
	});
});
