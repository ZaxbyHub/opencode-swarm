/**
 * Issue #2102 contract B — identity-bound authoritative rounds (schema v2).
 *
 * Pins:
 * - scope tokens are identity-bound: same identity ⇒ same token (accepted
 *   round retained across status-only transitions), different identity ⇒
 *   fresh authoritative round state;
 * - legacy v1 files remain on disk, auditable, and are never read or
 *   rewritten (no backfill);
 * - v1-shaped records under a v2 token fail closed as uncertain;
 * - max-rounds exhaustion emits one bounded, durable, redacted structured
 *   event and never executes anything outbound.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CouncilAttemptEvaluation } from '../../../src/council/council-round-state';
import {
	_internals,
	councilRoundStatePaths,
	runCouncilAttempt,
} from '../../../src/council/council-round-state';

const originals = { ..._internals };
const IDENTITY_A = 'a'.repeat(64);
const IDENTITY_B = 'b'.repeat(64);
let directory: string;

function evaluation(
	transition: 'stay' | 'advance' | 'close',
): CouncilAttemptEvaluation {
	return {
		disposition: `test_${transition}`,
		response: { success: true },
		transition,
		gateEffect: transition === 'close' ? 'allowed' : 'none',
	};
}

function parsed(result: string): Record<string, unknown> {
	return JSON.parse(result) as Record<string, unknown>;
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), 'council-v2-')));
});

describe('identity-bound scope tokens', () => {
	test('same identity reuses the same state files', () => {
		const a = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
			identityDigest: IDENTITY_A,
		});
		const b = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
			identityDigest: IDENTITY_A,
		});
		expect(a.state).toBe(b.state);
	});

	test('different identity opens a different token', () => {
		const a = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
			identityDigest: IDENTITY_A,
		});
		const b = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
			identityDigest: IDENTITY_B,
		});
		expect(a.state).not.toBe(b.state);
		const phaseA = councilRoundStatePaths(directory, {
			kind: 'phase',
			phaseNumber: 1,
			identityDigest: IDENTITY_A,
		});
		const phaseB = councilRoundStatePaths(directory, {
			kind: 'phase',
			phaseNumber: 1,
			identityDigest: IDENTITY_B,
		});
		expect(phaseA.state).not.toBe(phaseB.state);
	});

	test('a review-relevant change (new identity) opens a fresh authoritative round', async () => {
		const first = parsed(
			await runCouncilAttempt({
				directory,
				scope: { kind: 'final', identityDigest: IDENTITY_A },
				maxRounds: 3,
				request: { r: 1 },
				verdictCount: 5,
				members: ['critic', 'reviewer', 'sme', 'test_engineer', 'explorer'],
				evaluate: async () => evaluation('close'),
			}),
		);
		expect(first.maxRoundsExhausted).toBe(false);

		// New identity (plan/policy change): a fresh round state starts at 1,
		// and the previous accepted round is untouched on disk.
		const second = parsed(
			await runCouncilAttempt({
				directory,
				scope: { kind: 'final', identityDigest: IDENTITY_B },
				maxRounds: 3,
				request: { r: 2 },
				verdictCount: 5,
				members: ['critic', 'reviewer', 'sme', 'test_engineer', 'explorer'],
				evaluate: async (round) => {
					expect(round).toBe(1);
					return evaluation('stay');
				},
			}),
		);
		expect(second.authoritativeRound).toBe(1);
	});

	test('same identity retains the accepted round (status-only transition analog)', async () => {
		await runCouncilAttempt({
			directory,
			scope: { kind: 'final', identityDigest: IDENTITY_A },
			maxRounds: 3,
			request: { r: 1 },
			verdictCount: 5,
			members: ['critic', 'reviewer', 'sme', 'test_engineer', 'explorer'],
			evaluate: async () => evaluation('close'),
		});
		// The scope is CLOSED under this identity; a duplicate submission is
		// rejected as a duplicate instead of reopening (accepted projection
		// semantics preserved).
		const duplicate = parsed(
			await runCouncilAttempt({
				directory,
				scope: { kind: 'final', identityDigest: IDENTITY_A },
				maxRounds: 3,
				request: { r: 1 },
				verdictCount: 5,
				members: ['critic', 'reviewer', 'sme', 'test_engineer', 'explorer'],
				evaluate: async () => evaluation('close'),
			}),
		);
		expect(duplicate.reason).toBe('duplicate_submission');
	});
});

describe('bounded scope tokens', () => {
	test('hashes oversized task IDs for bounded paths and audit metadata', async () => {
		const taskId = Array.from({ length: 300 }, () => '1').join('.');
		const scope = { kind: 'task' as const, taskId, identityDigest: IDENTITY_A };
		const paths = councilRoundStatePaths(directory, scope);
		expect(paths.state.split(/[\\/]/).at(-1)?.length).toBeLessThan(100);
		await runCouncilAttempt({
			directory,
			scope,
			maxRounds: 3,
			request: { taskId },
			verdictCount: 1,
			members: ['critic'],
			evaluate: async () => evaluation('stay'),
		});
		expect(readFileSync(paths.audit, 'utf8')).not.toContain(taskId);
	});
});

describe('legacy v1 records (cutover, no backfill)', () => {
	test('v1 state/audit files under old tokens remain on disk and unread', async () => {
		// Simulate the legacy final token: final-sha256(generation).
		const legacyToken = `final-${IDENTITY_A}`; // any pre-v2 naming
		const legacyStatePath = join(
			directory,
			'.swarm',
			'council',
			'round-state',
			`${legacyToken}.json`,
		);
		mkdirSync(dirname(legacyStatePath), { recursive: true });
		writeFileSync(
			legacyStatePath,
			JSON.stringify({
				version: 1,
				currentRound: 2,
				status: 'open',
				maxRoundsExhausted: false,
			}),
			'utf8',
		);

		// v2 run under a NEW token: unaffected by the legacy file.
		const result = parsed(
			await runCouncilAttempt({
				directory,
				scope: { kind: 'final', identityDigest: IDENTITY_B },
				maxRounds: 3,
				request: {},
				verdictCount: 3,
				members: ['critic', 'reviewer', 'sme'],
				evaluate: async (round) => {
					expect(round).toBe(1);
					return evaluation('close');
				},
			}),
		);
		expect(result.success).toBe(true);
		// The legacy file was NOT rewritten or deleted.
		const legacy = JSON.parse(readFileSync(legacyStatePath, 'utf8'));
		expect(legacy.version).toBe(1);
		expect(legacy.currentRound).toBe(2);
	});

	test('v1-shaped record found under a v2 token fails closed', async () => {
		const paths = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
			identityDigest: IDENTITY_A,
		});
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				currentRound: 1,
				status: 'open',
				maxRoundsExhausted: false,
			}),
			'utf8',
		);
		const result = parsed(
			await runCouncilAttempt({
				directory,
				scope: { kind: 'task', taskId: '1.1', identityDigest: IDENTITY_A },
				maxRounds: 3,
				request: {},
				verdictCount: 1,
				members: ['critic'],
				evaluate: async () => evaluation('close'),
			}),
		);
		expect(result.reason).toBe('council_round_state_uncertain');
	});

	test('v2 state bound to a different identity fails closed', async () => {
		const paths = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
			identityDigest: IDENTITY_A,
		});
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(
			paths.state,
			JSON.stringify({
				version: 2,
				identityDigest: IDENTITY_B,
				currentRound: 1,
				status: 'open',
				maxRoundsExhausted: false,
			}),
			'utf8',
		);
		const result = parsed(
			await runCouncilAttempt({
				directory,
				scope: { kind: 'task', taskId: '1.1', identityDigest: IDENTITY_A },
				maxRounds: 3,
				request: {},
				verdictCount: 1,
				members: ['critic'],
				evaluate: async () => evaluation('close'),
			}),
		);
		expect(result.reason).toBe('council_round_state_uncertain');
	});
});

describe('max-rounds exhaustion event (contract F)', () => {
	test('emits one durable redacted structured event on the false→true transition', async () => {
		let call = 0;
		const run = () =>
			runCouncilAttempt({
				directory,
				scope: { kind: 'phase', phaseNumber: 1, identityDigest: IDENTITY_A },
				maxRounds: 2,
				request: { call },
				verdictCount: 3,
				members: ['critic', 'reviewer', 'sme'],
				escalationConfigured: true,
				evaluate: async () => evaluation('advance'),
			});
		await run(); // round 1 → 2
		call++;
		const exhausted = parsed(await run()); // round 2 at limit → exhausted
		expect(exhausted.maxRoundsExhausted).toBe(true);
		expect(exhausted.escalationRequired).toBe(true);

		const eventPath = join(
			directory,
			'.swarm',
			'council',
			'events',
			'max-rounds-exhaustion.jsonl',
		);
		const lines = readFileSync(eventPath, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.length).toBe(1);
		const event = lines[0]!;
		expect(event.type).toBe('max_rounds_exhausted');
		expect(event.level).toBe('phase');
		expect(event.round).toBe(2);
		expect(event.escalationConfigured).toBe(true);
		// Redaction: the handler/webhook string never appears anywhere.
		expect(JSON.stringify(event)).not.toContain('http');
		expect(JSON.stringify(event)).not.toContain('webhook');
		expect(String(event.identityDigest)).toMatch(/^[a-f0-9]{64}$/);

		// A further advance at the limit must not re-emit the event.
		call++;
		await run();
		const linesAfter = readFileSync(eventPath, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean);
		expect(linesAfter.length).toBe(1);
	});
});

describe('recovery-side exhaustion-event closure (PRR-020)', () => {
	const exhaustedScope = {
		kind: 'phase' as const,
		phaseNumber: 7,
		identityDigest: 'e'.repeat(64),
	};

	function eventPath(): string {
		return join(
			directory,
			'.swarm',
			'council',
			'events',
			'max-rounds-exhaustion.jsonl',
		);
	}

	function eventCount(): number {
		try {
			return readFileSync(eventPath(), 'utf8')
				.split('\n')
				.filter((l) => l.trim().length > 0).length;
		} catch {
			return 0;
		}
	}

	test('a pre-existing exhausted state without an event gets one ensured on the next attempt', async () => {
		// Simulate the crash window: exhausted v2 state + audit on disk, no event.
		const paths = councilRoundStatePaths(directory, exhaustedScope);
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(
			paths.state,
			JSON.stringify({
				version: 2,
				identityDigest: exhaustedScope.identityDigest,
				currentRound: 3,
				status: 'open',
				maxRoundsExhausted: true,
			}),
			'utf8',
		);
		expect(eventCount()).toBe(0);

		await runCouncilAttempt({
			directory,
			scope: exhaustedScope,
			maxRounds: 3,
			request: {},
			verdictCount: 3,
			members: ['critic', 'reviewer', 'sme'],
			evaluate: async () => evaluation('stay'),
		});

		expect(eventCount()).toBe(1);
		const event = JSON.parse(readFileSync(eventPath(), 'utf8').trim());
		expect(event.type).toBe('max_rounds_exhausted');
		expect(event.level).toBe('phase');
		expect(event.round).toBe(3);

		// Idempotent: another attempt must not duplicate the ensured event.
		await runCouncilAttempt({
			directory,
			scope: exhaustedScope,
			maxRounds: 3,
			request: { r: 2 },
			verdictCount: 3,
			members: ['critic', 'reviewer', 'sme'],
			evaluate: async () => evaluation('stay'),
		});
		expect(eventCount()).toBe(1);
	});

	test('a torn trailing event line does not block the ensure check (reader tolerance)', async () => {
		const paths = councilRoundStatePaths(directory, exhaustedScope);
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(
			paths.state,
			JSON.stringify({
				version: 2,
				identityDigest: exhaustedScope.identityDigest,
				currentRound: 3,
				status: 'open',
				maxRoundsExhausted: true,
			}),
			'utf8',
		);
		mkdirSync(dirname(eventPath()), { recursive: true });
		// Torn (newline-terminated but unparseable) trailing line.
		writeFileSync(
			eventPath(),
			'{"type":"max_rounds_exhausted","scopeTo' + String.fromCharCode(10),
			'utf8',
		);
		await runCouncilAttempt({
			directory,
			scope: exhaustedScope,
			maxRounds: 3,
			request: {},
			verdictCount: 3,
			members: ['critic', 'reviewer', 'sme'],
			evaluate: async () => evaluation('stay'),
		});
		// Tolerant reader skipped the partial line and appended a valid event.
		expect(eventCount()).toBe(2);
	});
});

// Keep the internals seam restored even if a test replaces it.
afterEach(() => {
	Object.assign(_internals, originals);
	rmSync(directory, { recursive: true, force: true });
});
