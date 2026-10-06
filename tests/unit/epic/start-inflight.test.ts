/**
 * `findInFlightCoderWork` (start refusal `in-flight-coders`, MINOR 2): every
 * project-wide source of coder work in flight, read-only, failing closed on
 * uncertain stores. Durable sources use a real temp project (real swarm.db
 * rows / WAL files / recovery records); in-memory and scan-only sources use
 * the start module's `_internals` seam.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionCoordinationState } from '../../../src/db/coordination-store';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	findDirtyBaseline,
	findInFlightCoderWork,
} from '../../../src/epic/start';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { createStartProject } from './start-fixture';

const realInternals = { ..._internals };
let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('epic-inflight-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_internals.countTrackedWorktreeDispatches = () => 0;
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('findInFlightCoderWork', () => {
	test('quiet project ⇒ nothing in flight (and nothing written)', async () => {
		const before = fs.readdirSync(path.join(dir, '.swarm'));
		expect(await findInFlightCoderWork(dir)).toEqual([]);
		expect(fs.readdirSync(path.join(dir, '.swarm'))).toEqual(before);
		expect(fs.existsSync(path.join(dir, '.swarm', 'swarm.db'))).toBe(false);
	});

	test('tracked worktree dispatches (in-memory)', async () => {
		_internals.countTrackedWorktreeDispatches = () => 3;
		expect(await findInFlightCoderWork(dir)).toEqual([
			'3 worktree-isolated coder dispatch(es) running or awaiting merge-back — let them finish (`/swarm lanes` shows them)',
		]);
	});

	test('non-terminal durable background delegations (terminal ones ignored)', async () => {
		for (const [key, status] of [
			['a', 'running'],
			['b', 'pending'],
			['c', 'completed'],
			['d', 'consumed'],
		] as const) {
			transitionCoordinationState(dir, {
				namespace: 'background.pending-delegation',
				entityKey: key,
				expectedRevision: null,
				generation: 1,
				status,
				payload: '{}',
			});
		}
		expect(await findInFlightCoderWork(dir)).toEqual([
			'2 non-terminal background delegation(s) — let them finish',
		]);
	});

	test('uncertain background store (no DB) fails closed', async () => {
		_internals.readDelegationsDetailed = (() => ({
			status: 'uncertain',
			reason: 'torn',
		})) as never;
		expect(await findInFlightCoderWork(dir)).toEqual([
			'background delegation state is uncertain — cannot prove no coder is running',
		]);
	});

	test('unsettled settlement WALs and a truncated scan', async () => {
		_internals.listCoderSettlementWalStates = (async () => ({
			states: [
				{
					taskId: '1.1',
					state: 'DISPATCHED',
					ownedInProcess: false,
					ownedByLiveForeignPid: false,
				},
				{
					taskId: '1.2',
					state: 'COMMITTED',
					ownedInProcess: false,
					ownedByLiveForeignPid: false,
				},
				{
					taskId: '1.3',
					state: 'unreadable',
					ownedInProcess: false,
					ownedByLiveForeignPid: false,
				},
				{
					taskId: '1.4',
					state: 'PREPARED',
					ownedInProcess: false,
					ownedByLiveForeignPid: true,
				},
				{
					taskId: '1.5',
					state: 'DISPATCHED',
					ownedInProcess: true,
					ownedByLiveForeignPid: false,
				},
			],
			truncated: true,
		})) as never;
		expect(await findInFlightCoderWork(dir)).toEqual([
			'2 coder settlement(s) still owned by a running dispatch: 1.4 (PREPARED), 1.5 (DISPATCHED) — let them finish',
			'2 stale or unreadable coder settlement(s): 1.1 (DISPATCHED), 1.3 (unreadable) — run `/swarm recover <taskId>` for each (it settles WALs whose owner process is gone)',
			'coder settlement directory exceeds the scan bound — cannot prove every settlement is final; run `/swarm recover` to settle stale WALs',
		]);
	});

	test('preserved Lean recovery lanes, recovery authorities, provisioning lanes', async () => {
		_internals.listRecoveryRecords = (() => [{}, {}]) as never;
		_internals.scanWorktreeRecoveryAuthoritiesForRecovery = (() => ({
			status: 'ok',
			authorities: [
				{ status: 'preserved' },
				{ status: 'claimed' },
				{ status: 'finalized' },
			],
		})) as never;
		_internals.scanWorktreeProvisioningOwnersForRecovery = (() => ({
			status: 'ok',
			owners: [{}],
		})) as never;
		expect(await findInFlightCoderWork(dir)).toEqual([
			'2 preserved Lean recovery lane(s) in .swarm/recovery/ — finish them with Lean Turbo (`/swarm turbo lean on`, then `/swarm turbo off`) or discard those lanes',
			'2 preserved/claimed worktree recovery lane(s) — inspect with `/swarm lanes`; merge or discard them (`/swarm reset-session` can purge dirty lanes)',
			'1 worktree lane(s) being provisioned — let the dispatch finish (`/swarm lanes`)',
		]);
	});

	test('unreadable recovery / uncertain worktree stores fail closed', async () => {
		_internals.recoveryReadErrored = () => true;
		_internals.scanWorktreeRecoveryAuthoritiesForRecovery = (() => ({
			status: 'uncertain',
			reason: 'x',
		})) as never;
		_internals.scanWorktreeProvisioningOwnersForRecovery = (() => ({
			status: 'uncertain',
			reason: 'unreadable dir',
		})) as never;
		expect(await findInFlightCoderWork(dir)).toEqual([
			'Lean recovery records in .swarm/recovery/ are unreadable — inspect and repair or remove them',
			'worktree recovery state is uncertain — inspect .swarm/worktree-merge-recovery-v2.json',
			'worktree provisioning state is uncertain (unreadable dir)',
		]);
	});
});

describe('findDirtyBaseline', () => {
	test('reports tracked edits, untracked files and renames outside .swarm only', async () => {
		const repo = await createStartProject('epic-dirty-', {
			git: true,
			plan: null,
		});
		try {
			expect(findDirtyBaseline(repo)).toEqual([]);
			fs.writeFileSync(path.join(repo, 'new file.ts'), 'x');
			fs.writeFileSync(
				path.join(repo, '.gitignore'),
				'.swarm/\nnode_modules/\n',
			);
			fs.writeFileSync(path.join(repo, '.swarm', 'ignored.json'), '{}');
			expect(findDirtyBaseline(repo).sort()).toEqual([
				'.gitignore',
				'new file.ts',
			]);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
