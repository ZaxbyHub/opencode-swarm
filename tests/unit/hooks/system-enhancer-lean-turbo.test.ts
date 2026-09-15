/**
 * Tests for Lean Turbo guidance in the registered host path.
 *
 * Architect guidance must not vary the cache-sensitive system surface (#2759).
 * These tests therefore assert that the registered system transform leaves its
 * seed untouched and that the registered messages transform delivers banners
 * through a host-renderable user-role guidance carrier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	FULL_AUTO_BANNER,
	LEAN_TURBO_BANNER,
	TURBO_MODE_BANNER,
} from '../../../src/config/constants';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import {
	_internals,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';

const SESSION_ID = 'sess-lean-turbo-banner-test';
const BASE_SYSTEM = 'Stable architect system prefix';
const HOST_CONFIG = {
	version_check: false,
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

describe('System Enhancer — Lean Turbo Banner Delivery (#2759)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = createPluginHostProject('swarm-lean-turbo-test-');
		resetSwarmState();
		startAgentSession(SESSION_ID, 'architect');
	});

	afterEach(async () => {
		resetSwarmState();
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup; registered host workers can briefly hold handles.
		}
	});

	async function createSwarmFiles(): Promise<void> {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(
			join(swarmDir, 'plan.md'),
			'# Plan\n\n## Phase 1 [IN PROGRESS]\n\nTest phase.\n',
		);
		await writeFile(
			join(swarmDir, 'context.md'),
			'# Context\n\nTest context.\n',
		);
	}

	async function invokeRegisteredHost(): Promise<{
		messages: HostPartsMessage[];
		rendered: ReturnType<typeof hostToModelMessages>;
		system: string[];
	}> {
		const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: 'lean-turbo-user',
					role: 'user',
					agent: 'architect',
					sessionID: SESSION_ID,
				},
				parts: [{ type: 'text', text: 'Continue the active plan.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		const system = [BASE_SYSTEM];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID: SESSION_ID },
			{ system },
		);
		return { messages, rendered: hostToModelMessages(messages), system };
	}

	function expectStableArchitectSystem(system: string[]): void {
		expect(system).toEqual([BASE_SYSTEM]);
		expect(system.join('\n')).not.toContain('TURBO');
		expect(system.join('\n')).not.toContain('FULL-AUTO');
	}

	function expectRenderableGuidance(
		messages: HostPartsMessage[],
		requiredText?: string,
	): void {
		const carrier = messages.find(
			(message) =>
				isGuidanceCarrier(message) &&
				(!requiredText || messageTextOf(message).includes(requiredText)),
		);
		expect(carrier).toBeDefined();
		expect(isRenderableGuidance(carrier)).toBe(true);
		expect(carrier?.info.role).toBe('user');
	}

	describe('LEAN_TURBO_BANNER content verification', () => {
		it('contains lane dispatch override text', () => {
			expect(LEAN_TURBO_BANNER).toContain(
				'Lane dispatch overrides the one-agent-per-message rule',
			);
		});

		it('states lane tasks skip per-task Stage B', () => {
			expect(LEAN_TURBO_BANNER).toContain('Lane tasks skip per-task Stage B');
		});
	});

	describe('Lean Turbo banner delivery — turboStrategy === lean', () => {
		it('delivers the Lean Turbo banner through the registered messages transform', async () => {
			await createSwarmFiles();
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;

			const result = await invokeRegisteredHost();
			const carrier = result.messages.find(
				(message) =>
					isGuidanceCarrier(message) &&
					messageTextOf(message).includes('LEAN TURBO ACTIVE'),
			);

			expectStableArchitectSystem(result.system);
			expect(carrier).toBeDefined();
			expect(isRenderableGuidance(carrier)).toBe(true);
			expect(renderedText(result.rendered)).toContain('LEAN TURBO ACTIVE');
		});
	});

	describe('Lean Turbo banner delivery — leanTurboActive === true', () => {
		it('delivers the active Lean Turbo banner through the host-renderable carrier', async () => {
			await createSwarmFiles();
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;

			const result = await invokeRegisteredHost();

			expectStableArchitectSystem(result.system);
			expectRenderableGuidance(result.messages, 'LEAN TURBO ACTIVE');
			expect(renderedText(result.rendered)).toContain('LEAN TURBO ACTIVE');
		});
	});

	describe('Lean Turbo banner NOT injected — standard turbo only', () => {
		it('delivers standard Turbo but not Lean Turbo through messages', async () => {
			await createSwarmFiles();
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'standard';
			session.leanTurboActive = false;

			const result = await invokeRegisteredHost();
			const text = renderedText(result.rendered);

			expectStableArchitectSystem(result.system);
			expectRenderableGuidance(result.messages, 'TURBO MODE ACTIVE');
			expect(text).toContain('TURBO MODE ACTIVE');
			expect(text).not.toContain('LEAN TURBO ACTIVE');
		});
	});

	describe('Lean Turbo banner NOT injected — turbo off', () => {
		it('does not deliver Lean Turbo guidance when turbo is off', async () => {
			await createSwarmFiles();
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = false;
			session.turboStrategy = undefined;
			session.leanTurboActive = false;

			const result = await invokeRegisteredHost();

			expectStableArchitectSystem(result.system);
			expect(
				result.messages.some(
					(message) =>
						isGuidanceCarrier(message) &&
						messageTextOf(message).includes('LEAN TURBO ACTIVE'),
				),
			).toBe(false);
			expect(renderedText(result.rendered)).not.toContain('LEAN TURBO ACTIVE');
		});
	});

	describe('All three banners compose correctly — Turbo + Full-Auto + Lean', () => {
		it('delivers all three banners in one host-renderable guidance carrier', async () => {
			await createSwarmFiles();
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;
			session.fullAutoMode = true;

			const result = await invokeRegisteredHost();
			const text = renderedText(result.rendered);

			expectStableArchitectSystem(result.system);
			expectRenderableGuidance(result.messages, 'LEAN TURBO ACTIVE');
			expect(text).toContain('TURBO MODE ACTIVE');
			expect(text).toContain('FULL-AUTO MODE ACTIVE');
			expect(text).toContain('LEAN TURBO ACTIVE');
			expect(text).toContain(TURBO_MODE_BANNER.slice(0, 30));
			expect(text).toContain(FULL_AUTO_BANNER.slice(0, 30));
		});
	});

	describe('hasActiveLeanTurbo helper function', () => {
		it('returns true when turboStrategy === lean and leanTurboActive === true', () => {
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;

			expect(_internals.hasActiveLeanTurbo(SESSION_ID)).toBe(true);
		});

		it('returns false when turboStrategy === standard', () => {
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'standard';
			session.leanTurboActive = false;

			expect(_internals.hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});

		it('returns false when leanTurboActive === false despite lean strategy', () => {
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = false;

			expect(_internals.hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});

		it('returns false when turbo is off', () => {
			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = false;
			session.turboStrategy = undefined;
			session.leanTurboActive = false;

			expect(_internals.hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});
	});
});
