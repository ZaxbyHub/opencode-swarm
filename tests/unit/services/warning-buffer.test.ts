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

	test('addDeferredWarning respects the MAX_DEFERRED_WARNINGS cap (50) with a truncation sentinel', () => {
		// Epic #1752 PR2 review F-003: overflow must not silently drop
		// advisories. The buffer reserves the last slot for a truncation
		// sentinel so /swarm diagnose can tell the operator entries were
		// dropped, rather than losing them without trace.
		for (let i = 0; i < 60; i += 1) {
			addDeferredWarning(`warning ${i}`);
		}

		const warnings = getDeferredWarnings();
		// 49 real entries + 1 truncation sentinel = 50 total.
		expect(warnings.length).toBe(50);
		expect(warnings[48]).toBe('warning 48');
		// The 50th slot is the sentinel, not warning 49.
		expect(warnings[49]).toContain('additional advisories were dropped');
		expect(warnings).not.toContain('warning 49');
		expect(warnings).not.toContain('warning 59');
	});

	test('addDeferredWarning sentinel appears exactly once even if the cap is hit repeatedly', () => {
		for (let i = 0; i < 80; i += 1) {
			addDeferredWarning(`warning ${i}`);
		}
		const warnings = getDeferredWarnings();
		const sentinels = warnings.filter((w) =>
			w.includes('additional advisories were dropped'),
		);
		expect(sentinels.length).toBe(1);
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

	// --- Issue #1886: the `data` argument must reach /swarm diagnose, not only
	// the debug log. Structural guardrail for the whole defect class: any
	// two-arg advisoryWarn caller (config-validation, fs errors, …) whose
	// actionable detail lives in `data` must surface that detail in the buffer.
	// These fail on the pre-fix advisoryWarn (which buffered only `message`).
	describe('folds the optional data arg into the buffered warning (#1886)', () => {
		test('appends string detail to the buffered entry', () => {
			advisoryWarn(
				'validation failed:',
				'agents.architect.fallback_models: too big',
			);
			const [entry] = getDeferredWarnings();
			expect(entry).toBe(
				'validation failed: agents.architect.fallback_models: too big',
			);
		});

		test("surfaces an Error's message", () => {
			advisoryWarn('Failed to load config:', new Error('ENOENT: missing file'));
			expect(getDeferredWarnings()[0]).toContain('ENOENT: missing file');
		});

		test('renders a plain object as compact JSON', () => {
			advisoryWarn('detail:', { field: 'x', code: 'too_big' });
			expect(getDeferredWarnings()[0]).toContain(
				'{"field":"x","code":"too_big"}',
			);
		});

		test('joins a string array with "; "', () => {
			advisoryWarn('issues:', ['a: bad', 'b: worse']);
			expect(getDeferredWarnings()[0]).toBe('issues: a: bad; b: worse');
		});

		test('buffers exactly the message when data is absent or nullish', () => {
			advisoryWarn('no data');
			advisoryWarn('null data', null);
			advisoryWarn('undefined data', undefined);
			expect(getDeferredWarnings()).toEqual([
				'no data',
				'null data',
				'undefined data',
			]);
		});

		test('collapses multi-line detail to a single line (markdown-bullet safe)', () => {
			advisoryWarn('multiline:', 'line one\n  line two\n\tline three');
			const entry = getDeferredWarnings()[0];
			expect(entry).not.toContain('\n');
			expect(entry).toBe('multiline: line one line two line three');
		});

		test('bounds very long detail with an ellipsis', () => {
			advisoryWarn('big:', 'D'.repeat(5000));
			const entry = getDeferredWarnings()[0];
			// message + space + <=600 chars of detail; far below the 5000 raw.
			expect(entry.length).toBeLessThan(700);
			expect(entry.endsWith('…')).toBe(true);
		});

		test('does not throw on circular / BigInt data (String() fallback)', () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(() => advisoryWarn('circular:', circular)).not.toThrow();
			expect(() => advisoryWarn('bigint:', { n: 10n })).not.toThrow();
			// Both still buffered (one entry each), never lost.
			expect(getDeferredWarnings().length).toBe(2);
		});

		test('still forwards raw structured data to the debug logger unchanged', () => {
			process.env.OPENCODE_SWARM_DEBUG = '1';
			const payload = { slug: 'x' };
			advisoryWarn('advisory:', payload);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining('advisory:'),
				payload,
			);
		});

		test('bounds detail at exactly the 600-char limit with no truncation', () => {
			advisoryWarn('exact:', 'D'.repeat(600));
			const entry = getDeferredWarnings()[0];
			expect(entry).toBe(`exact: ${'D'.repeat(600)}`);
			expect(entry.endsWith('…')).toBe(false);
		});

		test('truncates at exactly 601 chars (one over the limit)', () => {
			advisoryWarn('over:', 'D'.repeat(601));
			const entry = getDeferredWarnings()[0];
			expect(entry).toBe(`over: ${'D'.repeat(599)}…`);
			expect(entry.length).toBe('over: '.length + 600);
		});
	});

	// --- PR #1890 review, security-1: renderAdvisoryDetail's whitespace
	// collapse (`/\s+/g`) does not match C0/C1 terminal-control characters
	// (ESC \x1B, BEL \x07, ...), and `message` was never sanitized at all. A
	// malicious repo-committed opencode-swarm.json (auto-loaded — see
	// config/loader.ts) can carry these in an attacker-controlled key name
	// (e.g. an `agents` record key, or an unrecognized `gates.<key>`), which
	// then flows into an advisoryWarn call and is rendered verbatim as a
	// /swarm diagnose markdown bullet. These tests fail on the pre-fix
	// sanitizeBufferedLine (control-char strip missing entirely).
	describe('strips terminal-control characters (PR #1890 security review)', () => {
		test('strips ESC from the data-arg path', () => {
			advisoryWarn('validation failed:', 'before\x1B[2Jafter');
			const entry = getDeferredWarnings()[0];
			expect(entry).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
			expect(entry).toBe('validation failed: before[2Jafter');
		});

		test('strips BEL from the data-arg path', () => {
			advisoryWarn('detail:', 'ring\x07bell');
			expect(getDeferredWarnings()[0]).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
		});

		test('strips control characters embedded directly in the message arg (the broader gap)', () => {
			// Simulates loader.ts's `gates.${key}` / unrecognized-key-list sites,
			// which interpolate an attacker-controlled key name directly into
			// `message` rather than passing it as `data` — bypassing
			// renderAdvisoryDetail entirely on the pre-fix code.
			const maliciousKey = 'evil\x1B[31mkey\x07';
			advisoryWarn(
				`[opencode-swarm] Unknown gates config section "gates.${maliciousKey}" ignored.`,
			);
			const entry = getDeferredWarnings()[0];
			expect(entry).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
			expect(entry).toBe(
				'[opencode-swarm] Unknown gates config section "gates.evil[31mkey" ignored.',
			);
		});

		test('collapses a literal newline embedded in the message arg to one markdown bullet', () => {
			// A malicious config key containing a raw newline must not be able to
			// inject a fake bullet / fake "## Deferred Warnings" header into
			// /swarm diagnose output.
			const maliciousKey = 'evil\nkey';
			advisoryWarn(
				`[opencode-swarm] Ignored unrecognized config key(s): gates.${maliciousKey}.`,
			);
			const entry = getDeferredWarnings()[0];
			expect(entry).not.toContain('\n');
			expect(entry).toBe(
				'[opencode-swarm] Ignored unrecognized config key(s): gates.evil key.',
			);
		});

		test('neuters an OSC-52 clipboard-write attempt (ESC ] ... BEL)', () => {
			advisoryWarn('detail:', 'x\x1B]52;c;ZGF0YQ==\x07y');
			const entry = getDeferredWarnings()[0];
			// No ESC/BEL survive, so no terminal emulator can parse this as OSC.
			expect(entry).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
		});

		test('does not strip legitimate prose punctuation (em dash, ellipsis)', () => {
			advisoryWarn('note:', 'em—dash and ellipsis…stay');
			expect(getDeferredWarnings()[0]).toBe('note: em—dash and ellipsis…stay');
		});
	});
});

// --- PR #1890 review, security-1 (round 2): the round-1 fix sanitized only
// inside `advisoryWarn`, but ~15 call sites across src/index.ts and
// src/agents/index.ts call `addDeferredWarning` DIRECTLY with hand-composed
// messages, bypassing `advisoryWarn` entirely. Two confirmed reachable with
// attacker-controlled content from the same auto-loaded, repo-committed
// opencode-swarm.json threat model: the no-fallback-models warning (agent
// names are `agents: z.record(z.string(), ...)` keys) and the
// auto_select_architect mismatch warning (a lightly-validated user string).
// These tests call addDeferredWarning directly — bypassing advisoryWarn on
// purpose — to prove the fix lives at the true buffer-write choke point, not
// merely one of its callers. They fail on the round-1 fix.
describe('addDeferredWarning sanitizes direct callers, not just advisoryWarn (#1886 follow-up, round 2)', () => {
	beforeEach(() => {
		clearDeferredWarnings();
	});

	afterEach(() => {
		clearDeferredWarnings();
	});

	test('sanitizes a message built the same way as the no-fallback-models warning (src/index.ts)', () => {
		// Mirrors: noFallback.push(`${name}(${cfg.model})`) where `name` is an
		// attacker-controlled `agents` record key from a malicious repo config.
		const maliciousAgentName = 'evil\x1B[2Hpwn\x07agent';
		const noFallback = [`${maliciousAgentName}(some-model)`];
		const msg =
			`[opencode-swarm] WARNING: ${noFallback.length} agent(s) use a custom model without fallback_models: ` +
			noFallback.join(', ') +
			'. Add "fallback_models": ["model-a"] to each agent config for reliability.';

		addDeferredWarning(msg);

		const entry = getDeferredWarnings()[0];
		expect(entry).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
		expect(entry).toContain('evil[2Hpwnagent(some-model)');
	});

	test('sanitizes a message built the same way as the auto_select_architect mismatch warning (src/index.ts)', () => {
		const maliciousTarget = 'evil\x1B[2Jname\x07';
		const msg = `[opencode-swarm] auto_select_architect target "${maliciousTarget}" not found among generated agents.`;

		addDeferredWarning(msg);

		const entry = getDeferredWarnings()[0];
		expect(entry).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
	});

	test('sanitizes any direct addDeferredWarning caller generically (structural guardrail)', () => {
		addDeferredWarning('unknown\x1B[31magent\x07 not found in config');
		const entry = getDeferredWarnings()[0];
		expect(entry).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
		expect(entry).not.toContain('\n');
	});
});
