/**
 * #3491/#3539 W1 shipped suite — directory-state word forms through the real
 * `createGuardrailsHooks().toolBefore` gate (coder, declared scope `src/`).
 *
 * Pins the sole DirectoryState model ({cwd, prevCwd, dirStack}) introduced by
 * the fix-plan v3 item 3 + v4 constraints 1–3:
 * - cd word forms: bare `cd` / `cd ~` land at $HOME; `cd -` lands at prevCwd
 *   or withdraws when unmodeled; dynamic operands withdraw (the historical
 *   literal-append is REMOVED — it fail-opened under broad scopes).
 * - pushd/popd tracked (push, swap, pop) with stack-overflow/misuse
 *   withdrawal; `pushd src` ADMITS an in-scope sibling write (base blocked).
 * - `cd -P src` / `cd -- src` positive forms track the real operand.
 * - LogicalExpression carries BOTH outcomes (&& and ||): every leg below is
 *   judged under every candidate post-chain state.
 * - Pipeline components isolate (parent cwd preserved; post-pipeline
 *   withdrawal when a component mutated the directory).
 * - If/While/Case divergence over the COMPLETE state (cwd+prevCwd+dirStack)
 *   withdraws later writes; loops accept only a full-state fixpoint.
 * - HOME= reassignment withdraws the HOME-landing forms.
 *
 * Denials assert the message CLASS (and target where meaningful), never just
 * "any throw"; admits are over-block guards.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
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

async function gate(
	command: string,
	scope: string[] | '.' = ['src/'],
): Promise<Verdict> {
	const ws = canonicalMkdtemp('cdwf3491-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `cdwf3491-s${++counter}`;
	const callID = `cdwf3491-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	if (scope === '.') {
		// The broad-workspace scope: session-level declaredCoderScope (no
		// active binding — normalizeScopePath rejects a literal '.', so the
		// binding fixture cannot express it).
		const session = getAgentSession(sessionID);
		if (session) session.declaredCoderScope = ['.'];
	} else {
		installActiveScopeBinding({
			directory: ws,
			childSessionId: sessionID,
			taskId: '1.1',
			files: scope,
			dispatchCallId: callID,
		});
	}
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
			message: (error as Error).message.split('\n')[0],
		};
	} finally {
		resetSwarmState();
	}
}

const ANY_WRITE_BLOCK = /^WRITE BLOCKED(?: \[shell-write-scope\])?: /;
const SCOPE_VIOLATION =
	/WRITE BLOCKED \[shell-write-scope\]: SCOPE_VIOLATION: shell write target "[^"]*" is outside the active scope/;
const WITHDRAWAL = /^BLOCKED: bash\/shell write to a dynamic path target/;

beforeEach(() => {
	resetSwarmState();
});

describe('W1 gate: cd word forms resolve-or-withdraw (#3491 AC3 / #3539)', () => {
	test('bare cd lands at HOME — later write denied under it', async () => {
		const got = await gate('cd; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		// HOME is under a protected authority prefix on every CI host.
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/not authorised to write/);
	});

	test('cd ~ lands at HOME identically', async () => {
		const got = await gate('cd ~; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/not authorised to write/);
	});

	test('HOME= reassignment withdraws the bare-cd landing (fail-closed)', async () => {
		const got = await gate('HOME=/x; cd; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('cd src; cd - returns to the workspace root — later write out of scope', async () => {
		const got = await gate('cd src; cd -; echo x > f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(SCOPE_VIOLATION);
		expect(got.message).toMatch(/f\.ts/);
	});

	test('first cd - has no modeled prevCwd — later writes withdrawn', async () => {
		const got = await gate('cd -; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('dynamic cd operand withdraws later writes (literal-append removed)', async () => {
		const got = await gate('V=..; cd $V; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('group 6: dynamic cd withdraws a later python eval even under scope "."', async () => {
		const got = await gate('V=..; cd $V; python -c "print(1)"', '.');
		expect(got.verdict).toBe('DENIED');
		// The withdrawn capability eval denies BEFORE any evalDirectory
		// fallback (the base literal-append admitted this under a broad
		// scope — the plan-critic r2/r3 fail-open).
		expect(got.message).toMatch(/evaluates inline code/);
	});

	test('control: python eval under scope "." with no cd admits', async () => {
		const got = await gate('python -c "print(1)"', '.');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('cd -P src tracks the real operand — in-scope write admits', async () => {
		const got = await gate('cd -P src; echo x > f');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('cd -- src tracks the real operand — in-scope write admits', async () => {
		const got = await gate('cd -- src; echo x > f');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('control: plain cd src; echo x > f admits', async () => {
		const got = await gate('cd src; echo x > f');
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W1 gate: pushd/popd directory-stack tracking (#3539 AC5)', () => {
	test('pushd in an if-body withdraws the later write (divergence)', async () => {
		const got = await gate('if true; then pushd ..; fi; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('pushd src is tracked — the in-scope sibling write admits', async () => {
		const got = await gate('pushd src; echo x > f');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('pushd src; popd restores the parent — write judged at the parent', async () => {
		const got = await gate('pushd src; popd; echo x > src/f');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('bare popd with an empty stack withdraws later writes', async () => {
		const got = await gate('popd; echo x > src/f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('same cwd, different dirStack diverges over the COMPLETE state', async () => {
		// then-branch: {cwd: ws/src, dirStack: [ws]}; else-branch:
		// {cwd: ws/src, dirStack: []} — cwd-only comparison would merge them;
		// the complete-state rule withdraws.
		const got = await gate(
			'if true; then pushd src; else cd src; fi; echo x > f',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});
});

describe('W1 gate: dual-outcome conditionals and pipelines (v4 constraints 1–2)', () => {
	test('false || cd .. — the executed-landing candidate denies the sibling', async () => {
		const got = await gate('false || cd ..; echo x > src/f.ts');
		expect(got.verdict).toBe('DENIED');
		// #3567 review PRR-012 fix: the ||-chain now models BOTH outcomes
		// (right skipped on left success, right EXECUTING from the pre-left
		// state on left failure). With `false` the left cannot prove a
		// directory command, so the two candidates diverge and the sibling
		// write withdraws (null-path denial) instead of resolving at a
		// post-left landing the model can no longer claim.
		expect(got.message).toMatch(WITHDRAWAL);
		expect(got.message).toMatch(/src\/f\.ts/);
	});

	test('true && cd src — the skip-landing candidate denies the sibling', async () => {
		const got = await gate('true && cd src; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(SCOPE_VIOLATION);
	});

	test('false && cd src — the skip landing is the only reachable one but the executed candidate still gates (both outcomes enumerated)', async () => {
		const got = await gate('false && cd src; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(SCOPE_VIOLATION);
	});

	test('pipeline component cd isolates — post-pipeline sibling write withdrawn', async () => {
		// Real bash: `cd src | cat` cannot move the parent cwd (child
		// process). Isolation alone would judge `f` at the workspace root;
		// v4 constraint 2 additionally withdraws post-pipeline writes when a
		// component mutated its directory (belt-and-braces).
		const got = await gate('cd src | cat; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('pipeline isolation control — a cwd-neutral pipeline keeps the parent state', async () => {
		const got = await gate('echo hi | cat; echo x > src/f');
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W1 gate: control-flow divergence and loop fixpoint (v4 constraint 3)', () => {
	test('if-without-else: the implicit no-body outcome diverges — withdrawn', async () => {
		const got = await gate('if true; then cd src; fi; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('case no-match outcome diverges — withdrawn', async () => {
		const got = await gate('case x in y) cd src;; esac; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('while body without a full-state fixpoint withdraws the post-loop write', async () => {
		const got = await gate(
			'while true; do cd src; break; done; echo x > src/f',
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('control: a write INSIDE the loop body pairs with the body-internal state', async () => {
		// #3586 re-pin (trace 3586-3588-3591-shell-gate-walk-fixpoint, plan
		// rev 13 END-STATE): this leg was pinned ADMIT on the assumption a
		// direct `break` provably terminates after iteration 1. Fourteen
		// plan-critic rounds proved NO command-text condition on a break is
		// sound — the AMBIENT ENVIRONMENT redefines break outside the
		// analyzed command (a BASH_ENV startup file or an exported
		// BASH_FUNC_* definition: `break() { :; }` makes the loop re-iterate
		// at the alternated cwd and write the escaping root-level f). The
		// walk now withdraws every clause+body write on landing≠entry with
		// exactly ONE exemption (a For with a fully-literal one-word list and
		// no dynamic-execution family member anywhere); While loops never
		// qualify, so this pin flips ADMIT→DENIED (conservative, fail-closed).
		const got = await gate('while true; do cd src; echo x > f; break; done');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('control: a cwd-neutral loop keeps the parent state (no withdrawal)', async () => {
		const got = await gate(
			'while true; do echo hi; break; done; echo x > src/f',
		);
		expect(got.verdict).toBe('ADMITTED');
	});
});
