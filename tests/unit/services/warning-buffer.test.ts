/**
 * Unit tests for the deferred-warning buffer and the `advisoryWarn` helper.
 *
 * `advisoryWarn` is the TUI-safe replacement for raw `console.warn` on paths
 * that run while the host TUI owns the terminal (init / commands / tools /
 * hooks). It routes the message to BOTH the deferred-warning buffer (surfaced
 * in /swarm diagnose) and the debug-gated logger (`log`, gated on
 * OPENCODE_SWARM_DEBUG=1). It must NEVER write raw stderr/stdout.
 *
 * Regression for the broader TUI-pollution sweep (epic #1752) and the
 * bundled-skill-sync fix (issue: raw console.warn polluting the TUI).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
	addDeferredWarning,
	advisoryWarn,
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';

describe('deferred warning buffer', () => {
	beforeEach(() => {
		clearDeferredWarnings();
	});

	afterEach(() => {
		clearDeferredWarnings();
	});

	test('addDeferredWarning stores a warning retrievable via getDeferredWarnings', () => {
		addDeferredWarning('test warning A');
		addDeferredWarning('test warning B');

		const warnings = getDeferredWarnings();
		expect(warnings.length).toBe(2);
		expect(warnings[0]).toBe('test warning A');
		expect(warnings[1]).toBe('test warning B');
	});

	test('getDeferredWarnings returns a defensive copy, not the live buffer', () => {
		addDeferredWarning('original');

		const snapshot = getDeferredWarnings();
		// Mutate the snapshot — must NOT affect the internal buffer.
		(snapshot as string[]).push('injected');
		(snapshot as string[])[0] = 'mutated';

		expect(getDeferredWarnings()).toEqual(['original']);
	});

	test('clearDeferredWarnings empties the buffer', () => {
		addDeferredWarning('one');
		addDeferredWarning('two');
		expect(getDeferredWarnings().length).toBe(2);

		clearDeferredWarnings();

		expect(getDeferredWarnings().length).toBe(0);
	});

	test('addDeferredWarning respects the MAX_DEFERRED_WARNINGS cap (50)', () => {
		for (let i = 0; i < 60; i += 1) {
			addDeferredWarning(`warning ${i}`);
		}

		const warnings = getDeferredWarnings();
		expect(warnings.length).toBe(50);
		// The cap drops overflow entries silently; the last accepted entry is
		// warning 49 (the 50th), not warning 59.
		expect(warnings[49]).toBe('warning 49');
		expect(warnings).not.toContain('warning 59');
	});
});

describe('advisoryWarn', () => {
	let consoleWarnSpy: ReturnType<typeof spyOn>;
	let consoleLogSpy: ReturnType<typeof spyOn>;
	let originalDebugEnv: string | undefined;

	beforeEach(() => {
		clearDeferredWarnings();
		consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
		consoleLogSpy = spyOn(console, 'log').mockImplementation(() => undefined);
		originalDebugEnv = process.env.OPENCODE_SWARM_DEBUG;
	});

	afterEach(() => {
		consoleWarnSpy.mockRestore();
		consoleLogSpy.mockRestore();
		clearDeferredWarnings();
		if (originalDebugEnv === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebugEnv;
		}
	});

	test('buffers the message for /swarm diagnose regardless of debug flag', () => {
		process.env.OPENCODE_SWARM_DEBUG = undefined;

		advisoryWarn('actionable advisory');

		expect(getDeferredWarnings()).toEqual(['actionable advisory']);
	});

	test('does NOT write raw console.warn (TUI safety — issue #1249 class)', () => {
		process.env.OPENCODE_SWARM_DEBUG = undefined;

		advisoryWarn('never stderr');

		expect(consoleWarnSpy).not.toHaveBeenCalled();
	});

	test('does NOT write raw console.log when debug is off', () => {
		process.env.OPENCODE_SWARM_DEBUG = undefined;

		advisoryWarn('no stdout');

		expect(consoleLogSpy).not.toHaveBeenCalled();
	});

	test('also emits via debug-gated log when OPENCODE_SWARM_DEBUG=1', () => {
		process.env.OPENCODE_SWARM_DEBUG = '1';

		advisoryWarn('debug-visible advisory');

		// Buffer always populated...
		expect(getDeferredWarnings()).toEqual(['debug-visible advisory']);
		// ...and the debug-gated log fires (visible only under opt-in debug).
		expect(consoleLogSpy).toHaveBeenCalled();
		// Still never raw console.warn — only log() under debug.
		expect(consoleWarnSpy).not.toHaveBeenCalled();
	});

	test('forwards the optional data arg to the debug logger', () => {
		process.env.OPENCODE_SWARM_DEBUG = '1';

		advisoryWarn('contextual advisory', { slug: 'codebase-review-swarm' });

		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('contextual advisory'),
			{ slug: 'codebase-review-swarm' },
		);
	});

	test('preserves buffer ordering across multiple advisories', () => {
		advisoryWarn('first');
		advisoryWarn('second');
		advisoryWarn('third');

		expect(getDeferredWarnings()).toEqual(['first', 'second', 'third']);
	});
});
