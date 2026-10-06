/**
 * Tests for the first-class activation behavior in handleFullAutoCommand.
 *
 * Full-Auto is a first-class runtime toggle: activation no longer requires
 * `full_auto.enabled: true` in the plugin config. The only config-level gate
 * is `full_auto.locked: true`, which refuses runtime activation entirely
 * (administrative hard-off). `off` and `status` always work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import { handleFullAutoCommand } from '../commands/full-auto';
import { _internals as recoveryInternals } from '../full-auto/recovery';
import {
	loadFullAutoRunState,
	pauseFullAutoRun,
	recordFullAutoRecoveryProbe,
} from '../full-auto/state';
import { getAgentSession, swarmState } from '../state';

describe('handleFullAutoCommand — first-class toggle & locked guard', () => {
	let testSessionId: string;
	let tmpDir: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		testSessionId = `config-guard-test-${Date.now()}`;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-guard-'));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'user-config');
		swarmState.agentSessions.set(testSessionId, {
			agentName: 'architect',
			lastToolCallTime: Date.now(),
			lastAgentEventTime: Date.now(),
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			selfCodingWarnedAtCount: 0,
			catastrophicPhaseWarnings: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: new Map(),
			lastGateOutcome: null,
			declaredCoderScope: null,
			lastScopeViolation: null,
			modifiedFilesThisCoderTask: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			lastCompletedPhaseAgentsDispatched: new Set(),
			turboMode: false,
			fullAutoMode: false,
			fullAutoInteractionCount: 0,
			fullAutoDeadlockCount: 0,
			fullAutoLastQuestionHash: null,
			coderRevisions: 0,
			revisionLimitHit: false,
			model_fallback_index: 0,
			modelFallbackExhausted: false,
			sessionRehydratedAt: 0,
			prmPatternCounts: new Map(),
			prmEscalationLevel: 0,
			prmLastPatternDetected: null,
			prmTrajectoryStep: 0,
			prmHardStopPending: false,
		});
		// Config-level enabled flag is deprecated and must NOT gate activation.
		swarmState.fullAutoEnabledInConfig = false;
	});

	afterEach(() => {
		swarmState.agentSessions.delete(testSessionId);
		swarmState.fullAutoEnabledInConfig = false;
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	function getSession() {
		const session = getAgentSession(testSessionId);
		if (!session) throw new Error('Session not found');
		return session;
	}

	function writeConfig(config: Record<string, unknown>): void {
		const configDir = path.join(tmpDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify(config),
			'utf-8',
		);
	}

	describe('first-class activation — no config enablement required', () => {
		it('enables with "on" when no config file exists at all', async () => {
			// Previous behavior: activation was refused with "full_auto.enabled is
			// not set to true in the swarm plugin config". First-class toggle:
			// activation succeeds and creates a durable running run state.
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
			expect(loadFullAutoRunState(tmpDir, testSessionId)?.status).toBe(
				'running',
			);
		});

		it('enables with "on" even when config explicitly sets full_auto.enabled = false', async () => {
			writeConfig({ full_auto: { enabled: false } });
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});

		it('enables via bare toggle from off', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});
	});

	describe('locked guard blocks activation when full_auto.locked is true', () => {
		beforeEach(() => {
			writeConfig({ full_auto: { locked: true } });
		});

		it('refuses "on" with a locked error and does not flip the session flag', async () => {
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('locked');
			expect(result).toContain('full_auto.locked');
			expect(getSession().fullAutoMode).toBe(false);
			// No durable run may be created by a refused activation.
			expect(loadFullAutoRunState(tmpDir, testSessionId)).toBeUndefined();
		});

		it('refuses bare toggle from off', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(result).toContain('locked');
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('"off" still works when locked', async () => {
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(
				tmpDir,
				['off'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('"status" still works when locked and reports the lock', async () => {
			const result = await handleFullAutoCommand(
				tmpDir,
				['status'],
				testSessionId,
			);
			expect(result).toContain('locked');
		});
	});

	describe('fail-closed activation when config is unreadable (regression F2)', () => {
		it('refuses "on" when a config file exists but cannot be parsed', async () => {
			// Previous behavior: a corrupt config silently fell back to Zod
			// defaults (locked: false), so corrupting the file bypassed the
			// administrative lock. Activation must fail closed instead.
			const configDir = path.join(tmpDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				'{ not valid json',
				'utf-8',
			);
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('could not be loaded');
			expect(getSession().fullAutoMode).toBe(false);
			expect(loadFullAutoRunState(tmpDir, testSessionId)).toBeUndefined();
		});

		it('"off" still works when the config is unreadable', async () => {
			const configDir = path.join(tmpDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				'{ not valid json',
				'utf-8',
			);
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(
				tmpDir,
				['off'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});
	});

	describe('locked ORs across config levels (regression F7)', () => {
		it('a project-level locked: false cannot override a user-level locked: true', async () => {
			// Previous behavior: deepMerge let the repo-controlled project
			// config win, so .opencode/opencode-swarm.json with locked: false
			// defeated the user-level lock.
			const userConfigHome = fs.mkdtempSync(
				path.join(os.tmpdir(), 'full-auto-xdg-'),
			);
			const prevXdg = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = userConfigHome;
			try {
				const userDir = path.join(userConfigHome, 'opencode');
				fs.mkdirSync(userDir, { recursive: true });
				fs.writeFileSync(
					path.join(userDir, 'opencode-swarm.json'),
					JSON.stringify({ full_auto: { locked: true } }),
					'utf-8',
				);
				writeConfig({ full_auto: { locked: false } });

				const result = await handleFullAutoCommand(
					tmpDir,
					['on'],
					testSessionId,
				);
				expect(result).toContain('locked');
				expect(getSession().fullAutoMode).toBe(false);
			} finally {
				if (prevXdg === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = prevXdg;
				}
				try {
					fs.rmSync(userConfigHome, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			}
		});
	});

	describe('locked + toggle from ON still allows turning off', () => {
		it('bare toggle from ON proceeds to the off path under a locked config', async () => {
			writeConfig({ full_auto: { locked: true } });
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});
	});

	describe('disabling always works regardless of config state', () => {
		it('disables with "off" when no config exists', async () => {
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(
				tmpDir,
				['off'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('disabling on already-disabled session works', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(
				tmpDir,
				['off'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});
	});

	describe('error message references dashed shortcut form', () => {
		it('no-session error uses /swarm-full-auto (dashed), not /swarm full-auto (spaced)', async () => {
			const result = await handleFullAutoCommand(tmpDir, [], '');
			expect(result).toContain('/swarm-full-auto');
			expect(result).not.toContain('/swarm full-auto');
		});
	});

	describe('resume runs the same authorization preflight as start', () => {
		const INFRA_PAUSE =
			'oversight infrastructure failure after 1 attempt(s): server error';
		const LOCKED_MESSAGE =
			'Error: Full-Auto Mode is locked for this project (full_auto.locked is true in the swarm plugin config). Runtime activation is disabled by configuration; remove the lock to use /swarm full-auto on.';
		const UNREADABLE_MESSAGE =
			'Error: Full-Auto Mode cannot be enabled — a swarm plugin config file exists but could not be loaded, so full_auto.locked cannot be verified. Fix the config file (see warnings above) and retry.';

		beforeEach(() => {
			// Defense-in-depth against module-level evaluator state leaked from
			// sibling test files in the shared bun test process.
			recoveryInternals.resetRecoveryBlockerEvaluator();
		});

		function writeCorruptConfig(): void {
			const configDir = path.join(tmpDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				'{ not valid json',
				'utf-8',
			);
		}

		/**
		 * Seeds a paused infrastructure run with a healthy matching recovery
		 * probe (deterministic far-future expiry — literal timestamps keep the
		 * file clear of raw clock reads). Returns the paused runGeneration.
		 */
		async function seedPausedRunWithProbe(expiresAt: string): Promise<number> {
			const onOut = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			if (!onOut.includes('Full-Auto Mode enabled')) {
				throw new Error(`seeding failed: 'on' returned ${onOut}`);
			}
			pauseFullAutoRun(tmpDir, testSessionId, INFRA_PAUSE);
			const paused = loadFullAutoRunState(tmpDir, testSessionId);
			recordFullAutoRecoveryProbe(tmpDir, testSessionId, {
				pauseGeneration: paused?.pauseGeneration ?? 0,
				checkedAt: '2026-01-01T00:00:00.000Z',
				expiresAt,
				attempts: 1,
				outcome: 'healthy',
				reason: 'ok',
			});
			return paused?.runGeneration ?? 0;
		}

		it('refuses resume when full_auto.locked is true and leaves the paused run untouched', async () => {
			const runGen = await seedPausedRunWithProbe('2999-01-01T00:00:00.000Z');
			writeConfig({ full_auto: { locked: true } });
			const flagBefore = getSession().fullAutoMode;
			const probeBefore = loadFullAutoRunState(
				tmpDir,
				testSessionId,
			)?.lastRecoveryProbe;

			const result = await handleFullAutoCommand(
				tmpDir,
				['resume'],
				testSessionId,
			);

			expect(result).toBe(LOCKED_MESSAGE);
			const after = loadFullAutoRunState(tmpDir, testSessionId);
			expect(after?.status).toBe('paused');
			expect(after?.runGeneration).toBe(runGen);
			// A refusal mutates nothing: the legacy flag keeps its pre-call
			// value (true in the seeded paused state — `on` sets it and no
			// production pause site clears it), and the recovery probe stays
			// intact so the fix-config-then-resume loop still works.
			expect(getSession().fullAutoMode).toBe(flagBefore);
			expect(after?.lastRecoveryProbe).toEqual(probeBefore);
		});

		it('refuses resume when the config is unreadable (fail-closed) and leaves the paused run untouched', async () => {
			const runGen = await seedPausedRunWithProbe('2999-01-01T00:00:00.000Z');
			writeCorruptConfig();
			const flagBefore = getSession().fullAutoMode;
			const probeBefore = loadFullAutoRunState(
				tmpDir,
				testSessionId,
			)?.lastRecoveryProbe;

			const result = await handleFullAutoCommand(
				tmpDir,
				['resume'],
				testSessionId,
			);

			expect(result).toBe(UNREADABLE_MESSAGE);
			const after = loadFullAutoRunState(tmpDir, testSessionId);
			expect(after?.status).toBe('paused');
			expect(after?.runGeneration).toBe(runGen);
			expect(getSession().fullAutoMode).toBe(flagBefore);
			expect(after?.lastRecoveryProbe).toEqual(probeBefore);
		});

		it('still resumes with a clean config and a valid probe (no over-blocking)', async () => {
			const runGen = await seedPausedRunWithProbe('2999-01-01T00:00:00.000Z');

			const result = await handleFullAutoCommand(
				tmpDir,
				['resume'],
				testSessionId,
			);

			expect(result).toContain('Full-Auto Mode resumed');
			const after = loadFullAutoRunState(tmpDir, testSessionId);
			expect(after?.status).toBe('running');
			expect(after?.runGeneration).toBe(runGen + 1);
			expect(getSession().fullAutoMode).toBe(true);
		});

		it('refuses resume with the fail-closed message when the config is both locked and unreadable (precedence pin)', async () => {
			// Seed under the harness's clean user config first; only THEN swap
			// in a user-level locked:true (temp XDG_CONFIG_HOME, the
			// regression-F7 pattern) plus a corrupt project config, so BOTH
			// refusal predicates fire — configHadErrors must win, same as `on`.
			await seedPausedRunWithProbe('2999-01-01T00:00:00.000Z');
			const userConfigHome = canonicalMkdtemp('resume-auth-xdg-');
			const prevXdg = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = userConfigHome;
			try {
				const userDir = path.join(userConfigHome, 'opencode');
				fs.mkdirSync(userDir, { recursive: true });
				fs.writeFileSync(
					path.join(userDir, 'opencode-swarm.json'),
					JSON.stringify({ full_auto: { locked: true } }),
					'utf-8',
				);
				writeCorruptConfig();

				const result = await handleFullAutoCommand(
					tmpDir,
					['resume'],
					testSessionId,
				);

				expect(result).toBe(UNREADABLE_MESSAGE);
				expect(loadFullAutoRunState(tmpDir, testSessionId)?.status).toBe(
					'paused',
				);
			} finally {
				if (prevXdg === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = prevXdg;
				}
				try {
					fs.rmSync(userConfigHome, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			}
		});

		it('refuses resume with the LOCKED message even when the probe is invalid (preflight ordering pin)', async () => {
			// Expired probe: resume eligibility would fail — but the
			// authorization preflight runs FIRST, so the observable output is
			// the locked refusal, never the probe-eligibility error.
			await seedPausedRunWithProbe('2000-01-01T00:00:00.000Z');
			writeConfig({ full_auto: { locked: true } });

			const result = await handleFullAutoCommand(
				tmpDir,
				['resume'],
				testSessionId,
			);

			expect(result).toBe(LOCKED_MESSAGE);
			expect(loadFullAutoRunState(tmpDir, testSessionId)?.status).toBe(
				'paused',
			);
		});
	});
});
