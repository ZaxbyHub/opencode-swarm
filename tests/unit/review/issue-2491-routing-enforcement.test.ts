import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { resolveHiveDataDir } from '../../../src/knowledge/hive-paths.js';
import {
	buildReviewRouteReceipt,
	enforceReviewRouteReceipt,
	persistReviewRouteReceipt,
	readReviewRouteReceipt,
	readReviewRouteReceiptSync,
	routeReceiptPathForTask,
} from '../../../src/review/routing-enforcement.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
});

afterEach(() => {
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

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

	test('authenticates workspace-tampering receipts with an app-data key across project/restart state', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-mac-');
		const secondProjectRoot = canonicalMkdtemp('issue-2491-route-mac-copy-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			await mkdir(join(secondProjectRoot, '.opencode'), { recursive: true });
			const routeReceipt = buildReviewRouteReceipt({
				sessionId: 'session-2491',
				taskId: '2491-restart-copy',
				complexity: 'high',
				semanticRisk: 'cross_cutting',
				requiredReviewers: ['reviewer-a'],
				requiredTestEngineers: [],
			});
			const persisted = await persistReviewRouteReceipt({
				projectRoot,
				receipt: routeReceipt,
			});
			const persistedValue = JSON.parse(
				await readFile(persisted.path, 'utf8'),
			) as { mac?: unknown };
			expect(typeof persistedValue.mac).toBe('string');
			const keyPath = join(resolveHiveDataDir(), 'review-route-receipts.key');
			expect(keyPath.startsWith(join(projectRoot, '.swarm'))).toBe(false);
			expect(keyPath.startsWith(join(secondProjectRoot, '.swarm'))).toBe(false);

			// Copying the authenticated workspace artifact to a different project
			// must still verify: the key is user-scoped, not project-local.
			const copiedPath = routeReceiptPathForTask(
				secondProjectRoot,
				'session-2491',
				'2491-restart-copy',
			);
			await mkdir(
				join(secondProjectRoot, '.swarm', 'pr-review', 'route-receipts'),
				{
					recursive: true,
				},
			);
			await writeFile(copiedPath, await readFile(persisted.path));
			expect(
				await readReviewRouteReceipt({
					projectRoot: secondProjectRoot,
					sessionId: 'session-2491',
					taskId: '2491-restart-copy',
				}),
			).toMatchObject({
				kind: 'review_route_receipt',
				mac: persistedValue.mac,
			});
			expect(
				readReviewRouteReceiptSync({
					projectRoot: secondProjectRoot,
					sessionId: 'session-2491',
					taskId: '2491-restart-copy',
				}),
			).toMatchObject({
				kind: 'review_route_receipt',
				mac: persistedValue.mac,
			});
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
			await rm(secondProjectRoot, { recursive: true, force: true });
		}
	});

	test('fails closed when a persisted receipt is tampered or its MAC is missing', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-tamper-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			const persisted = await persistReviewRouteReceipt({
				projectRoot,
				receipt: buildReviewRouteReceipt({
					sessionId: 'session-2491',
					taskId: '2491-tamper',
					complexity: 'high',
					semanticRisk: 'cross_cutting',
					requiredReviewers: ['reviewer-a'],
					requiredTestEngineers: [],
				}),
			});
			const original = JSON.parse(
				await readFile(persisted.path, 'utf8'),
			) as Record<string, unknown>;
			await writeFile(
				persisted.path,
				JSON.stringify({ ...original, complexity: 'tampered' }),
			);
			await expect(
				readReviewRouteReceipt({
					projectRoot,
					sessionId: 'session-2491',
					taskId: '2491-tamper',
				}),
			).rejects.toThrow('ROUTE_RECEIPT_AUTH_INVALID');

			const { mac: _mac, ...withoutMac } = original;
			await writeFile(persisted.path, JSON.stringify(withoutMac));
			expect(() =>
				readReviewRouteReceiptSync({
					projectRoot,
					sessionId: 'session-2491',
					taskId: '2491-tamper',
				}),
			).toThrow('ROUTE_RECEIPT_AUTH_INVALID');
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('fails closed when the app-data key is not a regular file', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-key-type-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			const persisted = await persistReviewRouteReceipt({
				projectRoot,
				receipt: buildReviewRouteReceipt({
					sessionId: 'session-2491',
					taskId: '2491-key-type',
					complexity: 'high',
					semanticRisk: 'cross_cutting',
					requiredReviewers: ['reviewer-a'],
					requiredTestEngineers: [],
				}),
			});
			const keyPath = join(resolveHiveDataDir(), 'review-route-receipts.key');
			await rm(keyPath, { force: true });
			await mkdir(keyPath, { recursive: true });
			expect(() =>
				readReviewRouteReceiptSync({
					projectRoot,
					sessionId: 'session-2491',
					taskId: '2491-key-type',
				}),
			).toThrow('ROUTE_RECEIPT_AUTH_INVALID');
			await rm(persisted.path, { force: true });
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('uses distinct receipt paths when identities contain the separator (FB-026)', async () => {
		// Previously the raw `--` separator made (a--b, c) collide with
		// (a, b--c), allowing one route receipt to overwrite the other.
		const projectRoot = canonicalMkdtemp('issue-2491-route-path-');
		try {
			expect(routeReceiptPathForTask(projectRoot, 'a--b', 'c')).not.toBe(
				routeReceiptPathForTask(projectRoot, 'a', 'b--c'),
			);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('bounds long identity receipt filename components', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-long-path-');
		try {
			const receiptPath = routeReceiptPathForTask(
				projectRoot,
				'x'.repeat(256),
				'2491-long-identity',
			);
			const fileName = basename(receiptPath);
			expect(fileName).toContain('sha256_');
			expect(fileName.length).toBeLessThan(220);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('bounds the complete Stage-B receipt filename and keeps long identity pairs distinct', () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-long-pair-');
		try {
			// Previously each component was bounded independently, allowing two
			// valid 135-byte identities to produce a 367-byte basename.
			const sessionId = 's'.repeat(135);
			const firstTaskId = 't'.repeat(135);
			const secondTaskId = 'u'.repeat(135);
			const firstPath = routeReceiptPathForTask(
				projectRoot,
				sessionId,
				firstTaskId,
			);
			const secondPath = routeReceiptPathForTask(
				projectRoot,
				sessionId,
				secondTaskId,
			);

			expect(
				Buffer.byteLength(basename(firstPath), 'utf8'),
			).toBeLessThanOrEqual(255);
			expect(
				Buffer.byteLength(basename(secondPath), 'utf8'),
			).toBeLessThanOrEqual(255);
			expect(firstPath).not.toBe(secondPath);
		} finally {
			void rm(projectRoot, { recursive: true, force: true });
		}
	});

	test('rejects a project-scoped app-data fallback for the route MAC key (FB-028)', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-route-key-scope-');
		const envKey =
			process.platform === 'win32'
				? 'LOCALAPPDATA'
				: process.platform === 'darwin'
					? 'HOME'
					: 'XDG_DATA_HOME';
		const previous = process.env[envKey];
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			process.env[envKey] = projectRoot;
			await expect(
				persistReviewRouteReceipt({
					projectRoot,
					receipt: buildReviewRouteReceipt({
						sessionId: 'session-2491',
						taskId: '2491-key-scope',
						complexity: 'single',
						semanticRisk: 'low',
						requiredReviewers: ['reviewer-a'],
						requiredTestEngineers: [],
					}),
				}),
			).rejects.toThrow('ROUTE_RECEIPT_SECRET_UNSAFE_PATH');
		} finally {
			if (previous === undefined) delete process.env[envKey];
			else process.env[envKey] = previous;
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

	test('rejects malformed empty identities before route lookup (FB-019)', () => {
		const routeReceipt = buildReviewRouteReceipt({
			sessionId: 'session-2491',
			taskId: '2491-invalid-identity',
			complexity: 'high',
			semanticRisk: 'cross_cutting',
			requiredReviewers: ['reviewer-a'],
			requiredTestEngineers: [],
		});
		// Previously the map lookup ran first, misclassifying an empty identity as
		// merely unlisted instead of identifying malformed route evidence.
		const result = enforceReviewRouteReceipt({
			enforcementEnabled: true,
			routeReceipt,
			receipts: [{ role: 'reviewer', identity: '   ' }],
		});
		expect(result).toMatchObject({
			canAdvance: false,
			reason: 'ROUTE_RECEIPT_INVALID_IDENTITY',
		});
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
