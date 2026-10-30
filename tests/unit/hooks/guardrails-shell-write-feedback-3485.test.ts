/**
 * PR #3485 feedback-round regression legs (PRR-001..015/018). Each leg pins
 * one review finding's fix: RED at the reviewed head 0cad5d6dd, GREEN after
 * the feedback fixes. Frozen C3/C6 semantics are re-pinned here in their
 * post-fix form (failing-left && shapes block; succeeding chains admit).
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	detectWindowsWrites,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-fb3485-');
const SCOPE_OR_ROOT =
	/^WRITE BLOCKED(?: \[shell-write-scope\])?: (?:SCOPE_VIOLATION|Agent "coder" is not authorised)/;

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
let sessionCounter = 0;

async function runAsCoder(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	const sessionID = `fb3485-${++sessionCounter}`;
	const callID = `call-${++callCounter}`;
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

beforeEach(() => {
	resetSwarmState();
	mkdirSync(path.join(TEST_DIR, 'src', 'sub'), { recursive: true });
	writeFileSync(path.join(TEST_DIR, 'src', 'x.txt'), 'x');
});

afterAll(() => {
	try {
		rmSync(TEST_DIR, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	} catch {
		// Windows EBUSY teardown flake — leftover tmpdirs are harmless.
	}
});

describe('PRR-001: failing-left && cd must not leak into later siblings', () => {
	it('blocks false && cd src; write (skipped cd is not applied to the resolution)', async () => {
		await expect(
			runAsCoder('false && cd src; echo marker > out-a.txt'),
		).rejects.toThrow(SCOPE_OR_ROOT);
	});

	it('blocks nonexistent-dir && cd src; write', async () => {
		await expect(
			runAsCoder('nonexistent_dir_xyz && cd src; echo marker > out-b.txt'),
		).rejects.toThrow(SCOPE_OR_ROOT);
	});

	it('blocks the out-of-workspace landing shape (cd .. && true; false && cd src; write)', async () => {
		await expect(
			runAsCoder('cd .. && true; false && cd src; echo marker > out-c.txt'),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: |^BLOCKED: /);
	});

	it('still admits a succeeding && chain whose target is in scope', async () => {
		await expect(
			runAsCoder('cd src && echo hi > in-scope.txt'),
		).resolves.toBeUndefined();
	});

	it('still blocks the AC3 escape (cd src && cd .. && write at root)', async () => {
		await expect(
			runAsCoder('cd src && cd .. && echo x > escape.txt'),
		).rejects.toThrow(SCOPE_OR_ROOT);
	});
});

describe('PRR-002: Windows interpreter table carries no -m flag (#1902 carve-out)', () => {
	it('does not classify python -m pytest as interpreter_eval under cmd', () => {
		const writes = detectWindowsWrites('python -m pytest', 'cmd').writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(writes).toEqual([]);
	});

	it('does not classify python -m pytest as interpreter_eval under powershell', () => {
		const writes = detectWindowsWrites(
			'python -m pytest',
			'powershell',
		).writes.filter((w) => w.category === 'interpreter_eval');
		expect(writes).toEqual([]);
	});
});

describe('PRR-006: wrapper-prefixed stdin interpreters are classified', () => {
	it('classifies echo x | env python as interpreter_eval (detector)', () => {
		const writes = detectPosixWrites(
			'echo \'open("../zz.txt","w")\' | env python',
		).writes;
		expect(
			writes.some((w) => w.category === 'interpreter_eval'),
			`expected an eval write, got: ${JSON.stringify(writes)}`,
		).toBe(true);
	});

	it('blocks echo x | env python for a src/-scoped coder (gate)', async () => {
		await expect(
			runAsCoder(`echo 'open("../zz-fb.txt","w")' | env python`),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});
});

describe('PRR-009: heredoc stdin overrides the pipe (carve-out restored)', () => {
	it('does not classify echo x | python << EOF as an inline eval (detector)', () => {
		const writes = detectPosixWrites('echo x | python << EOF').writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(writes).toEqual([]);
	});
});

describe('PRR-011: producer redirects exclude the pipeline from stdin-eval classification', () => {
	it('does not classify echo x > f | python as an inline eval (detector)', () => {
		const writes = detectPosixWrites('echo x > f | python').writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(writes).toEqual([]);
	});
});

describe('PRR-012: env with empty-value assignments unwraps', () => {
	it('classifies env FOO= curl -o as network_download (detector)', () => {
		const writes = detectPosixWrites(
			'env FOO= curl -o out http://example.com/x',
		).writes;
		expect(
			writes.some((w) => w.category === 'network_download'),
			`expected a download write, got: ${JSON.stringify(writes)}`,
		).toBe(true);
	});
});

describe('PRR-015: launcher option-table completion + over-block removal', () => {
	it('blocks timeout -sKILL 10 cp outside scope (glued attached-arg short)', async () => {
		await expect(
			runAsCoder('timeout -sKILL 10 cp src/x.txt ../zz1'),
		).rejects.toThrow(SCOPE_OR_ROOT);
	});

	it('blocks timeout infinity cp outside scope (EXT-01)', async () => {
		await expect(
			runAsCoder('timeout infinity cp src/x.txt ../zz2'),
		).rejects.toThrow(SCOPE_OR_ROOT);
	});

	it('blocks timeout --verbose 5 cp outside scope', async () => {
		await expect(
			runAsCoder('timeout --verbose 5 cp src/x.txt ../zz3'),
		).rejects.toThrow(SCOPE_OR_ROOT);
	});

	it('blocks exec -cl cp outside scope (glued cluster)', async () => {
		await expect(runAsCoder('exec -cl cp src/x.txt ../zz4')).rejects.toThrow(
			/^WRITE BLOCKED(?: \[shell-write-scope\])?: /,
		);
	});

	it('blocks command -pp cp outside scope (glued -p cluster)', async () => {
		await expect(runAsCoder('command -pp cp src/x.txt ../zz5')).rejects.toThrow(
			/^WRITE BLOCKED(?: \[shell-write-scope\])?: /,
		);
	});

	it('admits timeout 5M rmdir ../zz (invalid interval — nothing runs)', async () => {
		await expect(runAsCoder('timeout 5M rmdir ../zz')).resolves.toBeUndefined();
	});

	it('admits builtin rm -rf ../zz (not a shell builtin — nothing runs)', async () => {
		await expect(runAsCoder('builtin rm -rf ../zz')).resolves.toBeUndefined();
	});

	it('admits builtin rmdir ../zz (rmdir is NOT a shell builtin — nothing runs)', async () => {
		// PRR-015: bash errors "not a shell builtin" for external commands, so
		// `builtin rmdir` executes nothing and the correct verdict is admit.
		await expect(runAsCoder('builtin rmdir ../zz6')).resolves.toBeUndefined();
	});
});

describe('PRR-018: Windows recognizer completeness', () => {
	it('classifies glued python -ccode under cmd', () => {
		const writes = detectWindowsWrites('python -ccode', 'cmd').writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(writes.length).toBe(1);
	});

	it('classifies py -ccode under cmd (py exists in the POSIX set now too)', () => {
		const writes = detectWindowsWrites('py -ccode', 'cmd').writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(writes.length).toBe(1);
	});
});

describe('EXT-2: parallel-review must-fix shapes (PR comment 6450031840)', () => {
	// M2: an unwrap that consumes a redirect as a launcher option argument
	// must not lose the redirect write — the original analysis's non-artifact
	// writes are unioned back into the gate's analysis.
	it.each([
		['stdbuf -o > ../zz-x2a.txt true'],
		['exec -a > ../zz-x2b.txt true'],
		['timeout -k >../zz-x2c.txt 5 5 echo PAYLOAD'],
		['env -u > ../zz-x2d.txt FOO true'],
	])('blocks a redirect in the option-argument position: %s', async (cmd) => {
		await expect(runAsCoder(cmd)).rejects.toThrow(SCOPE_OR_ROOT);
	});

	// M1: a failed/skipped && branch's cd must not leak into post-chain
	// siblings — closed by the pessimistic dual-context reading.
	it('blocks a skipped && cd leaking into a later ; segment (M1a)', async () => {
		await expect(
			runAsCoder('false && cd src/x; echo x > ../zz-x3.txt'),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});
	it('blocks a failed-left && chain eval (M1c)', async () => {
		await expect(
			runAsCoder(`false && cd src; python3 -c "open('../zz-x4.txt','w')"`),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	// M3: a sibling unwrap must not erase a pipeline's stdin-eval
	// classification (the `[eval stdin]` union).
	it('blocks the pipe-eval control beside an unwrapping sibling (M3a)', async () => {
		await expect(
			runAsCoder(`echo "print(1)" | python; time true`),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	// M7: strtod duration spellings run the wrapped command on real GNU
	// coreutils (`1e3` rc 0, `inf` rc 124, `INF` rc 124) and must unwrap;
	// `nan` is refused (rc 125, nothing runs) and stays an admit.
	it.each([
		['timeout 1e3 cp src/x.txt ../zz-x5.txt'],
		['timeout inf cp src/x.txt ../zz-x6.txt'],
		['timeout INF cp src/x.txt ../zz-x7.txt'],
	])('unwraps strtod duration spellings: %s', async (cmd) => {
		await expect(runAsCoder(cmd)).rejects.toThrow(SCOPE_OR_ROOT);
	});
	it('admits timeout nan (GNU refuses it, rc 125, nothing runs)', async () => {
		await expect(
			runAsCoder('timeout nan rmdir ../zz-x8'),
		).resolves.toBeUndefined();
	});

	// PE-a/PE-b: an unwrap that mangles the inner form must fall back to the
	// original command's parse, not hard-reject a valid idiom.
	it('admits timeout bash -c with a trailing 2>&1 | tail (PE-a)', async () => {
		await expect(
			runAsCoder('timeout 300 bash -c "cd src && ls" 2>&1 | tail -5'),
		).resolves.toBeUndefined();
	});
	it('admits timeout sh -c with trailing 2>&1 (PE-b)', async () => {
		await expect(
			runAsCoder('timeout 10 sh -c "echo hi" 2>&1'),
		).resolves.toBeUndefined();
	});
});
