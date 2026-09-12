import { afterAll, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import {
	evaluateScopeValidate,
	ScopeValidationError,
} from '../../../src/tools/scope-validate';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const root = canonicalMkdtemp('scope-validate-2500-');
const target = path.join(root, 'in-root', 'note.md');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, 'before\n');
const powershellTarget = path.join(root, 'safe', 'note.md');
mkdirSync(path.dirname(powershellTarget), { recursive: true });
writeFileSync(powershellTarget, 'before\n');

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('scope_validate (#2500)', () => {
	test('is registered for architect only', () => {
		expect(TOOL_METADATA.scope_validate.agents).toEqual(['architect']);
		expect(TOOL_MANIFEST.scope_validate).toBeDefined();
	});

	test('allows a safe in-scope POSIX write without executing it', () => {
		const result = evaluateScopeValidate(
			{
				command: 'printf after > in-root/note.md',
				shell: 'posix',
				scope_files: ['in-root/note.md'],
			},
			root,
		);
		expect(result.allowed).toBe(true);
		expect(result.targets[0]?.path).toBe('in-root/note.md');
		expect(readFileSync(target, 'utf8')).toBe('before\n');
	});

	test('handles POSIX GREATAND file targets without treating numeric descriptor copies as writes', () => {
		for (const command of [
			'echo x >&in-root/note.md',
			'echo x 2>&in-root/note.md',
		]) {
			const result = evaluateScopeValidate(
				{
					command,
					shell: 'posix',
					scope_files: ['in-root/note.md'],
				},
				root,
			);
			expect(result.allowed).toBe(true);
			expect(result.targets[0]?.path).toBe('in-root/note.md');
		}

		const descriptorCopy = evaluateScopeValidate(
			{
				command: 'echo x 2>&1',
				shell: 'posix',
				scope_files: ['in-root/note.md'],
			},
			root,
		);
		expect(descriptorCopy.targets).toEqual([]);
	});

	test('rejects out-of-scope, malformed, and dynamic POSIX GREATAND targets', () => {
		for (const command of [
			'echo x >&outside.txt',
			'echo x 2>&outside.txt',
			'echo x >&',
			'echo x >&$TARGET',
		]) {
			expect(() =>
				evaluateScopeValidate(
					{
						command,
						shell: 'posix',
						scope_files: ['in-root/note.md'],
					},
					root,
				),
			).toThrow(ScopeValidationError);
		}
	});

	test('rejects traversal, dynamic, destructive, and out-of-scope writes', () => {
		const cases = [
			{
				command: 'printf x > ../outside.txt',
				shell: 'posix' as const,
				scope_files: ['../outside.txt'],
			},
			{
				command: 'printf x > "$TARGET"',
				shell: 'posix' as const,
				scope_files: ['in-root/note.md'],
			},
			{
				command: 'rm -rf in-root',
				shell: 'posix' as const,
				scope_files: ['in-root/note.md'],
			},
			{
				command: 'printf x > outside.txt',
				shell: 'posix' as const,
				scope_files: ['in-root/note.md'],
			},
		];
		for (const input of cases) {
			expect(() => evaluateScopeValidate(input, root)).toThrow(
				ScopeValidationError,
			);
		}
	});

	test('rejects absolute scope entries', () => {
		expect(() =>
			evaluateScopeValidate(
				{
					command: 'printf x > in-root/note.md',
					shell: 'posix',
					scope_files: [path.join(root, 'in-root', 'note.md')],
				},
				root,
			),
		).toThrow(ScopeValidationError);
	});

	test('rejects empty and oversized scope entries', () => {
		for (const scopeFile of ['', 'x'.repeat(4097)]) {
			expect(() =>
				evaluateScopeValidate(
					{
						command: 'printf x > in-root/note.md',
						shell: 'posix',
						scope_files: [scopeFile],
					},
					root,
				),
			).toThrow();
		}
	});

	test('allows representative PowerShell and cmd writes inside scope', () => {
		for (const input of [
			{
				command: 'Copy-Item source.txt safe/note.md',
				shell: 'powershell' as const,
			},
			{ command: 'copy source.txt in-root/note.md', shell: 'cmd' as const },
		]) {
			const result = evaluateScopeValidate(
				{
					...input,
					scope_files: [
						input.shell === 'powershell' ? 'safe/note.md' : 'in-root/note.md',
					],
				},
				root,
			);
			expect(result.allowed).toBe(true);
			expect(result.targets[0]?.path).toBe(
				input.shell === 'powershell' ? 'safe/note.md' : 'in-root/note.md',
			);
		}
	});

	test('handles adjacent, append, and stream PowerShell redirections', () => {
		for (const command of [
			'dir>safe/note.md',
			'Get-Process>>safe/note.md',
			'foo.exe bar 2>safe/note.md',
			'foo.exe bar 2>>safe/note.md',
			'Get-Process>"safe/note.md"',
			"Get-Process>'safe/note.md'",
		]) {
			const result = evaluateScopeValidate(
				{
					command,
					shell: 'powershell',
					scope_files: ['safe/note.md'],
				},
				root,
			);
			expect(result.allowed).toBe(true);
			expect(result.targets[0]?.path).toBe('safe/note.md');
		}

		const descriptorCopy = evaluateScopeValidate(
			{
				command: 'foo.exe 2>&1',
				shell: 'powershell',
				scope_files: ['safe/note.md'],
			},
			root,
		);
		expect(descriptorCopy.targets).toEqual([]);
	});

	test('rejects adjacent, malformed, dynamic, and out-of-scope PowerShell redirections', () => {
		for (const command of [
			'dir>outside.txt',
			'Get-Process>>outside.txt',
			'foo.exe bar 2>outside.txt',
			'foo.exe 2>&outside.txt',
			'Get-Process>',
			'Get-Process>$TARGET',
			'Get-Process>"unterminated',
		]) {
			expect(() =>
				evaluateScopeValidate(
					{
						command,
						shell: 'powershell',
						scope_files: ['safe/note.md'],
					},
					root,
				),
			).toThrow(ScopeValidationError);
		}

		for (const command of [
			"Write-Output 'literal > content'",
			'Write-Output "literal > content"',
		]) {
			const result = evaluateScopeValidate(
				{
					command,
					shell: 'powershell',
					scope_files: ['safe/note.md'],
				},
				root,
			);
			expect(result.targets).toEqual([]);
		}
	});

	test('handles adjacent, append, and descriptor cmd redirections', () => {
		for (const command of [
			'echo x>in-root/note.md',
			'echo x>>in-root/note.md',
			'echo x 1>in-root/note.md',
			'echo x 2>>in-root/note.md',
		]) {
			const result = evaluateScopeValidate(
				{
					command,
					shell: 'cmd',
					scope_files: ['in-root/note.md'],
				},
				root,
			);
			expect(result.allowed).toBe(true);
			expect(result.targets[0]?.path).toBe('in-root/note.md');
		}
	});

	test('handles spaced cmd descriptors and && compounds', () => {
		const descriptor = evaluateScopeValidate(
			{
				command: 'echo x >& 1',
				shell: 'cmd',
				scope_files: ['in-root/note.md'],
			},
			root,
		);
		expect(descriptor.allowed).toBe(true);
		expect(descriptor.targets).toEqual([]);

		const compound = evaluateScopeValidate(
			{
				command: 'echo x>in-root/note.md && echo y>in-root/note.md',
				shell: 'cmd',
				scope_files: ['in-root/note.md'],
			},
			root,
		);
		expect(compound.allowed).toBe(true);
		expect(compound.targets[0]?.path).toBe('in-root/note.md');

		expect(() =>
			evaluateScopeValidate(
				{
					command: 'echo x>in-root/note.md && echo y>outside.txt',
					shell: 'cmd',
					scope_files: ['in-root/note.md'],
				},
				root,
			),
		).toThrow(ScopeValidationError);
	});

	test('rejects unresolved or out-of-scope cmd redirections', () => {
		for (const command of [
			'echo x>outside.txt',
			'echo x>>outside.txt',
			'echo x 1>outside.txt',
			'echo x 2>outside.txt',
			'echo x 2>>outside.txt',
			"echo can't>outside.txt",
			'echo "x>outside.txt',
			'echo x 2>&outside.txt',
			'echo x >',
			'echo x >%TARGET%',
		]) {
			expect(() =>
				evaluateScopeValidate(
					{
						command,
						shell: 'cmd',
						scope_files: ['in-root/note.md'],
					},
					root,
				),
			).toThrow(ScopeValidationError);
		}

		expect(() =>
			evaluateScopeValidate(
				{
					command: 'echo x>in-root/note.md 2>outside.txt',
					shell: 'cmd',
					scope_files: ['in-root/note.md'],
				},
				root,
			),
		).toThrow(ScopeValidationError);

		for (const command of [
			'echo x 2>&1',
			'echo x 1>&2',
			'echo x >& 1',
			'echo x ^>outside.txt',
			'echo "x > outside.txt"',
		]) {
			const result = evaluateScopeValidate(
				{
					command,
					shell: 'cmd',
					scope_files: ['in-root/note.md'],
				},
				root,
			);
			expect(result.targets).toEqual([]);
		}
	});

	test('rejects PowerShell and cmd writes outside the inline scope', () => {
		for (const input of [
			{
				command: 'Copy-Item source.txt outside.md',
				shell: 'powershell' as const,
			},
			{ command: 'copy source.txt outside.md', shell: 'cmd' as const },
		]) {
			expect(() =>
				evaluateScopeValidate(
					{ ...input, scope_files: ['in-root/note.md'] },
					root,
				),
			).toThrow(ScopeValidationError);
		}
	});

	test('keeps the maximum scope validation bounded (F-011)', () => {
		// Before F-011, every scope entry independently canonicalized the root and
		// its ancestors, monopolizing the event loop for the 10,000-entry bound.
		const scopeFiles = Array.from(
			{ length: 10_000 },
			(_, index) => `generated/${index}.md`,
		);
		const startedAt = performance.now();
		const result = evaluateScopeValidate(
			{ command: 'echo ok', shell: 'posix', scope_files: scopeFiles },
			root,
		);

		expect(result.allowed).toBe(true);
		expect(result.targets).toEqual([]);
		expect(performance.now() - startedAt).toBeLessThan(4_000);
	});

	test('rejects symlink or junction escapes when creation is available', () => {
		const outsideRoot = canonicalMkdtemp('scope-validate-2500-outside-');
		const linkPath = path.join(root, 'in-root', 'linked');
		try {
			symlinkSync(
				outsideRoot,
				linkPath,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			expect(() =>
				evaluateScopeValidate(
					{
						command: 'printf x > in-root/linked/note.md',
						shell: 'posix',
						scope_files: ['in-root/linked/note.md'],
					},
					root,
				),
			).toThrow(ScopeValidationError);
		} finally {
			rmSync(linkPath, { recursive: true, force: true });
			rmSync(outsideRoot, { recursive: true, force: true });
		}
	});

	test('rejects protected authority targets even when explicitly scoped', () => {
		expect(() =>
			evaluateScopeValidate(
				{
					command: 'printf x > .git/config',
					shell: 'posix',
					scope_files: ['.git/config'],
				},
				root,
			),
		).toThrow(ScopeValidationError);
	});
});
