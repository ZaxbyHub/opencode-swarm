/**
 * Issue #2034 — TRUE restart reconstruction: a fresh process (no shared module
 * cache) must reconstruct the identical folded state from the on-disk
 * checkpoint + tail that the writing process produced. The other suites run
 * in one bun process; this one spawns a child bun runtime to close that gap
 * (#2034 review PRR-016).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	compactBackgroundDelegations,
	putPendingBackgroundAdvisory,
	type RecordPendingInput,
	recordPendingDelegation,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-restart-');
afterAll(cleanup);

const CHILD_PROBE = `
import { scanDelegationsForRecovery, readDelegations } from ${JSON.stringify(
	new URL('../../../src/background/pending-delegations.ts', import.meta.url)
		.href,
)};
const directory = process.env.SWARM_RESTART_PROBE_DIR!;
const scan = scanDelegationsForRecovery(directory);
if (scan.status === 'uncertain') {
	console.log(JSON.stringify({ status: 'uncertain', reason: scan.reason }));
} else {
	console.log(JSON.stringify({
		status: 'ok',
		source: scan.source,
		owners: scan.owners
			.map((r) => ({ id: r.correlationId, status: r.status }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		lenient: readDelegations(directory).length,
	}));
}
`;

function runChildProbe(): {
	status: string;
	source?: string;
	owners?: Array<{ id: string; status: string }>;
	lenient?: number;
} {
	const result = spawnSync(process.execPath, ['-e', CHILD_PROBE], {
		cwd: import.meta.dir,
		encoding: 'utf-8',
		timeout: 60_000,
		env: { ...process.env, SWARM_RESTART_PROBE_DIR: dir },
	});
	if (result.status !== 0) {
		throw new Error(`child probe failed: ${result.stderr}${result.stdout}`);
	}
	return JSON.parse(result.stdout.trim().split('\n').pop()!);
}

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

describe('issue #2034 restart reconstruction (fresh process)', () => {
	it('a fresh process reconstructs the identical live set from checkpoint + tail', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });

		// Parent process: dispatch, complete one, add a pending advisory, compact.
		await recordPendingDelegation(dir, pendingInput('restart-live-1'));
		await recordPendingDelegation(dir, pendingInput('restart-done-1'));
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'restart-done-1',
			jobId: null,
			status: 'completed',
			resultDigest: 'restart body',
		});
		await claimTerminalResult(dir, 'restart-done-1', {
			eventId,
			status: 'completed',
			recordedAt: 6_000_000_000_000,
			result: {
				text: 'restart body',
				chars: 12,
				truncated: false,
				digest: 'restart body',
			},
		});
		await putPendingBackgroundAdvisory(dir, 'restart-done-1', {
			eventId,
			parentSessionId: 'sess_parent',
			message: 'advisory survives restart',
		});
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');
		// Post-compaction append → tail has content too.
		await recordPendingDelegation(dir, pendingInput('restart-tail-1'));
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
			),
		).toBe(true);

		// Parent's in-process view…
		const parentScan = scanDelegationsForRecovery(dir);
		expect(parentScan.status).toBe('ok');

		// …must equal the fresh child process's disk reconstruction.
		const child = runChildProbe();
		expect(child.status).toBe('ok');
		expect(child.source).toBe('checkpoint+tail');
		expect(child.owners).toEqual([
			{ id: 'restart-done-1', status: 'completed' },
			{ id: 'restart-live-1', status: 'pending' },
			{ id: 'restart-tail-1', status: 'pending' },
		]);
		if (parentScan.status === 'ok') {
			const parentSorted = parentScan.owners
				.map((r) => ({ id: r.correlationId, status: r.status }))
				.sort((a, b) => a.id.localeCompare(b.id));
			expect(child.owners).toEqual(parentSorted);
		}
	});
});
