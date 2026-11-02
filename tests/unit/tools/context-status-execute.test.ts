/** Integration tests for context_status.execute. */

import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	_internals as learningHealthInternals,
	readLearningHealth,
	resetLearningHealthForTest,
} from '../../../src/health/learning-health';
import { setLiveContextWindow, swarmState } from '../../../src/state';
import { _internals, context_status } from '../../../src/tools/context-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalLoadPluginConfig = _internals.loadPluginConfig;
const originalFetchSessionMessages = _internals.fetchSessionMessages;

const pluginCheckoutRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);
const originalWriteLearningHealthArtifact =
	learningHealthInternals.writeArtifact;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		directory: process.cwd(),
		sessionID: 'test-session',
		agent: 'architect',
		...overrides,
	} as unknown as ToolContext;
}

function makeMessage(
	overrides: {
		role?: string;
		modelID?: string;
		providerID?: string;
		text?: string;
	} = {},
) {
	return {
		info: {
			role: overrides.role ?? 'user',
			modelID: overrides.modelID,
			providerID: overrides.providerID,
		},
		parts: overrides.text ? [{ type: 'text', text: overrides.text }] : [],
	};
}

function mockConfig(
	overrides: {
		enabled?: boolean;
		warn_threshold?: number;
		critical_threshold?: number;
		model_limits?: Record<string, number>;
	} = {},
) {
	return {
		context_budget: {
			enabled: overrides.enabled ?? true,
			warn_threshold: overrides.warn_threshold ?? 0.7,
			critical_threshold: overrides.critical_threshold ?? 0.9,
			model_limits: overrides.model_limits ?? {},
		},
	} as Parameters<typeof _internals.loadPluginConfig>[0] extends (
		dir: string,
	) => infer R
		? R
		: never;
}

beforeEach(() => {
	swarmState.liveContextWindows.clear();
	_internals.loadPluginConfig = (() =>
		mockConfig()) as typeof _internals.loadPluginConfig;
	_internals.fetchSessionMessages = originalFetchSessionMessages;
});

afterEach(() => {
	swarmState.liveContextWindows.clear();
	_internals.loadPluginConfig = originalLoadPluginConfig;
	_internals.fetchSessionMessages = originalFetchSessionMessages;
});

describe('context_status.execute', () => {
	it('returns JSON with all required fields from the session', async () => {
		_internals.fetchSessionMessages = (async () => [
			makeMessage({ role: 'user', text: 'hello world' }),
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'anthropic',
				text: 'hi there',
			}),
		]) as typeof _internals.fetchSessionMessages;

		const raw = await context_status.execute({}, makeCtx());
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(typeof raw).toBe('string');
		expect(parsed).toHaveProperty('tokensUsed');
		expect(parsed).toHaveProperty('usageSource');
		expect(parsed).toHaveProperty('modelLimit');
		expect(parsed).toHaveProperty('usagePercent');
		expect(parsed).toHaveProperty('thresholdCrossed');
		expect(parsed).toHaveProperty('modelId');
		expect(parsed).toHaveProperty('provider');
		expect(typeof parsed.tokensUsed).toBe('number');
		expect(['provider', 'estimated']).toContain(parsed.usageSource);
		expect(typeof parsed.modelLimit).toBe('number');
		expect(typeof parsed.usagePercent).toBe('number');
		expect(['none', 'warn', 'critical']).toContain(parsed.thresholdCrossed);
		expect(parsed.modelId).toBe('claude-sonnet-4');
		expect(parsed.provider).toBe('anthropic');
	});

	it('returns data with empty session messages', async () => {
		_internals.fetchSessionMessages =
			(async () => []) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.tokensUsed).toBe(0);
		expect(parsed.usageSource).toBe('estimated');
		expect(parsed.usagePercent).toBe(0);
		expect(parsed.thresholdCrossed).toBe('none');
	});

	it('returns data when no sessionID is provided', async () => {
		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx({ sessionID: undefined })),
		) as Record<string, unknown>;
		expect(parsed.tokensUsed).toBe(0);
		expect(parsed.modelLimit).toBeGreaterThan(0);
	});

	it('returns zero-state when the OpenCode client is unavailable', async () => {
		_internals.fetchSessionMessages = (async () =>
			null) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.tokensUsed).toBe(0);
		expect(parsed.usageSource).toBe('estimated');
		expect(parsed.usagePercent).toBe(0);
		expect(parsed.thresholdCrossed).toBe('none');
	});

	it('does not throw on malformed session message entries', async () => {
		_internals.fetchSessionMessages = (async () => [
			null as unknown as never,
			undefined as unknown as never,
			{ info: {}, parts: [] },
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.tokensUsed).toBe(0);
	});

	it('derives messages from session context, not caller args', async () => {
		_internals.fetchSessionMessages = (async () => [
			makeMessage({ role: 'user', text: 'from session' }),
			makeMessage({
				role: 'assistant',
				modelID: 'gpt-5',
				providerID: 'openai',
				text: 'session reply',
			}),
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.modelId).toBe('gpt-5');
		expect(parsed.provider).toBe('openai');
		expect(parsed.tokensUsed).toBeGreaterThan(0);
		expect(parsed.usageSource).toBe('estimated');
	});

	it('does not treat an identity-less live cache entry as authoritative over assistant metadata', async () => {
		setLiveContextWindow('test-session', 200_000);
		_internals.fetchSessionMessages = (async () => [
			makeMessage({
				role: 'assistant',
				modelID: 'MiniMax-M3',
				providerID: 'minimax',
				text: 'reply',
			}),
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.modelId).toBe('MiniMax-M3');
		expect(parsed.provider).toBe('minimax');
	});

	it('reports the current live identity across a first-turn handoff', async () => {
		_internals.loadPluginConfig = (() =>
			mockConfig({
				model_limits: {
					'old-provider/old-model': 100_000,
					'new-provider/new-model': 800_000,
				},
			})) as typeof _internals.loadPluginConfig;
		_internals.fetchSessionMessages = (async () => [
			makeMessage({
				role: 'assistant',
				modelID: 'old-model',
				providerID: 'old-provider',
				text: 'outgoing reply',
			}),
		]) as typeof _internals.fetchSessionMessages;
		setLiveContextWindow('test-session', 1_000_000, {
			modelID: 'new-model',
			providerID: 'new-provider',
		});

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.modelLimit).toBe(800_000);
		expect(parsed.modelId).toBe('new-model');
		expect(parsed.provider).toBe('new-provider');
	});

	it('resolves custom warn and critical thresholds from config', async () => {
		_internals.loadPluginConfig = (() =>
			mockConfig({
				warn_threshold: 0.5,
				critical_threshold: 0.8,
			})) as typeof _internals.loadPluginConfig;
		_internals.fetchSessionMessages = (async () => [
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'anthropic',
				text: 'x'.repeat(10000),
			}),
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.thresholdCrossed).toBe('none');
	});

	it('works when context_budget.enabled is false', async () => {
		_internals.loadPluginConfig = (() =>
			mockConfig({
				enabled: false,
				warn_threshold: 0.6,
				critical_threshold: 0.85,
			})) as typeof _internals.loadPluginConfig;
		_internals.fetchSessionMessages = (async () => [
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'anthropic',
				text: 'test content',
			}),
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.tokensUsed).toBeGreaterThan(0);
		expect(parsed.modelLimit).toBeGreaterThan(0);
		expect(parsed.modelId).toBe('claude-sonnet-4');
		expect(parsed.thresholdCrossed).toBe('none');
	});

	it('does not inject warnings into the message stream', async () => {
		const sessionMessages = [
			makeMessage({ role: 'user', text: 'original user text' }),
			makeMessage({
				role: 'assistant',
				modelID: 'claude-sonnet-4',
				providerID: 'anthropic',
				text: 'reply',
			}),
		];
		_internals.fetchSessionMessages = (async () =>
			sessionMessages) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.tokensUsed).toBeGreaterThan(0);
		expect(sessionMessages[0].parts[0].text).toBe('original user text');
		expect(sessionMessages[1].parts[0].text).toBe('reply');
	});

	it('reports provider usage when assistant token accounting is available', async () => {
		_internals.fetchSessionMessages = (async () => [
			makeMessage({ role: 'user', text: 'before' }),
			{
				info: {
					role: 'assistant',
					modelID: 'gpt-5',
					providerID: 'openai',
					tokens: {
						input: 150,
						cache: { read: 20, write: 10 },
					},
				},
				parts: [{ type: 'text', text: 'reply' }],
			},
			makeMessage({ role: 'user', text: 'after' }),
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.usageSource).toBe('provider');
		expect(Number(parsed.tokensUsed)).toBeGreaterThan(180);
	});

	it('counts visible tool error text in provider usage', async () => {
		_internals.fetchSessionMessages = (async () => [
			{
				info: {
					role: 'assistant',
					modelID: 'gpt-5',
					providerID: 'openai',
					tokens: {
						input: 100,
						cache: { read: 20, write: 10 },
					},
				},
				parts: [
					{ type: 'text', text: 'reply' },
					{
						type: 'tool',
						tool: 'bash',
						state: { status: 'error', error: 'tool failed loudly' },
					},
				],
			},
		]) as typeof _internals.fetchSessionMessages;

		const parsed = JSON.parse(
			await context_status.execute({}, makeCtx()),
		) as Record<string, unknown>;
		expect(parsed.usageSource).toBe('provider');
		expect(Number(parsed.tokensUsed)).toBeGreaterThan(130);
	});
});

describe('context_status.execute learning-health scoping (#2044)', () => {
	beforeEach(() => {
		resetLearningHealthForTest();
		swarmState.liveContextWindows.clear();
		_internals.loadPluginConfig = ((dir: string) => {
			expect(dir).not.toBe(pluginCheckoutRoot);
			return mockConfig();
		}) as typeof _internals.loadPluginConfig;
		_internals.fetchSessionMessages = (async () => [
			makeMessage({
				role: 'assistant',
				modelID: 'mystery-model',
				providerID: 'unknown-provider',
			}),
		]) as typeof _internals.fetchSessionMessages;
		learningHealthInternals.writeArtifact = async (directory, contents) => {
			expect(path.resolve(directory)).not.toBe(pluginCheckoutRoot);
			return originalWriteLearningHealthArtifact(directory, contents);
		};
	});

	afterEach(() => {
		_internals.loadPluginConfig = originalLoadPluginConfig;
		_internals.fetchSessionMessages = originalFetchSessionMessages;
		learningHealthInternals.writeArtifact = originalWriteLearningHealthArtifact;
		resetLearningHealthForTest();
	});

	test(
		'a fallback resolution through execute is visible in the owning project snapshot only',
		async () => {
			const ownerDir = canonicalMkdtemp('swarm-ctx-exec-lh-');
			const otherDir = canonicalMkdtemp('swarm-ctx-exec-lh-');
			mkdirSync(`${ownerDir}/.swarm`, { recursive: true });
			mkdirSync(`${otherDir}/.swarm`, { recursive: true });
			try {
				const raw = await context_status.execute(
					{ working_directory: ownerDir },
					makeCtx({ directory: ownerDir, sessionID: 'sess-exec-scope' }),
				);
				const parsed = JSON.parse(raw) as { fallbackActive?: boolean };
				expect(parsed.fallbackActive).toBe(true);
				const ownerSnapshot = await readLearningHealth(ownerDir);
				expect(
					ownerSnapshot.activeAlarms.some(
						(a) => a.alarm === 'model_limit_fallback',
					),
				).toBe(true);
				const otherSnapshot = await readLearningHealth(otherDir);
				expect(
					otherSnapshot.activeAlarms.some(
						(a) => a.alarm === 'model_limit_fallback',
					),
				).toBe(false);
			} finally {
				rmSync(ownerDir, { recursive: true, force: true });
				rmSync(otherDir, { recursive: true, force: true });
			}
		},
		15000,
	);
});
