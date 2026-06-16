/**
 * Runtime tests for AUTO_PROCEED_BANNER injection in the system-enhancer hook.
 *
 * These tests exercise the actual code path in src/hooks/system-enhancer.ts
 * (around lines 1209-1230) that calls getResolvedAutoProceed, formats the
 * banner with the resolved value, source label, and nudge flag, and pushes
 * it into output.system via tryInject.
 *
 * Companion to tests/unit/phase-wrap/auto-proceed-behavior.test.ts which
 * verifies prompt text content. This file verifies runtime injection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_PROCEED_BANNER } from '../../../src/config/constants';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	_internals,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

describe('System Enhancer — Auto-Proceed Banner Injection (Runtime)', () => {
	let tempDir: string;
	const SESSION_ID = 'sess-auto-proceed-banner-runtime-test';

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-auto-proceed-runtime-'));
		resetSwarmState();
		startAgentSession(SESSION_ID, 'architect');
	});

	afterEach(async () => {
		swarmState.agentSessions.delete(SESSION_ID);
		try {
			await rm(tempDir, { recursive: true, force: true });
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
		const config = {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
		};
		const hooks = createSystemEnhancerHook(config, tempDir);
		const transform = hooks['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const input = { sessionID: SESSION_ID };
		const output = { system: ['Initial system prompt'] };
		await transform(input, output);
		return output.system;
	}

	it('injects AUTO_PROCEED_BANNER into output.system for the architect', async () => {
		await createSwarmFiles();
		const systemOutput = await invokeHook();

		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
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
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeUndefined();
	});

	it('does NOT inject the banner when no session is active', async () => {
		await createSwarmFiles();
		swarmState.agentSessions.delete(SESSION_ID);

		const systemOutput = await invokeHook();
		const bannerLine = systemOutput.find((s) =>
			s.startsWith(AUTO_PROCEED_BANNER),
		);
		expect(bannerLine).toBeUndefined();
	});
});
