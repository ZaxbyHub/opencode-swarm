import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	recordRealtimeLearningToolCall,
	resetRealtimeLearningNudgeState,
	shouldInjectRealtimeLearningNudge,
} from '../../src/hooks/realtime-learning-nudge';
import { cancelDeferredMaintenanceScans } from '../../src/hooks/system-enhancer';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../src/hooks/system-guidance-carrier';
import {
	claimTurnBudget,
	getTurnLedgerSummary,
	recordProducerEmission,
} from '../../src/services/injection-budget';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../helpers/host-contract-v1_18_3';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

const SESSION_ID = 'issue-2780-carrier-delivery-failure';
const NUDGE_CONFIG = {
	enabled: true,
	first_after_tool_calls: 10,
	repeat_after_tool_calls: 25,
};
const HOST_CONFIG = {
	version_check: false,
	context_budget: { scoring: { enabled: false } },
	knowledge: {
		enabled: true,
		hive_enabled: false,
		realtime_learning_nudge: NUDGE_CONFIG,
	},
	learning: { realtime_admission: { enabled: false } },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

function createHistory(agent: string): HostPartsMessage[] {
	return [
		{
			info: {
				id: 'real-user-message',
				role: 'user',
				agent,
				sessionID: SESSION_ID,
			},
			parts: [
				{ type: 'text', text: 'Please keep this conversation available.' },
			],
		},
		{
			info: {
				id: 'real-assistant-message',
				role: 'assistant',
				sessionID: SESSION_ID,
			},
			parts: [{ type: 'text', text: 'I will preserve the original history.' }],
		},
	];
}

function nudgeIsEligible(): boolean {
	return shouldInjectRealtimeLearningNudge({
		sessionID: SESSION_ID,
		config: NUDGE_CONFIG,
		realtimeAdmission: { enabled: false },
	});
}

describe('registered architect carrier delivery — fail-open regression (FB-003)', () => {
	let tempDir: string;
	let invokedEnhancer = false;
	// The link.json below makes the plugin materialize
	// <data dir>/links/receipt-test-cohort. Without platform-root isolation that
	// landed in the real knowledge store: the prod-store drift check failed the
	// first attempt, and the retry passed only because the directory now
	// existed (CI marked this file flaky).
	let cleanupIsolatedEnv: () => void = () => {};

	beforeEach(async () => {
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		tempDir = createPluginHostProject('swarm-2780-delivery-failure-');
		invokedEnhancer = false;
		resetSwarmState();
		resetRealtimeLearningNudgeState();
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(
			join(swarmDir, 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Carrier delivery failure test',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Execute',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Exercise fail-open carrier delivery',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		await writeFile(join(swarmDir, 'plan.md'), '# Plan\nCurrent phase: 1\n');
		await writeFile(join(swarmDir, 'context.md'), '# Context\n');
	});

	async function drainDeferredMaintenanceScan(): Promise<void> {
		if (!invokedEnhancer) return;
		const marker = join(tempDir, '.swarm', 'dark-matter.md');
		const deadline = performance.now() + 5000;
		while (!existsSync(marker) && performance.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function enableAllCarrierProducers(): Promise<void> {
		const planPath = join(tempDir, '.swarm', 'plan.json');
		const plan = JSON.parse(await readFile(planPath, 'utf8')) as Record<
			string,
			unknown
		>;
		plan.specHash = 'intentionally-stale-spec-hash';
		await writeFile(planPath, JSON.stringify(plan));
		await writeFile(
			join(tempDir, '.swarm', 'link.json'),
			JSON.stringify({
				version: 2,
				linkId: 'receipt-test-cohort',
				createdAt: new Date(0).toISOString(),
				source: 'manual',
			}),
		);
		ensureAgentSession(SESSION_ID, 'architect', tempDir).cachedCohortId =
			'receipt-test-cohort-id';
	}

	afterEach(async () => {
		resetRealtimeLearningNudgeState();
		try {
			await drainDeferredMaintenanceScan();
		} finally {
			cancelDeferredMaintenanceScans(tempDir);
			resetSwarmState();
			safeRmRecursive(tempDir);
			cleanupIsolatedEnv();
		}
	});

	test('preserves host history and nudge eligibility after one carrier append fails, then retries cleanly', async () => {
		const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
		const transform = host.hooks['experimental.chat.messages.transform'];
		expect(typeof transform).toBe('function');
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		for (let i = 0; i < 10; i++) recordRealtimeLearningToolCall(SESSION_ID);
		expect(nudgeIsEligible()).toBe(true);

		const messages = createHistory('architect');
		const nativePush = messages.push.bind(messages);
		let failedCarrierAppend = false;
		let carrierAppendAttempts = 0;
		// The failure is injected only on this request-owned array and before its
		// native append mutates the host history. No production seam is involved.
		messages.push = (...items: HostPartsMessage[]): number => {
			for (const item of items) {
				if (item.info.id === 'swarm-guidance:architect-session') {
					carrierAppendAttempts += 1;
					if (!failedCarrierAppend) {
						failedCarrierAppend = true;
						throw new Error('test-only carrier append failure');
					}
				}
			}
			return nativePush(...items);
		};

		invokedEnhancer = true;
		await transform({}, { messages });

		const originalHistoryText = renderedText(hostToModelMessages(messages));
		expect(originalHistoryText).toContain(
			'Please keep this conversation available.',
		);
		expect(originalHistoryText).toContain(
			'I will preserve the original history.',
		);
		expect(messages.some((message) => message.info.role === 'system')).toBe(
			false,
		);
		expect(
			messages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			),
		).toBe(false);
		expect(carrierAppendAttempts).toBe(1);
		expect(nudgeIsEligible()).toBe(true);

		// Reusing the failed request array under a non-architect identity proves
		// delivery deleted its staged WeakMap entry before the catch: the same
		// array cannot resurrect stale architect guidance.
		swarmState.activeAgent.set(SESSION_ID, 'reviewer');
		await transform({}, { messages });
		expect(
			messages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			),
		).toBe(false);
		expect(nudgeIsEligible()).toBe(true);

		// A fresh request array is the host's next architect turn. The failed
		// delivery left the cadence eligible, so this pass must append once and
		// commit the deferred nudge only after the renderable carrier exists.
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		const retryMessages = createHistory('architect');
		await transform({}, { messages: retryMessages });

		const carriers = retryMessages.filter(
			(message) =>
				isGuidanceCarrier(message) &&
				message.info.id === 'swarm-guidance:architect-session',
		);
		expect(carriers).toHaveLength(1);
		expect(isRenderableGuidance(carriers[0])).toBe(true);
		expect(messageTextOf(carriers[0])).toContain('[SWARM LEARNING NUDGE]');
		expect(renderedText(hostToModelMessages(retryMessages))).toContain(
			'[SWARM LEARNING NUDGE]',
		);
		expect(nudgeIsEligible()).toBe(false);
	});

	test('FB-025 refunds failed carrier budget receipts without changing unrelated system claims', async () => {
		const host = await bootSwarmPluginHost(tempDir, {
			...HOST_CONFIG,
			context_budget: {
				enabled: false,
				scoring: { enabled: false },
				max_injection_tokens: 4000,
				unified_injection_tokens: 100000,
			},
		});
		const transform = host.hooks['experimental.chat.messages.transform'];
		expect(typeof transform).toBe('function');
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		await enableAllCarrierProducers();

		const messages = createHistory('architect');
		const nativePush = messages.push.bind(messages);
		let injectedUnrelatedClaim = false;
		let usageBeforeFailedAppend: number | undefined;
		let ceilingActiveBeforeFailedAppend = false;
		let stagedGrantBeforeFailedAppend = 0;
		messages.push = (...items: HostPartsMessage[]): number => {
			for (const item of items) {
				if (
					item.info.id === 'swarm-guidance:architect-session' &&
					!injectedUnrelatedClaim
				) {
					injectedUnrelatedClaim = true;
					claimTurnBudget(SESSION_ID, 'final-accounting-warning', 17, {
						localMaxTokens: 17,
						surface: 'system',
					});
					recordProducerEmission(
						SESSION_ID,
						'final-accounting-warning',
						7,
						0,
						'system',
					);
					const beforeFailure = getTurnLedgerSummary(SESSION_ID);
					usageBeforeFailedAppend = beforeFailure?.used;
					ceilingActiveBeforeFailedAppend =
						beforeFailure?.ceilingActive ?? false;
					stagedGrantBeforeFailedAppend = ceilingActiveBeforeFailedAppend
						? (beforeFailure?.producers.find(
								(entry) =>
									entry.producer === 'system-enhancer' &&
									entry.surface === 'messages',
							)?.granted ?? 0) +
							(beforeFailure?.producers.find(
								(entry) =>
									entry.producer === 'guidance-carrier-fence' &&
									entry.surface === 'messages',
							)?.granted ?? 0)
						: 0;
					throw new Error('test-only carrier append failure');
				}
			}
			return nativePush(...items);
		};

		await transform({}, { messages });

		const summary = getTurnLedgerSummary(SESSION_ID);
		const systemEnhancer = summary?.producers.find(
			(entry) =>
				entry.producer === 'system-enhancer' && entry.surface === 'messages',
		);
		const fence = summary?.producers.find(
			(entry) =>
				entry.producer === 'guidance-carrier-fence' &&
				entry.surface === 'messages',
		);
		const unrelated = summary?.producers.find(
			(entry) =>
				entry.producer === 'final-accounting-warning' &&
				entry.surface === 'system',
		);
		const deliveryProducers = [
			'system-enhancer',
			'swarm-command-banner',
			'spec-drift-advisory',
			'linked-cohort-advisory',
		].map((producer) =>
			summary?.producers.find(
				(entry) => entry.producer === producer && entry.surface === 'messages',
			),
		);
		expect(injectedUnrelatedClaim).toBe(true);
		expect(deliveryProducers.map((entry) => entry?.producer)).toEqual([
			'system-enhancer',
			'swarm-command-banner',
			'spec-drift-advisory',
			'linked-cohort-advisory',
		]);
		for (const producer of deliveryProducers) {
			expect(producer?.emitted).toBe(0);
		}
		expect(systemEnhancer).toMatchObject({
			requested: 0,
			granted: 0,
			emitted: 0,
		});
		expect(systemEnhancer?.truncated).toBeGreaterThan(0);
		expect(fence?.requested ?? 0).toBe(0);
		expect(fence?.granted ?? 0).toBe(0);
		expect(fence?.emitted ?? 0).toBe(0);
		for (const producer of deliveryProducers.slice(1)) {
			expect(producer?.requested ?? 0).toBe(0);
			expect(producer?.granted ?? 0).toBe(0);
			expect(producer?.truncated ?? 0).toBeGreaterThan(0);
		}
		expect(usageBeforeFailedAppend).toBeDefined();
		expect(summary?.used).toBeGreaterThanOrEqual(0);
		expect(summary?.used).toBeLessThanOrEqual(usageBeforeFailedAppend ?? 0);
		if (ceilingActiveBeforeFailedAppend) {
			expect(summary?.used).toBe(
				(usageBeforeFailedAppend ?? 0) - stagedGrantBeforeFailedAppend,
			);
		} else {
			expect(summary?.used).toBe(0);
		}
		expect(unrelated).toMatchObject({ requested: 17, granted: 17, emitted: 7 });
		expect(renderedText(hostToModelMessages(messages))).toContain(
			'Please keep this conversation available.',
		);
		expect(
			messages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			),
		).toBe(false);
	});
});
