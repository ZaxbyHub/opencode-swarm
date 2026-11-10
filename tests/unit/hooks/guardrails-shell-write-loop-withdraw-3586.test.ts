/**
 * #3586 (collated trace 3586-3588-3591-shell-gate-walk-fixpoint, Fix 1 —
 * plan rev 13 END-STATE): a loop whose one-pass directory landing diverges
 * from its entry state withdraws EVERY clause+body write fail-closed. The
 * single exemption (arm (a)) admits exactly the For whose word list is one
 * fully-literal word immune to every word-producing expansion, with no
 * dynamic-execution family member anywhere in the command. NO break-based
 * exemption exists — the ambient environment (BASH_ENV / exported
 * BASH_FUNC_*) can redefine `break` outside the analyzed command text
 * (fourteen plan-critic rounds; the full bypass census is the frozen C1
 * corpus). Gate-level pins (coder agent, declared scope src/), each deny
 * family carrying an admit control.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	resolveWriteTargets,
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
	const ws = canonicalMkdtemp('lw3586-');
	created.push(ws);
	// src/sub hosts the clause-cd-drift leg's entry directory.
	mkdirSync(path.join(ws, 'src', 'sub'), { recursive: true });
	const sessionID = `lw3586-s${++counter}`;
	const callID = `lw3586-call-${counter}`;
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
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

// PR #3615 feedback PRR-010 (tests-falsifiability-002): pin the EXACT
// withdrawal channel — the unresolved-path deny message — so a regression
// that stops withdrawing but still denies via ANY other channel (scope,
// destructive, parse refusal) fails this suite instead of hiding behind a
// generic /BLOCKED/ match. Mirrors the shipped sibling predicate at
// guardrails-shell-write-cd-word-forms-3491.test.ts.
const WITHDRAWAL = /^BLOCKED: bash\/shell write to a dynamic path target/;

describe('#3586 Fix 1: loop landing≠entry withdraws clause+body writes', () => {
	test('for-alternation write inside the body denies', async () => {
		const got = await gate('cd src; for i in 1 2; do echo x > f; cd ..; done');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('until-alternation denies (Until arm, not just While)', async () => {
		const got = await gate(
			'cd src; i=0; until [ "$i" -ge 2 ]; do echo x > f; i=$((i+1)); cd ..; done',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('while-CLAUSE write is as iteration-carried as the body (denies)', async () => {
		// The clause re-executes per iteration; the slice capture starts
		// BEFORE the clause walk so the clause write is retroactively
		// withdrawn too.
		const got = await gate(
			'cd src; i=0; while echo x > f; i=$((i+1)); [ "$i" -lt 2 ]; do cd ..; done',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('clause-resident cd drifts the fixpoint basis (4.5 finding 2)', async () => {
		// Reviewer-executed shape: the cd lives in the while CLAUSE, which
		// re-executes every iteration — the body is idempotent against the
		// POST-clause state (the pre-4.5 comparison basis), so the drift
		// never fired and the gate admitted while real bash writes src/f
		// (iteration 1) and then the escaping workspace-root f (iteration 2).
		// The fixpoint now compares the body landing against the PRE-clause
		// ENTRY state (pinned as frozen C1 leg clause-cd-drift).
		const got = await gate(
			'cd src/sub; i=0; while cd ..; [ "$i" -lt 2 ]; do i=$((i+1)); echo x > f; done',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('net-zero for body keeps admitting (no post-walk divergence)', async () => {
		const got = await gate('cd src; for i in 1 2; do echo x > f; done');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('full-state (not cwd-only) comparison: a dirStack divergence also denies', async () => {
		// pushd alternates the directory stack while the cwd lands back at
		// entry — the landing equals entry, so no WITHDRAWAL fires; the
		// escaping iteration-1 write is caught directly by the scope check
		// (DENY either way is the invariant; the channel differs by design).
		const got = await gate(
			'cd src; for i in 1 2; do pushd .. >/dev/null; echo x > f; popd >/dev/null; done',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(
			/SCOPE_VIOLATION|WITHDRAWAL|dynamic path target/,
		);
	}, 30_000);

	test('write BEFORE a withdrawing loop keeps its own resolution (later loop denies)', async () => {
		// The in-scope pre-loop write resolves fine; the loop's escaping
		// iteration-2 write is withdrawn and the tool call denies.
		const got = await gate(
			'cd src; echo ok > src/f; for i in 1 2; do echo x > g; cd ..; done',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('post-loop siblings were already withdrawn at base — still deny', async () => {
		const got = await gate(
			'cd src; for i in 1 2; do cd ..; done; echo x > src/f',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);
});

describe('#3586 Fix 1 arm (a): the single fully-literal-word For exemption', () => {
	test('single literal word + alternating body keeps admitting (positive pin)', async () => {
		const got = await gate('cd src; for i in x; do echo x > f; cd ..; done');
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test('two literal words disqualify the exemption (the reported shape)', async () => {
		const got = await gate('cd src; for i in x y; do echo x > f; cd ..; done');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('a glob word disqualifies (one AST word, N runtime items)', async () => {
		const got = await gate('cd src; for i in *; do echo x > f; cd ..; done');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	// PR #3615 feedback PRR-004: hasUnquotedBraceExpansion runs a quadratic
	// regex over the raw word text on the per-call hot path. An oversized
	// word is treated as expansion-bearing (exemption withdrawn, fail
	// closed) instead of feeding the scan — this leg also proves the cap
	// keeps the gate responsive (the leg completes well under its timeout
	// where the uncapped scan took ~1.4s per walk at 40k chars).
	test('an oversized for-list word disqualifies the exemption without the quadratic scan', async () => {
		const bigWord = `{${'a,'.repeat(3000)}a}`;
		const got = await gate(
			`cd src; for i in ${bigWord}; do echo x > f; cd ..; done`,
		);
		expect(got.verdict).toBe('DENIED');
		// #3616 D10: the pre-parse oversized-word sentinel now denies this
		// shape BEFORE the parse (same fail-closed outcome, earlier stage) —
		// the message is the sentinel's blanket-block, not the withdrawal.
		expect(got.message).toMatch(/write detection failed to parse/);
	}, 30_000);

	test('a brace word disqualifies ({a,b} is one Word, two items)', async () => {
		const got = await gate(
			'cd src; for i in {a,b}; do echo x > f; cd ..; done',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('a `!` word disqualifies (history expansion multiplies words)', async () => {
		const got = await gate('cd src; for i in "!"; do echo x > f; cd ..; done');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('a tilde word disqualifies (tilde expansion)', async () => {
		const got = await gate('cd src; for i in "~x"; do echo x > f; cd ..; done');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test('a dynamic-execution family member AFTER the loop disqualifies (pre-pass)', async () => {
		// `shopt` is a later sibling — the family flag is computed over the
		// WHOLE command before the walk, so the earlier For loses the
		// exemption.
		const got = await gate(
			'cd src; for i in x; do echo x > f; cd ..; done; shopt -s expand_aliases',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	test.each([
		// Spellings that reach the walk verbatim (not unwrapped by the
		// gate's wrapper preprocessing first):
		'command -v ls',
		'source helper.sh',
		'. helper.sh',
		'trap "" USR1',
		'shopt -s expand_aliases',
		'set -e',
		'history -c',
		'fc -l',
		'enable -n true',
		'mapfile -t arr < list.txt',
		'readarray -t arr < list.txt',
		'alias c=continue',
		'unalias c || true',
	])('family member `%s` after the loop disqualifies arm (a)', async (family) => {
		const got = await gate(
			`cd src; for i in x; do echo x > f; cd ..; done; ${family}`,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	}, 30_000);

	// RESIDUAL (documented, not pinned): `eval`/`exec`/`builtin` TRANSPARENT
	// heads are unwrapped by the gate's wrapper preprocessing BEFORE the
	// walk, so their own-word spelling disappears from the analyzed command
	// and cannot contribute to the family flag. That interplay does not
	// reopen the alternation: arm (a) is sound independent of the family
	// flag (a fully-literal ONE-word list cannot APPEND items — the r12
	// execution argument), and the family spellings that survive
	// preprocessing (source/./trap/shopt/set/history/fc/enable/mapfile/
	// readarray/alias/unalias/command) are pinned above. The multi-word and
	// While alternation legs — where the family flag is load-bearing — never
	// qualify for arm (a) to begin with.
});

describe('#3586 Fix 1: resolver-level unresolvedContext marking', () => {
	function loopWrite(command: string) {
		const ws = canonicalMkdtemp('lw3586-res-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		const analysis = detectPosixWrites(command);
		const resolved = resolveWriteTargets(command, analysis.writes, ws);
		return resolved.filter(
			(r) => r.original.category === 'redirect' && r.original.path === 'f',
		);
	}

	test('alternation body write resolves to null (unresolved marker)', () => {
		const entries = loopWrite(
			'cd src; for i in 1 2; do echo x > f; cd ..; done',
		);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.resolvedPath).toBeNull();
			expect(entry.unresolved).toBe(true);
		}
	});

	// PR #3615 feedback PRR-010 (tests-falsifiability-003): a write collected
	// BEFORE a withdrawing loop keeps its own resolution — the retroactive
	// withdrawal must never reach earlier siblings (over-deny guard).
	test('pre-loop write keeps its resolution while the loop write withdraws', () => {
		const ws = canonicalMkdtemp('lw3586-pre-');
		created.push(ws);
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		const command =
			'cd src; echo ok > src/f; for i in 1 2; do echo x > g; cd ..; done';
		const analysis = detectPosixWrites(command);
		const resolved = resolveWriteTargets(command, analysis.writes, ws);
		const preLoop = resolved.filter(
			(r) => r.original.category === 'redirect' && r.original.path === 'src/f',
		);
		const loopWriteEntries = resolved.filter(
			(r) => r.original.category === 'redirect' && r.original.path === 'g',
		);
		expect(preLoop.length).toBeGreaterThan(0);
		for (const entry of preLoop) {
			expect(entry.resolvedPath).not.toBeNull();
			expect(entry.unresolved).not.toBe(true);
		}
		expect(loopWriteEntries.length).toBeGreaterThan(0);
		for (const entry of loopWriteEntries) {
			expect(entry.resolvedPath).toBeNull();
		}
	});

	test.each([
		'eval "echo hi"',
		'exec true',
		'builtin true',
		'readarray -t arr < list.txt',
	])('pre-pass: family member `%s` in the analyzed text withdraws an arm-(a) loop', (family) => {
		const entries = loopWrite(
			`cd src; for i in x; do echo x > f; cd ..; done; ${family}`,
		);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) expect(entry.resolvedPath).toBeNull();
	});

	test('arm (a) body write keeps its tracked resolution under src/', () => {
		const entries = loopWrite('cd src; for i in x; do echo x > f; cd ..; done');
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.resolvedPath).not.toBeNull();
			expect(entry.unresolved).toBeUndefined();
			expect(path.basename(path.dirname(entry.resolvedPath ?? ''))).toBe('src');
		}
	});
});
