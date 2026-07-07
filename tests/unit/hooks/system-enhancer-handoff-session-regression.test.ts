import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

describe('System Enhancer Hook - session-scoped handoff', () => {
	let tempDir: string;

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: false,
			delegation_max_chars: 1000,
		},
	};

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'handoff-session-test-'));
		resetSwarmState();
		swarmState.activeAgent.set('current-session', 'architect');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function createSwarmDir() {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(
			join(swarmDir, 'plan.json'),
			JSON.stringify({
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
								description: 'Test task',
								status: 'in_progress',
							},
						],
					},
				],
			}),
		);
		return swarmDir;
	}

	async function runTransform(
		config: PluginConfig | any,
		sessionID = 'current-session',
	) {
		const hook = createSystemEnhancerHook(config, tempDir);
		const transformHook = hook['experimental.chat.system.transform'] as any;
		const output = { system: ['Initial system prompt'] };
		await transformHook({ sessionID }, output);
		return output;
	}

	it('leaves a marked handoff for the same source session', async () => {
		const swarmDir = await createSwarmDir();
		const handoffPath = join(swarmDir, 'handoff.md');
		const body = 'Continue in the next model session.';
		await writeFile(
			handoffPath,
			`<!-- opencode-swarm-handoff-source-session: current-session -->\n${body}`,
		);

		const output = await runTransform(defaultConfig);

		expect(existsSync(handoffPath)).toBe(true);
		expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(false);
		expect(
			output.system.some((entry) => entry.includes('[HANDOFF BRIEF]')),
		).toBe(false);
	});

	it('consumes a marked handoff from a different source session and strips marker text', async () => {
		const swarmDir = await createSwarmDir();
		const handoffPath = join(swarmDir, 'handoff.md');
		const body = 'Continue with this handoff body.';
		await writeFile(
			handoffPath,
			`<!-- opencode-swarm-handoff-source-session: source-session -->\n${body}`,
		);

		const output = await runTransform(defaultConfig);

		expect(existsSync(handoffPath)).toBe(false);
		expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(true);
		const handoffInjection = output.system.find((entry) =>
			entry.includes('[HANDOFF BRIEF]'),
		);
		expect(handoffInjection).toContain(body);
		expect(handoffInjection).not.toContain(
			'opencode-swarm-handoff-source-session',
		);
	});

	it('leaves a marked same-session handoff on the scoring path', async () => {
		const swarmDir = await createSwarmDir();
		const handoffPath = join(swarmDir, 'handoff.md');
		await writeFile(
			handoffPath,
			'<!-- opencode-swarm-handoff-source-session: current-session -->\nScored handoff',
		);

		const output = await runTransform({
			...defaultConfig,
			context_budget: {
				scoring: {
					enabled: true,
					max_candidates: 100,
				},
				max_injection_tokens: 10000,
			},
		});

		expect(existsSync(handoffPath)).toBe(true);
		expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(false);
		expect(
			output.system.some((entry) => entry.includes('[HANDOFF BRIEF]')),
		).toBe(false);
	});
});
