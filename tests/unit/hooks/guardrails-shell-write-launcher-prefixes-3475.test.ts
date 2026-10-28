/**
 * #3475 launcher prefixes: `command`, `builtin`, `exec` and `timeout DURATION`
 * are transparent launchers — the write command behind them must be
 * scope-checked exactly like the unprefixed spelling. Parity legs: touch and
 * mkdir are NOT detected write commands today, so both the prefixed and the
 * plain spelling stay admitted (documented parity, not a block expectation);
 * if that ever changes, both spellings must change together.
 * RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-write-launcher-prefix-3475-');
// Round-4: an EMPTY sibling workspace root OUTSIDE the session workspace —
// the counterexample target the R3-B1 control below rmdirs after `cd ..`.
const SIBLING_OUTSIDE_DIR = canonicalMkdtemp('launcher-prefix-outside-sib-');

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

let callCounter = 0;

async function runAsCoder(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	const sessionID = `launcher-prefix-${++callCounter}`;
	const callID = `call-${callCounter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	await hooks.toolBefore(
		{ tool: 'bash', sessionID, callID },
		{ args: { command } },
	);
}

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
		rmSync(SIBLING_OUTSIDE_DIR, { recursive: true, force: true });
	} catch {
		// Windows EBUSY flake: a brief handle can outlive the test body.
	}
});

describe('gate: launcher-prefixed write commands (#3475)', () => {
	beforeEach(() => {
		resetSwarmState();
		mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
		writeFileSync(path.join(TEST_DIR, 'src', 'x.txt'), 'x');
	});

	// #3485 feedback (PRR-015): `builtin` is NOT unwrapped for external
	// commands — bash errors "not a shell builtin" and runs nothing for
	// `builtin rmdir/cp/mv …`, so those forms are (correctly) admitted and
	// live in the admits-it.each below. Only `command`/`exec` reject here.
	it.each([
		'command',
		'exec',
	])('%s rmdir ../zz rejects like the unprefixed form', async (prefix) => {
		await expect(runAsCoder(`${prefix} rmdir ../zz`)).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it.each([
		'command',
		'exec',
	])('%s cp src/x.txt ../zz4 rejects like the unprefixed form', async (prefix) => {
		await expect(runAsCoder(`${prefix} cp src/x.txt ../zz4`)).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it.each([
		'command',
		'exec',
	])('%s mv src/x.txt ../zz5 rejects like the unprefixed form', async (prefix) => {
		await expect(runAsCoder(`${prefix} mv src/x.txt ../zz5`)).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	// #3485 feedback (PRR-015): `builtin <external>` runs nothing in bash
	// ("not a shell builtin"), so admission is the correct verdict for every
	// external write-vector command behind the builtin prefix.
	it.each([
		'builtin rmdir ../zz',
		'builtin cp src/x.txt ../zz4',
		'builtin mv src/x.txt ../zz5',
	])('admits %s (not a shell builtin — nothing runs)', async (command) => {
		await expect(runAsCoder(command)).resolves.toBeUndefined();
	});

	it('rejects timeout 5 rmdir ../zz', async () => {
		await expect(runAsCoder('timeout 5 rmdir ../zz')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	// Round-3: zsh =-expansion in OPERAND position — `rmdir =somecmd`. At
	// base the bare-rmdir exemption admits it (the literal `=somecmd`
	// operand resolves inside the workspace). Post-fix the leading-=
	// operand guard withdraws the exemption and the ordinary scope check
	// blocks it for a coder scoped to src/. (Critic R2-B7, decision comment
	// 6434634384.)
	// Impl-review r1 F2: `--` ends command's options and the wrapped command
	// follows (verified against real bash: `command -- rmdir ../x` runs rmdir).
	it('rejects command -- rmdir ../zz (-- terminator unwraps)', async () => {
		await expect(runAsCoder('command -- rmdir ../zz')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('rejects command -- rm -rf ../zz (-- terminator unwraps)', async () => {
		// Blocks via the destructive layer's recursive-delete message.
		await expect(runAsCoder('command -- rm -rf ../zz')).rejects.toThrow(
			/^WRITE BLOCKED: |^BLOCKED: /,
		);
	});

	it('rejects rmdir =somecmd (leading-= operand guard withdraws the exemption)', async () => {
		await expect(runAsCoder('rmdir =somecmd')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	// Round-3 (green at base AND post-fix): a bare rmdir of an in-workspace
	// empty directory under `timeout` stays admitted. Post-fix the exemption
	// survives because the post-unwrap detection command is plain `rmdir`
	// (cwdNeutral is computed on the unwrapped string — no CWD_NEUTRAL_COMMANDS
	// change is made).
	it('admits timeout 5 rmdir of an in-workspace empty directory (exemption survives the unwrap)', async () => {
		mkdirSync(path.join(TEST_DIR, '.scratch-empty'), { recursive: true });
		await expect(
			runAsCoder('timeout 5 rmdir .scratch-empty'),
		).resolves.toBeUndefined();
	});

	// Round-3 (red at base): `-p` kills the plain-line exemption (options
	// are not bare), so post-fix the unwrap exposes the rmdir and the
	// ordinary scope check rejects the in-workspace-but-out-of-scope target.
	// At base `timeout` hides the rmdir entirely and the command admits.
	it('rejects timeout 5 rmdir -p of an in-workspace directory (option kills the exemption)', async () => {
		mkdirSync(path.join(TEST_DIR, '.scratch-p', 'x'), { recursive: true });
		await expect(runAsCoder('timeout 5 rmdir -p .scratch-p/x')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	// Round-4 counterexample control (critic R3-B1, green at base AND
	// post-fix): `command -- cd ..` unwraps to a tracked `cd`, which is not
	// cwd-neutral and not on the plain-line command list, so the exemption
	// is withdrawn. The bare rmdir then gets the ordinary declared-scope
	// check, which blocks for a src/-scoped coder. This pins that launcher
	// names are NOT added to CWD_NEUTRAL_COMMANDS — the round-3 plan's
	// fail-open is withdrawn; only the round-3 exempt leg above (timeout +
	// bare in-workspace rmdir) may admit.
	it('rejects command -- cd ..; rmdir of a sibling workspace root (R3-B1: launcher names never join the plain-line set)', async () => {
		await expect(
			runAsCoder(
				`command -- cd ..; rmdir ${path.basename(SIBLING_OUTSIDE_DIR)}`,
			),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	it('rejects command rm -rf ../zz', async () => {
		await expect(runAsCoder('command rm -rf ../zz')).rejects.toThrow(
			/^(?:WRITE )?BLOCKED: /,
		);
	});

	it.each([
		'command',
		'builtin',
		'exec',
	])('parity: %s touch ../zz stays admitted exactly like plain touch', async (prefix) => {
		await expect(runAsCoder(`${prefix} touch ../zz`)).resolves.toBeUndefined();
		await expect(runAsCoder('touch ../zz')).resolves.toBeUndefined();
	});

	it.each([
		'command',
		'builtin',
		'exec',
	])('parity: %s mkdir ../zz stays admitted exactly like plain mkdir', async (prefix) => {
		await expect(runAsCoder(`${prefix} mkdir ../zz`)).resolves.toBeUndefined();
		await expect(runAsCoder('mkdir ../zz')).resolves.toBeUndefined();
	});

	// Impl-review r2 question pin: GNU timeout treats a POST-duration `--`
	// as the command itself and fails to exec it (verified: exit 127, no
	// write) — admitting this form matches reality. A PRE-duration `--`
	// (`timeout -- 5 CMD`) unwraps and gates like the plain form.
	it('still admits timeout 5 -- rmdir ../zz (post-duration -- runs nothing)', async () => {
		await expect(
			runAsCoder('timeout 5 -- rmdir ../zz'),
		).resolves.toBeUndefined();
	});

	it('still admits launcher-prefixed read-only commands', async () => {
		await expect(runAsCoder('command ls src')).resolves.toBeUndefined();
		await expect(runAsCoder('command cat src/x.txt')).resolves.toBeUndefined();
		await expect(runAsCoder('builtin echo hi')).resolves.toBeUndefined();
		await expect(runAsCoder('exec true')).resolves.toBeUndefined();
	});

	// Round-2 FP legs: `command -v` / `command -V` are QUERY forms — they
	// print information and never execute the named write command, so the
	// unwrapping must not treat them as an execution of it.
	it('still admits command -v rmdir ../zz (query form, not execution)', async () => {
		await expect(runAsCoder('command -v rmdir ../zz')).resolves.toBeUndefined();
	});

	it('still admits command -V cp (query form, not execution)', async () => {
		await expect(runAsCoder('command -V cp')).resolves.toBeUndefined();
	});

	it('controls: the unprefixed forms still reject (the detector fires)', async () => {
		await expect(runAsCoder('rmdir ../zz')).rejects.toThrow(/^WRITE BLOCKED: /);
		await expect(runAsCoder('cp src/x.txt ../zz2')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
		await expect(runAsCoder('mv src/x.txt ../zz3')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
		await expect(runAsCoder('rm -rf ../zz')).rejects.toThrow(
			/^(?:WRITE )?BLOCKED: /,
		);
	});
});
