import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
	buildReviewRouteReceipt,
	enforceReviewRouteReceipt,
	persistReviewRouteReceipt,
	readReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('issue #2491 — route receipt and Stage-B enforcement (AC2–AC3)', () => {
	test('persists and reads back a route receipt bound to the project root', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			const routeReceipt = buildReviewRouteReceipt({
				sessionId: 'session-2491',
				taskId: '2491-route',
				complexity: 'high',
				semanticRisk: 'cross_cutting',
				requiredReviewers: ['reviewer-a', 'reviewer-b'],
				requiredTestEngineers: ['test-engineer-a', 'test-engineer-b'],
			});

			const persisted = await persistReviewRouteReceipt({
				projectRoot,
				receipt: routeReceipt,
			});
			const readBack = await readReviewRouteReceipt({
				projectRoot,
				sessionId: 'session-2491',
				taskId: '2491-route',
			});

			expect(persisted).toMatchObject({ persisted: true });
			expect(readBack).toMatchObject({
				kind: 'review_route_receipt',
				version: 1,
				sessionId: 'session-2491',
				taskId: '2491-route',
				required: { reviewers: 2, testEngineers: 2 },
				identities: {
					reviewers: ['reviewer-a', 'reviewer-b'],
					testEngineers: ['test-engineer-a', 'test-engineer-b'],
				},
			});

			// The receipt must be durable, not only returned by the write call.
			const receiptBytes = await readFile(persisted.path, 'utf8');
			expect(JSON.parse(receiptBytes)).toEqual(readBack);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('requires the exact independent receipt count and role type before advancing', () => {
		const routeReceipt = buildReviewRouteReceipt({
			sessionId: 'session-2491',
			taskId: '2491-settlement',
			complexity: 'high',
			semanticRisk: 'cross_cutting',
			requiredReviewers: ['reviewer-a', 'reviewer-b'],
			requiredTestEngineers: ['test-engineer-a'],
		});

		const exactIndependentSet = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [
				{ role: 'reviewer', identity: 'reviewer-a' },
				{ role: 'reviewer', identity: 'reviewer-b' },
				{ role: 'test_engineer', identity: 'test-engineer-a' },
			],
		});
		expect(exactIndependentSet).toMatchObject({ canAdvance: true });
	});

	test.each([
		{
			name: 'unlisted identity',
			receipts: [
				{ role: 'reviewer', identity: 'reviewer-x' },
				{ role: 'reviewer', identity: 'reviewer-b' },
				{ role: 'test_engineer', identity: 'test-engineer-a' },
			],
			reason: 'ROUTE_RECEIPT_IDENTITY_UNLISTED',
		},
		{
			name: 'duplicate identity',
			receipts: [
				{ role: 'reviewer', identity: 'reviewer-a' },
				{ role: 'reviewer', identity: 'reviewer-a' },
				{ role: 'test_engineer', identity: 'test-engineer-a' },
			],
			reason: 'ROUTE_RECEIPT_DUPLICATE',
		},
		{
			name: 'wrong role for listed identity',
			receipts: [
				{ role: 'test_engineer', identity: 'reviewer-a' },
				{ role: 'reviewer', identity: 'reviewer-b' },
				{ role: 'test_engineer', identity: 'test-engineer-a' },
			],
			reason: 'ROUTE_RECEIPT_ROLE_MISMATCH',
		},
	] as const)('$name blocks Stage-B advancement', ({ receipts, reason }) => {
		const routeReceipt = buildReviewRouteReceipt({
			sessionId: 'session-2491',
			taskId: '2491-reject',
			complexity: 'high',
			semanticRisk: 'cross_cutting',
			requiredReviewers: ['reviewer-a', 'reviewer-b'],
			requiredTestEngineers: ['test-engineer-a'],
		});

		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts,
		});
		expect(result).toMatchObject({ canAdvance: false, reason });
	});

	test('only an explicit router-error receipt follows the fail-open default', () => {
		const explicitRouterError = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt: {
				kind: 'review_route_router_error',
				version: 1,
				code: 'ROUTER_UNAVAILABLE',
				failOpen: true,
			},
			receipts: [],
		});
		expect(explicitRouterError).toMatchObject({
			canAdvance: true,
			mode: 'fail_open',
			routerFailure: 'ROUTER_UNAVAILABLE',
		});

		const absentReceipt = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt: null,
			receipts: [],
		});
		expect(absentReceipt).toMatchObject({
			canAdvance: false,
			reason: 'ROUTE_RECEIPT_MISSING',
		});
	});
});
