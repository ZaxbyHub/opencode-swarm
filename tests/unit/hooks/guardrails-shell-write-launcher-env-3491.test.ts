/**
 * #3491 W2 shipped suite — child-scoped env/sudo chdir through the quoted
 * subshell transform, driven through the real
 * `createGuardrailsHooks().toolBefore` gate (coder, declared scope `src/`).
 *
 * The gate preprocesses chdir-bearing wrapper segments (env -C DIR /
 * env -S '…-C DIR…' / sudo -D DIR) into correctly-quoted subshells
 * `( cd -- 'DIR' && <re-unwrapped inner> )`: the wrapped command's writes
 * resolve under the CHILD cwd while following siblings stay at the parent
 * cwd (bash-true for env/sudo). Dynamic DIR operands are never serialized —
 * the segment rewrites to the withdrawal form and inner writes withdraw.
 * Destructive segments receive an EVOLVING per-segment directory context
 * (W1 word-form rules); unrepresentable inner mutations withdraw to deny.
 *
 * Covers the plan round-3 discriminator groups 2 (the critic's five env
 * commands), 4 (nested chdir composition), 5 (destructive inner evolving
 * context) and 6 (dynamic-DIR withdrawal), plus the C2 frozen family.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function config(destructive: boolean): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...(destructive ? { block_destructive_commands: true } : {}),
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(command: string, destructive = false): Promise<Verdict> {
	const ws = canonicalMkdtemp('lenv3491-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	mkdirSync(path.join(ws, 'src', 'sub'), { recursive: true });
	const sessionID = `lenv3491-s${++counter}`;
	const callID = `lenv3491-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config(destructive));
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
const WITHDRAWAL = /^BLOCKED: bash\/shell write to a dynamic path target/;

beforeEach(() => {
	resetSwarmState();
});

describe('W2 gate: env -C / env -S child cwd (#3491 AC4, C2 family)', () => {
	test('env -C .. sh -c write resolves at the PARENT — denied', async () => {
		const got = await gate('env -C .. sh -c "mkdir -p src && echo x > src/a"');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
		expect(got.message).toMatch(/src\/a/);
	});

	test('env -S split-string chdir behaves like -C', async () => {
		const got = await gate(`env -S '-C .. sh -c "echo x > src/a"'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('control: the same payload with no env admits (in scope at the workspace)', async () => {
		const got = await gate('sh -c "mkdir -p src && echo x > src/a"');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('env -C src sh -c write escapes through the child cwd', async () => {
		// Child cwd ws/src: ../x lands at ws/x — outside scope src/.
		const got = await gate(`env -C src sh -c 'echo x > ../x'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('env -C src true restores the parent — the sibling write stays out of scope', async () => {
		// If the child cd leaked into the parent state, `f` would resolve at
		// ws/src/f (in scope) and admit; bash keeps the parent at ws.
		const got = await gate('env -C src true; echo x > f');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('env -C .. true restores the parent — the in-scope sibling write admits', async () => {
		const got = await gate('env -C .. true; echo x > src/f');
		expect(got.verdict).toBe('ADMITTED');
	});

	test("env -C 'src #': the space+# DIR serializes safely (quoted single word)", async () => {
		// A broken serializer would let `#` start a comment or split the word;
		// the tracked walk then either resolves f outside scope or withdraws.
		const got = await gate(`env -C 'src #' sh -c 'echo x > f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});
});

describe('W2 gate: dynamic DIR operands never serialize (v4 constraint 4)', () => {
	test('env -C $DIR withdraws the wrapped writes', async () => {
		const got = await gate(`env -C $DIR sh -c 'echo x > src/f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('env -C ~/x withdraws the wrapped writes', async () => {
		const got = await gate(`env -C ~/x sh -c 'echo x > src/f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test('control: an uncertain chdir wrapping nothing stays admitted', async () => {
		const got = await gate('env -C $DIR true');
		expect(got.verdict).toBe('ADMITTED');
	});

	// Review round 1 (F-1): the withdrawal must be UNCONDITIONAL. The first
	// round's withdrawal form was a synthetic `cd -`, which LANDS at OLDPWD
	// when a prior cd/pushd established one — `cd src; env -C '$D' …` then
	// resolved the wrapped writes at the OLDPWD landing and ADMITTED
	// (fail-open). The form now uses a synthetic dynamic operand the walk can
	// never resolve, independent of any modeled prevCwd.
	test("cd src; env -C '$D' withdraws the wrapped writes (no OLDPWD landing)", async () => {
		const got = await gate(`cd src; env -C '$D' sh -c 'echo x > src/f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test("pushd src; env -C '$D' withdraws the wrapped writes (no stack landing)", async () => {
		const got = await gate(`pushd src; env -C '$D' sh -c 'echo x > src/f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test("OLDPWD landing oracle: cd src; env -C '$D' … echo x > f denies WITH the withdrawal class", async () => {
		// `f` (no src/ prefix) is the leg the first round's `cd -` form
		// resolved at OLDPWD (ws) — it denied as a scope violation on the
		// <ws>/f landing instead of the withdrawal, proving the landing.
		const got = await gate(`cd src; env -C '$D' sh -c 'echo x > f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(WITHDRAWAL);
	});

	test("destructive arm: cd src; env -C '$D' rm -rf dist denies on the sentinel", async () => {
		const got = await gate(`cd src; env -C '$D' sh -c 'rm -rf dist'`, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(
			/Recursive delete target "\.\.\/__swarm_unresolved_chdir__\/dist"/,
		);
	});
});

describe('W2 gate: nested chdir wrappers compose as nested subshells (group 4)', () => {
	test('env -C src sudo -D .. escapes through the composed child cwd', async () => {
		// Outer child ws/src; inner child resolves relative to it: ws/src/..
		// = ws — `f` lands outside scope src/.
		const got = await gate(`env -C src sudo -D .. sh -c 'echo x > f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('control: env -C src sudo -D sub composes in scope', async () => {
		const got = await gate(`env -C src sudo -D sub sh -c 'echo x > f'`);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('sudo -D alone drives the child cwd', async () => {
		const got = await gate(`sudo -D .. sh -c 'echo x > src/f'`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});
});

describe('W2 gate: destructive segments evaluate at the evolving child cwd (group 5)', () => {
	test('env -C .. rm -rf dist denies at the child cwd (outside workspace)', async () => {
		const got = await gate('env -C .. rm -rf dist', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete target "..\/dist"/);
	});

	test('control: env -C src rm -rf dist evaluates the nested safe artifact in scope', async () => {
		const got = await gate('env -C src rm -rf dist', true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('control: a sibling rm after the wrapper evaluates at the parent cwd', async () => {
		const got = await gate('env -C .. true; rm -rf dist', true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('sudo -D .. rm -rf dist denies at the child cwd', async () => {
		const got = await gate('sudo -D .. rm -rf dist', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete target "..\/dist"/);
	});

	test('inner cd evolves the destructive context inside the wrapper', async () => {
		// Child cwd ws/..; the payload's `cd src` moves the evaluation to
		// ws/../src — dist resolves outside the workspace there.
		const got = await gate(`env -C .. sh -c 'cd src; rm -rf dist'`, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete target "..\/src\/dist"/);
	});

	test('an unrepresentable inner directory mutation withdraws to deny', async () => {
		const got = await gate(`env -C .. sh -c 'cd $D; rm -rf dist'`, true);
		expect(got.verdict).toBe('DENIED');
		// The unpinnable context lands the target on the escaping sentinel.
		expect(got.message).toMatch(
			/Recursive delete target "\.\.\/__swarm_unresolved_chdir__\/dist"/,
		);
	});

	// Review round 1 (F-2): the child-cwd context is keyed per OCCURRENCE.
	// The first round keyed it by segment TEXT with first-wins, so both
	// `rm -rf dist` occurrences inherited the FIRST segment's src context and
	// the escaping `env -C ..` occurrence was ADMITTED.
	test('env -C src rm -rf dist; env -C .. rm -rf dist — the second occurrence denies', async () => {
		const got = await gate(
			'env -C src rm -rf dist; env -C .. rm -rf dist',
			true,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete target "..\/dist"/);
	});
});
