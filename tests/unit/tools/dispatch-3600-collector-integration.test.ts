import { afterEach, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	getActiveWindow,
	swarmState,
} from '../../../src/state';
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
		output_ref: string;
	}>;
} {
	return result;
}

async function collectCheckpoint({ stale = false, hostBudget = false } = {}) {
	const directory = makeTempDir();
	const lane = `${batch}-lane`;
	const session = `${batch}-session`;
	await recordPending({
		directory,
		batchId: batch,
		mode: 'swarm-pr-review:base',
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
	expect(initial).toBeDefined();
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => revision;
	let now = Date.now();
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
		revision_digest: stale ? 'd'.repeat(64) : revision,
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
			data: terminal
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
		expect(getActiveWindow(session)?.reviewBudgetExhausted).toBe('tool_calls');
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
	if (hostBudget) swarmState.agentSessions.delete(session);
	expect(abort).not.toHaveBeenCalled();
	expect(result.success).toBe(false);
	if (stale) {
		expect(result.unsettled_coverage).toBeUndefined();
		return;
	}
	expect(result.unsettled_coverage).toEqual([
		{ lane_id: lane, dimension, output_ref: expect.any(String) },
	]);
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

test('collector retains a genuine lane-owned budget checkpoint without treating it as completed coverage', async () => {
	await collectCheckpoint();
}, 30_000);

test('collector rejects budget checkpoint evidence from a stale review revision', async () => {
	await collectCheckpoint({ stale: true });
}, 30_000);

test('collector preserves partial rows from a host-stopped lane without a model marker', async () => {
	await collectCheckpoint({ hostBudget: true });
}, 30_000);
