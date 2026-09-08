import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import {
	clearPrWorkflowAutoWakeState,
	observePrWorkflowAutoWakeEvent,
} from '../../../src/hooks/pr-workflow-auto-wake';
import {
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate';
import type { ToolResult } from '../../../src/tools/create-tool';
import {
	_internals,
	pr_workflow_status,
} from '../../../src/tools/pr-workflow-status';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function runTool(sessionID?: string): Promise<Record<string, unknown>> {
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

const realReadGate = _internals.readPrWorkflowGateStateForRecovery;
const realReadDelegationsDetailed = _internals.readDelegationsDetailed;
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
	_internals.runGitCapture = async (_dir: string, args: string[]) => {
		if (args[0] === 'rev-parse') return 'HEAD\n';
		if (args[0] === 'status') return '';
		if (args[0] === 'remote') return '';
		return null;
	};
});

afterEach(async () => {
	_internals.readPrWorkflowGateStateForRecovery = realReadGate;
	_internals.readDelegationsDetailed = realReadDelegationsDetailed;
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassifyGitState;
	clearPrWorkflowAutoWakeState(tempDir, SESSION_ID);
	await teardownPrWorkflowGateFixtures();
});

describe('pr_workflow_status — recovery operator section (issue #2511)', () => {
	test('populates a truthful recovery section for a healthy store and an active gate', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const gateState = await readPrWorkflowGateState(tempDir, SESSION_ID);
		if (!gateState) throw new Error('fixture gate must be readable');

		const parsed = await runTool(SESSION_ID);
		const recovery = parsed.recovery as Record<string, unknown>;
		expect(recovery.controllerSessionID).toBe(SESSION_ID);
		expect(recovery.delegationRead).toEqual({ state: 'ok' });
		expect(recovery.lastProgress).toEqual({
			revision: gateState.revision,
			updatedAt: gateState.updatedAt,
		});
		expect(recovery.wakeSuspension).toEqual({ suspended: false });
		expect(recovery.actionCircuits).toEqual({ state: 'unavailable' });
		const recoveryNextStep = recovery.nextStep as string;
		expect(recoveryNextStep).toContain('pr_workflow_status');
		expect(recoveryNextStep).toContain('abort_pr_workflow');
		// The pre-existing top-level operator field is retained unchanged.
		expect(typeof parsed.nextStep).toBe('string');
	});

	test('types the delegation read as uncertain with a bounded reason code', async () => {
		// _internals.readDelegationsDetailed is mocked to the 'uncertain'
		// branch ONLY. Untested branch: status 'ok' — covered by the real
		// reader in the healthy-store test above. Rationale: forcing a real
		// uncertain durable store here would require corrupting the store
		// internals owned by another workstream of this issue.
		_internals.readDelegationsDetailed = mock(() => ({
			status: 'uncertain',
			reason: 'coordination unreadable',
			source: 'coordination-read',
			attempts: 2,
		})) as unknown as typeof realReadDelegationsDetailed;

		const parsed = await runTool(SESSION_ID);
		const recovery = parsed.recovery as Record<string, unknown>;
		expect(recovery.delegationRead).toEqual({
			state: 'uncertain',
			reasonCode: 'coordination unreadable',
		});
		const recoveryNextStep = recovery.nextStep as string;
		expect(recoveryNextStep).toContain('uncertain');
		expect(recoveryNextStep).toContain('repair');
		expect(recoveryNextStep).toContain('pr_workflow_status');
		expect(recoveryNextStep).toContain('abort_pr_workflow');
	});

	test('reports controllerSessionID null and lastProgress null for an uncertain chain', async () => {
		for (const [correlationId, parentSessionId] of [
			['cycle-a', 'cycle-b'],
			['cycle-b', 'cycle-a'],
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

		const parsed = await runTool('cycle-a');
		const recovery = parsed.recovery as Record<string, unknown>;
		expect(recovery.controllerSessionID).toBeNull();
		expect(recovery.lastProgress).toBeNull();
		expect((parsed.gate as Record<string, unknown>).reason).toBe(
			'delegation-chain-uncertain',
		);
	});

	test('lastProgress is null and controllerSessionID is the caller when no gate exists', async () => {
		const parsed = await runTool(SESSION_ID);
		const recovery = parsed.recovery as Record<string, unknown>;
		expect(recovery.controllerSessionID).toBe(SESSION_ID);
		expect(recovery.lastProgress).toBeNull();
		expect((parsed.gate as Record<string, unknown>).reason).toBe(
			'no-active-gate',
		);
	});

	test('reports wake suspension observed on the caller session', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// A real abort event on the gate-owning session publishes the auto-wake
		// pause the same way the runtime hook does — no seam forgery.
		const decision = await observePrWorkflowAutoWakeEvent(tempDir, {
			type: 'message.updated',
			properties: {
				sessionID: SESSION_ID,
				info: { role: 'assistant', error: { name: 'MessageAbortedError' } },
			},
		});
		expect(decision.suppressWake).toBe(true);

		const parsed = await runTool(SESSION_ID);
		const recovery = parsed.recovery as Record<string, unknown>;
		expect(recovery.wakeSuspension).toEqual({ suspended: true });
	});
});
