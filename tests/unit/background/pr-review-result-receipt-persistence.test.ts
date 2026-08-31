import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	compactBackgroundDelegations,
	findByCorrelationId,
	publishPrReviewResultReceipt,
	readDelegations,
	recordPendingDelegation,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations.js';
import {
	type PrReviewLaneResultEnvelope,
	PrReviewResultReceiptSchema,
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

describe('PR-review result receipt persistence (#2384)', () => {
	test('strict receipt schema enforces semantic digest and owned-lane partition', () => {
		const valid = buildReceipt();
		const parsed = PrReviewResultReceiptSchema.safeParse(valid);
		expect(parsed.success).toBe(true);

		const wrongDigest = PrReviewResultReceiptSchema.safeParse({
			...valid,
			semanticEnvelopeDigest: '0'.repeat(64),
		});
		expect(wrongDigest.success).toBe(false);

		const missingOwnedCoverage = PrReviewResultReceiptSchema.safeParse(
			buildReceipt({
				ownedWorkflowLanes: ['intent-architecture'],
			}),
		);
		expect(missingOwnedCoverage.success).toBe(false);
	});

	test('v4 background records preserve the structured receipt through compaction without reusing transcript text', async () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-');
		try {
			const directory = safe.dir;
			fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
			fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
			await recordPendingDelegation(directory, {
				correlationId: 'corr-2384',
				jobId: null,
				subagentSessionId: 'corr-2384',
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
			});
			const transcript =
				'agent transcript\n[PR_REVIEW_RESULT_RECEIPT_V1] forged marker';
			const terminalResult = {
				text: transcript,
				chars: transcript.length,
				truncated: false,
				digest: 'b'.repeat(64),
				outputRef: `L1:${'c'.repeat(64)}:${'d'.repeat(64)}:${'b'.repeat(64)}`,
				prReviewResultReceipt: buildReceipt(),
			};

			const claimed = await appendDelegationTransition(directory, 'corr-2384', {
				status: 'completed',
				result: terminalResult,
			});
			expect(claimed?.schemaVersion).toBe(4);
			expect(
				claimed?.result?.prReviewResultReceipt?.semanticEnvelopeDigest,
			).toBe(prReviewLaneResultEnvelopeDigest(buildReceipt().envelope));

			const compacted = await compactBackgroundDelegations(directory, {
				force: true,
			});
			expect(compacted.status).toBe('compacted');

			const reloaded = findByCorrelationId(directory, 'corr-2384');
			expect(reloaded?.schemaVersion).toBe(4);
			expect(reloaded?.result?.text).toBeUndefined();
			expect(reloaded?.result?.chars).toBe(transcript.length);
			expect(reloaded?.result?.digest).toBe('b'.repeat(64));
			expect(reloaded?.result?.outputRef).toBe(
				`L1:${'c'.repeat(64)}:${'d'.repeat(64)}:${'b'.repeat(64)}`,
			);
			expect(reloaded?.result?.prReviewResultReceipt).toEqual(buildReceipt());
			const checkpoint = JSON.parse(
				fs.readFileSync(
					path.join(
						directory,
						'.swarm',
						BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
					),
					'utf-8',
				),
			) as {
				closed: Array<{
					result?: { text?: string; prReviewResultReceipt?: unknown };
				}>;
			};
			expect(checkpoint.closed).toHaveLength(1);
			expect(checkpoint.closed[0]?.result?.text).toBeUndefined();
			expect(checkpoint.closed[0]?.result?.prReviewResultReceipt).toEqual(
				buildReceipt(),
			);
		} finally {
			safe.cleanup();
		}
	});

	test('strict recovery fails closed on malformed v4 receipt state', () => {
		const safe = createSafeTestDir('swarm-pr-review-receipt-bad-');
		try {
			const swarmDir = path.join(safe.dir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			const transcript = 'persisted transcript';
			const badReceipt = buildReceipt({
				semanticEnvelopeDigest: '0'.repeat(64),
			});
			const record = {
				schemaVersion: 4,
				correlationId: 'corr-bad-2384',
				jobId: null,
				subagentSessionId: 'corr-bad-2384',
				parentSessionId: 'parent-2384',
				callID: 'call-2384',
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: null,
				evidenceTaskId: null,
				status: 'completed',
				createdAt: 1,
				updatedAt: 2,
				completedAt: 2,
				result: {
					text: transcript,
					chars: transcript.length,
					truncated: false,
					digest: 'e'.repeat(64),
					prReviewResultReceipt: badReceipt,
				},
				terminalResult: {
					eventId: 'bgc1:' + 'f'.repeat(64),
					status: 'completed',
					recordedAt: 2,
					result: {
						text: transcript,
						chars: transcript.length,
						truncated: false,
						digest: 'e'.repeat(64),
						prReviewResultReceipt: badReceipt,
					},
				},
			};
			fs.writeFileSync(
				path.join(swarmDir, 'background-delegations.jsonl'),
				`${JSON.stringify(record)}\n`,
				'utf-8',
			);

			expect(readDelegations(safe.dir)).toEqual([]);
			expect(scanDelegationsForRecovery(safe.dir).status).toBe('uncertain');
		} finally {
			safe.cleanup();
		}
	});

	test('receipt publication is child-bound, idempotent, and conflict-safe', async () => {
		const safe = createSafeTestDir('swarm-pr-review-submit-');
		try {
			const directory = safe.dir;
			fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
			await recordPendingDelegation(directory, {
				correlationId: 'child-2384',
				jobId: null,
				subagentSessionId: 'child-2384',
				parentSessionId: 'parent-2384',
				callID: 'call-2384',
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: 'batch-2384',
				laneId: 'lane-2384',
				mode: 'swarm-pr-review:base',
				workflowLane: 'intent-architecture',
				ownedWorkflowLanes: ['intent-architecture', 'security-trust'],
				generation: 1,
				workspace: {
					directory,
					gitHead: 'def5678',
					dirtyHash: null,
					prHeadSha: 'def5678',
					scope: null,
				},
			});
			const input = {
				parentSessionId: 'parent-2384',
				childSessionId: 'child-2384',
				batchId: 'batch-2384',
				laneId: 'lane-2384',
				expectedWorkflowInstanceId: 'wf-2384',
				expectedWorkflowRevision: 7,
				expectedBaseSha: 'abc1234',
				receipt: buildReceipt(),
			};
			expect(findByCorrelationId(directory, 'child-2384')?.schemaVersion).toBe(
				2,
			);
			expect(
				(await publishPrReviewResultReceipt(directory, input)).status,
			).toBe('recorded');
			expect(findByCorrelationId(directory, 'child-2384')?.schemaVersion).toBe(
				4,
			);
			expect(
				(await publishPrReviewResultReceipt(directory, input)).status,
			).toBe('duplicate');
			expect(
				(
					await publishPrReviewResultReceipt(directory, {
						...input,
						receipt: buildReceipt({ workflowRevision: 8 }),
					})
				).status,
			).toBe('conflict');
			const envelope = buildEnvelope({
				findings: [{ ...buildEnvelope().findings[0], id: 'different-finding' }],
			});
			expect(
				(
					await publishPrReviewResultReceipt(directory, {
						...input,
						receipt: buildReceipt({
							envelope,
							semanticEnvelopeDigest:
								prReviewLaneResultEnvelopeDigest(envelope),
						}),
					})
				).status,
			).toBe('conflict');
		} finally {
			safe.cleanup();
		}
	});

	test('reordered but semantically equivalent receipt replays as duplicate (FB-014)', async () => {
		const safe = createSafeTestDir('swarm-pr-review-reordered-receipt-');
		try {
			const directory = safe.dir;
			fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
			await recordPendingDelegation(directory, {
				correlationId: 'child-2384',
				jobId: null,
				subagentSessionId: 'child-2384',
				parentSessionId: 'parent-2384',
				callID: 'call-2384',
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: 'batch-2384',
				laneId: 'lane-2384',
				mode: 'swarm-pr-review:base',
				workflowLane: 'intent-architecture',
				ownedWorkflowLanes: ['intent-architecture', 'security-trust'],
				generation: 1,
				workspace: {
					directory,
					gitHead: 'def5678',
					dirtyHash: null,
					prHeadSha: 'def5678',
					scope: null,
				},
			});
			const base = {
				parentSessionId: 'parent-2384',
				childSessionId: 'child-2384',
				batchId: 'batch-2384',
				laneId: 'lane-2384',
				expectedWorkflowInstanceId: 'wf-2384',
				expectedWorkflowRevision: 7,
				expectedBaseSha: 'abc1234',
			};
			const findingOne = buildEnvelope().findings[0];
			const findingTwo = {
				...findingOne,
				id: 'finding-2',
				workflowLane: 'security-trust',
				title: 'Secondary routed bypass remains reachable',
			};
			const equivalentEnvelope = {
				...buildEnvelope({
					creditedLanes: ['security-trust', 'intent-architecture'],
					findings: [findingTwo, findingOne],
					cleanAttestations: [],
				}),
			};
			const first = await publishPrReviewResultReceipt(directory, {
				...base,
				receipt: buildReceipt({ envelope: equivalentEnvelope }),
			});
			expect(first.status).toBe('recorded');
			const duplicate = await publishPrReviewResultReceipt(directory, {
				...base,
				receipt: buildReceipt({
					envelope: {
						...equivalentEnvelope,
						creditedLanes: ['intent-architecture', 'security-trust'],
						findings: [findingOne, findingTwo],
						cleanAttestations: [],
					},
				}),
			});
			expect(duplicate.status).toBe('duplicate');
		} finally {
			safe.cleanup();
		}
	});

	test('concurrent publication serializes identical replays and conflicting results', async () => {
		for (const scenario of ['identical', 'conflicting'] as const) {
			const safe = createSafeTestDir(`swarm-pr-review-concurrent-${scenario}-`);
			try {
				const directory = safe.dir;
				fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
				await recordPendingDelegation(directory, {
					correlationId: 'child-2384',
					jobId: null,
					subagentSessionId: 'child-2384',
					parentSessionId: 'parent-2384',
					callID: 'call-2384',
					normalizedAgent: 'explorer',
					swarmPrefixedAgent: 'explorer',
					planTaskId: null,
					evidenceTaskId: null,
					batchId: 'batch-2384',
					laneId: 'lane-2384',
					mode: 'swarm-pr-review:base',
					workflowLane: 'intent-architecture',
					ownedWorkflowLanes: ['intent-architecture', 'security-trust'],
					generation: 1,
					workspace: {
						directory,
						gitHead: 'def5678',
						dirtyHash: null,
						prHeadSha: 'def5678',
						scope: null,
					},
				});
				const baseInput = {
					parentSessionId: 'parent-2384',
					childSessionId: 'child-2384',
					batchId: 'batch-2384',
					laneId: 'lane-2384',
					expectedWorkflowInstanceId: 'wf-2384',
					expectedWorkflowRevision: 7,
					expectedBaseSha: 'abc1234',
					receipt: buildReceipt(),
				};
				const otherEnvelope = buildEnvelope({
					findings: [
						{ ...buildEnvelope().findings[0], id: 'concurrent-conflict' },
					],
				});
				const otherInput =
					scenario === 'identical'
						? baseInput
						: {
								...baseInput,
								receipt: buildReceipt({
									envelope: otherEnvelope,
									semanticEnvelopeDigest:
										prReviewLaneResultEnvelopeDigest(otherEnvelope),
								}),
							};
				const statuses = (
					await Promise.all([
						publishPrReviewResultReceipt(directory, baseInput),
						publishPrReviewResultReceipt(directory, otherInput),
					])
				).map((outcome) => outcome.status);
				expect(statuses.filter((status) => status === 'recorded')).toHaveLength(
					1,
				);
				expect(statuses).toContain(
					scenario === 'identical' ? 'duplicate' : 'conflict',
				);
			} finally {
				safe.cleanup();
			}
		}
	});
});
