/**
 * Issue #3099 — defect-class regression rows.
 *
 * These live OUTSIDE the frozen acceptance checks on purpose: every file pinned
 * in `.agents/issue-traces/3099-readonly-gate-classification/repro/checkpoint.manifest`
 * is read-only for the whole of implementation, because its blob is what the
 * published anchor receipt attests to.
 *
 * What they cover is the shapes a naive fix would newly admit, plus the
 * redirect-preservation constraint the clause recursion has to honour.
 */
import { describe, expect, it } from 'bun:test';
import {
	detectPosixWrites,
	detectWindowsWrites,
	isPowerShellReadOnlyPipeline,
	isPowerShellShaped,
} from '../../../../src/hooks/shell-write-detect';

const writes = (command: string) => detectPosixWrites(command).writes;

describe('#3099 — shell-write clause recursion and shape classification', () => {
	// ------------------------------------------------------------------
	// R1e: a `cp` inside a control-flow body was never visited, so it
	// reported no write at all.
	// ------------------------------------------------------------------
	const CLAUSE_BODY_WRITES: Array<[string, string]> = [
		['if/then', 'if [ -f a.md ]; then cp a.md OUTSIDE.md; fi'],
		['until/do', 'until [ -f x ]; do cp a.md OUTSIDE.md; done'],
		['while/do', 'while [ -f x ]; do cp a.md OUTSIDE.md; done'],
		['for/do', 'for i in a b; do cp a.md OUTSIDE.md; done'],
		['function body', 'f() { cp a.md OUTSIDE.md; }'],
	];

	for (const [label, command] of CLAUSE_BODY_WRITES) {
		it(`detects a write inside a ${label} body`, () => {
			const found = writes(command);
			expect(found.some((write) => write.path === 'OUTSIDE.md')).toBe(true);
		});
	}

	// ------------------------------------------------------------------
	// R1e no-regression: the compound node's OWN redirections must stay
	// visible. Recursing without pushing the node would drop this.
	// ------------------------------------------------------------------
	it('keeps detecting a redirect applied to a compound statement', () => {
		const found = writes('if a; then echo x; fi > OUT.md');
		expect(found.some((write) => write.path === 'OUT.md')).toBe(true);
	});

	// ------------------------------------------------------------------
	// R1c: the shape predicate opens the Windows detector. It must fire on
	// PowerShell cmdlets and NOT on ordinary POSIX input, or the union
	// would either miss PowerShell writes or re-scan every POSIX command.
	// ------------------------------------------------------------------
	it.each([
		[
			'PowerShell read pipeline',
			'Get-Content a.md | Where-Object { $_ }',
			true,
		],
		[
			'PowerShell write pipeline',
			'Get-Content a.md | Set-Content OUT.md',
			true,
		],
		['New-Item', 'New-Item -ItemType Directory OUT_DIR', true],
		['POSIX set/cp', 'set -e && cp a.md OUTSIDE.md', false],
		['POSIX echo/sed', 'echo ok && sed -i "s/a/b/" f', false],
		['POSIX redirect', 'cat a.md > OUT.md', false],
	])('isPowerShellShaped(%s) is %s', (_label, command, expected) => {
		expect(isPowerShellShaped(command as string)).toBe(expected as boolean);
	});

	// ------------------------------------------------------------------
	// R3: New-Item target resolution. A dedicated matcher, because the
	// shared last-positional heuristic resolves an in-scope decoy.
	// ------------------------------------------------------------------
	it.each([
		['positional target', 'New-Item -ItemType Directory OUT_DIR', 'OUT_DIR'],
		[
			'-Path target',
			'New-Item -Path ../OUTSIDE.md -ItemType File',
			'../OUTSIDE.md',
		],
		[
			'-Path and -Name compose',
			'New-Item -Path src -Name ../OUTSIDE.md',
			'src/../OUTSIDE.md',
		],
		[
			'-Name and -Path compose in either order',
			'New-Item -Name ../OUTSIDE.md -Path src',
			'src/../OUTSIDE.md',
		],
	])('resolves New-Item %s', (_label, command, expected) => {
		const found = detectWindowsWrites(command as string, 'powershell').writes;
		expect(found.some((write) => write.operator === 'New-Item')).toBe(true);
		expect(found.some((write) => write.path === expected)).toBe(true);
	});

	// ------------------------------------------------------------------
	// R2: the read-only predicate is fail-closed. It must not admit a
	// command that carries a write token from ANY family, nor one whose
	// quoting is unbalanced.
	// ------------------------------------------------------------------
	it.each([
		['a PowerShell write cmdlet', 'Get-Content a.md | Set-Content OUT.md'],
		[
			'an assignment-prefixed write',
			'Get-Content a.md | ForEach-Object { $x = Set-Content OUT.md $_ }',
		],
		[
			'a POSIX write alias in a script block',
			'Get-Content a.md | Where-Object { cp a.md OUTSIDE.md }',
		],
		['an unbalanced quote', "Get-Content a.md | Where-Object { $_ '"],
		['an unbalanced brace', 'Get-Content a.md | Where-Object { $_'],
	])('isPowerShellReadOnlyPipeline rejects %s', (_label, command) => {
		expect(isPowerShellReadOnlyPipeline(command as string)).toBe(false);
	});

	it('isPowerShellReadOnlyPipeline admits a genuine read-only pipeline', () => {
		expect(
			isPowerShellReadOnlyPipeline(
				'Get-Content a.md | Where-Object { $_.Length -gt 5 }',
			),
		).toBe(true);
	});
});
