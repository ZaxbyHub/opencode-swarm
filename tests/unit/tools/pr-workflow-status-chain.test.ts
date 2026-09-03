import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate';
import type { ToolResult } from '../../../src/tools/create-tool';
import {
	_internals,
	pr_workflow_status,
} from '../../../src/tools/pr-workflow-status';
import {
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function runTool(sessionID: string): Promise<Record<string, unknown>> {
	const result = await (
		pr_workflow_status as unknown as {
			execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
		}
	).execute({}, { directory: tempDir, sessionID } as unknown as ToolContext);
	return JSON.parse(resultToString(result as ToolResult)) as Record<
		string,
		unknown
	>;
}

const realHead = _internals.resolveCurrentGitHeadAsync;
const realClean = _internals.resolveIsWorkingTreeCleanAsync;
const realRunGit = _internals.runGitCapture;
const realClassifyGitState = _internals.classifyGitState;

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	_internals.resolveCurrentGitHeadAsync = async () => 'a'.repeat(40);
	_internals.resolveIsWorkingTreeCleanAsync = async () => true;
	_internals.classifyGitState = async () => ({
		kind: 'clean',
		code: 'CLEAN',
		retryable: true,
		requiredAction: 'No checkout recovery is required.',
		evidence: {
			worktreeRoot: tempDir,
			gitDir: `${tempDir}/.git`,
			operations: [],
			unmergedCodes: [],
			paths: [],
			trackedCount: 0,
			untrackedCount: 0,
			pathsTruncated: false,
		},
	});
	_internals.runGitCapture = async (_directory: string, args: string[]) => {
		if (args[0] === 'rev-parse') return 'HEAD\n';
		if (args[0] === 'status') return '';
		if (args[0] === 'remote') return '';
		return null;
	};
});

afterEach(async () => {
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassifyGitState;
	await teardownPrWorkflowGateFixtures();
});

test('fails closed when delegation ancestry is missing, cyclic, or too deep', async () => {
	const cycleA = 'cycle-a';
	const cycleB = 'cycle-b';
	for (const [correlationId, parentSessionId] of [
		[cycleA, cycleB],
		[cycleB, cycleA],
	] as const) {
		await recordPendingDelegation(tempDir, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId,
			callID: `${correlationId}-call`,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
		});
	}
	await recordPendingDelegation(tempDir, {
		correlationId: 'missing-parent-child',
		jobId: null,
		subagentSessionId: 'missing-parent-child',
		parentSessionId: 'missing-parent',
		callID: 'missing-parent-call',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
	});

	expect(
		await _internals.resolveWorkflowGateSession(tempDir, cycleA),
	).toBeNull();
	expect(
		await _internals.resolveWorkflowGateSession(
			tempDir,
			'missing-parent-child',
		),
	).toBeNull();
	const cycleStatus = await runTool(cycleA);
	expect(cycleStatus.gate).toMatchObject({
		active: false,
		reason: 'delegation-chain-uncertain',
	});
	expect(cycleStatus.nextStep).toContain('state as unknown');

	let child = 'depth-0';
	for (let depth = 1; depth <= 17; depth += 1) {
		const parent = `depth-${depth}`;
		await recordPendingDelegation(tempDir, {
			correlationId: child,
			subagentSessionId: child,
			parentSessionId: parent,
			jobId: null,
			callID: `${child}-call`,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		child = parent;
	}
	expect(
		await _internals.resolveWorkflowGateSession(tempDir, 'depth-0'),
	).toBeNull();
});

test('prefers a gate owned by the queried session before walking its parent', async () => {
	const sessionID = 'delegated-controller';
	await recordPendingDelegation(tempDir, {
		correlationId: sessionID,
		jobId: null,
		subagentSessionId: sessionID,
		parentSessionId: 'outer-controller',
		callID: 'delegated-controller-call',
		normalizedAgent: 'architect',
		swarmPrefixedAgent: 'architect',
		planTaskId: null,
		evidenceTaskId: null,
	});
	await activatePrWorkflow(tempDir, sessionID, 'PR_FEEDBACK');

	expect(await _internals.resolveWorkflowGateSession(tempDir, sessionID)).toBe(
		sessionID,
	);
	expect((await runTool(sessionID)).gate).toMatchObject({
		active: true,
		mode: 'PR_FEEDBACK',
	});
});
