import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	compactBackgroundDelegations,
	findByCorrelationId,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

function buildEnvelope(
	overrides: Partial<PrReviewLaneResultEnvelope> = {},
): PrReviewLaneResultEnvelope {
	return {
		schemaVersion: 1,
		outcome: 'FINDINGS',
		creditedLanes: ['intent-architecture', 'security-trust'],
		findings: [
			{
				id: 'finding-1',
				workflowLane: 'intent-architecture',
				severity: 'HIGH',
				riskImpact: 'HIGH_IMPACT',
				riskTags: ['SECURITY'],
				title: 'Routing bypass remains reachable',
				body: 'The lane found a reachable bypass in the current review scope.',
				evidence:
					'Confirmed from the changed path and the reviewer-visible state snapshot.',
				location: {
					kind: 'local',
					file: 'src/review.ts',
					line: 12,
				},
			},
		],
		cleanAttestations: [
			{
				workflowLane: 'security-trust',
				coverageScope: 'Changed trust-boundary checks only',
				evidence:
					'The diff keeps the trust boundary unchanged outside the reviewed branch.',
			},
		],
		unresolved: [],
		...overrides,
	};
}

function buildReceipt(overrides: Record<string, unknown> = {}) {
	const envelope = buildEnvelope(
		(overrides.envelope as Partial<PrReviewLaneResultEnvelope> | undefined) ??
			{},
	);
	return {
		schemaVersion: 1,
		mode: 'swarm-pr-review:base' as const,
		workflowInstanceId: 'wf-2384',
		workflowRevision: 7,
		batchId: 'batch-2384',
		laneId: 'lane-2384',
		workflowLane: 'intent-architecture',
		ownedWorkflowLanes: ['intent-architecture', 'security-trust'],
		baseSha: 'abc1234',
		headSha: 'def5678',
		dispatchRevisionDigest: 'd'.repeat(64),
		childSessionId: 'child-2384',
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
		...overrides,
	};
}

async function seedReceiptLane(directory: string): Promise<void> {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	await recordPendingDelegation(directory, {
		correlationId: 'child-2384',
		jobId: encodePrReviewWorkflowBinding('wf-2384'),
		subagentSessionId: 'child-2384',
		parentSessionId: 'parent-2384',
		callID: 'call-2384',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-2384',
		laneId: 'lane-2384',
		mode: 'swarm-pr-review:base',
		workflowLane: 'intent-architecture',
		ownedWorkflowLanes: ['intent-architecture', 'security-trust'],
		workflowGeneration: 7,
		generation: 1,
		workspace: {
			directory,
			gitHead: 'def5678',
			dirtyHash: null,
			prHeadSha: 'def5678',
			scope: null,
		},
	});
}

function basePublicationInput() {
	return {
		parentSessionId: 'parent-2384',
		childSessionId: 'child-2384',
		batchId: 'batch-2384',
		laneId: 'lane-2384',
		expectedWorkflowInstanceId: 'wf-2384',
		expectedWorkflowRevision: 7,
		expectedBaseSha: 'abc1234',
		receipt: buildReceipt(),
	};
}

describe('PR-review result receipt lifecycle regressions (#2384)', () => {
	test('publish then ordinary terminal claim preserves the bound receipt and duplicate replay remains duplicate (F-001/F-018)', async () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-lifecycle-');
		try {
			await seedReceiptLane(safe.dir);
			expect(
				(await publishPrReviewResultReceipt(safe.dir, basePublicationInput()))
					.status,
			).toBe('recorded');

			const terminalText = 'ordinary completion text';
			const terminal = {
				eventId: buildBackgroundCompletionEventId({
					correlationId: 'child-2384',
					jobId: encodePrReviewWorkflowBinding('wf-2384'),
					status: 'completed',
					resultDigest: 'e'.repeat(64),
				}),
				status: 'completed' as const,
				recordedAt: 42,
				result: {
					text: terminalText,
					chars: terminalText.length,
					truncated: false,
					digest: 'e'.repeat(64),
				},
			};

			const first = await claimTerminalResult(safe.dir, 'child-2384', terminal);
			expect(first?.disposition).toBe('claimed');
			expect(first?.record.result?.prReviewResultReceipt).toEqual(
				buildReceipt(),
			);
			expect(
				first?.record.terminalResult?.result.prReviewResultReceipt,
			).toEqual(buildReceipt());

			const replay = await claimTerminalResult(
				safe.dir,
				'child-2384',
				terminal,
			);
			expect(replay?.disposition).toBe('duplicate');
			expect(
				replay?.record.terminalResult?.result.prReviewResultReceipt,
			).toEqual(buildReceipt());
		} finally {
			safe.cleanup();
		}
	});

	test('publication rejects wrong session coordinates, stale identity, and already-terminal rows (FB-003/018)', async () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-negative-');
		try {
			await seedReceiptLane(safe.dir);
			for (const scenario of [
				{
					label: 'wrong parent session',
					input: { ...basePublicationInput(), parentSessionId: 'other-parent' },
					status: 'not_found',
				},
				{
					label: 'wrong child session',
					input: { ...basePublicationInput(), childSessionId: 'other-child' },
					status: 'not_found',
				},
				{
					label: 'cross-lane batch',
					input: { ...basePublicationInput(), batchId: 'other-batch' },
					status: 'not_found',
				},
				{
					label: 'cross-lane lane id',
					input: { ...basePublicationInput(), laneId: 'other-lane' },
					status: 'not_found',
				},
				{
					label: 'stale workflow revision expectation',
					input: {
						...basePublicationInput(),
						expectedWorkflowRevision: 8,
					},
					status: 'conflict',
				},
				{
					label: 'stale head sha inside receipt',
					input: {
						...basePublicationInput(),
						receipt: buildReceipt({ headSha: 'feed999' }),
					},
					status: 'conflict',
				},
				{
					label: 'stale generation inside receipt',
					input: {
						...basePublicationInput(),
						receipt: buildReceipt({ generation: 2 }),
					},
					status: 'conflict',
				},
			] as const) {
				expect(
					(await publishPrReviewResultReceipt(safe.dir, scenario.input)).status,
					scenario.label,
				).toBe(scenario.status);
			}

			await appendDelegationTransition(safe.dir, 'child-2384', {
				status: 'completed',
				result: {
					text: 'done',
					chars: 4,
					truncated: false,
					digest: 'f'.repeat(64),
				},
			});
			expect(
				(await publishPrReviewResultReceipt(safe.dir, basePublicationInput()))
					.status,
			).toBe('terminal');
		} finally {
			safe.cleanup();
		}
	});

	test('semantically equivalent receipt replay is duplicate when set-like arrays are reordered (FB-014)', async () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-reordered-');
		try {
			await seedReceiptLane(safe.dir);
			const firstFinding = {
				id: 'finding-1',
				workflowLane: 'intent-architecture',
				severity: 'HIGH' as const,
				riskImpact: 'HIGH_IMPACT' as const,
				riskTags: ['SECURITY', 'WRITE_PATH'],
				title: 'Routing bypass remains reachable',
				body: 'The lane found a reachable bypass in the current review scope.',
				evidence:
					'Confirmed from the changed path and the reviewer-visible state snapshot.',
				location: {
					kind: 'local' as const,
					file: 'src/review.ts',
					line: 12,
				},
			};
			const secondFinding = {
				id: 'finding-2',
				workflowLane: 'security-trust',
				severity: 'MEDIUM' as const,
				riskImpact: 'ORDINARY' as const,
				riskTags: ['AUTH_PERMISSIONS', 'STATE_INTEGRITY'],
				title: 'Secondary finding',
				body: 'A second finding proves object-array order is ignored.',
				evidence: 'The replay duplicates even when finding rows are reordered.',
				location: {
					kind: 'local' as const,
					file: 'src/secondary-review.ts',
					line: 27,
				},
			};
			const initialEnvelope = buildEnvelope({
				cleanAttestations: [],
				findings: [firstFinding, secondFinding],
			});
			expect(
				(
					await publishPrReviewResultReceipt(safe.dir, {
						...basePublicationInput(),
						receipt: buildReceipt({
							envelope: initialEnvelope,
						}),
					})
				).status,
			).toBe('recorded');

			const reorderedEnvelope = buildEnvelope({
				creditedLanes: ['security-trust', 'intent-architecture'],
				cleanAttestations: [],
				findings: [secondFinding, firstFinding],
			});
			const replay = {
				...basePublicationInput(),
				receipt: buildReceipt({
					ownedWorkflowLanes: ['security-trust', 'intent-architecture'],
					envelope: reorderedEnvelope,
				}),
			};
			expect(
				(await publishPrReviewResultReceipt(safe.dir, replay)).status,
			).toBe('duplicate');
		} finally {
			safe.cleanup();
		}
	});

	test('closed summaries keep the receipt authority on result while stripping the duplicate terminal copy (FB-012)', async () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-closed-');
		try {
			await seedReceiptLane(safe.dir);
			expect(
				(await publishPrReviewResultReceipt(safe.dir, basePublicationInput()))
					.status,
			).toBe('recorded');
			const terminalText = 'ordinary completion text';
			await claimTerminalResult(safe.dir, 'child-2384', {
				eventId: buildBackgroundCompletionEventId({
					correlationId: 'child-2384',
					jobId: encodePrReviewWorkflowBinding('wf-2384'),
					status: 'completed',
					resultDigest: 'a'.repeat(64),
				}),
				status: 'completed',
				recordedAt: 42,
				result: {
					text: terminalText,
					chars: terminalText.length,
					truncated: false,
					digest: 'a'.repeat(64),
				},
			});

			const compacted = await compactBackgroundDelegations(safe.dir, {
				force: true,
			});
			expect(compacted.status).toBe('compacted');

			const checkpoint = JSON.parse(
				fs.readFileSync(
					path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
					'utf-8',
				),
			) as {
				closed: Array<{
					result?: { prReviewResultReceipt?: unknown };
					terminalResult?: { result?: { prReviewResultReceipt?: unknown } };
				}>;
			};
			expect(checkpoint.closed).toHaveLength(1);
			expect(checkpoint.closed[0]?.result?.prReviewResultReceipt).toEqual(
				buildReceipt(),
			);
			expect(
				checkpoint.closed[0]?.terminalResult?.result?.prReviewResultReceipt,
			).toBeUndefined();
			expect(
				findByCorrelationId(safe.dir, 'child-2384')?.result
					?.prReviewResultReceipt,
			).toEqual(buildReceipt());
		} finally {
			safe.cleanup();
		}
	});
});
