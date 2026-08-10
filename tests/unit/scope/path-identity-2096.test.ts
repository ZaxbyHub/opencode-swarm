import { describe, expect, test } from 'bun:test';
import {
	isOnDifferentPathRoot,
	isPathIdentityWithin,
	isPathWithinDeclaredScope,
	normalizePathIdentity,
	pathIdentitiesEqual,
	sanitizeDiagnosticText,
	unsafePathTextReason,
} from '../../../src/scope/path-identity';

describe('issue #2096 platform-aware path identity', () => {
	test('Windows drive case and separators share identity', () => {
		expect(
			pathIdentitiesEqual('c:/Repo/src/A.ts', 'C:\\repo\\SRC\\a.TS', 'win32'),
		).toBe(true);
		expect(isOnDifferentPathRoot('c:\\repo\\a', 'C:\\repo', 'win32')).toBe(
			false,
		);
	});

	test('Windows drive, UNC, and extended roots stay distinct', () => {
		expect(isOnDifferentPathRoot('D:\\repo\\a', 'C:\\repo', 'win32')).toBe(
			true,
		);
		expect(
			isOnDifferentPathRoot(
				'\\\\server\\share\\repo\\a',
				'\\\\SERVER\\SHARE\\repo',
				'win32',
			),
		).toBe(false);
		expect(
			isOnDifferentPathRoot(
				'\\\\server\\other\\repo\\a',
				'\\\\server\\share\\repo',
				'win32',
			),
		).toBe(true);
		expect(
			isOnDifferentPathRoot('\\\\?\\c:\\repo\\a', '\\\\?\\C:\\repo', 'win32'),
		).toBe(false);
	});

	test('Windows containment case-folds while POSIX preserves case', () => {
		expect(
			isPathIdentityWithin('C:\\Repo\\SRC\\a.ts', 'c:\\repo\\src', 'win32'),
		).toBe(true);
		expect(isPathIdentityWithin('/repo/SRC/a.ts', '/repo/src', 'posix')).toBe(
			false,
		);
		expect(pathIdentitiesEqual('/repo/A.ts', '/repo/a.ts', 'posix')).toBe(
			false,
		);
		expect(normalizePathIdentity('/repo/A.ts', 'posix')).toBe('/repo/A.ts');
	});

	test('containment rejects sibling-prefix confusion', () => {
		expect(isPathIdentityWithin('/repo/src2/a.ts', '/repo/src', 'posix')).toBe(
			false,
		);
	});

	test('declared-scope resolution shares canonical platform identity (FB-009)', () => {
		expect(
			isPathWithinDeclaredScope(
				'C:\\Repo\\SRC\\a.ts',
				['c:/repo/src'],
				'C:\\Repo',
				'win32',
			),
		).toBe(true);
		expect(
			isPathWithinDeclaredScope(
				'/repo/SRC/a.ts',
				['/repo/src'],
				'/repo',
				'posix',
			),
		).toBe(false);
		expect(
			isPathWithinDeclaredScope(
				'/repo/src2/a.ts',
				['/repo/src'],
				'/repo',
				'posix',
			),
		).toBe(false);
	});

	test('control and bidi text are rejected and rendered safely', () => {
		expect(unsafePathTextReason('src/a\n.ts')).toContain('control');
		expect(unsafePathTextReason('src/\u202efile.ts')).toContain(
			'bidirectional',
		);
		const rendered = sanitizeDiagnosticText('a\n\u202eb', 20);
		expect(rendered).toBe('a??b');
	});
});
