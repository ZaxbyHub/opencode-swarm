/**
 * Tests for Lean Turbo banner injection in system-enhancer hook.
 *
 * Covers:
 * - Lean Turbo banner injected when turboStrategy === 'lean'
 * - Lean Turbo banner injected when leanTurboActive === true
 * - Lean Turbo banner NOT injected when standard turbo only
 * - Lean Turbo banner NOT injected when off
 * - All three banners (Turbo + Full-Auto + Lean) compose correctly
 * - Banner contains lane dispatch override text
 * - Banner states standard Turbo Stage B bypass does NOT apply
 *
 * Uses _internals seam for state manipulation, not mock.module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FULL_AUTO_BANNER,
	LEAN_TURBO_BANNER,
	TURBO_MODE_BANNER,
} from '../../../src/config/constants';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	_internals,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

describe('System Enhancer — Lean Turbo Banner Injection', () => {
	let tempDir: string;
	const SESSION_ID = 'sess-lean-turbo-banner-test';

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-lean-turbo-test-'));
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

	/**
	 * Helper to create minimal .swarm directory with plan.md and context.md
	 */
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

	/**
	 * Helper to invoke the transform hook and return the output system lines
	 */
	async function invokeHook(
		config: Parameters<typeof createSystemEnhancerHook>[0],
	): Promise<string[]> {
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

	const defaultConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	describe('LEAN_TURBO_BANNER content verification', () => {
		it('banner contains lane dispatch override text', () => {
			expect(LEAN_TURBO_BANNER).toContain(
				'Lane dispatch overrides the one-agent-per-message rule',
			);
		});

		it('banner states standard Turbo Stage B bypass does NOT apply', () => {
			expect(LEAN_TURBO_BANNER).toContain(
				'Standard Turbo Stage B bypass does NOT apply to Lean Turbo lanes',
			);
		});
	});

	describe('Lean Turbo banner injection — turboStrategy === lean', () => {
		it('injects Lean Turbo banner when turboStrategy is lean', async () => {
			await createSwarmFiles();

			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;

			const systemOutput = await invokeHook(defaultConfig);

			const hasLeanBanner = systemOutput.some((s) =>
				s.includes('LEAN TURBO ACTIVE'),
			);
			expect(hasLeanBanner).toBe(true);
		});
	});

	describe('Lean Turbo banner injection — leanTurboActive === true', () => {
		it('injects Lean Turbo banner when leanTurboActive is true', async () => {
			await createSwarmFiles();

			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;

			const systemOutput = await invokeHook(defaultConfig);

			const hasLeanBanner = systemOutput.some((s) =>
				s.includes('LEAN TURBO ACTIVE'),
			);
			expect(hasLeanBanner).toBe(true);
		});
	});

	describe('Lean Turbo banner NOT injected — standard turbo only', () => {
		it('does NOT inject Lean Turbo banner when turboMode=true but leanTurboActive=false', async () => {
			await createSwarmFiles();

			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'standard';
			session.leanTurboActive = false;

			const systemOutput = await invokeHook(defaultConfig);

			// Standard turbo banner should be present
			const hasTurboBanner = systemOutput.some((s) =>
				s.includes('TURBO MODE ACTIVE'),
			);
			expect(hasTurboBanner).toBe(true);

			// Lean turbo banner should NOT be present
			const hasLeanBanner = systemOutput.some((s) =>
				s.includes('LEAN TURBO ACTIVE'),
			);
			expect(hasLeanBanner).toBe(false);
		});
	});

	describe('Lean Turbo banner NOT injected — turbo off', () => {
		it('does NOT inject Lean Turbo banner when turbo is off', async () => {
			await createSwarmFiles();

			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = false;
			session.turboStrategy = undefined;
			session.leanTurboActive = false;

			const systemOutput = await invokeHook(defaultConfig);

			const hasLeanBanner = systemOutput.some((s) =>
				s.includes('LEAN TURBO ACTIVE'),
			);
			expect(hasLeanBanner).toBe(false);
		});
	});

	describe('All three banners compose correctly — Turbo + Full-Auto + Lean', () => {
		it('injects all three banners when turbo=lean, fullAuto=true, leanTurboActive=true', async () => {
			await createSwarmFiles();

			const session = _internals.swarmState.agentSessions.get(SESSION_ID)!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;
			session.fullAutoMode = true;

			const systemOutput = await invokeHook(defaultConfig);

			// Turbo banner
			const hasTurboBanner = systemOutput.some((s) =>
				s.includes('TURBO MODE ACTIVE'),
			);
			expect(hasTurboBanner).toBe(true);

			// Full-Auto banner
			const hasFullAutoBanner = systemOutput.some((s) =>
				s.includes('FULL-AUTO MODE ACTIVE'),
			);
			expect(hasFullAutoBanner).toBe(true);

			// Lean Turbo banner
			const hasLeanBanner = systemOutput.some((s) =>
				s.includes('LEAN TURBO ACTIVE'),
			);
			expect(hasLeanBanner).toBe(true);
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
