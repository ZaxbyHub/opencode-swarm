/**
 * Bare POSIX `rmdir <dir>` is provably non-destructive: rmdir(2) refuses a
 * non-empty directory (ENOTEMPTY), so removing it can never destroy file
 * data. The shell write-scope gate therefore admits a bare, single-target,
 * literal `rmdir` whose target resolves (symlinks included) inside the
 * session workspace even when the target is outside the coder's declared
 * scope. Every other form keeps its current gating: flags (`-p`,
 * `--ignore-fail-on-non-empty`), multiple targets, globs, dynamic targets,
 * targets outside the workspace, symlink escapes, and the Windows recursive
 * forms. The gate performs no emptiness pre-check (that would be a TOCTOU
 * check); the kernel is the safety net, which the last block asserts.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	isEmptyDirectoryRemovalWithinWorkspace,
	isPosixRmdirExecutor,
} from '../../../src/hooks/guardrails/tool-before';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-rmdir-scope-');
const OUTSIDE_DIR = canonicalMkdtemp('guardrails-shell-write-rmdir-outside-');
const isWin32 = process.platform === 'win32';
const SCOPE_VIOLATION =
	/^WRITE BLOCKED \[shell-write-scope\]: SCOPE_VIOLATION: shell write target /;
const ROOT_ESCAPE =
	/^WRITE BLOCKED: Agent "coder" is not authorised to write .*AUTHORITY_ROOT_ESCAPE/;

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

function coderWithScope(sessionID: string, files: string[]): string {
	const callID = `call-${++callCounter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files,
		dispatchCallId: callID,
	});
	return callID;
}

async function runAsCoder(
	sessionID: string,
	command: string,
	tool = 'bash',
): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	const callID = coderWithScope(sessionID, ['src/']);
	await hooks.toolBefore({ tool, sessionID, callID }, { args: { command } });
}

function emptyDir(relative: string): string {
	const absolute = path.join(TEST_DIR, relative);
	mkdirSync(absolute, { recursive: true });
	return absolute;
}

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	rmSync(OUTSIDE_DIR, { recursive: true, force: true });
});

describe('shell write scope: bare rmdir of a workspace directory', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('admits bare rmdir of an out-of-scope directory inside the workspace', async () => {
		emptyDir('.scratch-a/tmp1');
		await expect(
			runAsCoder('rmdir-bare', 'rmdir .scratch-a/tmp1'),
		).resolves.toBeUndefined();
	});

	it('admits bare rmdir of an in-scope directory (unchanged)', async () => {
		emptyDir('src/empty-in-scope');
		await expect(
			runAsCoder('rmdir-in-scope', 'rmdir src/empty-in-scope'),
		).resolves.toBeUndefined();
	});

	it('still checks each rmdir in a sequence independently', async () => {
		emptyDir('.scratch-b/one');
		emptyDir('.scratch-b/two');
		await expect(
			runAsCoder(
				'rmdir-sequence',
				'rmdir .scratch-b/one && rmdir .scratch-b/two',
			),
		).resolves.toBeUndefined();
	});

	it.each([
		['rmdir -p (removes parent components)', 'rmdir -p .scratch-c/a/b'],
		[
			'rmdir with a long option',
			'rmdir --ignore-fail-on-non-empty .scratch-c/a',
		],
		['rmdir with an end-of-options marker', 'rmdir -- .scratch-c/a'],
		['rmdir with several targets', 'rmdir .scratch-c/a .scratch-c/b'],
		['rmdir with a glob target', 'rmdir .scratch-c/*'],
		['rmdir with a brace target', 'rmdir .scratch-c/{a,b}'],
	])('keeps scope gating for %s', async (_label, command) => {
		emptyDir('.scratch-c/a/b');
		emptyDir('.scratch-c/b');
		await expect(
			runAsCoder(`rmdir-gated-${++callCounter}`, command),
		).rejects.toThrow(SCOPE_VIOLATION);
	});

	it('keeps blocking a dynamic rmdir target', async () => {
		await expect(
			runAsCoder('rmdir-dynamic', 'rmdir "$SCRATCH_DIR"'),
		).rejects.toThrow(/BLOCKED: bash\/shell write to a dynamic path target/);
	});

	it('keeps blocking rmdir of a directory outside the workspace', async () => {
		const outside = path.join(OUTSIDE_DIR, 'victim');
		mkdirSync(outside, { recursive: true });
		// Forward slashes: the POSIX parse treats `\` as an escape, so a raw
		// win32 path would name a drive-relative `C:Users...` instead. Which
		// layer refuses depends on the host temp path: a destructive-command
		// guard ("BLOCKED: ...", e.g. its cmd `rmdir /s` heuristic matches any
		// `/s` in the path, or its system-path list) or the shell write gate's
		// file authority ("WRITE BLOCKED: ... AUTHORITY_ROOT_ESCAPE").
		await expect(
			runAsCoder('rmdir-outside', `rmdir ${outside.replace(/\\/g, '/')}`),
		).rejects.toThrow(/^(?:WRITE )?BLOCKED: /);
	});

	it('keeps blocking rmdir that escapes the workspace through a symlink', async () => {
		// The leaf is not named `s...`: an operand containing `/s` trips the
		// destructive guard's cmd `rmdir /s` heuristic first, which would hide
		// that the shell write gate's file authority (canonical containment)
		// refuses the escape; the exemption helper is the second line
		// (isEmptyDirectoryRemovalWithinWorkspace symlink tests below).
		mkdirSync(path.join(OUTSIDE_DIR, 'linked', 'inner'), { recursive: true });
		symlinkSync(
			path.join(OUTSIDE_DIR, 'linked'),
			path.join(TEST_DIR, 'escape-link'),
			isWin32 ? 'junction' : 'dir',
		);
		await expect(
			runAsCoder('rmdir-symlink', 'rmdir escape-link/inner'),
		).rejects.toThrow(ROOT_ESCAPE);
	});

	it('keeps blocking a bare rmdir that a cd moves outside the workspace', async () => {
		await expect(
			runAsCoder(
				'rmdir-cd-escape',
				`cd .. && rmdir ${path.basename(OUTSIDE_DIR)}`,
			),
		).rejects.toThrow(ROOT_ESCAPE);
	});

	it.each([
		['rm -rf', 'rm -rf .scratch-d'],
		['rmdir /s /q', 'rmdir /s /q .scratch-d'],
		['rd /s', 'rd /s .scratch-d'],
	])('keeps blocking the recursive form %s', async (_label, command) => {
		emptyDir('.scratch-d');
		await expect(
			runAsCoder(`rmdir-recursive-${++callCounter}`, command),
		).rejects.toThrow(/^BLOCKED: Recursive delete target /);
	});
});

describe.skipIf(isWin32)(
	'bare rmdir: kernel outcome after the gate admits it',
	() => {
		beforeEach(() => {
			resetSwarmState();
		});

		function hostRmdir(relative: string) {
			return spawnSync('rmdir', [relative], {
				cwd: TEST_DIR,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 5_000,
				encoding: 'utf8',
			});
		}

		it('removes an empty out-of-scope directory', async () => {
			const target = emptyDir('.scratch-e/empty');
			await expect(
				runAsCoder('rmdir-kernel-empty', 'rmdir .scratch-e/empty'),
			).resolves.toBeUndefined();
			const result = hostRmdir('.scratch-e/empty');
			expect(result.status).toBe(0);
			expect(existsSync(target)).toBe(false);
		});

		it('leaves a non-empty directory and its contents in place', async () => {
			const target = emptyDir('.scratch-e/full');
			const kept = path.join(target, 'keep.txt');
			writeFileSync(kept, 'data');
			await expect(
				runAsCoder('rmdir-kernel-full', 'rmdir .scratch-e/full'),
			).resolves.toBeUndefined();
			const result = hostRmdir('.scratch-e/full');
			expect(result.status).not.toBe(0);
			expect(existsSync(kept)).toBe(true);
		});
	},
);

describe('isEmptyDirectoryRemovalWithinWorkspace', () => {
	it('accepts an existing or missing directory strictly inside the root', () => {
		emptyDir('.scratch-f/present');
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('.scratch-f/present', TEST_DIR),
		).toBe(true);
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('.scratch-f/missing', TEST_DIR),
		).toBe(true);
	});

	it('rejects the workspace root, an outside path, and a missing parent', () => {
		expect(isEmptyDirectoryRemovalWithinWorkspace('.', TEST_DIR)).toBe(false);
		expect(isEmptyDirectoryRemovalWithinWorkspace(OUTSIDE_DIR, TEST_DIR)).toBe(
			false,
		);
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('no-such/child', TEST_DIR),
		).toBe(false);
	});

	it('rejects a target whose parent chain escapes through a symlink', () => {
		mkdirSync(path.join(OUTSIDE_DIR, 'helper-linked', 'sub'), {
			recursive: true,
		});
		symlinkSync(
			path.join(OUTSIDE_DIR, 'helper-linked'),
			path.join(TEST_DIR, 'helper-escape'),
			isWin32 ? 'junction' : 'dir',
		);
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('helper-escape/sub', TEST_DIR),
		).toBe(false);
	});
});

/**
 * `/swarm guardrail explain` has no tool or platform flag: it evaluates the
 * command as the `shell` tool. Off Windows that is a POSIX executor, so it
 * mirrors the live gate; on a Windows host the `shell` tool is not POSIX, so
 * explain conservatively blocks a bare rmdir that the live `bash` tool admits.
 */
describe('guardrail explain parity for bare rmdir', () => {
	const explainRmdir = (...operands: string[]) =>
		handleGuardrailExplain(TEST_DIR, [
			'--agent',
			'coder',
			'--scope',
			'src',
			'rmdir',
			...operands,
		]);

	it.skipIf(isWin32)(
		'explains a bare out-of-scope rmdir as allowed and rmdir -p as blocked',
		async () => {
			emptyDir('.scratch-g/tmp1');
			expect(await explainRmdir('.scratch-g/tmp1')).toMatch(
				/\| *Decision *\| *allow */i,
			);
			const parents = await explainRmdir('-p', '.scratch-g/tmp1');
			expect(parents).toMatch(/\| *Decision *\| *block */i);
			expect(parents).toContain('scope_violation');
		},
	);

	it.skipIf(!isWin32)(
		'on a Windows host explains a bare out-of-scope rmdir as blocked (shell tool)',
		async () => {
			emptyDir('.scratch-g/tmp2');
			const bare = await explainRmdir('.scratch-g/tmp2');
			expect(bare).toMatch(/\| *Decision *\| *block */i);
			expect(bare).toContain('scope_violation');
		},
	);
});

/**
 * The exemption rests on POSIX rmdir(2) semantics. Under PowerShell `rmdir`
 * is an alias of Remove-Item (it deletes a FILE operand and can recurse), and
 * cmd's `rd` differs too, so a Windows executor never earns it. A target that
 * exists as a file or symlink also falls back to the normal scope check.
 */
describe('bare rmdir exemption: POSIX executor and real directory only', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each([
		['bash', 'powershell -Command "rmdir .scratch-h/x"'],
		['bash', 'pwsh -c "rmdir .scratch-h/x"'],
		['bash', 'cmd /c rmdir .scratch-h/x'],
		['bash', 'Get-ChildItem .scratch-h | Out-Null; rmdir .scratch-h/x'],
		['shell', 'powershell -Command "rmdir .scratch-h/x"'],
		['shell', 'Get-ChildItem .scratch-h | Out-Null; rmdir .scratch-h/x'],
	])('keeps scope gating under a Windows executor (%s: %s)', async (tool, command) => {
		emptyDir('.scratch-h/x');
		await expect(
			runAsCoder(`rmdir-windows-${++callCounter}`, command, tool),
		).rejects.toThrow(SCOPE_VIOLATION);
	});

	it('keeps scope gating for a file operand named like a directory', async () => {
		emptyDir('.scratch-i');
		writeFileSync(path.join(TEST_DIR, '.scratch-i', 'looks-like-dir'), 'data');
		await expect(
			runAsCoder('rmdir-file-operand', 'rmdir .scratch-i/looks-like-dir'),
		).rejects.toThrow(SCOPE_VIOLATION);
	});

	it('keeps scope gating for a symlink to a directory inside the workspace', async () => {
		emptyDir('.scratch-i/real');
		symlinkSync(
			path.join(TEST_DIR, '.scratch-i', 'real'),
			path.join(TEST_DIR, '.scratch-i', 'link'),
			isWin32 ? 'junction' : 'dir',
		);
		await expect(
			runAsCoder('rmdir-symlink-operand', 'rmdir .scratch-i/link'),
		).rejects.toThrow(SCOPE_VIOLATION);
	});

	it('helper rejects a file or symlink target', () => {
		emptyDir('.scratch-j/real');
		writeFileSync(path.join(TEST_DIR, '.scratch-j', 'file'), 'data');
		symlinkSync(
			path.join(TEST_DIR, '.scratch-j', 'real'),
			path.join(TEST_DIR, '.scratch-j', 'link'),
			isWin32 ? 'junction' : 'dir',
		);
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('.scratch-j/file', TEST_DIR),
		).toBe(false);
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('.scratch-j/link', TEST_DIR),
		).toBe(false);
		expect(
			isEmptyDirectoryRemovalWithinWorkspace('.scratch-j/real', TEST_DIR),
		).toBe(true);
	});

	it('executor predicate admits only a POSIX executor', () => {
		expect(isPosixRmdirExecutor('bash', null, 'rmdir a', 'linux')).toBe(true);
		expect(isPosixRmdirExecutor('shell', null, 'rmdir a', 'darwin')).toBe(true);
		expect(isPosixRmdirExecutor('bash', null, 'rmdir a', 'win32')).toBe(true);
		expect(isPosixRmdirExecutor('shell', null, 'rmdir a', 'win32')).toBe(false);
		expect(isPosixRmdirExecutor('bash', 'powershell', 'rmdir a', 'linux')).toBe(
			false,
		);
		expect(isPosixRmdirExecutor('bash', 'cmd', 'rmdir a', 'linux')).toBe(false);
		expect(
			isPosixRmdirExecutor(
				'bash',
				null,
				'powershell -Command "rmdir a"',
				'linux',
			),
		).toBe(false);
		expect(isPosixRmdirExecutor('bash', null, 'cmd /c rmdir a', 'linux')).toBe(
			false,
		);
		expect(
			isPosixRmdirExecutor('bash', null, 'cmd /d /s /c rmdir a', 'linux'),
		).toBe(false);
	});

	it('explain blocks a PowerShell-wrapped rmdir like the gate', async () => {
		emptyDir('.scratch-k/x');
		const wrapped = await handleGuardrailExplain(TEST_DIR, [
			'--agent',
			'coder',
			'--scope',
			'src',
			'powershell',
			'-Command',
			'"rmdir',
			'.scratch-k/x"',
		]);
		expect(wrapped).toMatch(/\| *Decision *\| *block */i);
	});
});
