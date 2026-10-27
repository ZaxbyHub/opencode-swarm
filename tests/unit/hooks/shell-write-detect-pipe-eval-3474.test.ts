/**
 * #3474 pipe-fed interpreter eval: an inline-literal producer piped into an
 * interpreter (`echo 'open(...)' | python`, `printf '...' | python`) supplies
 * the interpreter's PROGRAM, so it must classify as an interpreter_eval write
 * and the gate must reject it for an out-of-scope coder. The #1901
 * script-path carve-out stays: a script FILE source (`cat src/script.py |
 * python`, `python src/script.py`, `python -m pytest`, `python --version`)
 * yields NO eval write and stays admitted.
 * RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-write-pipe-eval-3474-');

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
	const sessionID = `pipe-eval-${++callCounter}`;
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

function expectEvalDetected(command: string): void {
	const analysis = detectPosixWrites(command);
	expect(
		analysis.writes.some((w) => w.category === 'interpreter_eval'),
		`${command} must classify as interpreter_eval`,
	).toBe(true);
}

function expectNoEvalWrite(command: string): void {
	const analysis = detectPosixWrites(command);
	expect(
		analysis.writes.some((w) => w.category === 'interpreter_eval'),
		`${command} must NOT classify as interpreter_eval (#1901 carve-out)`,
	).toBe(false);
}

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Windows EBUSY flake: a brief handle can outlive the test body.
	}
});

describe('detector: inline-literal pipe source feeds the interpreter (#3474)', () => {
	it("classifies echo 'open(...)' | python as interpreter_eval", () => {
		expectEvalDetected('echo \'open("../zz.txt","w")\' | python');
	});

	it("classifies printf 'open(...)' | python as interpreter_eval", () => {
		expectEvalDetected('printf \'open("../zz.txt","w")\' | python');
	});

	it('keeps the #1901 script-path carve-out unclassified', () => {
		expectNoEvalWrite('cat src/script.py | python');
		expectNoEvalWrite('python src/script.py');
		expectNoEvalWrite('python -m pytest');
		expectNoEvalWrite('python --version');
	});

	// Round-2: the stdin-consumed spelling `| python -` is still an
	// inline-literal pipe source feeding the interpreter's program.
	it("classifies echo 'open(...)' | python - as interpreter_eval", () => {
		expectEvalDetected('echo \'open("a.txt","w")\' | python -');
	});

	// Round-2: an ordinary eval AND a pipe-fed eval in one command string
	// must BOTH surface as eval writes (occurrence preservation).
	it('yields two eval writes for an ordinary -c eval plus a pipe-fed eval', () => {
		const analysis = detectPosixWrites(
			'python -c "x=1"; echo \'open("b.txt","w")\' | python',
		);
		const evalWrites = analysis.writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(evalWrites.length).toBeGreaterThanOrEqual(2);
	});

	// Round-3 controls (green at base AND post-fix): the #1901 stdin-REDIRECT
	// override rule — when stdin comes from a file redirect, the interpreter
	// reads its program (or input) from the file, NOT from the pipe, so even
	// a pipe-shaped prefix on the line must not produce an eval write.
	it('keeps python - < src/script.py unclassified (#1901 stdin redirect)', () => {
		expectNoEvalWrite('python - < src/script.py');
	});

	it('keeps a pipe plus stdin-redirect override unclassified (file wins over pipe)', () => {
		expectNoEvalWrite('echo \'open("x.txt","w")\' | python - < src/script.py');
	});
});

describe('gate: pipe-fed eval vs script-path carve-out (#3474)', () => {
	beforeEach(() => {
		resetSwarmState();
		mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
		writeFileSync(path.join(TEST_DIR, 'src', 'script.py'), 'pass\n');
	});

	// Impl-review r1 F3: a mid-pipe interpreter still executes the piped
	// program (`echo CODE | python | cat`); the classifier checks every
	// position >= 1.
	it("rejects echo 'open(...)' | python | cat (mid-pipe interpreter)", async () => {
		await expect(
			runAsCoder(`echo 'open("../zz-mp.txt","w")' | python | cat`),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	it("rejects echo 'open(...)' | python for a src/-scoped coder", async () => {
		await expect(
			runAsCoder('echo \'open("../zz.txt","w")\' | python'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	it("rejects printf 'open(...)' | python for a src/-scoped coder", async () => {
		await expect(
			runAsCoder('printf \'open("../zz.txt","w")\' | python'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	// Round-2: stdin-consumed spelling through the gate.
	it("rejects echo 'open(...)' | python - for a src/-scoped coder", async () => {
		await expect(
			runAsCoder('echo \'open("a.txt","w")\' | python -'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	// Round-2/3: the SECOND pipe-fed eval of the compound runs after `cd ..`
	// — outside scope src/ — while the FIRST eval alone would be admissible
	// (it runs in src/, in scope). Only the second occurrence causes the
	// rejection, so a post-fix pass proves each occurrence is paired with
	// its own tracked cwd instead of a collapsed first-occurrence decision.
	it('rejects a repeated pipeline whose second eval runs after cd .. (first eval in scope)', async () => {
		await expect(
			runAsCoder(
				'cd src; echo \'open("esc-a.txt","w")\' | python; cd ..; echo \'open("../esc-b.txt","w")\' | python',
			),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	// Round-2 control (green at base AND post-fix): with NO cd, the pipe-fed
	// eval runs at the coder's STARTING directory — inside the declared
	// scope src/ — so it must ADMIT. If the pipe-eval fix ever emits the
	// write without the cd-aware second-walker routing, the eval falls back
	// to the workspace-root directory and this leg blocks — it detects the
	// missing walker emission.
	it("admits cd src && echo 'open(...)' | python (eval dir inside scope)", async () => {
		await expect(
			runAsCoder('cd src && echo \'open("esc6.txt","w")\' | python'),
		).resolves.toBeUndefined();
	});

	// Carve-out CONTROL (preserving): the write-scope gate must not block the
	// #1901 script-path pipe form. Asserting "no WRITE BLOCKED rejection"
	// rather than a bare resolves because a win32 host without the native
	// sandbox runner falls back to the restricted-environment executor, whose
	// wrapper refuses PowerShell-native piped bodies (`cat` is a PS alias)
	// with an unrelated sandbox_wrapper_failure — an environmental veto this
	// check must not inherit. On hosts whose sandbox wraps the command (or
	// has no executor) the command resolves, which also satisfies this.
	it('still admits cat src/script.py | python (#1901 script-path carve-out)', async () => {
		let writeGateBlocked: unknown = null;
		try {
			await runAsCoder('cat src/script.py | python');
		} catch (error) {
			writeGateBlocked = error;
		}
		if (writeGateBlocked !== null) {
			const message =
				writeGateBlocked instanceof Error ? writeGateBlocked.message : '';
			expect(
				/^WRITE BLOCKED: /.test(message),
				'cat src/script.py | python must stay admitted by the write-scope gate ' +
					`(#1901 carve-out); got: ${message.slice(0, 120)}`,
			).toBe(false);
		}
	});
});
