import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isLegacyTaskGateRequirementsChain,
	readTaskGateRequirementsReceipts,
	routeEvidenceFromTaskGateRequirements,
} from '../../../src/evidence/task-gate-requirements.js';
import {
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	buildReviewRouteReceipt,
	buildReviewRouteRouterError,
	enforcePersistedReviewRouteReceipt,
	enforceReviewRouteReceipt,
	persistReviewRouteReceipt,
	readReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const route = buildReviewRouteReceipt({
	sessionId: 'parent-2491',
	taskId: '1.1',
	complexity: 'high',
	semanticRisk: 'cross_cutting',
	requiredReviewers: ['reviewer-a'],
	requiredTestEngineers: [],
});

const completeBinding = {
	role: 'reviewer' as const,
	identity: 'reviewer-a',
	sessionId: 'parent-2491',
	taskId: '1.1',
	slotId: '1.1:reviewer:1',
	callId: 'review-call-1',
	childSessionId: 'review-child-1',
	generation: 4,
};

describe('issue #2491 adversarial route enforcement', () => {
	test('live enforcement rejects missing or wrong call/child/generation bindings', () => {
		const cases = [
			['missing call', { callId: undefined }, 'ROUTE_RECEIPT_BINDING_MISSING'],
			[
				'wrong call',
				{ callId: 'review-call-other' },
				'ROUTE_RECEIPT_DISPATCH_MISMATCH',
			],
			[
				'missing child',
				{ childSessionId: undefined },
				'ROUTE_RECEIPT_BINDING_MISSING',
			],
			[
				'wrong child',
				{ childSessionId: 'review-child-other' },
				'ROUTE_RECEIPT_DISPATCH_MISMATCH',
			],
			[
				'missing generation',
				{ generation: undefined },
				'ROUTE_RECEIPT_BINDING_MISSING',
			],
			[
				'wrong generation',
				{ generation: 5 },
				'ROUTE_RECEIPT_DISPATCH_MISMATCH',
			],
		] as const;

		for (const [_name, patch, reason] of cases) {
			const result = enforceReviewRouteReceipt({
				enforcementEnabled: true,
				routeReceipt: route,
				receipts: [{ ...completeBinding, ...patch }],
				sessionId: 'parent-2491',
				taskId: '1.1',
				requireEvidenceBindings: true,
				expectedDispatch: completeBinding,
			});
			expect(result.canAdvance).toBe(false);
			expect(result.reason).toBe(reason);
		}
	});

	test('wrong-bound router errors cannot take the live fail-open branch', () => {
		const right = buildReviewRouteRouterError({
			code: 'ROUTER_UNAVAILABLE',
			sessionId: 'parent-2491',
			taskId: '1.1',
		});
		const wrong = buildReviewRouteRouterError({
			code: 'ROUTER_UNAVAILABLE',
			sessionId: 'other-session',
			taskId: 'other-task',
		});

		expect(
			enforceReviewRouteReceipt({
				enforcementEnabled: true,
				routeReceipt: right,
				receipts: [],
				sessionId: 'parent-2491',
				taskId: '1.1',
			}),
		).toMatchObject({ canAdvance: true, mode: 'fail_open' });
		expect(
			enforceReviewRouteReceipt({
				enforcementEnabled: true,
				routeReceipt: wrong,
				receipts: [],
				sessionId: 'parent-2491',
				taskId: '1.1',
			}),
		).toMatchObject({
			canAdvance: false,
			reason: 'ROUTE_RECEIPT_IDENTITY_MISMATCH',
		});
	});

	test('typed router exception receipt is durably bound to its task', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-router-error-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			await persistReviewRouteReceipt({
				projectRoot,
				receipt: buildReviewRouteRouterError({
					code: 'ROUTER_FAILED',
					sessionId: 'parent-2491',
					taskId: '1.1',
					detail: 'router exception',
				}),
			});
			expect(
				await readReviewRouteReceipt({
					projectRoot,
					sessionId: 'parent-2491',
					taskId: '1.1',
				}),
			).toMatchObject({
				kind: 'review_route_router_error',
				code: 'ROUTER_FAILED',
				sessionId: 'parent-2491',
				taskId: '1.1',
			});
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('missing new-work receipt blocks while an explicit durable legacy chain discloses fail-open', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-adversarial-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			const missing = enforcePersistedReviewRouteReceipt({
				projectRoot,
				sessionId: 'parent-2491',
				taskId: '1.1',
				receipts: [],
				enforcementEnabled: true,
			});
			expect(missing).toMatchObject({
				canAdvance: false,
				reason: 'ROUTE_RECEIPT_MISSING',
			});

			await transitionTaskWorkflowEvidence(projectRoot, '1.3', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder:1.3',
			});
			await transitionTaskWorkflowEvidence(projectRoot, '1.3', {
				type: 'stage_a_passed',
				expectedGeneration: 1,
				transitionId: 'stage-a:1.3',
			});
			await recordGateEvidence(
				projectRoot,
				'1.3',
				'reviewer',
				'legacy-reviewer',
				undefined,
				{ expectedGeneration: 1, transitionId: 'review:1.3' },
			);
			const legacyReceipts = await readTaskGateRequirementsReceipts(
				projectRoot,
				'1.3',
			);
			expect(isLegacyTaskGateRequirementsChain(legacyReceipts)).toBe(true);
			const legacy = enforcePersistedReviewRouteReceipt({
				projectRoot,
				sessionId: 'parent-2491',
				taskId: '1.3',
				receipts: routeEvidenceFromTaskGateRequirements(legacyReceipts),
				enforcementEnabled: true,
				legacyUnrouted: isLegacyTaskGateRequirementsChain(legacyReceipts),
			});
			expect(legacy).toMatchObject({
				canAdvance: true,
				mode: 'legacy_unrouted',
			});
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('task-gate route bindings reconstruct after the in-memory session is gone', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-restart-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			await persistReviewRouteReceipt({ projectRoot, receipt: route });
			await transitionTaskWorkflowEvidence(projectRoot, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder:1.1',
			});
			await transitionTaskWorkflowEvidence(projectRoot, '1.1', {
				type: 'stage_a_passed',
				expectedGeneration: 1,
				transitionId: 'stage-a:1.1',
			});
			await recordGateEvidence(
				projectRoot,
				'1.1',
				'reviewer',
				'parent-2491',
				undefined,
				{
					expectedGeneration: 1,
					transitionId: 'review-call-1:1.1',
					routeBinding: completeBinding,
				},
			);

			const durable = await readTaskGateRequirementsReceipts(
				projectRoot,
				'1.1',
			);
			const reconstructed = routeEvidenceFromTaskGateRequirements(durable);
			expect(reconstructed).toEqual([completeBinding]);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});
});
