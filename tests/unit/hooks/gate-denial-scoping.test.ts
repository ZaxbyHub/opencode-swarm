/**
 * Gate-denial tracker — DISCRIMINATOR scoping and STOP-rung narrowing
 * (issue #2063 B1, reviewer round-4 REQUIRED 2 + advisory E).
 *
 * Split from `gate-denial-tracker.test.ts` to keep both files under the FR-006
 * 500-line cap.
 *
 * REQUIRED 2: `resetGateDenialStreaks` used to drop the entire (session, tool)
 * prefix, so ONE successful `Task` → `explorer` wiped an in-progress
 * `Task` → `coder` denial streak. Under the interleaving the reported loop
 * actually exhibits — deny coder, delegate an explorer to investigate the
 * denial, deny coder again — the STOP rung was unreachable. Streaks are now
 * keyed by (session, tool, discriminator, code) and the reset is scoped to the
 * (session, tool, discriminator) prefix.
 *
 * Advisory E: `UNCLASSIFIED` is the catch-all bucket for denials with no stable
 * code token, so N of them are not evidence of N repeats of ONE cause. The warn
 * decoration still applies; the STOP directive, its advisory, and its telemetry
 * do not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	clearGateDenialStreaks,
	DEFAULT_GATE_DENIAL_STOP_THRESHOLD,
	gateDenialDiscriminator,
	gateDenialStopText,
	noteGateDenial,
	resetGateDenialStreaks,
	UNCLASSIFIED_GATE_DENIAL_CODE,
} from '../../../src/hooks/gate-denial-tracker';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';

const ACCEPTANCE = 'ACCEPTANCE_FIELD_REQUIRED';
const acceptanceDenial = () =>
	new Error(
		`${ACCEPTANCE}: task 1.1 delegation prompt has no ACCEPTANCE field`,
	);

const CODER = { subagent_type: 'coder', prompt: 'implement task 1.1' };
const EXPLORER = { subagent_type: 'explorer', prompt: 'find the caller' };

let tempDir: string;
let events: Array<{ event: string; data: Record<string, unknown> }>;

function advisoriesFor(sessionID: string): string[] {
	return swarmState.agentSessions.get(sessionID)?.pendingAdvisoryMessages ?? [];
}

beforeEach(() => {
	resetTelemetryForTesting();
	resetSwarmState();
	clearGateDenialStreaks();
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'gate-denial-scope-')),
	);
	initTelemetry(tempDir);
	events = [];
	addTelemetryListener((event, data) => {
		events.push({ event, data });
	});
});

afterEach(() => {
	resetTelemetryForTesting();
	resetSwarmState();
	clearGateDenialStreaks();
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

describe('gateDenialDiscriminator', () => {
	test('canonicalizes the Task dispatch target and ignores every other tool', () => {
		expect(gateDenialDiscriminator('Task', CODER)).toBe('coder');
		expect(gateDenialDiscriminator('opencode:Task', CODER)).toBe('coder');
		// Prefixed / hyphenated swarm names share one streak with their canonical
		// role, matching `canonicalDispatchRole` in execution-stall.ts.
		expect(
			gateDenialDiscriminator('Task', { subagent_type: 'mega_coder' }),
		).toBe('coder');
		expect(
			gateDenialDiscriminator('Task', { subagent_type: 'ACME-Reviewer' }),
		).toBe('reviewer');
		// Non-Task tools, and Tasks with no usable subagent_type, share the ''
		// bucket — i.e. exactly the pre-discriminator behavior.
		expect(gateDenialDiscriminator('read', { filePath: '/a.ts' })).toBe('');
		expect(gateDenialDiscriminator('Task', {})).toBe('');
		expect(gateDenialDiscriminator('Task', undefined)).toBe('');
		expect(gateDenialDiscriminator('Task', { subagent_type: 42 })).toBe('');
		// The PROMPT is deliberately NOT a fallback source: arbitrary model prose
		// as a map key is an unbounded-cardinality hazard (invariant 8).
		expect(
			gateDenialDiscriminator('Task', { prompt: 'coder\ndo the thing' }),
		).toBe('');
	});

	test('the derived key is length-bounded', () => {
		const huge = 'z'.repeat(_test_exports.MAX_DISCRIMINATOR_LENGTH + 200);
		expect(
			gateDenialDiscriminator('Task', { subagent_type: huge }).length,
		).toBe(_test_exports.MAX_DISCRIMINATOR_LENGTH);
	});
});

describe('#2063 B1 — per-discriminator streak scoping (reviewer r4)', () => {
	test('REGRESSION: a successful Task(explorer) does NOT reset the Task(coder) streak', () => {
		// Before the discriminator, the explorer success dropped the whole
		// (session, 'task') prefix, so the 5th coder denial counted as #1 and the
		// STOP rung was unreachable under this (very common) interleaving.
		const session = 'sess-interleaved';
		startAgentSession(session, 'architect');

		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD - 1; i++) {
			noteGateDenial(session, 'Task', acceptanceDenial(), undefined, CODER);
		}
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'coder')).toBe(
			4,
		);

		// The architect delegates an explorer to investigate the denial; that
		// dispatch passes the whole fail-closed chain.
		resetGateDenialStreaks(session, 'Task', EXPLORER);
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'coder')).toBe(
			4,
		);

		const fifth = acceptanceDenial();
		const outcome = noteGateDenial(session, 'Task', fifth, undefined, CODER);

		expect(outcome.count).toBe(DEFAULT_GATE_DENIAL_STOP_THRESHOLD);
		expect(outcome.stopped).toBe(true);
		expect(fifth.message).toContain(
			gateDenialStopText(
				DEFAULT_GATE_DENIAL_STOP_THRESHOLD,
				ACCEPTANCE,
				'task',
			),
		);
		expect(advisoriesFor(session)).toHaveLength(1);
		expect(events.filter((e) => e.event === 'gate_denial_loop')).toHaveLength(
			1,
		);
	});

	test('two dispatch targets escalate independently', () => {
		const session = 'sess-two-targets';
		startAgentSession(session, 'architect');

		for (let i = 0; i < 2; i++) {
			noteGateDenial(session, 'Task', acceptanceDenial(), undefined, CODER);
			noteGateDenial(session, 'Task', acceptanceDenial(), undefined, EXPLORER);
		}
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'coder')).toBe(
			2,
		);
		expect(
			_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'explorer'),
		).toBe(2);

		// The third coder denial warns; the explorer streak is untouched.
		expect(
			noteGateDenial(session, 'Task', acceptanceDenial(), undefined, CODER)
				.warned,
		).toBe(true);
		expect(
			_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'explorer'),
		).toBe(2);
	});

	test('the discriminator-scoped reset does not leak across the empty bucket', () => {
		// The trailing NUL in the key prefix is what makes this true: without it,
		// the `''` prefix `sess\0task\0` would also match `sess\0task\0coder\0…`.
		const session = 'sess-bucket-isolation';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'Task', acceptanceDenial(), undefined, CODER);
		noteGateDenial(session, 'Task', acceptanceDenial());

		resetGateDenialStreaks(session, 'Task');
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE)).toBe(0);
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'coder')).toBe(
			1,
		);

		resetGateDenialStreaks(session, 'Task', CODER);
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'coder')).toBe(
			0,
		);
	});

	test('the reset still clears EVERY code for the matched discriminator', () => {
		const session = 'sess-codes-per-target';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'Task', acceptanceDenial(), undefined, CODER);
		noteGateDenial(
			session,
			'Task',
			new Error('SCOPE_NOT_DECLARED: no binding'),
			undefined,
			CODER,
		);

		resetGateDenialStreaks(session, 'opencode:Task', {
			subagent_type: 'mega_coder',
		});
		expect(_test_exports.peekStreak(session, 'Task', ACCEPTANCE, 'coder')).toBe(
			0,
		);
		expect(
			_test_exports.peekStreak(session, 'Task', 'SCOPE_NOT_DECLARED', 'coder'),
		).toBe(0);
	});

	test('a non-Task tool is unaffected by the discriminator', () => {
		const session = 'sess-non-task';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'read', acceptanceDenial(), undefined, {
			subagent_type: 'coder',
		});
		// `subagent_type` on a non-Task call is meaningless and must not shard.
		expect(_test_exports.peekStreak(session, 'read', ACCEPTANCE)).toBe(1);
		resetGateDenialStreaks(session, 'read');
		expect(_test_exports.peekStreak(session, 'read', ACCEPTANCE)).toBe(0);
	});
});

describe('#2063 B1 — UNCLASSIFIED never reaches the STOP rung (advisory E)', () => {
	test('5 UNCLASSIFIED denials warn but issue no STOP directive, advisory, or telemetry', () => {
		const session = 'sess-unclassified';
		startAgentSession(session, 'architect');

		let last: Error | null = null;
		let lastOutcome: ReturnType<typeof noteGateDenial> | null = null;
		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; i++) {
			last = new Error('Blocked by skill propagation gate');
			lastOutcome = noteGateDenial(session, 'Task', last);
		}
		const err = last as Error;

		expect(lastOutcome?.code).toBe(UNCLASSIFIED_GATE_DENIAL_CODE);
		expect(lastOutcome?.count).toBe(DEFAULT_GATE_DENIAL_STOP_THRESHOLD);
		expect(lastOutcome?.warned).toBe(true);
		expect(lastOutcome?.stopped).toBe(false);

		// Warn decoration only.
		expect(err.message).toContain('Blocked by skill propagation gate');
		expect(err.message).toContain('This is denial #5');
		expect(err.message).not.toContain('GATE DENIAL LOOP');
		expect(err.message).not.toContain('STOP tool calls');

		expect(advisoriesFor(session)).toHaveLength(0);
		expect(events.filter((e) => e.event === 'gate_denial_loop')).toHaveLength(
			0,
		);
	});

	test('a real gate code at the same count DOES reach the STOP rung', () => {
		// Differential control: the narrowing is about the classification, not
		// about the ladder being broken.
		const session = 'sess-classified-control';
		startAgentSession(session, 'architect');
		let last: Error | null = null;
		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; i++) {
			last = acceptanceDenial();
			noteGateDenial(session, 'Task', last);
		}
		expect((last as Error).message).toContain('GATE DENIAL LOOP');
		expect(advisoriesFor(session)).toHaveLength(1);
		expect(events.filter((e) => e.event === 'gate_denial_loop')).toHaveLength(
			1,
		);
	});
});
