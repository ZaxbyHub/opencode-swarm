/**
 * #3106 (PRR-003): /swarm full-auto resume re-derives the armed mode from
 * live config (mirroring `on`) instead of re-arming with the paused-time mode,
 * plus the command-level CAS interleave refusal leg (paired with
 * tests/unit/full-auto/resume-cas-3106.test.ts for the state-level CAS).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleFullAutoCommand } from '../../../src/commands/full-auto';
import {
	_internals as recoveryInternals,
	registerFullAutoRecoveryBlockerEvaluator,
} from '../../../src/full-auto/recovery';
import {
	loadFullAutoRunState,
	pauseFullAutoRun,
	recordFullAutoRecoveryProbe,
	startFullAutoRun,
	terminateFullAutoRun,
} from '../../../src/full-auto/state';
import { startAgentSession, swarmState } from '../../../src/state';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'sess-resume-mode-3106';
const INFRA_PAUSE =
	'oversight infrastructure failure after 1 attempt(s): server error';

let tmpDir: string;
let originalXdgConfigHome: string | undefined;

function writeProjectConfig(fullAuto: unknown): void {
	fs.mkdirSync(path.join(tmpDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(fullAuto === undefined ? {} : { full_auto: fullAuto }),
		'utf8',
	);
}

/** Arm → pause → healthy recovery probe, so resume is probe-eligible. */
async function seedPausedRun(mode: string): Promise<void> {
	startFullAutoRun(tmpDir, SESSION_ID, { mode } as never);
	pauseFullAutoRun(tmpDir, SESSION_ID, INFRA_PAUSE);
	const runState = loadFullAutoRunState(tmpDir, SESSION_ID);
	if (!runState) throw new Error('seed failed: no run state after pause');
	// Freeze at the REAL current instant (not the helper's epoch-0 default) so
	// the recorded probe stays eligible after the freeze lifts.
	const fixedNow = Date.now();
	await withFrozenClockAsync(
		async () => {
			recordFullAutoRecoveryProbe(tmpDir, SESSION_ID, {
				pauseGeneration: runState.pauseGeneration ?? 0,
				checkedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				attempts: 1,
				outcome: 'healthy',
				reason: 'probe ok',
			});
		},
		{ fixedNow },
	);
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('resume-mode-3106-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg-config');
	swarmState.fullAutoEnabledInConfig = true;
	startAgentSession(SESSION_ID, 'architect');
});

afterEach(() => {
	swarmState.agentSessions.delete(SESSION_ID);
	swarmState.fullAutoEnabledInConfig = false;
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
	recoveryInternals.resetRecoveryBlockerEvaluator();
	registerFullAutoRecoveryBlockerEvaluator(() => []);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resume mode re-derivation (#3106 PRR-003)', () => {
	test('live config tightening is in force for the resumed run', async () => {
		writeProjectConfig({ mode: 'strict' });
		await seedPausedRun('assisted');
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).not.toStartWith('Error:');
		expect(out).toContain('mode=strict');
		expect(loadFullAutoRunState(tmpDir, SESSION_ID)?.mode).toBe('strict');
	}, 60_000);

	test('no explicit config mode: the parsed config materializes the schema default (supervised) and wins over the paused-time mode', async () => {
		// Schema nuance (#3106 owner decision disclosure): full_auto.mode has
		// a Zod .default('supervised'), so the MERGED PARSED config always
		// carries a mode — the hybrid's "config absent keeps the run's armed
		// mode" arm is unreachable at the parsed layer, and a per-run
		// override does not survive resume unless the config sets no
		// full_auto at all AND the raw layer were consulted. We pin the
		// actual shipped behavior; the nuance is disclosed in the fragment.
		writeProjectConfig(undefined);
		await seedPausedRun('assisted');
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).not.toStartWith('Error:');
		expect(loadFullAutoRunState(tmpDir, SESSION_ID)?.mode).toBe('supervised');
	}, 60_000);

	// NOTE: this cell is non-discriminating for the mode-SOURCE axis — the
	// old runState fallback and the new config-default semantics arm the
	// same value here. The supervised outcome is attributable to the parsed
	// config's schema default (full_auto.mode always materializes), NOT to
	// the terminal ?? fallback: under a successful config parse that
	// fallback is unreachable (runState.mode is always set on a paused
	// run, and fullAutoConfig?.mode is always set when parsing succeeds).
	// Cell 2 above is the discriminator for the semantics change.
	test('config file without a full_auto block: the schema default (supervised) wins over the paused-time mode', async () => {
		writeProjectConfig(undefined);
		await seedPausedRun('supervised');
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).not.toStartWith('Error:');
		expect(loadFullAutoRunState(tmpDir, SESSION_ID)?.mode).toBe('supervised');
	}, 60_000);
});

describe('resume CAS command interleave (#3106 PRR-004)', () => {
	test('terminal write inside the check-then-arm window is refused, not resurrected', async () => {
		writeProjectConfig(undefined);
		await seedPausedRun('supervised');
		// The recovery-blocker evaluator runs INSIDE the command, between the
		// state read and the arm — the true production interleave window.
		registerFullAutoRecoveryBlockerEvaluator(() => {
			terminateFullAutoRun(
				tmpDir,
				SESSION_ID,
				'manual abort via /swarm full-auto abort',
			);
			return [];
		});
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session).toBeDefined();
		if (session) session.fullAutoMode = false;
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).toStartWith('Error:');
		expect(out).toContain('/swarm full-auto on');
		expect(out).not.toContain('retry-oversight');
		const after = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(after?.status).toBe('terminated');
		expect(after?.terminateReason).toBe(
			'manual abort via /swarm full-auto abort',
		);
		expect(session?.fullAutoMode).toBe(false);
	}, 60_000);

	test('re-pause inside the check-then-arm window is refused with retry-oversight guidance (run stays resumable)', async () => {
		writeProjectConfig(undefined);
		await seedPausedRun('supervised');
		const seeded = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(seeded?.status).toBe('paused');
		// A second process pauses the run INSIDE the command, between the
		// state read and the arm — pauseGeneration moves under the run, so
		// the CAS refuses. Unlike the terminate leg, the run stays paused
		// and resumable: the refusal guidance points at retry-oversight
		// (fresh probe), not at re-enable.
		registerFullAutoRecoveryBlockerEvaluator(() => {
			pauseFullAutoRun(
				tmpDir,
				SESSION_ID,
				'oversight infrastructure failure after 1 attempt(s): server error',
			);
			return [];
		});
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).toStartWith('Error:');
		expect(out).toContain('retry-oversight');
		const after = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(after?.status).toBe('paused');
		expect(after?.pauseGeneration).toBe((seeded?.pauseGeneration ?? 0) + 1);
	}, 60_000);

	test('non-infrastructure re-pause refusal names the reason and does NOT point at retry-oversight', async () => {
		writeProjectConfig(undefined);
		await seedPausedRun('supervised');
		const seeded = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(seeded?.status).toBe('paused');
		// canRetryOversight requires an infrastructure/deadline pause reason;
		// a concurrent reactive-verdict or denial-limit re-pause (reachable
		// on the legacy session flag, full-auto-intercept.ts:1464) is NOT
		// retry-oversight-eligible, so the refusal must say so instead of
		// recommending a command that would refuse the run (Stage B NEW-1).
		registerFullAutoRecoveryBlockerEvaluator(() => {
			pauseFullAutoRun(tmpDir, SESSION_ID, 'reactive verdict DENY');
			return [];
		});
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).toStartWith('Error:');
		expect(out).toContain(
			'non-infrastructure pause is not retry-oversight-eligible',
		);
		expect(out).toContain('reason: reactive verdict DENY');
		expect(out).not.toContain('to establish a fresh probe');
		// The recovery path must be actionable: off→on is the only supported
		// recovery for a non-infrastructure pause (canResumeFromProbe still
		// requires an infrastructure reason, so re-running resume alone is
		// refused — closeout NEW-1).
		expect(out).toContain('/swarm full-auto off');
		expect(out).toContain('/swarm full-auto on');
		const after = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(after?.status).toBe('paused');
		expect(after?.pauseGeneration).toBe((seeded?.pauseGeneration ?? 0) + 1);
	}, 60_000);

	test('positive control: no interleave, resume arms (status running)', async () => {
		writeProjectConfig(undefined);
		await seedPausedRun('supervised');
		const before = loadFullAutoRunState(tmpDir, SESSION_ID);
		const out = await handleFullAutoCommand(tmpDir, ['resume'], SESSION_ID);
		expect(out).not.toStartWith('Error:');
		const after = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(after?.status).toBe('running');
		expect(after?.runGeneration).toBe((before?.runGeneration ?? 0) + 1);
	}, 60_000);
});
