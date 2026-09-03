import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	clearPrWorkflowGateState,
	_test_exports as gateInternals,
	type PrWorkflowGateState,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-abort-')),
	);
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	// Issue #2251: abort settles lanes, and settlement now probes host session
	// liveness. Pin "no host" so this suite cannot inherit a `swarmState.
	// opencodeClient` leaked by another file in bun's shared process — a leaked
	// client whose `session.status` never resolves would burn the probe's real
	// 5s deadline against bun's 5s per-test timeout.
	gateInternals.getSessionOps = () => null;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

/** A valid controller-recorded terminal recovery condition. */
const TERMINAL_RECOVERY = {
	code: 'UNMERGED_INDEX',
	retryable: false,
	requiredAction: 'resolve the unmerged index manually',
	evidence: {
		worktreeRoot: null,
		gitDir: null,
		operations: ['merge'],
		unmergedCodes: ['UU'],
		paths: ['src/conflict.ts'],
		trackedCount: 1,
		untrackedCount: 0,
		pathsTruncated: false,
	},
	detectedAt: '2026-07-19T00:00:00.000Z',
} as const;

/** Write a raw gate-state record straight to disk. */
async function writeRawState(
	sessionID: string,
	partial: Partial<PrWorkflowGateState>,
): Promise<void> {
	const relative = gateInternals.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const base: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	};
	await fs.writeFile(
		absolute,
		JSON.stringify({ ...base, ...partial }, null, 2),
		'utf-8',
	);
}

describe('abortPrWorkflow', () => {
	test('recovery abort clears an UNBOUND active gate (the deadlock case)', async () => {
		await activatePrWorkflow(directory, 'deadlocked-session', 'PR_REVIEW');
		expect(
			await readPrWorkflowGateState(directory, 'deadlocked-session'),
		).not.toBeNull();

		const summary = await abortPrWorkflow(directory, 'deadlocked-session', {
			kind: 'recovery',
			reason: 'compound git checkout rejected; could not bind PR head',
		});

		expect(summary.mode).toBe('PR_REVIEW');
		expect(summary.openLanes).toBe(0);
		expect(summary.prHeadSha).toBeUndefined();
		expect(
			await readPrWorkflowGateState(directory, 'deadlocked-session'),
		).toBeNull();
	});

	test('recovery abort clears a settled BOUND review', async () => {
		await writeRawState('bound-session', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 3,
		});
		const summary = await abortPrWorkflow(directory, 'bound-session', {
			kind: 'recovery',
			reason: 'bounded discovery recovery exhausted',
		});
		expect(summary.prHeadSha).toBe('abc123');
		expect(
			await readPrWorkflowGateState(directory, 'bound-session'),
		).toBeNull();
	});

	test('recovery abort of a bound review SUCCEEDS when checkoutRecovery exists', async () => {
		await writeRawState('terminal-session', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 3,
			checkoutRecovery: TERMINAL_RECOVERY,
		});
		const summary = await abortPrWorkflow(directory, 'terminal-session', {
			kind: 'recovery',
			reason: 'unmerged index after bind; checkout path unreachable',
		});
		expect(summary.mode).toBe('PR_REVIEW');
		expect(
			await readPrWorkflowGateState(directory, 'terminal-session'),
		).toBeNull();
	});

	test('force abort clears a BOUND review (explicit user override)', async () => {
		await writeRawState('bound-force', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 3,
		});
		const summary = await abortPrWorkflow(directory, 'bound-force', {
			kind: 'force',
			reason: 'user-authorized force abort',
		});
		expect(summary).toEqual({
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			openLanes: 0,
		});
		expect(await readPrWorkflowGateState(directory, 'bound-force')).toBeNull();
	});

	test('recovery abort clears a bound gate after exhausted base settlement', async () => {
		// This is the liveness-critical scenario: base coverage settled, but a
		// failed lane exhausted its retries before trigger/micro artifacts exist.
		await writeRawState('base-settled', {
			mode: 'PR_REVIEW',
			prHeadSha: 'abc123',
			revision: 4,
			// Base coverage has settled (a base dispatch + dimensions recorded)...
			prReviewBaseDispatch: {
				batchId: 'base-1',
				lanes: [
					{
						laneId: 'intent-architecture',
						workflowLane: 'intent-architecture',
					},
				],
				validatedAt: '2026-07-19T00:00:00.000Z',
			},
			prReviewBaseDispatches: [
				{
					batchId: 'base-1',
					lanes: [
						{
							laneId: 'intent-architecture',
							workflowLane: 'intent-architecture',
						},
					],
					validatedAt: '2026-07-19T00:00:00.000Z',
				},
			],
			// ...but NO prReviewTriggerEval / micro artifacts (trigger/micro receipts absent).
		});
		const summary = await abortPrWorkflow(directory, 'base-settled', {
			kind: 'recovery',
			reason: 'base lane retries exhausted before trigger evaluation',
		});
		expect(summary.prHeadSha).toBe('abc123');
		expect(await readPrWorkflowGateState(directory, 'base-settled')).toBeNull();
	});

	test('throws when no active gate exists for the session', async () => {
		await expect(
			abortPrWorkflow(directory, 'no-gate-session', {
				kind: 'recovery',
				reason: 'x',
			}),
		).rejects.toThrow(/no active PR workflow gate/i);
	});

	test('throws on mode mismatch when expectedMode is supplied', async () => {
		await activatePrWorkflow(directory, 'review-only', 'PR_REVIEW');
		await expect(
			abortPrWorkflow(directory, 'review-only', {
				kind: 'recovery',
				reason: 'x',
				expectedMode: 'PR_FEEDBACK',
			}),
		).rejects.toThrow(/active in PR_REVIEW, not PR_FEEDBACK/i);
		expect(
			await readPrWorkflowGateState(directory, 'review-only'),
		).not.toBeNull();
	});

	test('refuses to abort while PR_FEEDBACK is armed for publication', async () => {
		await writeRawState('armed-session', {
			mode: 'PR_FEEDBACK',
			prHeadSha: 'abc123',
			prFeedbackReadyToPublish: {
				revisionDigest: 'rev-1',
				localHead: 'def456',
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/fix/x',
				remoteRef: 'refs/remotes/origin/fix/x',
				validatedAt: '2026-07-19T00:00:00.000Z',
			} as PrWorkflowGateState['prFeedbackReadyToPublish'],
		});
		await expect(
			abortPrWorkflow(directory, 'armed-session', {
				kind: 'force',
				reason: 'x',
				expectedMode: 'PR_FEEDBACK',
			}),
		).rejects.toThrow(/armed for publication; abort is blocked/i);
		const state = await readPrWorkflowGateState(directory, 'armed-session');
		expect(state?.prFeedbackReadyToPublish).toBeDefined();
	});

	test('refuses to abort while PR workflow lanes are in flight', async () => {
		await activatePrWorkflow(directory, 'lanes-session', 'PR_REVIEW');
		await recordPendingDelegation(directory, {
			correlationId: 'c1',
			jobId: null,
			subagentSessionId: 'c1',
			parentSessionId: 'lanes-session',
			callID: 'call-1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'b1',
			laneId: 'intent-architecture',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		await expect(
			abortPrWorkflow(directory, 'lanes-session', {
				kind: 'recovery',
				reason: 'x',
			}),
		).rejects.toThrow(/in flight.*intent-architecture/i);
		expect(
			await readPrWorkflowGateState(directory, 'lanes-session'),
		).not.toBeNull();
	});

	test('appends a non-fatal audit event with kind + reason to .swarm/events.jsonl', async () => {
		await activatePrWorkflow(directory, 'audited-session', 'PR_REVIEW');
		await abortPrWorkflow(directory, 'audited-session', {
			kind: 'recovery',
			reason: 'audit-trail check',
		});
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const contents = await fs.readFile(eventsPath, 'utf-8');
		const event = JSON.parse(contents.trim().split('\n').pop() as string);
		expect(event).toMatchObject({
			type: 'pr_workflow_aborted',
			sessionID: 'audited-session',
			mode: 'PR_REVIEW',
			kind: 'recovery',
			openLanes: 0,
			reason: 'audit-trail check',
		});
	});

	test('clears the gate even if the audit write would fail', async () => {
		await activatePrWorkflow(directory, 'resilient-session', 'PR_REVIEW');
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		await fs.mkdir(eventsPath, { recursive: true });
		const summary = await abortPrWorkflow(directory, 'resilient-session', {
			kind: 'recovery',
			reason: 'resilient',
		});
		expect(summary.mode).toBe('PR_REVIEW');
		expect(
			await readPrWorkflowGateState(directory, 'resilient-session'),
		).toBeNull();
	});

	test('sanitizes a long reason down to 500 characters', async () => {
		await activatePrWorkflow(directory, 'long-reason', 'PR_REVIEW');
		const longReason = 'x'.repeat(2000);
		await abortPrWorkflow(directory, 'long-reason', {
			kind: 'recovery',
			reason: longReason,
		});
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const contents = await fs.readFile(eventsPath, 'utf-8');
		const event = JSON.parse(contents.trim().split('\n').pop() as string);
		expect(event.reason.length).toBe(500);
	});

	test('throws when reason is empty/missing', async () => {
		await activatePrWorkflow(directory, 'no-reason', 'PR_REVIEW');
		await expect(
			abortPrWorkflow(directory, 'no-reason', { kind: 'recovery', reason: '' }),
		).rejects.toThrow(/requires a non-empty reason/i);
	});
});

describe('executeAbortPrWorkflow tool schema (issue #2131 finding 1a)', () => {
	test('rejects an abort call without kind', async () => {
		const { executeAbortPrWorkflow } = await import(
			'../../../src/tools/abort-pr-workflow.js'
		);
		const result = await executeAbortPrWorkflow(
			{ mode: 'PR_REVIEW', reason: 'x' },
			directory,
			{ sessionID: 'sch' },
		);
		expect(JSON.parse(result).success).toBe(false);
	});

	test('rejects an abort call without reason', async () => {
		const { executeAbortPrWorkflow } = await import(
			'../../../src/tools/abort-pr-workflow.js'
		);
		const result = await executeAbortPrWorkflow(
			{ kind: 'recovery' },
			directory,
			{ sessionID: 'sch' },
		);
		expect(JSON.parse(result).success).toBe(false);
	});
});
