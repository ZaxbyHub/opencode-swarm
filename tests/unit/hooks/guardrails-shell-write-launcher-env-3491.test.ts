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

// ---------------------------------------------------------------------------
// W3 (#3491): per-manual launcher option grammar + fail-closed depth caps.
// The old strip handled only BARE `sudo|time|nohup` and `nice -n N`, so an
// option-bearing launcher left the option word in verb position and the
// identical wrapped command ADMITTED (RC-2b).
// ---------------------------------------------------------------------------

describe('W3 gate: sudo option grammar (sudo(8) mode table)', () => {
	test.each([
		['sudo -u root rmdir ../x'],
		['sudo -g wheel rmdir ../x'],
		['sudo -p "[pass]" rmdir ../x'],
		['sudo -E rmdir ../x'],
		['sudo -n rmdir ../x'],
		['sudo -b rmdir ../x'],
		['sudo -B rmdir ../x'],
		['sudo -u root -E -n rmdir ../x'],
		['sudo --user=root rmdir ../x'],
		['sudo -- rmdir ../x'],
	])('%s → DENIED (options consumed, tail inspected)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test.each([
		['sudo -l'],
		['sudo -v'],
		['sudo -V'],
		['sudo -l rmdir ../x'], // -l [command] LISTS privileges for it — never executes
		['sudo -K'],
	])('%s → ADMITTED (non-execution query modes)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test.each([
		['sudo -i'],
		['sudo -s'],
		['sudo --login'],
		['sudo --shell'],
	])('%s → DENIED (interactive root shell, no inspectable command)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/interactive shell/);
	});

	test('sudo -i rmdir ../x → DENIED (a tail through the login shell is executed)', async () => {
		const got = await gate('sudo -i rmdir ../x', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test('sudo -e edit target outside the scope → DENIED (edit operands are write-class)', async () => {
		const got = await gate('sudo -e ../secret.txt');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('sudo -e in-scope edit target admits', async () => {
		const got = await gate('cd src && sudo -e ok.txt');
		expect(got.verdict).toBe('ADMITTED');
	});

	test.each([
		['sudo -z rmdir ../x'],
		['sudo -h host rmdir ../x'],
		['sudo --wat rmdir ../x'],
	])('%s → DENIED (unknown option: every remaining word is a potential execution tail)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
	});

	test('sudo -z alone → ADMITTED (unknown option with no tail: sudo errors, nothing runs)', async () => {
		const got = await gate('sudo -z', true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('sudo -u root -D .. composes: options before the chdir, tail escapes', async () => {
		const got = await gate('sudo -u root -D .. rm -rf dist', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete target "..\/dist"/);
	});

	test('control: sudo rm -rf node_modules stays admitted (safe artifact)', async () => {
		const got = await gate('sudo rm -rf node_modules', true);
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W3 gate: time keyword vs GNU binary (spelling-selected grammar)', () => {
	test.each([
		['time -p rmdir ../x'],
		['time rmdir ../x'],
		['/usr/bin/time -p rmdir ../x'],
		['/usr/bin/time -v rmdir ../x'],
		['/usr/bin/time -f %e rmdir ../x'],
	])('%s → DENIED (the timed command is inspected)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test('time -o FILE writes the timing report (ADDITIONAL write target)', async () => {
		const got = await gate('/usr/bin/time -o ../report.txt true');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('time -a -o FILE append variant is still a write target', async () => {
		const got = await gate('/usr/bin/time -a -o ../report.txt true');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('time --output=FILE glued long form', async () => {
		const got = await gate('/usr/bin/time --output=../report.txt true');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});

	test('time -o in scope admits (report at src/ok.txt)', async () => {
		const got = await gate('cd src && /usr/bin/time -o ok.txt true');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('bash keyword `time -v cmd`: -v IS the command word (nothing runs) — admits', async () => {
		const got = await gate('time -v true', true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('control: external time -v true with benign tail admits', async () => {
		const got = await gate('/usr/bin/time -v true', true);
		expect(got.verdict).toBe('ADMITTED');
	});
});

describe('W3 gate: nice / nohup option grammar', () => {
	test.each([
		['nice -n 5 rmdir ../x'],
		['nice -10 rmdir ../x'],
		['nice --adjustment=5 rmdir ../x'],
		['nice -n5 rmdir ../x'],
		['nice -- rmdir ../x'],
	])('%s → DENIED (adjustment consumed, tail inspected)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test.each([
		['nice'],
		['nice --help'],
		['nice -n 5'],
	])('%s → ADMITTED (no command runs)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('nice -z rmdir ../x → DENIED (unknown option, potential tail)', async () => {
		const got = await gate('nice -z rmdir ../x', true);
		expect(got.verdict).toBe('DENIED');
	});

	test('nohup rm -rf node_modules stays admitted (safe artifact through the wrapper)', async () => {
		const got = await gate('nohup rm -rf node_modules', true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('nohup -- rm -rf ../../outside → DENIED (transparent --)', async () => {
		const got = await gate('nohup -- rm -rf ../../outside', true);
		expect(got.verdict).toBe('DENIED');
	});

	test('nohup -x cmd → DENIED (deny-on-uncertainty for dash-led non-option words)', async () => {
		const got = await gate('nohup -x true', true);
		expect(got.verdict).toBe('DENIED');
	});
});

describe('W3 gate: fail-closed depth caps (RC-2b, C4 family)', () => {
	test('sudo x6 + rm -rf → DENIED (cursor-bounded unwrap reaches the verb)', async () => {
		const got = await gate(
			'sudo sudo sudo sudo sudo sudo rm -rf ../../outside',
			true,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete/);
	});

	test('command x14 + rm -rf → DENIED', async () => {
		const got = await gate(
			`${'command '.repeat(14)}rm -rf ../../outside`,
			true,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/Recursive delete/);
	});

	test('paranoid bound: sudo x70 + benign tail → DENIED through the depth channel', async () => {
		const got = await gate(`${'sudo '.repeat(70)}echo hi`, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/inspection bound/);
	});

	test('write arm paranoid bound: env x70 + python -c → DENIED (unwrapDepthExceeded)', async () => {
		const got = await gate(`${'env '.repeat(70)}python -c "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/inspection bound/);
	});

	test('control: env x3 + python -c still classifies normally (deny on scope)', async () => {
		const got = await gate(`env env env python -c "open('../x','w')"`);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_WRITE_BLOCK);
	});
});
