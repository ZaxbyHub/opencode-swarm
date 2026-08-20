/**
 * Issue #2034 — checkpoint/compaction basics: >4 MiB history with a small live
 * set must recover from a bounded checkpoint + tail; legacy uncheckpointed
 * oversize must still fail closed; retention budgets must hold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACKGROUND_DELEGATIONS_HEALTH_FILE } from '../../../src/background/delegation-health';
import {
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	claimTerminalResult,
	compactBackgroundDelegations,
	DELEGATION_COMPACTION_HIGH_WATER_BYTES,
	MAX_CHECKPOINT_BYTES,
	putPendingBackgroundAdvisory,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-ckpt-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

function pendingInput(correlationId: string): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_parent',
		callID: `call_${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
	};
}

function histLine(correlationId: string, pad = 64): string {
	return JSON.stringify({
		schemaVersion: 1,
		...pendingInput(correlationId),
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		completedAt: 2,
		promptHash: 'x'.repeat(8 + pad),
	});
}

/** Append synthetic history until the ledger exceeds `bytes`. */
function growLedger(bytes: number): number {
	const ledger = path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE);
	const handle = fs.openSync(ledger, 'a');
	let written = fs.statSync(ledger).size;
	let i = 0;
	while (written <= bytes) {
		const line = histLine(`hist-${i}`);
		fs.writeSync(handle, `${line}\n`);
		written += Buffer.byteLength(line) + 1;
		i += 1;
	}
	fs.closeSync(handle);
	return i;
}

describe('issue #2034 checkpoint/compaction', () => {
	it('fails closed on a legacy oversized ledger before any checkpoint exists', () => {
		growLedger(4 * 1024 * 1024);
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toBe(
				'background delegation ledger exceeds the 4194304-byte recovery bound',
			);
		}
	});

	it('recovers the exact live set from checkpoint + tail after compacting >4 MiB of history', async () => {
		const live = await recordPendingDelegation(dir, pendingInput('live-1'));
		expect(live).not.toBeNull();
		const histCount = growLedger(4 * 1024 * 1024);

		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');
		if (compact.status === 'compacted') {
			expect(compact.sequence).toBe(1);
			expect(compact.tailBytes).toBe(0);
			expect(compact.checkpointBytes).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
		}

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.source).toBe('checkpoint+tail');
			const liveRecord = scan.owners.find(
				(record) => record.correlationId === 'live-1',
			);
			expect(liveRecord?.status).toBe('pending');
		}

		// The live set is still visible to the lenient reader and mutation paths.
		const lenient = readDelegations(dir);
		expect(lenient.some((r) => r.correlationId === 'live-1')).toBe(true);
		void histCount;
	});

	it('keeps post-compaction tail bytes below the recovery bound', async () => {
		growLedger(4 * 1024 * 1024);
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');
		const tailBytes = fs.statSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		).size;
		expect(tailBytes).toBeLessThan(DELEGATION_COMPACTION_HIGH_WATER_BYTES);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_HEALTH_FILE),
			),
		).toBe(true);
	});

	it('auto-compacts when a mutation pushes the ledger past the high-water mark', async () => {
		// Leave less than one record (~350 B) below the high-water mark so the
		// next append must cross it and trigger lazy maintenance.
		growLedger(DELEGATION_COMPACTION_HIGH_WATER_BYTES - 100);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			),
		).toBe(false);

		// A single appended record crosses the high-water mark; the mutation's
		// lazy maintenance must compact under the same lock.
		await recordPendingDelegation(dir, pendingInput('trigger-1'));

		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			),
		).toBe(true);
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(
				scan.owners.some((record) => record.correlationId === 'trigger-1'),
			).toBe(true);
		}
	});

	it('skips compaction below the high-water mark unless forced', async () => {
		await recordPendingDelegation(dir, pendingInput('only-1'));
		const skipped = await compactBackgroundDelegations(dir);
		expect(skipped.status).toBe('skipped');
		const forced = await compactBackgroundDelegations(dir, { force: true });
		expect(forced.status).toBe('compacted');
		// Idempotent second compaction: nothing to retire, tail already empty.
		const again = await compactBackgroundDelegations(dir, { force: true });
		expect(again.status).toBe('compacted');
		if (again.status === 'compacted' && forced.status === 'compacted') {
			expect(again.sequence).toBe((forced.sequence ?? 1) + 1);
		}
	});

	it('drops closed bodies but keeps lane identity, workspace, and result scalars in summaries', async () => {
		await recordPendingDelegation(dir, {
			...pendingInput('lane-1'),
			batchId: 'batch-1',
			laneId: 'lane-1',
			mode: 'swarm-pr-review',
			workflowLane: 'correctness',
			ownedWorkflowLanes: ['correctness'],
			workspace: {
				directory: dir,
				gitHead: 'deadbeef',
				dirtyHash: 'cafe',
				changedFiles: ['src/a.ts'],
				prHeadSha: null,
				scope: null,
			},
			prompt: {
				text: 'big prompt body',
				chars: 16,
				truncated: false,
				digest: 'p'.repeat(64),
			},
		});
		await claimTerminalResult(dir, 'lane-1', {
			eventId: 'bgc1:' + 'a'.repeat(64),
			status: 'completed',
			recordedAt: 42,
			result: {
				text: 'result body text',
				chars: 17,
				truncated: false,
				digest: 'r'.repeat(64),
				outputDegraded: false,
			},
		});

		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');

		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		) as {
			records: unknown[];
			closed: Array<Record<string, unknown>>;
		};
		expect(checkpoint.records).toHaveLength(0);
		expect(checkpoint.closed).toHaveLength(1);
		const summary = checkpoint.closed[0]!;
		// Large bodies dropped.
		expect(summary.prompt).toBeUndefined();
		expect(
			(summary.terminalResult as { result?: { text?: string } }).result.text,
		).toBeUndefined();
		// Gate-relevant fields retained (pr-workflow-gate batch integrity).
		expect(summary.batchId).toBe('batch-1');
		expect(summary.laneId).toBe('lane-1');
		expect(summary.workflowLane).toBe('correctness');
		expect(summary.mode).toBe('swarm-pr-review');
		expect((summary.workspace as { gitHead?: string }).gitHead).toBe(
			'deadbeef',
		);
		expect(
			(
				summary.terminalResult as {
					result?: { digest?: string; outputDegraded?: boolean };
				}
			).result.digest,
		).toBe('r'.repeat(64));
	});

	it('keeps pending advisories and unsettled worktree owners as live (full) records', async () => {
		await recordPendingDelegation(dir, pendingInput('adv-1'));
		const terminal = {
			eventId: 'bgc1:' + 'b'.repeat(64),
			status: 'completed' as const,
			recordedAt: 50,
			result: { chars: 1, truncated: false, digest: 'd'.repeat(64) },
		};
		await claimTerminalResult(dir, 'adv-1', terminal);
		const advisory = await putPendingBackgroundAdvisory(dir, 'adv-1', {
			eventId: terminal.eventId,
			parentSessionId: 'sess_parent',
			message: 'pending advisory survives compaction',
		});
		expect(advisory).not.toBeNull();

		await compactBackgroundDelegations(dir, { force: true });
		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		) as {
			records: Array<{
				correlationId: string;
				advisoryInbox?: { state: string };
			}>;
		};
		expect(checkpoint.records).toHaveLength(1);
		expect(checkpoint.records[0]!.correlationId).toBe('adv-1');
		expect(checkpoint.records[0]!.advisoryInbox?.state).toBe('pending');
	});

	it('audit counters are lifetime totals: repeated compaction of a stable corpus does not decay them', async () => {
		await recordPendingDelegation(dir, pendingInput('stable-live'));
		const terminalInput = pendingInput('stable-done');
		await recordPendingDelegation(dir, terminalInput);
		await claimTerminalResult(dir, 'stable-done', {
			eventId: 'bgc1:' + 'c'.repeat(64),
			status: 'completed',
			recordedAt: 77,
			result: { chars: 1, truncated: false, digest: 'g'.repeat(64) },
		});

		await compactBackgroundDelegations(dir, { force: true });
		const readAudit = () => {
			const checkpoint = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
					'utf-8',
				),
			) as {
				audit: {
					terminalsByStatus: Record<string, number>;
					dispatchCount: number;
				};
			};
			return checkpoint.audit;
		};
		const first = readAudit();
		expect(first.terminalsByStatus.completed).toBe(1);
		expect(first.dispatchCount).toBe(2);

		// Re-compacting the unchanged corpus must not decay the counters
		// (regression: increment-then-subtract made them epoch-local).
		await compactBackgroundDelegations(dir, { force: true });
		await compactBackgroundDelegations(dir, { force: true });
		const third = readAudit();
		expect(third.terminalsByStatus.completed).toBe(1);
		expect(third.dispatchCount).toBe(2);
	});

	it('settled coder summaries retain observedFiles (executed-contract audit artifact)', async () => {
		const input = pendingInput('settled-coder');
		await recordPendingDelegation(dir, {
			...input,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			taskChangeContext: {
				declaredFiles: ['src/a.ts'],
				baseline: {
					directory: dir,
					gitHead: null,
					dirtyHash: null,
					changedFiles: null,
					prHeadSha: null,
					scope: null,
				},
			},
		});
		const terminal = {
			eventId: 'bgc1:' + '1'.repeat(64),
			status: 'completed' as const,
			recordedAt: 88,
			result: {
				text: 'coder body',
				chars: 10,
				truncated: false,
				digest: 'coder body',
			},
		};
		await claimTerminalResult(dir, input.correlationId, terminal);
		const {
			claimCoderSettlement,
			updateCoderSettlement,
			claimDelegationIngestion,
			recordDelegationIngestionResult,
		} = await import('../../../src/background/pending-delegations');
		await claimCoderSettlement(dir, input.correlationId, 'op-s');
		await updateCoderSettlement(dir, input.correlationId, {
			operationId: 'op-s',
			state: 'settled',
			observedFiles: ['src/a.ts', 'src/b.ts'],
			outcome: { kind: 'shared-root', result: 'merged' },
		});
		// Complete the lifecycle: completed-unconsumed coders stay live records
		// (admission semantics); consumed ones become closed summaries.
		const ingestion = await claimDelegationIngestion(dir, input.correlationId, {
			claimantId: 'audit-test',
		});
		expect(ingestion?.disposition).toBe('claimed');
		const consumed = await recordDelegationIngestionResult(
			dir,
			input.correlationId,
			ingestion!.record.ingestion!.claimToken,
			true,
		);
		expect(consumed?.status).toBe('consumed');
		await compactBackgroundDelegations(dir, { force: true });

		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		) as {
			closed: Array<{
				correlationId: string;
				coderSettlement?: { observedFiles: string[] | null };
			}>;
		};
		const summary = checkpoint.closed.find(
			(entry) => entry.correlationId === 'settled-coder',
		);
		expect(summary).toBeDefined();
		expect(summary!.coderSettlement?.observedFiles).toEqual([
			'src/a.ts',
			'src/b.ts',
		]);
	});
});
