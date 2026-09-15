import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

const BASE_SYSTEM = 'Stable architect system prefix';
const HOST_CONFIG = {
	version_check: false,
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

describe('System Enhancer Hook - session-scoped handoff (#2759)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createPluginHostProject('handoff-session-test-');
		resetSwarmState();
		swarmState.activeAgent.set('current-session', 'architect');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			safeRmRecursive(tempDir);
		} catch {
			// Best-effort cleanup; registered host workers can briefly hold handles.
		}
	});

	async function createSwarmDir(): Promise<string> {
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

	function architectMessage(sessionID: string): HostPartsMessage {
		return {
			info: {
				id: `user-${sessionID}`,
				role: 'user',
				agent: 'architect',
				sessionID,
			},
			parts: [{ type: 'text', text: 'Continue the active plan.' }],
		};
	}

	async function runTransform(
		configOverrides: Record<string, unknown> = {},
		sessionID = 'current-session',
	): Promise<{
		messages: HostPartsMessage[];
		rendered: ReturnType<typeof hostToModelMessages>;
		system: string[];
	}> {
		const host = await bootSwarmPluginHost(tempDir, {
			...HOST_CONFIG,
			...configOverrides,
		});
		const messages = [architectMessage(sessionID)];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		const system = [BASE_SYSTEM];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID },
			{ system },
		);
		return { messages, rendered: hostToModelMessages(messages), system };
	}

	function expectStableArchitectSystem(system: string[]): void {
		expect(system).toEqual([BASE_SYSTEM]);
		expect(system.join('\n')).not.toContain('[HANDOFF BRIEF]');
	}

	it('leaves a marked handoff for the same source session', async () => {
		const swarmDir = await createSwarmDir();
		const handoffPath = join(swarmDir, 'handoff.md');
		const body = 'Continue in the next model session.';
		await writeFile(
			handoffPath,
			`<!-- opencode-swarm-handoff-source-session: current-session -->\n${body}`,
		);

		const result = await runTransform();

		expectStableArchitectSystem(result.system);
		expect(existsSync(handoffPath)).toBe(true);
		expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(false);
		expect(
			result.messages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					messageTextOf(message).includes('[HANDOFF BRIEF]'),
			),
		).toBe(false);
		expect(renderedText(result.rendered)).not.toContain(body);
	});

	it('consumes a marked handoff from a different source session and strips marker text', async () => {
		const swarmDir = await createSwarmDir();
		const handoffPath = join(swarmDir, 'handoff.md');
		const body = 'Continue with this handoff body.';
		await writeFile(
			handoffPath,
			`<!-- opencode-swarm-handoff-source-session: source-session -->\n${body}`,
		);

		const result = await runTransform();
		const handoffCarrier = result.messages.find(
			(message) =>
				isGuidanceCarrier(message) && messageTextOf(message).includes(body),
		);
		const rendered = renderedText(result.rendered);

		expectStableArchitectSystem(result.system);
		expect(existsSync(handoffPath)).toBe(false);
		expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(true);
		expect(handoffCarrier).toBeDefined();
		expect(isRenderableGuidance(handoffCarrier)).toBe(true);
		expect(handoffCarrier?.info.role).toBe('user');
		expect(rendered).toContain(body);
		expect(rendered).not.toContain('opencode-swarm-handoff-source-session');
	});

	it('leaves a marked same-session handoff on the scoring path', async () => {
		const swarmDir = await createSwarmDir();
		const handoffPath = join(swarmDir, 'handoff.md');
		await writeFile(
			handoffPath,
			'<!-- opencode-swarm-handoff-source-session: current-session -->\nScored handoff',
		);

		const result = await runTransform({
			context_budget: {
				scoring: { enabled: true, max_candidates: 100 },
				max_injection_tokens: 10000,
			},
		});

		expectStableArchitectSystem(result.system);
		expect(existsSync(handoffPath)).toBe(true);
		expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(false);
		expect(
			result.messages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					messageTextOf(message).includes('[HANDOFF BRIEF]'),
			),
		).toBe(false);
		expect(renderedText(result.rendered)).not.toContain('Scored handoff');
	});
});
