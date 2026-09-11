import { describe, expect, test } from 'bun:test';
import {
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import {
	evaluateScopeValidate,
	ScopeValidationError,
} from '../../../src/tools/scope-validate';

describe('shell write detector feedback regressions (#2500)', () => {
	test('FB-001: finds writes across PowerShell semicolon and script-block compounds', () => {
		for (const command of [
			'Set-Content allowed.txt x; Set-Content outside.txt y',
			'{ Set-Content outside.txt y }',
		]) {
			const result = detectWindowsWrites(command, 'powershell');
			expect(result.hasWrites).toBe(true);
			expect(result.writes.some((write) => write.path === 'outside.txt')).toBe(
				true,
			);
		}
	});

	test('FB-001: rejects relative writes after a PowerShell directory mutation', () => {
		const result = detectWindowsWrites(
			'Set-Location ..; Set-Content note.txt x',
			'powershell',
		);
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toContainEqual(
			expect.objectContaining({
				operator: 'working-directory mutation',
				path: null,
			}),
		);
	});

	test('FB-001: rejects executable parenthesized PowerShell script blocks', () => {
		const root = process.cwd();
		expect(() =>
			evaluateScopeValidate(
				{
					command: '& ({ Set-Content ../outside.txt -Value x })',
					shell: 'powershell',
					scope_files: ['src'],
				},
				root,
			),
		).toThrow(ScopeValidationError);
	});

	test('FB-002: ignores CMD copy and move switches before selecting the destination', () => {
		for (const command of [
			'copy /Y allowed.txt outside.txt',
			'move /Y allowed.txt outside.txt',
			'copy allowed.txt /Y outside.txt',
		]) {
			const result = detectWindowsWrites(command, 'cmd');
			expect(result.writes).toContainEqual(
				expect.objectContaining({ path: 'outside.txt' }),
			);
		}
	});

	test('FB-003: reports every PowerShell -Path array element', () => {
		const result = detectWindowsWrites(
			'Set-Content -Path "allowed.txt","outside.txt" x',
			'powershell',
		);
		expect(result.writes.map((write) => write.path)).toEqual([
			'allowed.txt',
			'outside.txt',
		]);
	});

	test('FB-004: treats bash -c and eval as unresolved POSIX write effects', () => {
		for (const command of [
			'bash -c "printf x > outside.txt"',
			'eval "printf x > outside.txt"',
		]) {
			const result = detectPosixWrites(command);
			expect(result.hasWrites).toBe(true);
			expect(result.writes).toContainEqual(
				expect.objectContaining({
					category: 'interpreter_eval',
					path: null,
				}),
			);
		}
	});

	test('FB-005: marks tilde and CMD batch-parameter paths unresolved', () => {
		for (const [shell, command] of [
			['posix', 'printf x > ~/outside.txt'],
			['powershell', 'Set-Content ~\\outside.txt x'],
			['cmd', 'echo x > %~dp0\\outside.txt'],
			['cmd', 'echo x > %1\\outside.txt'],
			['cmd', 'echo x > %*\\outside.txt'],
		] as const) {
			const analysis =
				shell === 'posix'
					? detectPosixWrites(command)
					: detectWindowsWrites(command, shell);
			expect(analysis.hasWrites).toBe(true);
			const resolved = resolveWriteTargets(
				'',
				analysis.writes,
				'/workspace/project',
			);
			expect(resolved.some((target) => target.resolved === false)).toBe(true);
		}
	});

	test('FB-006: detects POSIX unlink and rmdir file-system writes', () => {
		for (const [command, path] of [
			['unlink outside.txt', 'outside.txt'],
			['rmdir outside-dir', 'outside-dir'],
		] as const) {
			const result = detectPosixWrites(command);
			expect(result.writes).toContainEqual(
				expect.objectContaining({
					category: 'builtin_write',
					path,
				}),
			);
		}
	});

	test('FB-030: treats encoded PowerShell payloads as unresolved writes', () => {
		for (const command of [
			'powershell -EncodedCommand SQBFAFgA',
			'pwsh -enc SQBFAFgA',
			'powershell.exe -ec SQBFAFgA',
		]) {
			const result = detectWindowsWrites(command, 'powershell');
			expect(result.hasWrites).toBe(true);
			expect(result.writes).toContainEqual(
				expect.objectContaining({
					category: 'interpreter_eval',
					path: null,
				}),
			);
		}
	});

	test('FB-030: treats dynamic PowerShell call operators as unresolved writes', () => {
		for (const command of [
			`powershell -Command "& 'Set-Content' outside.txt x"`,
			`powershell -Command "Invoke-Expression 'Set-Content outside.txt x'"`,
		]) {
			const result = detectWindowsWrites(command, 'powershell');
			expect(result.hasWrites).toBe(true);
			expect(result.writes).toContainEqual(
				expect.objectContaining({
					category: 'interpreter_eval',
					operator: 'dynamic PowerShell invocation',
					path: null,
				}),
			);
		}

		expect(() =>
			evaluateScopeValidate(
				{
					command: `powershell -Command "& 'Set-Content' outside.txt x"`,
					shell: 'powershell',
					scope_files: ['src'],
				},
				process.cwd(),
			),
		).toThrow(ScopeValidationError);
	});

	test('FB-027: rejects NUL, DEL, and other ASCII control bytes in commands', () => {
		for (const control of ['\u0000', '\u007f', '\u0009']) {
			expect(() =>
				evaluateScopeValidate(
					{
						command: `printf x > src/note.md${control}`,
						shell: 'posix',
						scope_files: ['src/note.md'],
					},
					process.cwd(),
				),
			).toThrow(ScopeValidationError);
		}
	});
});
