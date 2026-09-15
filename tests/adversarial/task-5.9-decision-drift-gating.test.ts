/**
 * Decision-drift gating and edge-case attacks.
 *
 * The gating cases exercise the registered messages.transform chain. Security
 * assertions inspect the host-visible user-role guidance carrier rather than
 * the enhancer's internal output.system staging array.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../src/config';
import {
	isGuidanceCarrier,
	messageTextOf,
} from '../../src/hooks/system-guidance-carrier';
import {
	analyzeDecisionDrift,
	extractDecisionsFromContext,
} from '../../src/services/decision-drift-analyzer';
import { resetSwarmState, swarmState } from '../../src/state';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { canonicalMkdtemp } from '../helpers/tmpdir.js';

describe('ATTACK VECTOR 4: Gating Bypass Attempts', () => {
	let tempDir: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	beforeEach(async () => {
		tempDir = createPluginHostProject('drift-gating-attack');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		resetSwarmState();
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {}
		resetSwarmState();
	});

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	const withDriftCapabilities = (
		enabled: boolean,
	): PluginConfig['automation'] => ({
		mode: 'manual',
		capabilities: {
			plan_sync: false,
			phase_preflight: false,
			config_doctor_on_startup: false,
			config_doctor_autofix: false,
			evidence_auto_summaries: false,
			decision_drift_detection: enabled,
		},
	});

	async function invokeRegisteredMessages(
		config: PluginConfig,
		sessionID = 'test-session',
		agent = swarmState.activeAgent.get(sessionID) ?? 'architect',
	): Promise<string> {
		host = await bootSwarmPluginHost(tempDir, config);
		const messages = [
			{
				info: {
					id: `drift-user-${sessionID}`,
					role: 'user' as const,
					sessionID,
					agent,
				},
				parts: [{ type: 'text', text: 'Continue the current swarm task.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		return messages
			.filter((message) => isGuidanceCarrier(message))
			.map((message) => messageTextOf(message as never))
			.join('\n');
	}

	async function writeDriftInputs() {
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			'# Plan\n\nPhase: 2\n\n## Phase 1 [COMPLETE]\n## Phase 2 [IN PROGRESS]',
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			'## Decisions\n- Use TypeScript Phase 1',
		);
	}

	test('coder agent cannot bypass drift detection gate', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};
		swarmState.activeAgent.set('test-session', 'swarm_coder');

		const delivered = await invokeRegisteredMessages(config);
		expect(delivered).not.toContain('DECISION DRIFT');
	});

	test('reviewer agent cannot bypass drift detection gate', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};
		swarmState.activeAgent.set('test-session', 'swarm_reviewer');

		const delivered = await invokeRegisteredMessages(config);
		expect(delivered).not.toContain('DECISION DRIFT');
	});

	test('architect with correct prefix gets drift detection', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};
		swarmState.activeAgent.set('test-session', 'swarm_architect');

		const delivered = await invokeRegisteredMessages(config);
		expect(delivered).toContain('DECISION DRIFT');
	});

	test('architect without prefix still gets drift detection', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};
		swarmState.activeAgent.set('test-session', 'architect');

		const delivered = await invokeRegisteredMessages(config);
		expect(delivered).toContain('DECISION DRIFT');
	});

	test('sessionless request stays outside the architect drift gate', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};

		const delivered = await invokeRegisteredMessages(config, '');
		expect(delivered).not.toContain('DECISION DRIFT');
	});

	test('feature flag disabled blocks drift detection even for architect', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(false),
		};
		swarmState.activeAgent.set('test-session', 'swarm_architect');

		const delivered = await invokeRegisteredMessages(config);
		expect(delivered).not.toContain('DECISION DRIFT');
	});

	test('special-character architect sessions remain safely gated', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};

		for (const sessionID of [
			'../etc/passwd',
			'; rm -rf /',
			'${process.env}',
			'<script>alert(1)</script>',
			'null',
			'undefined',
		]) {
			swarmState.activeAgent.set(sessionID, 'swarm_architect');
			const delivered = await invokeRegisteredMessages(config, sessionID);
			expect(delivered).toContain('DECISION DRIFT');
			expect(delivered).not.toContain(sessionID);
		}
	});

	test('cannot bypass by manipulating swarmState during hook call', async () => {
		await writeDriftInputs();
		const config = {
			...defaultConfig,
			automation: withDriftCapabilities(true),
		};
		swarmState.activeAgent.set('test-session', 'swarm_coder');

		const delivered = await invokeRegisteredMessages(config);
		expect(delivered).not.toContain('DECISION DRIFT');
	});
});

describe('Additional Decision Drift Edge Cases', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('drift-edge-');
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test('handles decision text that looks like code injection', async () => {
		const content = `## Decisions
- Use \${process.exit(1)} as pattern
- Execute \`(function(){throw new Error()})()\`
- Run \`require('child_process').exec('rm -rf /')\``;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);
		const decisions = extractDecisionsFromContext(content);
		expect(decisions.length).toBe(3);
		expect(decisions[0].text).toContain('${');
	});

	test('handles decision text with markdown injection attempt', async () => {
		const content = `## Decisions
- Use [link](javascript:alert(1))
- See ![img](data:text/html,<script>alert(1)</script>)
- Check <!-- comment --><script>alert(1)</script>`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);
		const decisions = extractDecisionsFromContext(content);
		expect(decisions.length).toBe(3);
	});

	test('handles decisions section at very end of large file', async () => {
		const content = `## Agent Activity\n${'x'.repeat(50000)}\n\n## Decisions\n- Last decision`;
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);
		const decisions = extractDecisionsFromContext(content);
		expect(decisions.length).toBe(1);
		expect(decisions[0].text).toContain('Last decision');
	});

	test('handles multiple decisions sections (uses first)', async () => {
		const content =
			'## Decisions\n- First\n\n## Other\n\n## Decisions\n- Second';
		await writeFile(join(tempDir, '.swarm', 'context.md'), content);
		const decisions = extractDecisionsFromContext(content);
		expect(decisions.length).toBe(1);
		expect(decisions[0].text).toBe('First');
	});

	test('handles timestamp with various formats', async () => {
		const content = `## Decisions
- Decision 1 [2024-01-15T10:30:00Z]
- Decision 2 [2024-01-15T10:30:00.000Z]
- Decision 3 [not-a-timestamp]`;
		const decisions = extractDecisionsFromContext(content);
		expect(decisions[0].timestamp).toBe('2024-01-15T10:30:00Z');
		expect(decisions[1].timestamp).toBe('2024-01-15T10:30:00.000Z');
		expect(decisions[2].timestamp).toBeNull();
	});

	test('handles phase extraction from decision text edge cases', async () => {
		const content = `## Decisions
- Use Phase 10 for advanced features
- Phase 2 is complete
- The Phase99 approach
- Phase number: 5`;
		expect(extractDecisionsFromContext(content)).toBeInstanceOf(Array);
	});

	test('analyzeDecisionDrift with empty directory does not crash', async () => {
		const result = await analyzeDecisionDrift(tempDir);
		expect(result.hasDrift).toBe(false);
		expect(result.signals).toHaveLength(0);
	});

	test('handles extremely high phase numbers', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ current_phase: 999999999, phases: [] }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			'## Decisions\n- Use TypeScript',
		);
		expect(await analyzeDecisionDrift(tempDir)).toBeDefined();
	});

	test('handles config with negative staleThresholdPhases', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ current_phase: 1, phases: [] }),
		);
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			'## Decisions\n- Use TypeScript',
		);
		expect(
			await analyzeDecisionDrift(tempDir, { staleThresholdPhases: -1 }),
		).toBeDefined();
	});

	test('handles config with very large maxSignals', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ current_phase: 10, phases: [] }),
		);
		const decisions = Array.from(
			{ length: 20 },
			(_, i) => `- Decision ${i}`,
		).join('\n');
		await writeFile(
			join(tempDir, '.swarm', 'context.md'),
			`## Decisions\n${decisions}`,
		);
		const result = await analyzeDecisionDrift(tempDir, { maxSignals: 1000000 });
		expect(result.signals.length).toBe(20);
	});
});
