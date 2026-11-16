/**
 * Issue #3323 (PR #3326 review follow-up): pins the inputs the shell-tool
 * grammar resolver and the cmd `>&<descriptor>` scanner actually receive in
 * production — real `detectShellType()` outputs, wrapper declaration spellings,
 * and descriptor token shapes around the `;` boundary.
 * @jest-environment node
 */

import { describe, expect, it } from 'bun:test';
import { resolveWindowsWriteAuthority } from '../../../src/hooks/guardrails/tool-before';
import { detectWindowsWrites } from '../../../src/hooks/shell-write-detect';

const PLATFORMS: NodeJS.Platform[] = ['win32', 'linux', 'darwin'];

describe('resolveWindowsWriteAuthority — real detector output values', () => {
	// detectShellType() never returns 'posix'; its POSIX-ish outputs are
	// 'bash' and 'unix'. Neither may inherit a Windows grammar for any tool.
	it('never inherits a Windows grammar for detected bash/unix (any tool, any platform)', () => {
		for (const platform of PLATFORMS) {
			for (const tool of ['bash', 'shell', 'other']) {
				for (const detected of ['bash', 'unix'] as const) {
					expect(
						resolveWindowsWriteAuthority(
							tool,
							'ls -la',
							detected,
							false,
							platform,
						),
					).toBeNull();
				}
			}
		}
	});
});

describe('resolveWindowsWriteAuthority — wrapper declaration inputs', () => {
	const call = (command: string) =>
		resolveWindowsWriteAuthority('bash', command, 'bash', false, 'linux');

	it.each([
		['CMD /C copy a ..\\b', 'cmd'],
		['cmd.exe /c copy a ..\\b', 'cmd'],
		['CMD.EXE /D /S /C copy a ..\\b', 'cmd'],
		['cmd /d /s /c copy a ..\\b', 'cmd'],
		['echo hi; cmd /c copy a ..\\b', 'cmd'],
		['echo hi | cmd /c copy a ..\\b', 'cmd'],
		['POWERSHELL -Command "copy a b"', 'powershell'],
		['echo hi; PowerShell -Command x', 'powershell'],
		['PWSH -NoProfile -Command "copy a b"', 'powershell'],
		['pwsh.exe -NoProfile -Command x', 'powershell'],
		['echo a | pwsh -File x.ps1', 'powershell'],
		['echo a | PowerShell -File x.ps1', 'powershell'],
	])('declares %s', (command, expected) => {
		expect(call(command)).toBe(expected as 'cmd' | 'powershell');
	});

	it.each([
		['echo cmd /c copy a ..\\b'],
		['echo powershell -foo > out.txt'],
		['echo pwsh -foo > out.txt'],
	])('does not declare %s', (command) => {
		expect(call(command)).toBeNull();
	});

	// #3572 review N-28 re-pin: the F-4 MSYS-parity widening INTENTIONALLY
	// declares `cmd /k <payload>` (commit 40f4a3704 — cmd /k RUNS the
	// payload, so the win32 authority must claim it). The escaping copy
	// payload denies fail-closed at the gate (parse-fail on the merged
	// walk) — the security property the old base-false pin incidentally
	// co-held; the declaration itself is now true.
	it('declares cmd /k copy a ..\\b (F-4 widening, intent re-pin)', () => {
		expect(call('cmd /k copy a ..\\b')).not.toBeNull();
		expect(call('cmd //k copy a ..\\b')).not.toBeNull();
	});
});

describe('cmd redirect scanner — >&<descriptor> token', () => {
	const writes = (command: string) =>
		detectWindowsWrites(command, 'cmd').writes;

	it.each([
		'echo x >&1',
		'echo x 2>&1',
		'echo x >&3',
		'echo x >&0;echo y',
		'echo x >&12; echo y',
		'echo x >&007;echo y',
		'echo x >& 1; echo y',
		'echo x >&9 | more',
		'(echo x >&1)',
		// Whitespace and an opening paren also end the descriptor token.
		'echo x >&1 y',
		'echo x >&1 2>&1',
		'echo x >&1(',
		// Every whitespace flavor ends the token (the class is `\s`, not a space).
		// A leading `(` stops the PowerShell scanner from masking the difference.
		'(echo x >&1\necho y',
		'(echo x >&1\r\necho y',
		// Whitespace between the operator, `&` and the digits; `&` / `|` as the
		// terminator. The leading `(` defeats the pre-split and the PS scanner.
		'(echo x >&\n1',
		'(echo x >&\r\n1',
		'(echo x >\n&1',
		'(echo x >\r&1',
		'(echo x >&1&echo y',
		'(echo x >&1|more',
		'(echo x >&1 echo y',
	])('treats %s as pure duplication', (command) => {
		expect(writes(command)).toEqual([]);
	});

	it.each([
		'echo x >&',
		'echo x >&;echo y',
		'echo x >& ; echo y',
		'echo x >&-',
		'echo x >&-;echo y',
		'echo x >&)',
		'echo x >&1x',
		'echo x >&1.5',
		'echo x >&1,y',
		// Inside a cmd wrapper the PowerShell scanner cannot report this, so only
		// the cmd boundary class (which must NOT include a comma) keeps it closed.
		'cmd /c "echo x >&1, echo y"',
		'echo x >&1:y',
		'echo x >&1"y"',
		'echo x >&1<y',
	])('fails closed (null write) on %s', (command) => {
		const w = writes(command);
		expect(w.length).toBeGreaterThanOrEqual(1);
		expect(w[0]?.path).toBeNull();
	});

	it('resumes scanning after a fail-closed descriptor without corrupting quote state', () => {
		// The unresolved `>&"y>z"` token must be consumed exactly once: advancing
		// the scan index past the quote would flip the double-quote state and
		// surface a spurious second write for the quoted `>z"` text.
		const w = writes('echo x >&"y>z"');
		expect(w).toHaveLength(1);
		expect(w[0]?.path).toBeNull();
	});

	it('keeps the fail-closed null write for a bare `>&` after a caret-escaped redirect', () => {
		// The caret-escaped `>` is reported as a literal `^` path; the bare `>&`
		// with no descriptor must still surface its own unresolved write, in order.
		expect(writes('echo x>^>&').map((w) => [w.operator, w.path])).toEqual([
			['>', '^'],
			['>', null],
		]);
		expect(
			writes('echo x>^>&;echo y > o').map((w) => [w.operator, w.path]),
		).toEqual([
			['>', '^'],
			['>', 'o'],
			['>', null],
		]);
	});

	it('keeps the boundary check load-bearing for a digit-led descriptor token', () => {
		// `>&1echo` is not a descriptor duplication (no boundary after the digit).
		// The PowerShell scanner in the union masks this for plain input, but after
		// a caret-escaped redirect only the cmd branch can surface the null write.
		const w = writes('>^>&1echo x');
		expect(w.some((entry) => entry.path === null)).toBe(true);
		expect(w.map((entry) => entry.path)).toEqual(['^', null]);
	});

	it('reports a fail-closed append descriptor exactly once', () => {
		// Without advancing past the `&`, the trailing `>` would be re-read as a
		// second operator.
		expect(writes('echo x >>&')).toEqual([
			{ category: 'redirect', operator: '>>', path: null },
		]);
	});

	it('does not swallow a real redirect glued to the descriptor', () => {
		expect(writes('echo x >&1>out.txt').map((w) => w.path)).toEqual([
			null,
			'out.txt',
		]);
	});
});
