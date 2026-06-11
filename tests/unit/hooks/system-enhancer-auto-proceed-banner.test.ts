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
		expect(bannerLine).toContain(
			'AUTO_PROCEED STATUS: off (source: plan-or-default)',
		);
		expect(bannerLine).toContain('nudge: false');
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
		expect(bannerLine).toContain('AUTO_PROCEED STATUS: on (source: session)');
		expect(bannerLine).toContain('nudge: true');
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
		expect(bannerLine).toContain('AUTO_PROCEED STATUS: off (source: session)');
		expect(bannerLine).toContain('nudge: true');
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
