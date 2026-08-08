/**
 * Gate-denial tracker (issue #2063 B1).
 *
 * The tracker is the terminal containment for a denial-retry loop: a
 * fail-closed `tool.execute.before` hook throws, the host reports a tool
 * rejection, and nothing previously stopped the model from re-issuing the
 * identical dispatch forever. These tests pin the two things that make the
 * containment safe to ship — the escalation actually fires, and the decoration
 * is strictly append-only so the fail-closed contract is untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	clearGateDenialStreaks,
	DEFAULT_GATE_DENIAL_STOP_THRESHOLD,
	DEFAULT_GATE_DENIAL_WARN_THRESHOLD,
	deriveGateDenialCode,
	gateDenialStopText,
	gateDenialWarnText,
	isAbortLikeError,
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

const DENY = 'SCOPE_NOT_DECLARED';
const denial = (code = DENY, detail = 'task 1.1 has no active scope binding') =>
	new Error(`${code}: ${detail}`);

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
		fs.mkdtempSync(path.join(os.tmpdir(), 'gate-denial-')),
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

describe('deriveGateDenialCode', () => {
	test('takes the leading token up to the first colon', () => {
		expect(deriveGateDenialCode('ACCEPTANCE_FIELD_REQUIRED: task 1.1')).toBe(
			'ACCEPTANCE_FIELD_REQUIRED',
		);
		expect(
			deriveGateDenialCode('FULL_AUTO_DENY [path_out_of_root]: outside root'),
		).toBe('FULL_AUTO_DENY [path_out_of_root]');
	});

	test('falls back to UNCLASSIFIED when there is no usable code token', () => {
		expect(deriveGateDenialCode('Blocked by skill propagation gate')).toBe(
			UNCLASSIFIED_GATE_DENIAL_CODE,
		);
		// Leading colon => empty prefix.
		expect(deriveGateDenialCode(': nope')).toBe(UNCLASSIFIED_GATE_DENIAL_CODE);
		// A prose prefix is not a code; classifying it per-occurrence would
		// shatter the streak into singletons and defeat the whole ladder.
		const prose = `${'x'.repeat(_test_exports.MAX_CODE_LENGTH + 1)}: detail`;
		expect(deriveGateDenialCode(prose)).toBe(UNCLASSIFIED_GATE_DENIAL_CODE);
	});
});

describe('escalation ladder', () => {
	test('denials 1 and 2 are counted but leave the message untouched; 3 appends the warn text', () => {
		const session = 'sess-ladder';
		startAgentSession(session, 'architect');

		const first = denial();
		const firstOriginal = first.message;
		expect(noteGateDenial(session, 'Task', first)).toMatchObject({
			code: DENY,
			count: 1,
			warned: false,
			stopped: false,
			decorated: false,
		});
		expect(first.message).toBe(firstOriginal);

		const second = denial();
		expect(noteGateDenial(session, 'Task', second).count).toBe(2);
		expect(second.message).toBe(firstOriginal);

		const third = denial();
		const outcome = noteGateDenial(session, 'Task', third);
		expect(outcome.count).toBe(DEFAULT_GATE_DENIAL_WARN_THRESHOLD);
		expect(outcome.warned).toBe(true);
		expect(outcome.stopped).toBe(false);
		expect(third.message).toBe(firstOriginal + gateDenialWarnText(3, DENY));
		expect(third.message).toContain('Do NOT retry the same dispatch');
		// No hard rung yet.
		expect(advisoriesFor(session)).toHaveLength(0);
		expect(events.filter((e) => e.event === 'gate_denial_loop')).toHaveLength(
			0,
		);
	});

	test('the 5th denial appends the STOP directive AND pushes an advisory AND emits telemetry', () => {
		const session = 'sess-stop';
		startAgentSession(session, 'architect');

		let last: Error | null = null;
		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; i++) {
			last = denial();
			noteGateDenial(session, 'Task', last);
		}
		const err = last as Error;

		// Both rungs are present at the hard rung — warn first, then STOP.
		expect(err.message).toBe(
			`${DENY}: task 1.1 has no active scope binding` +
				gateDenialWarnText(5, DENY) +
				gateDenialStopText(5, DENY, 'task'),
		);
		expect(err.message).toContain(
			'STOP tool calls and report the blocker to the user with the full error text.',
		);

		const advisories = advisoriesFor(session);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain(`[swarm:gate-denial-loop:${DENY}]`);

		const emitted = events.filter((e) => e.event === 'gate_denial_loop');
		expect(emitted).toHaveLength(1);
		expect(emitted[0].data).toMatchObject({
			sessionId: session,
			tool: 'task',
			code: DENY,
			count: 5,
		});
	});

	test('honours configured thresholds instead of the defaults', () => {
		const session = 'sess-config';
		startAgentSession(session, 'architect');
		const opts = { warnThreshold: 1, stopThreshold: 2 };

		const first = denial();
		expect(noteGateDenial(session, 'Task', first, opts).warned).toBe(true);
		expect(first.message).toContain('This is denial #1');

		const second = denial();
		expect(noteGateDenial(session, 'Task', second, opts).stopped).toBe(true);
		expect(second.message).toContain('GATE DENIAL LOOP: 2 consecutive');
	});

	test('guardrails disabled: no counting, no decoration, no advisory, no telemetry', () => {
		const session = 'sess-disabled';
		startAgentSession(session, 'architect');

		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD + 2; i++) {
			const err = denial();
			const outcome = noteGateDenial(session, 'Task', err, { enabled: false });
			expect(outcome.count).toBe(0);
			expect(outcome.decorated).toBe(false);
			expect(err.message).toBe(`${DENY}: task 1.1 has no active scope binding`);
		}
		expect(_test_exports.streakCount()).toBe(0);
		expect(advisoriesFor(session)).toHaveLength(0);
		expect(events.filter((e) => e.event === 'gate_denial_loop')).toHaveLength(
			0,
		);
	});

	test('an invalid threshold falls back to the default rather than escalating on denial #1', () => {
		const session = 'sess-bad-threshold';
		startAgentSession(session, 'architect');
		const err = denial();
		// 0 / NaN would make `count >= threshold` true immediately.
		expect(
			noteGateDenial(session, 'Task', err, {
				warnThreshold: 0,
				stopThreshold: Number.NaN,
			}).warned,
		).toBe(false);
		expect(err.message).toBe(`${DENY}: task 1.1 has no active scope binding`);
	});
});

describe('append-only contract', () => {
	test('decoration never rewrites the original message prefix', () => {
		const session = 'sess-prefix';
		startAgentSession(session, 'architect');
		const original = `${DENY}: task 1.1 has no active scope binding`;

		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD + 3; i++) {
			const err = denial();
			noteGateDenial(session, 'Task', err);
			expect(err.message.startsWith(original)).toBe(true);
			// The leading code token stays byte-identical for every consumer that
			// substring-matches a gate code.
			expect(err.message.slice(0, DENY.length)).toBe(DENY);
		}
	});

	test('mutates the caught object in place so name and custom fields survive', () => {
		const session = 'sess-identity';
		startAgentSession(session, 'architect');
		// Walk the streak to just below the warn rung with throwaway errors.
		for (let i = 0; i < DEFAULT_GATE_DENIAL_WARN_THRESHOLD - 1; i++) {
			noteGateDenial(session, 'Task', denial());
		}
		// The error that DOES get decorated carries a custom name + field, the
		// way a real gate error does. Constructing a replacement Error instead of
		// mutating in place would silently drop both.
		const err = Object.assign(denial(), { gateCode: DENY });
		err.name = 'DelegationGateError';
		const outcome = noteGateDenial(session, 'Task', err);

		expect(outcome.decorated).toBe(true);
		expect(err.message).toContain('This is denial #3');
		expect(err.name).toBe('DelegationGateError');
		expect(err.gateCode).toBe(DENY);
		expect(err instanceof Error).toBe(true);
	});

	test('non-Error throws are neither counted nor decorated', () => {
		const session = 'sess-nonerror';
		startAgentSession(session, 'architect');
		for (const value of ['a string denial', 42, null, undefined, {}]) {
			expect(noteGateDenial(session, 'Task', value)).toMatchObject({
				count: 0,
				decorated: false,
			});
		}
		expect(_test_exports.streakCount()).toBe(0);
	});

	test('a read-only message is left alone and the outcome reports it', () => {
		const session = 'sess-frozen';
		startAgentSession(session, 'architect');
		for (let i = 0; i < DEFAULT_GATE_DENIAL_WARN_THRESHOLD - 1; i++) {
			noteGateDenial(session, 'Task', denial());
		}
		const frozen = denial();
		Object.freeze(frozen);
		const outcome = noteGateDenial(session, 'Task', frozen);
		expect(outcome.warned).toBe(true);
		expect(outcome.decorated).toBe(false);
		expect(frozen.message).toBe(
			`${DENY}: task 1.1 has no active scope binding`,
		);
	});
});

describe('streak scoping', () => {
	test('different codes for the same tool escalate independently', () => {
		const session = 'sess-codes';
		startAgentSession(session, 'architect');

		// Interleave two causes; neither should reach the warn rung at 2 each.
		for (let i = 0; i < 2; i++) {
			expect(noteGateDenial(session, 'Task', denial(DENY)).warned).toBe(false);
			expect(
				noteGateDenial(session, 'Task', denial('ACCEPTANCE_FIELD_REQUIRED'))
					.warned,
			).toBe(false);
		}
		expect(_test_exports.peekStreak(session, 'Task', DENY)).toBe(2);
		expect(
			_test_exports.peekStreak(session, 'Task', 'ACCEPTANCE_FIELD_REQUIRED'),
		).toBe(2);

		// The third of ONE cause escalates only that cause.
		expect(noteGateDenial(session, 'Task', denial(DENY)).warned).toBe(true);
		expect(
			_test_exports.peekStreak(session, 'Task', 'ACCEPTANCE_FIELD_REQUIRED'),
		).toBe(2);
	});

	test('two sessions do not share a streak', () => {
		startAgentSession('sess-a', 'architect');
		startAgentSession('sess-b', 'architect');

		for (let i = 0; i < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; i++) {
			noteGateDenial('sess-a', 'Task', denial());
		}
		const otherSessionErr = denial();
		const outcome = noteGateDenial('sess-b', 'Task', otherSessionErr);

		expect(outcome.count).toBe(1);
		expect(outcome.warned).toBe(false);
		expect(otherSessionErr.message).toBe(
			`${DENY}: task 1.1 has no active scope binding`,
		);
		expect(advisoriesFor('sess-b')).toHaveLength(0);
	});

	test('host tool-name namespacing shares one streak', () => {
		const session = 'sess-normalize';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'opencode:Task', denial());
		noteGateDenial(session, 'Task', denial());
		const third = denial();
		expect(noteGateDenial(session, 'opencode.task', third).count).toBe(3);
		expect(third.message).toContain('This is denial #3');
	});
});

describe('reset semantics', () => {
	test('a successful chain completion for that tool AND discriminator clears its streaks', () => {
		const session = 'sess-reset';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'Task', denial());
		noteGateDenial(session, 'Task', denial());
		expect(_test_exports.peekStreak(session, 'Task', DENY)).toBe(2);

		resetGateDenialStreaks(session, 'Task');
		expect(_test_exports.peekStreak(session, 'Task', DENY)).toBe(0);

		const next = denial();
		expect(noteGateDenial(session, 'Task', next).count).toBe(1);
		expect(next.message).toBe(`${DENY}: task 1.1 has no active scope binding`);
	});

	test('a successful Task(coder) DOES clear the coder streak', () => {
		// The discriminator narrows the reset; it must not disable it. A dispatch
		// that finally passes for the SAME target ends that target's streak.
		const session = 'sess-reset-same-target';
		startAgentSession(session, 'architect');
		const coder = { subagent_type: 'coder', prompt: 'implement 1.1' };
		noteGateDenial(session, 'Task', denial(), undefined, coder);
		noteGateDenial(session, 'Task', denial(), undefined, coder);
		expect(_test_exports.peekStreak(session, 'Task', DENY, 'coder')).toBe(2);

		resetGateDenialStreaks(session, 'Task', coder);
		expect(_test_exports.peekStreak(session, 'Task', DENY, 'coder')).toBe(0);

		const next = denial();
		expect(noteGateDenial(session, 'Task', next, undefined, coder).count).toBe(
			1,
		);
		expect(next.message).toBe(`${DENY}: task 1.1 has no active scope binding`);
	});

	test('the reset is scoped to one tool, not the whole session', () => {
		const session = 'sess-reset-scope';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'Task', denial());
		noteGateDenial(session, 'Task', denial());
		noteGateDenial(session, 'read', denial());

		// A successful `read` must not erase the in-progress Task denial loop.
		resetGateDenialStreaks(session, 'read');
		expect(_test_exports.peekStreak(session, 'Task', DENY)).toBe(2);
		expect(_test_exports.peekStreak(session, 'read', DENY)).toBe(0);
	});

	test('the reset clears every code for that tool', () => {
		const session = 'sess-reset-codes';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'Task', denial(DENY));
		noteGateDenial(session, 'Task', denial('FULL_AUTO_DELEGATION_DENY'));

		resetGateDenialStreaks(session, 'opencode:Task');
		expect(_test_exports.peekStreak(session, 'Task', DENY)).toBe(0);
		expect(
			_test_exports.peekStreak(session, 'Task', 'FULL_AUTO_DELEGATION_DENY'),
		).toBe(0);
	});
});

describe('abort exclusion', () => {
	test('recognises both the name form and the message form', () => {
		const named = new Error('The operation was aborted');
		named.name = 'AbortError';
		expect(isAbortLikeError(named)).toBe(true);
		expect(isAbortLikeError(new Error('AbortError: user cancelled'))).toBe(
			true,
		);
		expect(isAbortLikeError(denial())).toBe(false);
		expect(isAbortLikeError('AbortError')).toBe(false);
	});

	test('repeated user cancels never escalate', () => {
		const session = 'sess-abort';
		startAgentSession(session, 'architect');
		for (let i = 0; i < 10; i++) {
			const aborted = new Error('The operation was aborted');
			aborted.name = 'AbortError';
			const outcome = noteGateDenial(session, 'Task', aborted);
			expect(outcome.count).toBe(0);
			expect(aborted.message).toBe('The operation was aborted');
		}
		expect(_test_exports.streakCount()).toBe(0);
		expect(advisoriesFor(session)).toHaveLength(0);
	});

	test('an abort in the middle of a denial streak does not reset it', () => {
		const session = 'sess-abort-mid';
		startAgentSession(session, 'architect');
		noteGateDenial(session, 'Task', denial());
		noteGateDenial(session, 'Task', denial());

		const aborted = new Error('AbortError: user pressed escape');
		noteGateDenial(session, 'Task', aborted);
		expect(_test_exports.peekStreak(session, 'Task', DENY)).toBe(2);

		// The streak resumes where it left off — cancelling did not fix the cause.
		const third = denial();
		expect(noteGateDenial(session, 'Task', third).count).toBe(3);
		expect(third.message).toContain('This is denial #3');
	});
});

describe('bounded state (invariant 8)', () => {
	test('the streak map is capped and evicts the oldest entry', () => {
		const cap = _test_exports.MAX_TRACKED_DENIAL_STREAKS;
		for (let i = 0; i <= cap; i++) {
			noteGateDenial(`bulk-session-${i}`, 'Task', denial());
		}
		expect(_test_exports.streakCount()).toBeLessThanOrEqual(cap);
		// The very first session was evicted; the newest survives.
		expect(_test_exports.peekStreak('bulk-session-0', 'Task', DENY)).toBe(0);
		expect(_test_exports.peekStreak(`bulk-session-${cap}`, 'Task', DENY)).toBe(
			1,
		);
	});

	test('an idle streak expires and is swept on the next denial', () => {
		startAgentSession('sess-ttl', 'architect');
		noteGateDenial('sess-ttl', 'Task', denial());
		noteGateDenial('sess-ttl', 'Task', denial());
		expect(_test_exports.peekStreak('sess-ttl', 'Task', DENY)).toBe(2);

		_test_exports.expireStreak('sess-ttl', 'Task', DENY);
		// Any later denial sweeps expired entries first.
		noteGateDenial('sess-other', 'Task', denial());
		expect(_test_exports.peekStreak('sess-ttl', 'Task', DENY)).toBe(0);

		// And the expired session restarts at 1 rather than resuming at 3.
		const revived = denial();
		expect(noteGateDenial('sess-ttl', 'Task', revived).count).toBe(1);
		expect(revived.message).toBe(
			`${DENY}: task 1.1 has no active scope binding`,
		);
	});
});
