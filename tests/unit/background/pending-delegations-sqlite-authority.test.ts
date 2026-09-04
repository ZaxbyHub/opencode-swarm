import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	BACKGROUND_CODER_RESERVATIONS_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	type BackgroundTerminalResult,
	bindBackgroundCoderReservation,
	buildBackgroundCoderReservationId,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimTerminalResult,
	findByCorrelationId,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegationDetailed,
	releaseBackgroundCoderReservation,
	reserveBackgroundCoderSlot,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { _internals as coordinationInternals } from '../../../src/db/coordination-store';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const dirs: string[] = [];

function project(): string {
	const dir = canonicalMkdtemp('bg-sqlite-auth-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function pendingInput(
	correlationId: string,
	agent = 'reviewer',
	generation = 1,
): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'parent',
		callID: `${correlationId}-call`,
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: agent === 'coder' ? '1.1' : null,
		evidenceTaskId: agent === 'coder' ? '1.1' : null,
		generation,
		...(agent === 'coder'
			? {
					taskChangeContext: {
						declaredFiles: ['src/a.ts'],
						baseline: {
							directory: '.',
							gitHead: null,
							dirtyHash: null,
							changedFiles: null,
							prHeadSha: null,
							scope: null,
						},
					},
				}
			: {}),
	};
}

function completedTerminal(
	correlationId: string,
	status: BackgroundTerminalResult['status'] = 'completed',
): BackgroundTerminalResult {
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId,
			jobId: null,
			status,
			resultDigest: `${correlationId}:${status}`,
		}),
		status,
		recordedAt: 100,
		result: {
			chars: 4,
			truncated: false,
			digest: `${correlationId}:${status}`,
			...(status === 'error' || status === 'rejected'
				? { error: status }
				: { text: status }),
		},
	};
}

const SETTLEMENT_CHILD = `
const mod = await import(process.env.SWARM_BG_MODULE);
const result = await mod.claimCoderSettlement(
	process.env.SWARM_BG_DIR,
	process.env.SWARM_BG_CORRELATION,
	process.env.SWARM_BG_OPERATION,
);
console.log(JSON.stringify(result));
`;

afterEach(() => {
	coordinationInternals.coordinationFaultInjector = undefined;
	closeAllProjectDbs();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('pending delegations SQLite authority', () => {
	test('legacy import archives originals and rewrites shadow projections', async () => {
		const dir = project();
		const legacy = {
			...pendingInput('legacy-1'),
			status: 'pending' as const,
			schemaVersion: 1 as const,
			createdAt: 1,
			updatedAt: 1,
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${JSON.stringify(legacy)}\n`,
			'utf-8',
		);

		const result = await recordPendingDelegationDetailed(
			dir,
			pendingInput('new-1'),
		);
		expect(result.status).toBe('recorded');
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', `${BACKGROUND_DELEGATIONS_FILE}.imported`),
			),
		).toBe(true);
		expect(
			readDelegations(dir)
				.map((record) => record.correlationId)
				.sort(),
		).toEqual(['legacy-1', 'new-1']);
	});

	test('two processes cannot steal coder settlement ownership', async () => {
		const dir = project();
		const input = pendingInput('coder-1', 'coder');
		expect((await recordPendingDelegationDetailed(dir, input)).status).toBe(
			'recorded',
		);
		await claimTerminalResult(
			dir,
			input.correlationId,
			completedTerminal('coder-1'),
		);

		const child = Bun.spawn(['bun', '-e', SETTLEMENT_CHILD], {
			cwd: process.cwd(),
			env: {
				...process.env,
				SWARM_BG_MODULE: pathToFileURL(
					path.resolve('src/background/pending-delegations.ts'),
				).href,
				SWARM_BG_DIR: dir,
				SWARM_BG_CORRELATION: input.correlationId,
				SWARM_BG_OPERATION: 'op-child',
			},
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 60_000,
		});
		const parent = await claimCoderSettlement(
			dir,
			input.correlationId,
			'op-parent',
		);
		const childOutput = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		const parsedChild = JSON.parse(childOutput.trim()) as {
			disposition?: string;
		} | null;
		const outcomes = [
			parent?.disposition ?? null,
			parsedChild?.disposition ?? null,
		];
		expect(outcomes.filter((entry) => entry === 'claimed')).toHaveLength(1);
		expect(outcomes.filter((entry) => entry === null)).toHaveLength(1);

		const winner = parent?.disposition === 'claimed' ? 'op-parent' : 'op-child';
		const resumed = await claimCoderSettlement(
			dir,
			input.correlationId,
			winner,
		);
		expect(resumed?.disposition).toBe('resume');
	});

	test('older-generation reservation release is rejected and the current owner remains', async () => {
		const dir = project();
		const reservationId = buildBackgroundCoderReservationId({
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'call-1',
		});
		const reserved = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'call-1',
			maxConcurrent: 2,
			generation: 2,
		});
		expect(reserved.ok).toBe(true);
		const bound = await bindBackgroundCoderReservation(dir, {
			reservationId,
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'call-1',
			correlationId: 'corr-2',
			generation: 2,
		});
		expect(bound?.generation).toBe(2);
		expect(
			await releaseBackgroundCoderReservation(dir, {
				reservationId,
				parentSessionId: 'parent',
				planTaskId: '1.1',
				callID: 'call-1',
				correlationId: 'corr-2',
				generation: 1,
				reason: 'recovered',
			}),
		).toBe(false);
		expect(
			await bindBackgroundCoderReservation(dir, {
				reservationId,
				parentSessionId: 'parent',
				planTaskId: '1.1',
				callID: 'call-1',
				correlationId: 'corr-2',
				generation: 2,
			}),
		).not.toBeNull();
	});

	test('successful reservation release removes its durable lease', async () => {
		const dir = project();
		const reservationId = buildBackgroundCoderReservationId({
			parentSessionId: 'parent',
			planTaskId: '1.2',
			callID: 'call-release',
		});
		const reserved = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent',
			planTaskId: '1.2',
			callID: 'call-release',
			maxConcurrent: 2,
			generation: 3,
		});
		expect(reserved.ok).toBe(true);
		if (!reserved.ok) throw new Error(reserved.detail);
		expect(reserved.reservation.reservationId).toBe(reservationId);
		expect(
			await releaseBackgroundCoderReservation(dir, {
				reservationId,
				parentSessionId: 'parent',
				planTaskId: '1.2',
				callID: 'call-release',
				correlationId: null,
				generation: 3,
				reason: 'dispatch_failed',
			}),
		).toBe(true);
		const remaining = getProjectDb(dir)
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM coordination_lease WHERE namespace = 'background.coder-reservation'",
			)
			.get();
		expect(remaining?.count).toBe(0);
	});

	test('mismatched reservation lease aborts cleanup without deleting authority', async () => {
		const dir = project();
		const reserved = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent',
			planTaskId: '1.3',
			callID: 'call-mismatched-lease',
			maxConcurrent: 2,
			generation: 4,
		});
		expect(reserved.ok).toBe(true);
		if (!reserved.ok) throw new Error(reserved.detail);
		getProjectDb(dir).run(
			`UPDATE coordination_lease SET owner_token = ?
			 WHERE namespace = ? AND entity_key = ?`,
			[
				'foreign-owner',
				'background.coder-reservation.lease',
				reserved.reservation.reservationId,
			],
		);

		expect(
			await releaseBackgroundCoderReservation(dir, {
				reservationId: reserved.reservation.reservationId,
				parentSessionId: 'parent',
				planTaskId: '1.3',
				callID: 'call-mismatched-lease',
				correlationId: null,
				generation: 4,
				reason: 'dispatch_failed',
			}),
		).toBe(false);
		const state = getProjectDb(dir)
			.query<{ count: number }, [string]>(
				`SELECT COUNT(*) AS count FROM coordination_state
				 WHERE namespace = 'background.coder-reservation' AND entity_key = ?`,
			)
			.get(reserved.reservation.reservationId);
		expect(state?.count).toBe(1);
		const lease = getProjectDb(dir)
			.query<{ owner_token: string }, [string]>(
				`SELECT owner_token FROM coordination_lease
				 WHERE namespace = 'background.coder-reservation.lease' AND entity_key = ?`,
			)
			.get(reserved.reservation.reservationId);
		expect(lease?.owner_token).toBe('foreign-owner');
	});

	test('rejected terminal state is durably visible to readers and recovery scans', async () => {
		const dir = project();
		expect(
			(await recordPendingDelegationDetailed(dir, pendingInput('reject-1')))
				.status,
		).toBe('recorded');
		const claimed = await claimTerminalResult(
			dir,
			'reject-1',
			completedTerminal('reject-1', 'rejected'),
		);
		expect(claimed?.disposition).toBe('claimed');
		expect(findByCorrelationId(dir, 'reject-1')?.status).toBe('rejected');
		expect(
			readDelegations(dir).find((record) => record.correlationId === 'reject-1')
				?.status,
		).toBe('rejected');
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(
				scan.owners.find((record) => record.correlationId === 'reject-1')
					?.status,
			).toBe('rejected');
		}
	});

	test('import crash after commit archives on replay without reimporting', async () => {
		const dir = project();
		const legacy = {
			...pendingInput('legacy-crash'),
			status: 'pending' as const,
			schemaVersion: 1 as const,
			createdAt: 1,
			updatedAt: 1,
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${JSON.stringify(legacy)}\n`,
			'utf-8',
		);
		let injected = false;
		coordinationInternals.coordinationFaultInjector = (point) => {
			if (!injected && point === 'after_commit_before_archive') {
				injected = true;
				throw new Error('simulated crash after commit');
			}
		};
		const failed = await recordPendingDelegationDetailed(
			dir,
			pendingInput('fresh'),
		);
		expect(failed.status).toBe('failed');

		coordinationInternals.coordinationFaultInjector = undefined;
		const delegated = readDelegations(dir);
		expect(
			delegated.some((record) => record.correlationId === 'legacy-crash'),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', `${BACKGROUND_DELEGATIONS_FILE}.imported`),
			),
		).toBe(true);
	});

	test('reservation legacy import archives originals and preserves exact identities', async () => {
		const dir = project();
		const reservation = {
			reservationId: buildBackgroundCoderReservationId({
				parentSessionId: 'parent',
				planTaskId: '1.1',
				callID: 'call-legacy',
			}),
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'call-legacy',
			state: 'reserved' as const,
			correlationId: null,
			generation: 1,
			leaseExpiresAt: 10_000,
			createdAt: 1,
			updatedAt: 1,
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_CODER_RESERVATIONS_FILE),
			`${JSON.stringify({ schemaVersion: 1, reservations: [reservation] })}\n`,
			'utf-8',
		);
		const reserved = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent',
			planTaskId: '2.2',
			callID: 'call-new',
			maxConcurrent: 4,
		});
		expect(reserved.ok).toBe(true);
		expect(
			fs.existsSync(
				path.join(
					dir,
					'.swarm',
					`${BACKGROUND_CODER_RESERVATIONS_FILE}.imported`,
				),
			),
		).toBe(true);
		const shadow = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', BACKGROUND_CODER_RESERVATIONS_FILE),
				'utf-8',
			),
		) as { reservations: Array<{ reservationId: string }> };
		expect(
			shadow.reservations.some(
				(entry) => entry.reservationId === reservation.reservationId,
			),
		).toBe(true);
	});
});
