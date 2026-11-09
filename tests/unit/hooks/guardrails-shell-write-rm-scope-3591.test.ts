/**
 * #3591 (collated trace 3586-3588-3591-shell-gate-walk-fixpoint, Fix 6):
 * - 6a: a dedicated POSIX rm arm emits EVERY literal non-option operand of
 *   a NON-destructive rm (flagless, -i/-v/-I/-d) as a scope-checked write
 *   target — the AC10 policy decision is SCOPE CONTAINMENT modeled on
 *   unlink/rmdir. Recursive/forced shapes emit nothing there (the
 *   destructive arm owns them and runs first).
 * - 6b: GNU getopt permutation — the shared two-pass parse
 *   (parseRmOptionTokens) reads flags at ANY position before `--`, so
 *   `rm foo -rf ../../outside` is recursive (fail-closed).
 * - 6c: dcEvaluateRecursiveDeleteTargets runs the pre-allowlist checks over
 *   EVERY target first, so the denial NAMES the escaping target.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcDecodeShellWord,
	dcEvaluateRecursiveDeleteTargets,
	dcExtractRecursiveRmTargets,
} from '../../../src/hooks/guardrails/destructive-command';
import {
	detectPosixWrites,
	parseRmOptionTokens,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(command: string): Promise<Verdict> {
	const ws = canonicalMkdtemp('rm3591-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `rm3591-s${++counter}`;
	const callID = `rm3591-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		const text = (error as Error).message ?? '';
		if (!/BLOCKED|SCOPE_/.test(text)) throw error;
		return {
			verdict: 'DENIED',
			message: text.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

function rmWritePaths(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'builtin_write')
		.map((w) => w.path);
}

describe('#3591 Fix 6 shared two-pass parse (parseRmOptionTokens)', () => {
	test('leading flags: destructive, operands extracted', () => {
		const p = parseRmOptionTokens(['-rf', 'foo', 'bar']);
		expect(p.destructive).toBe(true);
		expect(p.targetIndices).toEqual([1, 2]);
	});

	test('GNU permutation: a late flag is still read and consumed', () => {
		const p = parseRmOptionTokens(['foo', '-rf', '../../outside']);
		expect(p.destructive).toBe(true);
		expect(p.targetIndices).toEqual([0, 2]);
	});

	// PR #3615 feedback PRR-002: the DC feed is decoded at the boundary
	// (dcDecodeShellWord in destructive-command.ts), so parseRmOptionTokens
	// always receives the quote-removed / escape-decoded words bash hands rm.
	// These legs pin that contract on DECODED inputs; the decoding itself is
	// pinned by the dcDecodeShellWord legs below and by the gate-level
	// quoted/escaped flag matrix in the Fix 6 verdicts describe.
	test('QUOTED destructive flag decodes to a real option (PRR-002)', () => {
		expect(dcDecodeShellWord('"-rf"')).toBe('-rf');
		expect(dcDecodeShellWord("'-rf'")).toBe('-rf');
		expect(dcDecodeShellWord('"--recursive"')).toBe('--recursive');
		// A literal-quote filename (single-quoted outer, double quotes
		// literal inside) decodes to a word still carrying quote characters
		// — NOT an option, faithful to bash quote removal.
		expect(dcDecodeShellWord(`'"-rf"'`)).toBe('"-rf"');
		// Backslash escapes decode (pre-existing PRR-002b fail-open).
		expect(dcDecodeShellWord('\\-rf')).toBe('-rf');
		expect(dcDecodeShellWord('\\--force')).toBe('--force');
		// The shared parse classifies the decoded words identically to the
		// detector feed.
		expect(parseRmOptionTokens(['-rf', '../../outside']).destructive).toBe(
			true,
		);
		expect(
			parseRmOptionTokens(['--recursive', '../../outside']).destructive,
		).toBe(true);
		expect(
			parseRmOptionTokens(['foo', '-f', '../../outside']).destructive,
		).toBe(true);
		// A decoded option is consumed, not extracted as a target.
		const p = parseRmOptionTokens(['-rf', '../../outside']);
		expect(p.targetIndices).toEqual([1]);
		// A decoded word still carrying quote characters is a target, not an
		// option (literal-quote filename — faithful to bash).
		const q = parseRmOptionTokens(['"-rf"', '../../outside']);
		expect(q.destructive).toBe(false);
		expect(q.targetIndices).toEqual([0, 1]);
		// Decoded non-destructive options are consumed too.
		const v = parseRmOptionTokens(['-v', 'src/temp.ts']);
		expect(v.destructive).toBe(false);
		expect(v.targetIndices).toEqual([1]);
	});

	test('non-destructive flags anywhere: not destructive, consumed', () => {
		const p = parseRmOptionTokens(['a', '-v', '-i', 'b']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([0, 3]);
	});

	test('exact long options --recursive / --force are destructive', () => {
		expect(parseRmOptionTokens(['x', '--recursive']).destructive).toBe(true);
		expect(parseRmOptionTokens(['--force', 'x']).destructive).toBe(true);
		expect(parseRmOptionTokens(['--verbose', 'x']).destructive).toBe(false);
	});

	test('`--` ends options: later dash words are targets, not flags', () => {
		const p = parseRmOptionTokens(['--', '-rf', 'x']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([1, 2]);
	});

	test('`--` after an operand ends option parsing (late -rf is a target)', () => {
		const p = parseRmOptionTokens(['x', '--', '-rf', 'y']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([0, 2, 3]);
	});

	test('a bare `-` is an operand, never an option', () => {
		const p = parseRmOptionTokens(['-', 'x']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([0, 1]);
	});
});

describe('#3591 Fix 6b extractor (dcExtractRecursiveRmTargets)', () => {
	test('late-flag permutation extracts BOTH targets', () => {
		expect(dcExtractRecursiveRmTargets('rm foo -rf ../../outside')).toEqual([
			'foo',
			'../../outside',
		]);
	});

	test('leading-flag control extracts the same set', () => {
		expect(dcExtractRecursiveRmTargets('rm -rf foo ../../outside')).toEqual([
			'foo',
			'../../outside',
		]);
	});

	test('flagless literal stays null (brace-3569 pin preserved)', () => {
		expect(dcExtractRecursiveRmTargets('rm ../esc')).toBeNull();
	});

	test('verbose-only stays null (nested-artifacts-2096 pin preserved)', () => {
		expect(dcExtractRecursiveRmTargets('rm -v x')).toBeNull();
	});

	test('the late flag is consumed, never extracted as a target', () => {
		const targets = dcExtractRecursiveRmTargets('rm a -f b') ?? [];
		expect(targets).toEqual(['a', 'b']);
	});
});

describe('#3591 Fix 6c two-phase evaluation (dcEvaluateRecursiveDeleteTargets)', () => {
	const cwd = canonicalMkdtemp('rm3591-eval-');
	created.push(cwd);

	test('escape after a non-allowlisted target: denial names the escape', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['foo', '../../outside'],
			cwd,
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) {
			expect(d.code).toBe('DESTRUCTIVE_TARGET_INVALID');
			expect(d.reason).toContain('../../outside');
		}
	});

	test('protected component after a non-allowlisted target names .git', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['foo', '.git'],
			cwd,
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) {
			expect(d.code).toBe('DESTRUCTIVE_TARGET_PROTECTED');
			expect(d.reason).toContain('.git');
		}
	});

	test('per-target pre-allowlist order preserved: traversal before protected', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['../.swarm'],
			cwd,
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.code).toBe('DESTRUCTIVE_TARGET_INVALID');
	});

	test('phase 2 still rejects a non-allowlisted in-workspace target', () => {
		const d = dcEvaluateRecursiveDeleteTargets({ targets: ['foo'], cwd });
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.code).toBe('DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT');
	});

	test('bare allowlisted artifacts stay allowed', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['node_modules', 'dist'],
			cwd,
		});
		expect(d.allowed).toBe(true);
	});
});

describe('#3591 Fix 6a detector rm arm', () => {
	test('every literal operand of a flagless rm is emitted', () => {
		expect(rmWritePaths('rm a src/b ../c')).toEqual(['a', 'src/b', '../c']);
	});

	test('non-destructive flags still emit every operand', () => {
		expect(rmWritePaths('rm -v a -i b')).toEqual(['a', 'b']);
	});

	test('recursive/forced shapes emit nothing here (destructive arm owns them)', () => {
		expect(rmWritePaths('rm -rf a b')).toEqual([]);
		expect(rmWritePaths('rm a -f b')).toEqual([]);
		expect(rmWritePaths('rm --recursive a')).toEqual([]);
	});

	test('`--` makes a dash-word an operand', () => {
		expect(rmWritePaths('rm -- -v')).toEqual(['-v']);
	});

	test('brace operands expand per branch', () => {
		expect(rmWritePaths('rm src/{a,b}')).toEqual(['src/a', 'src/b']);
	});

	test('wrapper-consumed window: sudo rm emits the operand only', () => {
		expect(rmWritePaths('sudo rm ../esc')).toEqual(['../esc']);
	});
});

describe('#3591 re-pins relocated from guardrails-swarm-path-evasion.adversarial', () => {
	// The evasion suite's two `rm` rows flipped when Fix 6a made a
	// non-recursive rm's operands write targets (AC10 policy: scope
	// containment modeled on unlink). The FR-006 ratchet forbids growing the
	// 852-line evasion file, so the full rationale and the strengthened
	// assertions live HERE; the evasion rows keep compact re-pinned
	// expectations pointing at this block.
	//
	// Rationale: a scope-LESS coder session performing `rm src/temp.ts` is
	// now denied SCOPE_NOT_DECLARED — EXACTLY like `echo x > src/f`,
	// `unlink src/temp.ts`, or any other write-capable command under
	// invariant 9 (the reviewer verified the identical flip for unlink in
	// the same fixture class). The rows' original intent still holds: the
	// `.swarm` guard does NOT fire on a non-.swarm path, and disabling the
	// destructive arm no longer leaves a flagless `rm .swarm/file`
	// unchecked — the write-authorization layer owns it. The in-scope ALLOW
	// with a declared scope is pinned above and in -rm-parity-3591.
	const SESSION = 'evasion-repin-session';

	test('rm src/temp.ts (scope-less coder): SCOPE_NOT_DECLARED, no .swarm message', async () => {
		const ws = canonicalMkdtemp('rm3591-repin-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		resetSwarmState();
		startAgentSession(SESSION, 'coder');
		const hooks = createGuardrailsHooks(ws, undefined, config());
		let message = '';
		try {
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: SESSION, callID: 'r1' },
				{ args: { command: 'rm src/temp.ts' } },
			);
		} catch (error) {
			message = (error as Error).message;
		} finally {
			resetSwarmState();
		}
		// Denied by the write-authorization layer…
		expect(message).toMatch(/SCOPE_NOT_DECLARED/);
		// …and independently NOT by the destructive arm's .swarm guard (the
		// original row's intent: a non-.swarm path never trips that arm).
		expect(message).not.toMatch(/targeting \.swarm/);
	});

	test('rm .swarm/file (block_destructive_commands=false): write-layer scope block', async () => {
		const ws = canonicalMkdtemp('rm3591-repin-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		resetSwarmState();
		startAgentSession(SESSION, 'coder');
		const hooks = createGuardrailsHooks(ws, undefined, {
			...config(),
			block_destructive_commands: false,
		});
		let message = '';
		try {
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: SESSION, callID: 'r2' },
				{ args: { command: 'rm .swarm/file' } },
			);
		} catch (error) {
			message = (error as Error).message;
		} finally {
			resetSwarmState();
		}
		// PR #3615 feedback PRR-010 (hermes Minor): pin the EXACT layer —
		// the write-authorization SCOPE_NOT_DECLARED denial, and NOT the
		// destructive arm's .swarm message (block_destructive_commands is
		// false here, so that arm cannot own the operand).
		expect(message).toMatch(/SCOPE_NOT_DECLARED/);
		expect(message).not.toMatch(/targeting \.swarm/);
	});
});

describe('#3591 Fix 6 gate verdicts (coder, scope src/)', () => {
	test.each([
		'rm ../esc',
		'rm ../../outside',
		'rm src/ok ../esc',
		'rm -v ../esc',
		'rm -i ../esc',
	])('%s → DENY (out-of-scope operand)', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test.each([
		'rm src/temp.ts',
		'rm -i src/temp.ts',
		'rm src/a src/b',
	])('%s → ADMIT (in-scope operands)', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('rm src/a -- -rf denies as a scope write, not a destructive flag', async () => {
		const got = await gate('rm src/a -- -rf');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/SCOPE_VIOLATION/);
	}, 30_000);

	test('rm src/a -- src/-rf admits (the token after -- is an in-scope target)', async () => {
		const got = await gate('rm src/a -- src/-rf');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test.each([
		'rm foo -rf ../../outside',
		'rm -rf foo ../../outside',
	])('%s → DENY naming ../../outside', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toContain('../../outside');
	}, 30_000);

	// PR #3615 feedback PRR-002: quoted destructive flags reach neither the
	// detector's emit-nothing hand-off nor the extractor's option scan —
	// every guard the unquoted twins hit must fire here too. Delta-round
	// PRR-002a: LITERAL-quote filenames (`'"-rf"'` — the quotes are filename
	// characters after bash quote removal) must NOT be classified as options
	// by the boundary decode; the detector emits both words as write targets
	// and the scope check denies the out-of-scope sibling (stricter than
	// base, which admitted this shape — fail-closed, PR-introduced).
	// PRR-002b: ESCAPE-DECODED flags (`\-rf`) decode to real options at the
	// DC boundary (pre-existing recursive-delete fail-open, fixed there).
	test.each([
		['rm "-rf" ../../outside', 'DENIED', /Recursive delete target/],
		["rm '-rf' ../../outside", 'DENIED', /Recursive delete target/],
		['rm "-f" ../../outside', 'DENIED', /Recursive delete target/],
		['rm "--recursive" ../../outside', 'DENIED', /Recursive delete target/],
		['rm "-rf" .git', 'DENIED', /\.git/i],
		['rm "-rf" /', 'DENIED', /filesystem root/i],
		['rm "-rf" src', 'DENIED', /allowlisted/i],
		['rm "-rf" -- .git', 'DENIED', /\.git/i],
		['rm "-rf" ~', 'DENIED', /allowlisted/i],
		// PRR-002a: the literal-quote filename `"-rf"` is NOT an option; both
		// words emit as write targets and scope denies ../outside (cwd
		// resolution puts the literal-quote file at the workspace root).
		[`rm '"-rf"' ../outside`, 'DENIED', /SCOPE_VIOLATION|outside/i],
		// PRR-002b: escape-decoded destructive flags are real options.
		['rm \\-rf ../outside', 'DENIED', /Recursive delete target/],
		['rm \\-f ../outside', 'DENIED', /Recursive delete target/],
		['rm \\--force ../outside', 'DENIED', /Recursive delete target/],
		// PRR-002a control: the literal-quote `"-v"` operand is a TARGET (not
		// an option) resolving at the workspace root — outside the declared
		// src/ scope, so real bash deleting it denies fail-closed (probed).
		[`rm '"-v"' src/temp.ts`, 'DENIED', /SCOPE_VIOLATION/i],
	])(
		'%s → %s (quoted/escaped flag matrix)',
		async (command, expected, pattern) => {
			const got = await gate(command);
			expect(got.verdict).toBe(expected);
			if (expected === 'DENIED') {
				expect(got.message).toMatch(pattern);
			}
		},
		30_000,
	);

	test('rmdir brace escape still denies (AC12 preserved)', async () => {
		const got = await gate('rmdir src/{a,../esc}');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);
});
