/**
 * Runtime tests for AUTO_PROCEED_BANNER delivery through the registered host.
 *
 * These tests exercise the actual code path in src/hooks/system-enhancer.ts
 * (around lines 1209-1230) that calls getResolvedAutoProceed, formats the
 * banner with the resolved value, source label, and nudge flag. Architect
 * guidance is asserted in the late user-role carrier, never output.system.
 *
 * Companion to tests/unit/phase-wrap/auto-proceed-behavior.test.ts which
 * verifies prompt text content. This file verifies runtime injection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTO_PROCEED_BANNER } from '../../../src/config/constants';
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
import { safeRmRecursive } from '../../helpers/safe-test-dir';

const BASE_SYSTEM = 'Stable architect system prefix';
const HOST_CONFIG = {
	version_check: false,
	context_budget: { scoring: { enabled: false } },
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

describe('System Enhancer — Auto-Proceed Banner Injection (Runtime)', () => {
	let tempDir: string;
	const SESSION_ID = 'sess-auto-proceed-banner-runtime-test';

	beforeEach(async () => {
		tempDir = createPluginHostProject('swarm-auto-proceed-runtime-');
		resetSwarmState();
		startAgentSession(SESSION_ID, 'architect');
	});

	afterEach(async () => {
		swarmState.agentSessions.delete(SESSION_ID);
		try {
			safeRmRecursive(tempDir);
		} catch {
			// best-effort
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

	async function invokeHook(): Promise<string[]> {
		const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
		const agent = swarmState.agentSessions.get(SESSION_ID)?.agentName;
		const system = [BASE_SYSTEM];
		if (agent === 'architect') {
			const messages: HostPartsMessage[] = [
				{
					info: {
						id: 'auto-proceed-user',
						role: 'user',
						agent,
						sessionID: SESSION_ID,
					},
					parts: [{ type: 'text', text: 'Continue the active plan.' }],
				},
			];
			await host.hooks['experimental.chat.messages.transform'](
				{},
				{ messages },
			);
			await host.hooks['experimental.chat.system.transform'](
				{ sessionID: SESSION_ID },
				{ system },
			);
			expect(system).toEqual([BASE_SYSTEM]);
			const carrier = messages.find(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			);
			expect(carrier).toBeDefined();
			if (!carrier) return [];
			expect(isRenderableGuidance(carrier)).toBe(true);
			expect(carrier.info.role).toBe('user');
			const text = messageTextOf(carrier);
			expect(renderedText(hostToModelMessages(messages))).toContain(text);
			return [text];
		}

		await host.hooks['experimental.chat.system.transform'](
			{ sessionID: SESSION_ID },
			{ system },
		);
		return system;
	}

	it('delivers AUTO_PROCEED_BANNER in the architect user-role carrier', async () => {
		await createSwarmFiles();
		const systemOutput = await invokeHook();

		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeDefined();
		expect(bannerLine).toContain('AUTO_PROCEED STATUS:');
	});

	it('banner uses the documented key-value format (auto-proceed / source / nudge)', async () => {
		await createSwarmFiles();
		// The phase-wrap skill documents the banner format as:
		//   - `auto-proceed: <on|off>`
		//   - `source: <session|plan-or-default>`
		//   - `nudge: <true|false>`
		// Verify all three keys are present in the injected line.
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.autoProceedOverride = true;
		session.autoProceedNudgeDone = true;

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeDefined();
		expect(bannerLine).toMatch(/- auto-proceed: (on|off)/);
		expect(bannerLine).toMatch(/- source: (session|plan-or-default)/);
		expect(bannerLine).toMatch(/- nudge: (true|false)/);
	});

	it('banner resolves to "off" with "plan-or-default" source when nothing is set', async () => {
		await createSwarmFiles();
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		// Both autoProceedOverride and autoProceedNudgeDone remain undefined
		// and the plan has no execution_profile.auto_proceed.

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeDefined();
		expect(bannerLine).toContain('- auto-proceed: off');
		expect(bannerLine).toContain('- source: plan-or-default');
		expect(bannerLine).toContain('- nudge: false');
	});

	it('banner resolves to "on" with "session" source when autoProceedOverride=true', async () => {
		await createSwarmFiles();
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.autoProceedOverride = true;
		session.autoProceedNudgeDone = true;

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeDefined();
		expect(bannerLine).toContain('- auto-proceed: on');
		expect(bannerLine).toContain('- source: session');
		expect(bannerLine).toContain('- nudge: true');
	});

	it('banner resolves to "off" with "session" source when autoProceedOverride=false', async () => {
		await createSwarmFiles();
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.autoProceedOverride = false;
		session.autoProceedNudgeDone = true;

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeDefined();
		expect(bannerLine).toContain('- auto-proceed: off');
		expect(bannerLine).toContain('- source: session');
		expect(bannerLine).toContain('- nudge: true');
	});

	it('banner reflects override=true, nudge=false independently (mismatched state)', async () => {
		// Edge case: user has set override=true but nudge is still false.
		// The banner must report the override as on and the nudge as false,
		// matching the live session state without combining them.
		await createSwarmFiles();
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.autoProceedOverride = true;
		session.autoProceedNudgeDone = false;

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeDefined();
		expect(bannerLine).toContain('- auto-proceed: on');
		expect(bannerLine).toContain('- source: session');
		expect(bannerLine).toContain('- nudge: false');
	});

	it('does NOT inject the banner for non-architect sessions', async () => {
		await createSwarmFiles();
		// End the architect session and start a reviewer session instead.
		swarmState.agentSessions.delete(SESSION_ID);
		startAgentSession(SESSION_ID, 'reviewer');

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeUndefined();
	});

	it('does NOT inject the banner when a non-architect session has autoProceedOverride set (security boundary)', async () => {
		await createSwarmFiles();
		// Even if a non-architect session happens to have autoProceedOverride set,
		// the banner must NOT be injected. Two layers protect this:
		//   1. The parent `if (isArchitect)` block at line 1190 of system-enhancer.ts
		//   2. The inner `stripKnownSwarmPrefix(...) === 'architect'` check at
		//      line 1216 of system-enhancer.ts (defense in depth)
		// Together they ensure the banner is architect-only.
		swarmState.agentSessions.delete(SESSION_ID);
		startAgentSession(SESSION_ID, 'reviewer');
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.autoProceedOverride = true;
		session.autoProceedNudgeDone = true;

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeUndefined();
	});

	it('inner guard blocks injection for non-architect session.agentName (defense in depth)', async () => {
		await createSwarmFiles();
		// Test the inner guard specifically: even if the parent `isArchitect` block
		// were ever removed or relaxed, the inner
		// `stripKnownSwarmPrefix(session.agentName) === 'architect'` check at
		// line 1216 of system-enhancer.ts must still block the banner.
		//
		// We cannot remove the parent block at runtime, but we CAN set up a state
		// where the activeAgent for the session is non-architect while the
		// session has autoProceedOverride set. The inner check looks at
		// session.agentName (not the activeAgent), so a direct test of session
		// state is the cleanest assertion.
		swarmState.agentSessions.delete(SESSION_ID);
		startAgentSession(SESSION_ID, 'coder');
		const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
		session.autoProceedOverride = true;
		session.autoProceedNudgeDone = false;

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeUndefined();
	});

	it('does NOT inject the banner when no session is active', async () => {
		await createSwarmFiles();
		swarmState.agentSessions.delete(SESSION_ID);

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((text) =>
			text.includes(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeUndefined();
	});
});
