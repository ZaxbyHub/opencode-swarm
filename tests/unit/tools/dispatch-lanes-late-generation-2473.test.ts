/**
 * Issue #2473 — AC3 (preserving characterization): the attempt generation is
 * captured before launch, persisted, and a LATE artifact from a prior
 * generation can never settle, clear, or advance a successor invocation's
 * durable state. These tests pin EXISTING fence behavior delivered by
 * PR #2091 / #2045 — they must be GREEN on the base commit (08be83096) and
 * stay green after the fix.
 *
 * Fences exercised:
 *  1. createLaneSession's late-create cleanup: a generation-1 create that
 *     resolves AFTER the generation-2 retry launched is deleted and never
 *     prompted; the successor ledger record keeps generation 2 + the
 *     generation-2 session id (async entry point).
 *  2. settleDelegationTerminal's exactly-once terminal claim (the settle sink
 *     appendAsyncLaneLaunchError uses): once the successor record settled, a
 *     late terminal observation for the same correlation cannot claim a new
 *     terminal or flip the record.
 *  3. appendDelegationTransition's expectedCurrentStatuses guard (the stale
 *     sweep's guarded transition): a transition whose expected statuses do not
 *     match the current record is a no-op.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	appendDelegationTransition,
	findByBatchId,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };
const tempDirs: string[] = [];

function tempProject(): string {
	const directory = canonicalMkdtemp('dispatch-lanes-late-gen-2473-');
	tempDirs.push(directory);
	return directory;
}

/** Bounded real-timer poll — fails loudly instead of hanging on a missed condition. */
async function waitFor(
	predicate: () => boolean,
	what: string,
	budgetMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`condition not observed within ${budgetMs}ms: ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('late stale generation artifacts stay fenced (issue 2473 AC3)', () => {
	test('a late generation-1 create resolution cannot disturb the generation-2 successor record', async () => {
		const directory = tempProject();
		let resolveFirst!: (value: { data: { id: string } }) => void;
		const firstCreate = new Promise<{ data: { id: string } }>((resolve) => {
			resolveFirst = resolve;
		});
		let attempt = 0;
		let lateSessionDeleted!: () => void;
		const lateDeleteSignalled = new Promise<void>((resolve) => {
			lateSessionDeleted = resolve;
		});
		const ops: SessionOps = {
			create: mock(() =>
				++attempt === 1
					? firstCreate
					: Promise.resolve({ data: { id: 'gen2-successor-session' } }),
			),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async () => ({ data: { accepted: true } })),
			abort: mock(async () => undefined),
			delete: mock(async (args: { path: { id: string } }) => {
				if (args.path.id === 'late-gen1-session') lateSessionDeleted();
			}),
		};
		_internals.getSessionOps = () => ops;

		// launch_timeout_ms: 10 makes generation-1's create time out locally,
		// bump to generation 2, and launch the prompt on the gen-2 session.
		const launched = await executeDispatchLanesAsync(
			{
				batch_id: 'late-gen-fence',
				launch_timeout_ms: 10,
				lanes: [{ id: 'fence-lane', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		expect(launched.lane_results[0]).toMatchObject({
			status: 'pending',
			generation: 2,
			session_id: 'gen2-successor-session',
		});

		// The successor's running transition lands in the launch microtask; wait
		// for it BEFORE releasing the late generation-1 artifact.
		await waitFor(
			() => findByBatchId(directory, 'late-gen-fence')[0]?.status === 'running',
			'successor record reaches running',
		);

		// Release the LATE generation-1 create: it resolves long after the
		// generation-2 retry already launched. It must be cleaned up (deleted),
		// never prompted, and must not move the successor record.
		resolveFirst({ data: { id: 'late-gen1-session' } });
		await waitFor(
			() =>
				ops.delete.mock.calls.some(
					(call) => call[0].path.id === 'late-gen1-session',
				),
			'late generation-1 session deleted',
		);
		await lateDeleteSignalled;

		expect(ops.promptAsync).toHaveBeenCalledTimes(1);
		expect(ops.promptAsync.mock.calls[0]?.[0].path.id).toBe(
			'gen2-successor-session',
		);
		const record = findByBatchId(directory, 'late-gen-fence')[0];
		expect(record?.generation).toBe(2);
		expect(record?.subagentSessionId).toBe('gen2-successor-session');
		expect(record?.status).toBe('running');
	});

	test('a late terminal observation cannot re-settle or advance an already-terminal record', async () => {
		const directory = tempProject();
		let abortSignal!: (value: unknown) => void;
		const aborted = new Promise((resolve) => {
			abortSignal = resolve;
		});
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'terminal-fence-session' } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			// Returned error result -> launch error -> the record settles 'error'
			// through the same settleDelegationTerminal sink a real launch uses.
			promptAsync: mock(async () => ({
				error: { message: '429 rate_limit_exceeded: too many requests' },
			})),
			abort: mock(async () => {
				abortSignal(null);
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'terminal-fence',
				launch_timeout_ms: 5_000,
				lanes: [{ id: 'terminal-lane', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		await waitFor(
			() => findByBatchId(directory, 'terminal-fence')[0]?.status === 'error',
			'successor record settled to error',
		);

		// A late artifact claiming a DIFFERENT terminal (e.g. the prior
		// generation's launch attempt reporting success) must not claim a fresh
		// terminal or flip the settled record.
		const record = findByBatchId(directory, 'terminal-fence')[0];
		expect(record).toBeDefined();
		const lateText = 'late stale generation artifact: completed after error';
		const outcome = await settleDelegationTerminal(
			directory,
			record!,
			{
				status: 'completed',
				result: {
					text: lateText,
					chars: lateText.length,
					truncated: false,
					digest: digest(lateText),
				},
			},
			{},
			Date.now(),
		);
		expect(outcome.kind).not.toBe('claimed');

		const after = findByCorrelationId(directory, 'terminal-fence-session');
		expect(after?.status).toBe('error');
	});

	test('a guarded delegation transition with mismatched expected statuses is a no-op', async () => {
		const directory = tempProject();
		const recorded = await recordPendingDelegation(directory, {
			correlationId: 'fence-guarded-session',
			jobId: null,
			subagentSessionId: 'fence-guarded-session',
			parentSessionId: 'parent',
			callID: 'fence-guarded-batch',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'fence-guarded-batch',
			laneId: 'fence-guarded-lane',
		});
		expect(recorded?.status).toBe('pending');

		// A late writer expecting the record to be 'running' (a prior
		// generation's belief) must not terminalize a 'pending' successor.
		const transitioned = await appendDelegationTransition(
			directory,
			'fence-guarded-session',
			{ status: 'stale', expectedCurrentStatuses: ['running'] },
		);
		expect(transitioned?.status).toBe('pending');

		const after = findByCorrelationId(directory, 'fence-guarded-session');
		expect(after?.status).toBe('pending');
	});
});
