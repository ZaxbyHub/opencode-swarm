/**
 * Issue #3331 (AC2 backstop) — the scoped-model-selection discard diagnostic.
 *
 * The frozen C2 suite accepts `applied || diagnosticSeen`; once AC1 lands,
 * `applied` is true and C2 stays green even if the diagnostic were deleted.
 * This suite is the direct proof the diagnostic exists and behaves:
 * - a FIRST seed is silent (no discard line) even with debug enabled;
 * - a live advanced entry followed by a signature-changed chain emits EXACTLY
 *   ONE bounded diagnostic naming the discard/reseed semantics;
 * - the line carries the scope identity and no model-string payload.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	advanceScopedModelSelection,
	normalizeModelChain,
	resetScopedModelSelectionStateForTests,
	resolveScopedModelSelection,
	type ScopedModelOverrideKey,
} from '../../../src/models/model-override-state';

const DISCARD_LINE =
	/reseeded: live selection discarded \(chain signature changed; discardedFallbackIndex=[^)]+\) scope=[^\s]+/;

describe('scoped model selection discard diagnostic (#3331 AC2)', () => {
	let consoleLogSpy: ReturnType<typeof mock>;
	let originalLog: typeof console.log;
	let previousDebug: string | undefined;

	beforeEach(() => {
		resetScopedModelSelectionStateForTests();
		previousDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		originalLog = console.log;
		consoleLogSpy = mock(() => {});
		(console as any).log = consoleLogSpy;
	});

	afterEach(() => {
		// Restore the ORIGINAL function — a bare mock() carries no binding to
		// the property it was assigned to, so mockRestore() alone would leak
		// the silenced console.log into the rest of the shared test process
		// (implementation-review round 1 finding).
		console.log = originalLog;
		if (previousDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = previousDebug;
		}
		resetScopedModelSelectionStateForTests();
	});

	const scope: ScopedModelOverrideKey = {
		sessionID: 'sess-diag',
		invocationID: '7',
		role: 'coder',
	};

	test('a first seed is silent (no discard diagnostic)', () => {
		const chain = normalizeModelChain('prov/primary', ['prov/fb1']);
		const selection = resolveScopedModelSelection(scope, chain, 1_000);
		expect(selection.fallbackIndex).toBe(0);
		const lines = consoleLogSpy.mock.calls.map((call) => String(call[0]));
		expect(lines.some((line) => DISCARD_LINE.test(line))).toBe(false);
	});

	test('a live-entry discard emits exactly one bounded diagnostic', () => {
		const chainA = normalizeModelChain('prov/primary', ['prov/fb1']);
		const seeded = resolveScopedModelSelection(scope, chainA, 1_000);
		const advanced = advanceScopedModelSelection(
			scope,
			chainA,
			seeded.generation,
			2_000,
		);
		expect(advanced.accepted).toBe(true);
		consoleLogSpy.mock.calls.length = 0;

		// A signature-changed chain (primary dropped) discards the live entry.
		const chainB = normalizeModelChain(undefined, ['prov/fb1']);
		const after = resolveScopedModelSelection(scope, chainB, 3_000);
		expect(after.fallbackIndex).toBe(0);
		expect(after.generation).toBeGreaterThan(advanced.selection.generation);

		const matching = consoleLogSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => DISCARD_LINE.test(line));
		expect(matching.length).toBe(1);
		// Scope identity is present (session/invocation/role), the discarded
		// index is reported (PRR-009: the entry's fallbackIndex, even 0), and
		// no model payload rides the line.
		expect(matching[0]).toContain('sess-diag/7//coder');
		expect(matching[0]).toContain('discardedFallbackIndex=1');
		expect(matching[0]).not.toContain('prov/primary');
		expect(matching[0]).not.toContain('prov/fb1');
	});

	test('an index-0 reseed reports discardedFallbackIndex=0 (never claims a completed advance)', () => {
		// F-06b/F-08e (#3617 review): a live entry that never advanced sits at
		// fallbackIndex 0 — the line must report the true index instead of
		// implying a completed fallback was discarded.
		const chainA = normalizeModelChain('prov/primary', ['prov/fb1']);
		resolveScopedModelSelection(scope, chainA, 1_000);
		consoleLogSpy.mock.calls.length = 0;

		const chainB = normalizeModelChain(undefined, ['prov/fb1']);
		const after = resolveScopedModelSelection(scope, chainB, 2_000);
		expect(after.fallbackIndex).toBe(0);

		const matching = consoleLogSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => DISCARD_LINE.test(line));
		expect(matching.length).toBe(1);
		expect(matching[0]).toContain('discardedFallbackIndex=0');
	});
});
