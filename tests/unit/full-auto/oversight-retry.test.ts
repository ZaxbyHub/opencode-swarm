/**
 * Unit tests for src/full-auto/oversight.ts — FR-003 retry and auto-degrade.
 *
 * Tests:
 *   SC-009: oversight retries transient errors (mocked to fail twice, succeed on 3rd).
 *   SC-010: pause message identifies oversight cause distinctly from policy pause.
 *   SC-011: auto-degrade after max_consecutive_dispatch_failures consecutive failures.
 *   Config: new schema keys present with correct defaults.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchFullAutoOversight } from '../../../src/full-auto/oversight';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { createFullAutoPermissionHook } from '../../../src/hooks/full-auto-permission';
import { _internals as stateInternals } from '../../../src/state';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-oversight-retry-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ---------------------------------------------------------------------------
// SC-009: oversight retries transient errors
// ---------------------------------------------------------------------------
describe('SC-009 — oversight retries transient errors', () => {
	test('retries up to max_dispatch_retries then succeeds', async () => {
		startFullAutoRun(tmpDir, 'sess-retry', { enabled: true });

		let createCallCount = 0;
		const mockClient = {
			session: {
				create: mock(async () => {
					createCallCount++;
					// Fail on first 2 attempts, succeed on 3rd.
					if (createCallCount <= 2) {
						return {
							data: null,
							error: { code: 'ERR_TRANSIENT', message: 'server error' },
						};
					}
					return { data: { id: 'critic-session-ok' }, error: null };
				}),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: looks fine\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-retry',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 2,
				max_consecutive_dispatch_failures: 3,
			},
		});

		// Should succeed after 3 create attempts (1 original + 2 retries).
		expect(createCallCount).toBe(3);
		expect(out.verdict).toBe('APPROVED');
		expect(out.decision).toBe('allow');
	});

	test('pauses after exhausting retries on persistent create failure', async () => {
		startFullAutoRun(tmpDir, 'sess-fail', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: null,
					error: { code: 'ERR_TRANSIENT', message: 'server error' },
				})),
				prompt: mock(async () => ({
					data: null,
					error: { code: 'ERR_PROMPT', message: 'prompt error' },
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-fail',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 2,
				max_consecutive_dispatch_failures: 3,
			},
		});

		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pause');
		const state = loadFullAutoRunState(tmpDir, 'sess-fail');
		expect(state?.status).toBe('paused');
		// Pause reason must identify infrastructure failure.
		expect(state?.pauseReason).toContain('infrastructure failure');
	});

	test('resets consecutive failure counter on success', async () => {
		// Start with an active run.
		startFullAutoRun(tmpDir, 'sess-reset', { enabled: true });

		// First dispatch: fail once (1 create attempt fails, then succeeds).
		let createCallCount = 0;
		const mockClient = {
			session: {
				create: mock(async () => {
					createCallCount++;
					if (createCallCount === 1) {
						return { data: null, error: { code: 'ERR', message: 'transient' } };
					}
					return { data: { id: 'session-ok' }, error: null };
				}),
				prompt: mock(async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-reset',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 2,
				max_consecutive_dispatch_failures: 3,
			},
		});

		const stateAfterSuccess = loadFullAutoRunState(tmpDir, 'sess-reset');
		// Counter should have been reset to 0 on success.
		expect(stateAfterSuccess?.counters.consecutiveOversightFailures).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// SC-010: pause message identifies oversight cause distinctly from policy pause
// ---------------------------------------------------------------------------
describe('SC-010 — oversight pause reason is distinguishable from policy pause', () => {
	test('pause reason for infrastructure failure contains OVERSIGHT_INFRASTRUCTURE_FAILURE', async () => {
		startFullAutoRun(tmpDir, 'sess-infra', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: null,
					error: { code: 'ERR_TRANSIENT', message: 'server error' },
				})),
				prompt: mock(async () => ({
					data: null,
					error: { code: 'ERR', message: 'prompt error' },
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-infra',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 0, // no retries — immediate pause
				max_consecutive_dispatch_failures: 3,
			},
		});

		const state = loadFullAutoRunState(tmpDir, 'sess-infra');
		expect(state?.status).toBe('paused');
		// The pause reason must indicate infrastructure failure so the permission
		// hook error message can prefix it as OVERSIGHT_INFRASTRUCTURE_FAILURE.
		expect(state?.pauseReason).toContain('infrastructure failure');
		expect(state?.pauseReason).toContain('1 attempt'); // max_retries=0 → 1 attempt total

		// SC-010: verify the exact permission-hook error prefix.
		const hook = createFullAutoPermissionHook({
			// @ts-expect-error — minimal config sufficient for permission hook
			config: { full_auto: { enabled: true, mode: 'supervised' }, agents: {} },
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'sess-infra', callID: 'c1' },
				{ args: { file_path: 'x' } },
			),
		).rejects.toThrow(/^FULL_AUTO_PAUSED:OVERSIGHT_INFRASTRUCTURE_FAILURE/);
	});

	test('policy pause (denial threshold) reason does NOT contain infrastructure failure', async () => {
		startFullAutoRun(tmpDir, 'sess-policy', { enabled: true });

		// Simulate a policy-based pause by manually pausing with a denial reason.
		const { pauseFullAutoRun } = await import('../../../src/full-auto/state');
		pauseFullAutoRun(
			tmpDir,
			'sess-policy',
			'denial threshold exceeded: 3 consecutive denials',
		);

		const state = loadFullAutoRunState(tmpDir, 'sess-policy');
		expect(state?.status).toBe('paused');
		expect(state?.pauseReason).not.toContain('infrastructure failure');
		expect(state?.pauseReason).toContain('denial threshold');
	});
});

// ---------------------------------------------------------------------------
// SC-011: auto-degrade to manual mode after max consecutive failures
// ---------------------------------------------------------------------------
describe('SC-011 — auto-degrade after max_consecutive_dispatch_failures', () => {
	test('terminates (degrades to manual) after 3 consecutive infrastructure failures', async () => {
		startFullAutoRun(tmpDir, 'sess-degrade', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: null,
					error: { code: 'ERR_TRANSIENT', message: 'server error' },
				})),
				prompt: mock(async () => ({
					data: null,
					error: { code: 'ERR', message: 'prompt error' },
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		// Exhaust 3 failures — should auto-degrade on the 3rd.
		for (let i = 0; i < 3; i++) {
			const out = await dispatchFullAutoOversight({
				directory: tmpDir,
				sessionID: 'sess-degrade',
				trigger: 'test',
				triggerSource: 'tool_action',
				criticModel: 'test-model',
				oversightAgentName: 'critic_oversight',
				fullAutoConfig: {
					max_dispatch_retries: 0, // immediate failure each time
					max_consecutive_dispatch_failures: 3,
				},
			});
			expect(out.verdict).toBe('BLOCKED');
		}

		const state = loadFullAutoRunState(tmpDir, 'sess-degrade');
		// After 3rd failure, status should be 'terminated' (not 'paused').
		expect(state?.status).toBe('terminated');
		expect(state?.terminateReason).toContain('auto-degraded');
		expect(state?.terminateReason).toContain('3');
	});

	test('pauses (does not terminate) when below consecutive failure threshold', async () => {
		startFullAutoRun(tmpDir, 'sess-threshold', { enabled: true });

		const mockClient = {
			session: {
				create: mock(async () => ({
					data: null,
					error: { code: 'ERR_TRANSIENT', message: 'server error' },
				})),
				prompt: mock(async () => ({
					data: null,
					error: { code: 'ERR', message: 'prompt error' },
				})),
				delete: mock(async () => ({})),
			},
		};
		stateInternals.swarmState.opencodeClient = mockClient as any;

		// Only 2 failures — below threshold of 3.
		for (let i = 0; i < 2; i++) {
			await dispatchFullAutoOversight({
				directory: tmpDir,
				sessionID: 'sess-threshold',
				trigger: 'test',
				triggerSource: 'tool_action',
				criticModel: 'test-model',
				oversightAgentName: 'critic_oversight',
				fullAutoConfig: {
					max_dispatch_retries: 0,
					max_consecutive_dispatch_failures: 3,
				},
			});
		}

		const state = loadFullAutoRunState(tmpDir, 'sess-threshold');
		// Still paused (not terminated) because we haven't hit the threshold.
		expect(state?.status).toBe('paused');
		// But the counter has been incremented.
		expect(state?.counters.consecutiveOversightFailures).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Config schema: new keys present with correct defaults
// ---------------------------------------------------------------------------
describe('Config schema — FR-003 new oversight keys', () => {
	test('full_auto.oversight schema accepts max_dispatch_retries', async () => {
		const schemaModule = await import('../../../src/config/schema.js');
		const parse = schemaModule.PluginConfigSchema.parse;
		const result = parse({
			full_auto: {
				enabled: true,
				oversight: {
					max_dispatch_retries: 5,
					max_consecutive_dispatch_failures: 10,
				},
			},
		});
		expect(result.full_auto?.oversight?.max_dispatch_retries).toBe(5);
		expect(result.full_auto?.oversight?.max_consecutive_dispatch_failures).toBe(
			10,
		);
	});

	test('full_auto.oversight schema defaults are correct', async () => {
		const schemaModule = await import('../../../src/config/schema.js');
		const parse = schemaModule.PluginConfigSchema.parse;
		const result = parse({
			full_auto: { enabled: true },
		});
		expect(result.full_auto?.oversight?.max_dispatch_retries).toBe(2);
		expect(result.full_auto?.oversight?.max_consecutive_dispatch_failures).toBe(
			3,
		);
	});

	test('max_dispatch_retries must be non-negative integer', async () => {
		const schemaModule = await import('../../../src/config/schema.js');
		const parse = schemaModule.PluginConfigSchema.safeParse;
		const invalid = parse({
			full_auto: {
				enabled: true,
				oversight: { max_dispatch_retries: -1 },
			},
		});
		expect(invalid.success).toBe(false);
	});

	test('max_consecutive_dispatch_failures must be non-negative integer', async () => {
		const schemaModule = await import('../../../src/config/schema.js');
		const parse = schemaModule.PluginConfigSchema.safeParse;
		const invalid = parse({
			full_auto: {
				enabled: true,
				oversight: { max_consecutive_dispatch_failures: -5 },
			},
		});
		expect(invalid.success).toBe(false);
	});
});
