import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { encodePrReviewWorkflowBinding } from '../../../src/background/pr-review-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	readPrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	_internals as responseInternals,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('PR workflow response-gate lane progress token (#2469)', () => {
	let directory = '';
	const sessionID = 'lane-progress-session';
	const originalDelegationScan = responseInternals.scanDelegationsForRecovery;
	const originalResolveCurrentGitHeadAsync =
		workflowInternals.resolveCurrentGitHeadAsync;
	const originalResolveIsWorkingTreeCleanAsync =
		workflowInternals.resolveIsWorkingTreeCleanAsync;
	const originalResolvePrReviewDiffStatsAsync =
		workflowInternals.resolvePrReviewDiffStatsAsync;
	const originalResolvePrWorkflowRevisionDigest =
		workflowInternals.resolvePrWorkflowRevisionDigest;

	async function registerActiveBatch(
		batchId: string,
		laneIds: readonly string[],
	): Promise<void> {
		await withSessionStateMutation(directory, sessionID, async () => {
			const current = await readPrWorkflowGateState(directory, sessionID);
			if (!current) throw new Error('missing active workflow state');
			await writeStateWhileLocked(directory, {
				...current,
				prReviewValidationBatches: [
					{
						batchId,
						phase: 'council',
						lanes: laneIds.map((laneId) => ({
							laneId,
							workflowLane: laneId,
						})),
						validatedAt: '2026-01-01T00:00:00.000Z',
					},
				],
			});
		});
		workflowInternals.resetTrackedStateCache();
	}

	beforeEach(() => {
		directory = canonicalMkdtemp('pr-response-lane-progress-');
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		workflowInternals.resetTrackedStateCache();
	});

	afterEach(async () => {
		responseInternals.scanDelegationsForRecovery = originalDelegationScan;
		workflowInternals.resolveCurrentGitHeadAsync =
			originalResolveCurrentGitHeadAsync;
		workflowInternals.resolveIsWorkingTreeCleanAsync =
			originalResolveIsWorkingTreeCleanAsync;
		workflowInternals.resolvePrReviewDiffStatsAsync =
			originalResolvePrReviewDiffStatsAsync;
		workflowInternals.resolvePrWorkflowRevisionDigest =
			originalResolvePrWorkflowRevisionDigest;
		workflowInternals.resetTrackedStateCache();
		await fs.rm(directory, { recursive: true, force: true });
	});

	test('five genuine lane transitions stay productive, then five unchanged wakes trip the brake', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await registerActiveBatch(
			'lane-progress-batch',
			Array.from({ length: 5 }, (_, index) => `lane-${index}`),
		);
		for (let index = 0; index < 5; index++) {
			await recordPendingDelegation(directory, {
				correlationId: `lane-progress-${index}`,
				jobId: null,
				subagentSessionId: `lane-progress-${index}`,
				parentSessionId: sessionID,
				callID: `lane-progress-call-${index}`,
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: 'lane-progress-batch',
				laneId: `lane-${index}`,
				mode: 'swarm-pr-review:base',
				workflowLane: `lane-${index}`,
				workspace: {
					directory,
					gitHead: 'abc123',
					dirtyHash: null,
					prHeadSha: 'abc123',
					scope: null,
				},
			});
		}

		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 5,
			wakeCooldownMs: 0,
		});
		const idle = {
			event: { type: 'session.idle', properties: { sessionID } },
		};

		await gate.event(idle);
		for (let index = 0; index < 5; index++) {
			await appendDelegationTransition(directory, `lane-progress-${index}`, {
				status: 'running',
			});
			await gate.event(idle);
		}
		expect(gate._inspectWakeBudget(sessionID)?.suspended).toBe(false);
		expect(gate._inspectWakeBudget(sessionID)?.consecutiveUnproductive).toBe(0);

		for (let index = 0; index < 5; index++) {
			await gate.event(idle);
		}
		expect(gate._inspectWakeBudget(sessionID)?.suspended).toBe(true);
		expect(promptAsync).toHaveBeenCalledTimes(11);
	});

	test('valid to corrupt to recovered ledger never receives false progress credit', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await registerActiveBatch('corrupt-batch', ['lane-0']);
		await recordPendingDelegation(directory, {
			correlationId: 'corrupt-lane',
			jobId: null,
			subagentSessionId: 'corrupt-lane',
			parentSessionId: sessionID,
			callID: 'corrupt-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'corrupt-batch',
			laneId: 'lane-0',
			mode: 'swarm-pr-review:base',
			workflowLane: 'lane-0',
		});
		const ledgerPath = path.join(
			directory,
			'.swarm',
			'background-delegations.jsonl',
		);
		const validLedger = await fs.readFile(ledgerPath, 'utf8');
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 3,
			wakeCooldownMs: 0,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		await gate.event(idle);
		await fs.writeFile(ledgerPath, '{not-json}\n', 'utf8');
		await gate.event(idle);
		await gate.event(idle);
		await fs.writeFile(ledgerPath, validLedger, 'utf8');
		await gate.event(idle);
		expect(gate._inspectWakeBudget(sessionID)?.suspended).toBe(true);
	});

	test('duplicate active lane identities remain independently observable', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await registerActiveBatch('shared-batch', ['shared-lane']);
		for (const correlationId of ['duplicate-a', 'duplicate-b']) {
			await recordPendingDelegation(directory, {
				correlationId,
				jobId: null,
				subagentSessionId: correlationId,
				parentSessionId: sessionID,
				callID: `${correlationId}-call`,
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: 'shared-batch',
				laneId: 'shared-lane',
				mode: 'swarm-pr-review:base',
				workflowLane: 'shared-lane',
			});
		}
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			wakeCooldownMs: 0,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		await gate.event(idle);
		await appendDelegationTransition(directory, 'duplicate-b', {
			status: 'running',
		});
		await gate.event(idle);
		expect(gate._inspectWakeBudget(sessionID)?.consecutiveUnproductive).toBe(0);
	});

	test('excludes stale same-session records from a later workflow activation', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await registerActiveBatch('stale-batch', ['stale-lane']);
		await recordPendingDelegation(directory, {
			correlationId: 'stale-correlation',
			jobId: null,
			subagentSessionId: 'stale-correlation',
			parentSessionId: sessionID,
			callID: 'stale-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'stale-batch',
			laneId: 'stale-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'stale-lane',
		});
		await withSessionStateMutation(directory, sessionID, async () => {
			const current = await readPrWorkflowGateState(directory, sessionID);
			if (!current) throw new Error('missing active workflow state');
			await writeStateWhileLocked(directory, {
				...current,
				activatedAt: '2100-01-01T00:00:00.000Z',
			});
		});
		workflowInternals.resetTrackedStateCache();
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			wakeCooldownMs: 0,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		await gate.event(idle);
		await appendDelegationTransition(directory, 'stale-correlation', {
			status: 'running',
		});
		await gate.event(idle);
		expect(gate._inspectWakeBudget(sessionID)?.consecutiveUnproductive).toBe(1);
	});

	test('detects a genuine lane transition that lands during the wake', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await registerActiveBatch('mid-wake-batch', ['mid-wake-lane']);
		await recordPendingDelegation(directory, {
			correlationId: 'mid-wake-correlation',
			jobId: null,
			subagentSessionId: 'mid-wake-correlation',
			parentSessionId: sessionID,
			callID: 'mid-wake-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'mid-wake-batch',
			laneId: 'mid-wake-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'mid-wake-lane',
		});
		let mutateDuringPrompt = false;
		const promptAsync = mock(async () => {
			if (mutateDuringPrompt) {
				mutateDuringPrompt = false;
				await appendDelegationTransition(directory, 'mid-wake-correlation', {
					status: 'running',
				});
			}
			return {};
		});
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			wakeCooldownMs: 0,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		await gate.event(idle);
		mutateDuringPrompt = true;
		await gate.event(idle);
		expect(gate._inspectWakeBudget(sessionID)?.consecutiveUnproductive).toBe(0);
	});

	test('a structured receipt digest transition is productive without a gate revision bump', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		workflowInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
		workflowInternals.resolveIsWorkingTreeCleanAsync = async () => true;
		workflowInternals.resolvePrReviewDiffStatsAsync = async () => ({
			changedLines: 400,
			changedFiles: 12,
			hasSubmoduleChange: false,
		});
		workflowInternals.resolvePrWorkflowRevisionDigest = () => 'd'.repeat(64);
		await bindPrReviewBase(directory, sessionID, {
			prHeadSha: 'abc123',
			baseRef: 'origin/main',
			baseSha: 'def456',
		});
		await registerActiveBatch('receipt-batch', ['receipt-lane']);
		const activeState = await readPrWorkflowGateState(directory, sessionID);
		if (!activeState?.workflowInstanceId)
			throw new Error('missing active workflow');
		await recordPendingDelegation(directory, {
			correlationId: 'receipt-correlation',
			jobId: encodePrReviewWorkflowBinding(activeState.workflowInstanceId),
			subagentSessionId: 'receipt-correlation',
			parentSessionId: sessionID,
			callID: 'receipt-call',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'receipt-batch',
			laneId: 'receipt-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'receipt-lane',
			workflowGeneration: activeState.revision,
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			wakeCooldownMs: 0,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		await gate.event(idle);
		const submitted = JSON.parse(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: 1,
					revisionDigest: 'd'.repeat(64),
					result: {
						schemaVersion: 1,
						outcome: 'CLEAN',
						creditedLanes: ['receipt-lane'],
						findings: [],
						cleanAttestations: [
							{
								workflowLane: 'receipt-lane',
								coverageScope:
									'Persisted receipt transport for the active lane.',
								evidence:
									'The registered child submission was durably recovered.',
							},
						],
						unresolved: [],
					},
				},
				directory,
				{ sessionID: 'receipt-correlation' },
			),
		);
		expect(submitted).toMatchObject({ success: true, status: 'recorded' });
		await gate.event(idle);
		expect(gate._inspectWakeBudget(sessionID)?.consecutiveUnproductive).toBe(0);
	});

	test('cooldown wakes skip the durable progress scan', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await registerActiveBatch('cooldown-batch', ['cooldown-lane']);
		await recordPendingDelegation(directory, {
			correlationId: 'cooldown-correlation',
			jobId: null,
			subagentSessionId: 'cooldown-correlation',
			parentSessionId: sessionID,
			callID: 'cooldown-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'cooldown-batch',
			laneId: 'cooldown-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'cooldown-lane',
		});
		let scans = 0;
		responseInternals.scanDelegationsForRecovery = (targetDirectory) => {
			scans += 1;
			return originalDelegationScan(targetDirectory);
		};
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			wakeCooldownMs: 60_000,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		await gate.event(idle);
		await gate.event(idle);
		expect(gate._inspectWakeBudget(sessionID)?.consecutiveUnproductive).toBe(1);
		const scansAfterUnproductiveWake = scans;
		await gate.event(idle);
		await gate.event(idle);
		expect(scans).toBe(scansAfterUnproductiveWake);
	});

	test('a throwing recovery scan is treated as uncertain and never kills the wake', async () => {
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		responseInternals.scanDelegationsForRecovery = () => {
			throw new Error('scan blew up');
		};
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			wakeCooldownMs: 0,
		});
		const idle = { event: { type: 'session.idle', properties: { sessionID } } };
		// workflowProgressSnapshot must convert the throw into an uncertain
		// snapshot: the wake still fires (promptAsync called, budget updated)
		// instead of the error discarding the whole evaluation.
		await gate.event(idle);
		expect(promptAsync).toHaveBeenCalledTimes(1);
		const budget = gate._inspectWakeBudget(sessionID);
		expect(budget?.totalWakes).toBe(1);
		expect(budget?.consecutiveUnproductive).toBe(1);
		expect(budget?.suspended).toBe(false);
	});
});
