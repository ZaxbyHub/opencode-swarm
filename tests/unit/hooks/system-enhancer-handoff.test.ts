import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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

describe('System Enhancer Hook - Handoff Detection (#2759)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createPluginHostProject('handoff-test-');
		resetSwarmState();
		// Architect system output is deliberately stable. Dynamic handoff
		// guidance is delivered through the registered messages surface.
		swarmState.activeAgent.set('test-session', 'architect');
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
		return swarmDir;
	}

	async function createPlanWithActiveTask(): Promise<string> {
		const swarmDir = await createSwarmDir();
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

	function architectMessage(sessionID = 'test-session'): HostPartsMessage {
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

	async function runRegisteredTurn(
		overrides: Record<string, unknown> = {},
	): Promise<{
		handoffMessages: HostPartsMessage[];
		renderedMessages: ReturnType<typeof hostToModelMessages>;
		system: string[];
	}> {
		const host = await bootSwarmPluginHost(tempDir, {
			...HOST_CONFIG,
			...overrides,
		});
		const handoffMessages = [architectMessage()];
		await host.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: handoffMessages },
		);
		const system = [BASE_SYSTEM];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID: 'test-session' },
			{ system },
		);
		return {
			handoffMessages,
			renderedMessages: hostToModelMessages(handoffMessages),
			system,
		};
	}

	function expectArchitectSystemSurfaceIsStable(system: string[]): void {
		expect(system).toEqual([BASE_SYSTEM]);
		expect(system.join('\n')).not.toContain('[HANDOFF BRIEF]');
	}

	describe('handoff detection and delivery', () => {
		it('consumes handoff.md and delivers its body through a host-renderable carrier', async () => {
			const swarmDir = await createPlanWithActiveTask();
			const handoffPath = join(swarmDir, 'handoff.md');
			const handoffContent =
				'Previous session ended. Here is context from model switch.';
			await writeFile(handoffPath, handoffContent);

			const result = await runRegisteredTurn();
			const handoffCarrier = result.handoffMessages.find(
				(message) =>
					isGuidanceCarrier(message) &&
					messageTextOf(message).includes('[HANDOFF BRIEF]'),
			);

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(existsSync(handoffPath)).toBe(false);
			expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(true);
			expect(handoffCarrier).toBeDefined();
			expect(isRenderableGuidance(handoffCarrier)).toBe(true);
			expect(handoffCarrier?.info.role).toBe('user');
			expect(renderedText(result.renderedMessages)).toContain(handoffContent);
		});

		it('renames before delivery, so the consumed file is the delivery authority', async () => {
			const swarmDir = await createPlanWithActiveTask();
			const handoffPath = join(swarmDir, 'handoff.md');
			await writeFile(handoffPath, 'Test content');

			const result = await runRegisteredTurn();

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(existsSync(handoffPath)).toBe(false);
			expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(true);
			expect(renderedText(result.renderedMessages)).toContain('Test content');
		});

		it('handles missing handoff.md without injecting on either architect surface', async () => {
			await createPlanWithActiveTask();

			const result = await runRegisteredTurn();

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(
				result.handoffMessages.some(
					(message) =>
						isGuidanceCarrier(message) &&
						messageTextOf(message).includes('[HANDOFF BRIEF]'),
				),
			).toBe(false);
			expect(renderedText(result.renderedMessages)).not.toContain(
				'[HANDOFF BRIEF]',
			);
		});

		it('replaces duplicate handoff-consumed.md before delivering the new handoff', async () => {
			const swarmDir = await createPlanWithActiveTask();
			const handoffPath = join(swarmDir, 'handoff.md');
			const consumedPath = join(swarmDir, 'handoff-consumed.md');
			await writeFile(handoffPath, 'New handoff content');
			await writeFile(consumedPath, 'Old consumed content');

			const result = await runRegisteredTurn();

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(existsSync(handoffPath)).toBe(false);
			expect(readFileSync(consumedPath, 'utf-8')).toBe('New handoff content');
			expect(renderedText(result.renderedMessages)).toContain(
				'New handoff content',
			);
		});

		it('performs the Windows-safe atomic rename and delivers the handoff body', async () => {
			const swarmDir = await createPlanWithActiveTask();
			const handoffPath = join(swarmDir, 'handoff.md');
			const consumedPath = join(swarmDir, 'handoff-consumed.md');
			await writeFile(handoffPath, 'Atomic rename test content');

			const result = await runRegisteredTurn();

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(existsSync(handoffPath)).toBe(false);
			expect(existsSync(consumedPath)).toBe(true);
			expect(renderedText(result.renderedMessages)).toContain(
				'Atomic rename test content',
			);
		});
	});

	describe('handoff detection in DISCOVER mode', () => {
		it('does not deliver a handoff when the registered message pass is sessionless', async () => {
			resetSwarmState();
			const swarmDir = await createSwarmDir();
			const handoffPath = join(swarmDir, 'handoff.md');
			await writeFile(handoffPath, 'Handoff content');
			const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
			const messages: HostPartsMessage[] = [
				{
					info: { id: 'discover-user', role: 'user' },
					parts: [{ type: 'text', text: 'Discover the project.' }],
				},
			];

			await host.hooks['experimental.chat.messages.transform'](
				{},
				{ messages },
			);

			expect(existsSync(handoffPath)).toBe(true);
			expect(messages.some((message) => isGuidanceCarrier(message))).toBe(
				false,
			);
			expect(renderedText(hostToModelMessages(messages))).not.toContain(
				'Handoff content',
			);
		});
	});

	describe('handoff with scoring enabled', () => {
		it('delivers a scored handoff through the registered host path', async () => {
			const swarmDir = await createPlanWithActiveTask();
			const handoffPath = join(swarmDir, 'handoff.md');
			const handoffContent = 'Scoring path handoff content';
			await writeFile(handoffPath, handoffContent);

			const result = await runRegisteredTurn({
				context_budget: {
					scoring: { enabled: true, max_candidates: 100 },
					max_injection_tokens: 10000,
				},
			});
			const handoffCarrier = result.handoffMessages.find(
				(message) =>
					isGuidanceCarrier(message) &&
					messageTextOf(message).includes(handoffContent),
			);

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(handoffCarrier).toBeDefined();
			expect(isRenderableGuidance(handoffCarrier)).toBe(true);
			expect(renderedText(result.renderedMessages)).toContain(handoffContent);
			expect(existsSync(handoffPath)).toBe(false);
			expect(existsSync(join(swarmDir, 'handoff-consumed.md'))).toBe(true);
		});

		it('handles a missing scored handoff without fabricating guidance', async () => {
			await createPlanWithActiveTask();

			const result = await runRegisteredTurn({
				context_budget: {
					scoring: { enabled: true, max_candidates: 100 },
					max_injection_tokens: 10000,
				},
			});

			expectArchitectSystemSurfaceIsStable(result.system);
			expect(
				result.handoffMessages.some(
					(message) =>
						isGuidanceCarrier(message) &&
						messageTextOf(message).includes('[HANDOFF BRIEF]'),
				),
			).toBe(false);
			expect(renderedText(result.renderedMessages)).not.toContain(
				'[HANDOFF BRIEF]',
			);
		});
	});
});
