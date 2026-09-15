/**
 * F-004 rebuildPlan write-marker tests.
 *
 * A failed plan.md projection is advisory because plan.json is authoritative.
 * Failure while clearing the advisory marker must not mask the original
 * Markdown warning or turn a successful recovery into a failed rebuild.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import * as realHookUtils from '../../../src/hooks/utils';
import * as realLedger from '../../../src/plan/ledger';
import * as realUtils from '../../../src/utils';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function createTestPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'medium',
						description: 'Task two',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Task three',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function makeBunCompatMock() {
	return {
		bunWrite: mock(async (_path: string, _data: string | Uint8Array) => {}),
		bunHash: mock(() => 0n),
		bunFile: (_path: string) => ({
			text: async () => '',
			exists: async () => false,
			arrayBuffer: async () => new ArrayBuffer(0),
			size: 0,
		}),
		isBun: () => false,
		bunSpawn: () => ({
			stdout: {
				text: async () => '',
				bytes: async () => new Uint8Array(0),
				getReader: () => ({
					read: async () => ({ done: true, value: undefined }),
				}),
			},
			stderr: {
				text: async () => '',
				bytes: async () => new Uint8Array(0),
				getReader: () => ({
					read: async () => ({ done: true, value: undefined }),
				}),
			},
			exited: Promise.resolve(0),
			exitCode: null as number | null,
			kill: () => {},
		}),
		bunSpawnSync: () => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: 0,
			success: true,
		}),
	};
}

function makeLedgerMock() {
	return {
		...realLedger,
		appendLedgerEvent: mock(async () => ({})),
		takeSnapshotEvent: mock(async () => ({})),
		ledgerExists: mock(async () => false),
		initLedger: mock(async () => {}),
		readLedgerEvents: mock(async () => []),
		computePlanLedgerHash: mock(() => 'hash'),
		computeCurrentPlanHash: mock(() => 'hash'),
		getLatestLedgerSeq: mock(async () => 0),
	};
}

describe('rebuildPlan — F-004 marker reset on failure', () => {
	let tempDir: string;
	let cleanupTempDir: () => void;

	beforeEach(() => {
		const safeDir = createSafeTestDir('rebuild-plan-f004-');
		tempDir = safeDir.dir;
		cleanupTempDir = safeDir.cleanup;
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		cleanupTempDir();
		mock.restore();
	});

	/**
	 * Before the fix, a final-marker write throw escaped from `finally` before the
	 * stored plan.md projection error could be handled, masking its warning and
	 * rejecting rebuildPlan after plan.json had already committed.
	 */
	test('F-004: projection and final-marker failures remain advisory', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (path: string) => path,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: Array<{ path: string; content: string }> = [];
		let planMdWriteAttempted = false;
		let markerWriteAttempts = 0;
		let finalMarkerWriteFailed = false;
		const warnings: string[] = [];
		const warnMock = mock((message: string) => warnings.push(message));
		mock.module('../../../src/utils', () => ({ ...realUtils, warn: warnMock }));

		const bunWriteMock = mock(
			async (path: string, content: string | Uint8Array) => {
				writeLog.push({ path, content: String(content) });
				if (path.includes('plan.md.rebuild.')) {
					planMdWriteAttempted = true;
					// Throw after the write await so rebuildPlan's projection catch handles it.
					throw new Error('disk full during plan.md write');
				}
				if (
					path.includes('.plan-write-marker.rebuild.') &&
					++markerWriteAttempts === 2
				) {
					finalMarkerWriteFailed = true;
					throw new Error('disk full during final marker write');
				}
			},
		);

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));
		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...realFs,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		const { rebuildPlan } = await import('../../../src/plan/manager');
		const plan = createTestPlan();
		const rebuilt = await rebuildPlan(tempDir, plan, { reason: 'test-f004' });

		expect(rebuilt).toBe(plan);
		expect(planMdWriteAttempted).toBe(true);
		expect(finalMarkerWriteFailed).toBe(true);
		expect(
			warnings.some((message) =>
				message.includes('disk full during plan.md write'),
			),
		).toBe(true);
		expect(
			warnings.some((message) =>
				message.includes('disk full during final marker write'),
			),
		).toBe(false);

		const markerWrites = writeLog.filter((write) =>
			write.path.includes('.plan-write-marker'),
		);
		expect(markerWrites.length).toBe(2);
		expect(JSON.parse(markerWrites[0].content).in_progress).toBe(true);
		expect(JSON.parse(markerWrites[1].content).in_progress).toBe(false);
	});

	test('F-004: rebuildPlan success — markers written in correct sequence', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (path: string) => path,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: Array<{ path: string; content: string }> = [];
		const bunWriteMock = mock(
			async (path: string, content: string | Uint8Array) => {
				writeLog.push({ path, content: String(content) });
			},
		);

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));
		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...realFs,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		const { rebuildPlan } = await import('../../../src/plan/manager');
		const plan = createTestPlan();
		await rebuildPlan(tempDir, plan, { reason: 'test-f004-happy' });

		const markerWrites = writeLog.filter((write) =>
			write.path.includes('.plan-write-marker'),
		);
		expect(markerWrites.length).toBe(2);
		expect(JSON.parse(markerWrites[0].content)).toMatchObject({
			in_progress: true,
			source: 'plan_manager',
		});
		expect(JSON.parse(markerWrites[1].content)).toMatchObject({
			in_progress: false,
			source: 'plan_manager',
		});
	});
});
