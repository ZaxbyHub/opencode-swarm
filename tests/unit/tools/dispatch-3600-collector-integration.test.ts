import { afterEach, expect, mock, test } from 'bun:test';
import {
	buildTypedDelegationTerminal,
	claimTerminalResult,
	findByCorrelationId,
} from '../../../src/background/pending-delegations';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { ensureAgentSession, swarmState } from '../../../src/state';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { retrieve_lane_output } from '../../../src/tools/retrieve-lane-output';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

const {
	assistantMessage,
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
} = createCollectLaneTimeoutFixture();

afterEach(async () => {
	restoreInternals();
	swarmState.activeAgent.delete(`${batch}-session`);
	swarmState.agentSessions.delete(`${batch}-session`);
	_test_exports.resetDeliveredLaneOutputs();
	await cleanupTempDirs();
});

const batch = 'budget-checkpoint';
const dimension = 'correctness-state';
const head = 'a'.repeat(40);
const revision = 'b'.repeat(64);
const rows = '| F1 | src/feature.ts | 23 | invalid state |';

function readCoverage(
	result: Awaited<ReturnType<typeof executeCollectLaneResults>>,
): {
	success?: boolean;
	all_settled?: boolean;
	pending_lanes?: Array<{ lane_id: string }>;
	unsettled_coverage?: Array<{
		lane_id: string;
		dimension: string;
		output_ref?: string;
	}>;
} {
	return result;
}

async function collectCheckpoint({
	hostBudget = true,
	council = false,
	empty = false,
} = {}) {
	const directory = makeTempDir();
	const lane = `${batch}-lane`;
	const session = `${batch}-session`;
	await recordPending({
		directory,
		batchId: batch,
		mode: council ? 'swarm-pr-review:council' : 'swarm-pr-review:base',
		workflowLane: dimension,
		workspace: {
			directory,
			gitHead: head,
			dirtyHash: null,
			prHeadSha: head,
			scope: `complete PR diff ${'c'.repeat(40)}...${head}`,
		},
	});
	const initial = findByCorrelationId(directory, session);
	if (!initial) throw new Error('fixture delegation missing');
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => revision;
	let now = 1_760_000_000_000;
	_internals.now = () => now;
	_internals.sleep = mock(async (ms: number) => {
		now += ms;
	});
	const abort = mock(async () => undefined);
	const metadata = JSON.stringify({
		status: 'UNSETTLED',
		batch_id: batch,
		lane_id: lane,
		dimension,
		pr_head_sha: head,
		revision_digest: revision,
	});
	let terminal = false;
	_internals.getSessionOps = () => ({
		...baseOps(),
		abort,
		status: mock(async () => ({
			data: {
				[session]: { type: terminal ? ('idle' as const) : ('busy' as const) },
			},
		})),
		messages: mock(async () => ({
			data:
				terminal && !empty
					? [
							assistantMessage(
								hostBudget
									? rows
									: `SWARM_REVIEW_LANE_CHECKPOINT ${metadata}\n${rows}`,
							),
						]
					: [],
		})),
	});

	const observed = readCoverage(
		await executeCollectLaneResults(
			{
				batch_id: batch,
				wait: true,
				timeout_ms: 1000,
			},
			directory,
		),
	);
	expect(observed.all_settled).toBe(false);
	expect(observed.pending_lanes?.map((item) => item.lane_id)).toContain(lane);
	expect(observed.unsettled_coverage).toBeUndefined();
	expect(findByCorrelationId(directory, session)?.status).toBe(initial?.status);
	expect(abort).not.toHaveBeenCalled();

	terminal = true;
	if (hostBudget) {
		swarmState.activeAgent.set(session, 'swarm-explorer');
		ensureAgentSession(session, 'swarm-explorer');
		const hooks = createGuardrailsHooks(directory, {
			enabled: true,
			max_tool_calls: 1,
			max_duration_minutes: 30,
			idle_timeout_minutes: 60,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			profiles: { explorer: { max_tool_calls: 1 } },
		});
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID: session, callID: 'budget-stop' },
				{ args: { filePath: 'feature.ts' } },
			),
		).rejects.toThrow('Tool calls exhausted');
		expect(
			findByCorrelationId(directory, session)?.prReviewBudgetExhausted,
		).toBe('tool_calls');
		// A caller may still hold the pre-exhaustion snapshot. The store owns
		// the ordering decision even when that caller proposes completion.
		const staleCompletion = buildTypedDelegationTerminal(
			initial,
			'completed',
			{ text: rows, chars: rows.length, truncated: false, digest: revision },
			now,
		);
		expect(await claimTerminalResult(directory, session, staleCompletion)).toBe(
			null,
		);
		swarmState.activeAgent.delete(session);
		swarmState.agentSessions.delete(session);
	}
	const result = readCoverage(
		await executeCollectLaneResults(
			{
				batch_id: batch,
				wait: false,
			},
			directory,
		),
	);
	expect(abort).not.toHaveBeenCalled();
	expect(result.success).toBe(false);
	if (!hostBudget) {
		expect(result.unsettled_coverage).toBeUndefined();
		return;
	}
	expect(result.unsettled_coverage).toEqual([
		{
			lane_id: lane,
			dimension,
			...(empty ? {} : { output_ref: expect.any(String) }),
		},
	]);
	expect(result.all_settled).toBe(true);
	const settled = findByCorrelationId(directory, session);
	expect(settled?.status).toBe('error');
	expect(settled?.result?.error).toBe('PR_REVIEW_BUDGET_EXHAUSTED');
	expect(settled?.result?.prReviewResultReceipt).toBeUndefined();
	if (empty) return;
	const reference = result.unsettled_coverage?.[0]?.output_ref;
	if (!reference) throw new Error('missing output reference');
	const full = await retrieve_lane_output.execute(
		{ ref: reference },
		{
			directory,
			worktree: directory,
			sessionID: session,
			messageID: 'retrieve',
			agent: 'architect',
			abort: new AbortController().signal,
			metadata: () => {},
			ask: async () => {},
		},
	);
	expect(full).toContain(rows);
}

test('collector preserves a host-stopped lane’s partial rows after session teardown', async () => {
	await collectCheckpoint();
}, 30_000);

test('collector ignores a model-authored budget marker even with matching dispatch identity', async () => {
	await collectCheckpoint({ hostBudget: false });
}, 30_000);

test('collector reports a host-stopped council lane with no output reference', async () => {
	await collectCheckpoint({ council: true, empty: true });
}, 30_000);
