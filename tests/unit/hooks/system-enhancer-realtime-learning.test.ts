import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createAgentActivityHooks } from '../../../src/hooks/agent-activity';
import {
	buildRealtimeLearningNudge,
	getTrackedRealtimeLearningNudgeSessionCount,
	recordRealtimeLearningToolCall,
	resetRealtimeLearningNudgeState,
} from '../../../src/hooks/realtime-learning-nudge';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { endAgentSession, resetSwarmState } from '../../../src/state';

describe('System Enhancer real-time learning nudge', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-learning-nudge-test-'));
		resetSwarmState();
		resetRealtimeLearningNudgeState();
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(join(swarmDir, 'plan.md'), '# Plan\nCurrent phase: 2\n');
		await writeFile(join(swarmDir, 'context.md'), '# Context\n');
	});

	afterEach(async () => {
		resetRealtimeLearningNudgeState();
		await rm(tempDir, { recursive: true, force: true });
	});

	async function invokeHook(
		config: PluginConfig,
		sessionID = 'learning-session',
	): Promise<string[]> {
		const hooks = createSystemEnhancerHook(config, tempDir);
		const transform = hooks['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;
		const output = { system: ['Initial system prompt'] };
		await transform({ sessionID }, output);
		return output.system;
	}

	async function recordCompletedToolCalls(
		sessionID: string,
		count: number,
	): Promise<void> {
		const hooks = createAgentActivityHooks(defaultConfig, tempDir);
		for (let i = 0; i < count; i++) {
			const callID = `${sessionID}-call-${i}`;
			await hooks.toolBefore(
				{ tool: 'bash', sessionID, callID },
				{ args: { index: i } },
			);
			await hooks.toolAfter(
				{ tool: 'bash', sessionID, callID },
				{ success: true },
			);
		}
	}

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	it('injects the nudge at the first default threshold and suppresses duplicates', async () => {
		await recordCompletedToolCalls('learning-session', 10);

		const firstOutput = await invokeHook(defaultConfig);
		expect(
			firstOutput.some((entry) => entry.includes('[SWARM LEARNING NUDGE]')),
		).toBe(true);
		expect(firstOutput.some((entry) => entry.includes('knowledge_add'))).toBe(
			true,
		);

		const secondOutput = await invokeHook(defaultConfig);
		expect(
			secondOutput.some((entry) => entry.includes('[SWARM LEARNING NUDGE]')),
		).toBe(false);
	});

	it('uses configured first and repeat thresholds', async () => {
		const config = {
			...defaultConfig,
			knowledge: {
				enabled: true,
				realtime_learning_nudge: {
					enabled: true,
					first_after_tool_calls: 3,
					repeat_after_tool_calls: 5,
				},
			} as PluginConfig['knowledge'],
		};

		await recordCompletedToolCalls('learning-session', 3);
		expect(
			(await invokeHook(config)).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(true);

		await recordCompletedToolCalls('learning-session', 4);
		expect(
			(await invokeHook(config)).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(false);

		await recordCompletedToolCalls('learning-session', 1);
		expect(
			(await invokeHook(config)).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(true);
	});

	it('respects knowledge and nudge disable flags', async () => {
		await recordCompletedToolCalls('learning-session', 100);

		const knowledgeDisabled = {
			...defaultConfig,
			knowledge: { enabled: false } as PluginConfig['knowledge'],
		};
		expect(
			(await invokeHook(knowledgeDisabled)).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(false);

		resetRealtimeLearningNudgeState();
		const nudgeDisabled = {
			...defaultConfig,
			knowledge: {
				enabled: true,
				realtime_learning_nudge: { enabled: false },
			} as PluginConfig['knowledge'],
		};
		expect(
			(await invokeHook(nudgeDisabled)).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(false);
	});

	it('keeps cadence isolated between sessions', async () => {
		await recordCompletedToolCalls('session-a', 10);

		expect(
			(await invokeHook(defaultConfig, 'session-a')).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(true);
		expect(
			(await invokeHook(defaultConfig, 'session-b')).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(false);

		await recordCompletedToolCalls('session-b', 9);
		expect(
			(await invokeHook(defaultConfig, 'session-b')).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(false);

		await recordCompletedToolCalls('session-b', 1);
		expect(
			(await invokeHook(defaultConfig, 'session-b')).some((entry) =>
				entry.includes('[SWARM LEARNING NUDGE]'),
			),
		).toBe(true);
	});

	it('bounds tracked session state with FIFO eviction', () => {
		for (let i = 0; i < 510; i++) {
			recordRealtimeLearningToolCall(`session-${i}`);
		}

		expect(getTrackedRealtimeLearningNudgeSessionCount()).toBe(500);
	});

	it('clears tracked state on session teardown and swarm reset', () => {
		recordRealtimeLearningToolCall('session-to-end');
		recordRealtimeLearningToolCall('session-to-reset');

		endAgentSession('session-to-end');
		expect(getTrackedRealtimeLearningNudgeSessionCount()).toBe(1);

		resetSwarmState();
		expect(getTrackedRealtimeLearningNudgeSessionCount()).toBe(0);
	});

	it('keeps the prompt bounded and action-oriented', () => {
		const prompt = buildRealtimeLearningNudge({
			currentPhase: 2,
			toolCallCount: 42,
		});

		expect(prompt).toContain('phase 2');
		expect(prompt).toContain('knowledge_add');
		expect(prompt).toContain('curator');
		expect(prompt).toContain('knowledge_application_findings');
		expect(prompt).toContain('skill_improve');
		expect(prompt.length).toBeLessThan(1100);
	});
});
