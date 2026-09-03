import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	canonicalExistingFilesystemPath,
	canonicalPathForFutureIo,
	canonicalPathFromExistingAncestor,
	sameExistingFilesystemPath,
} from '../../../src/utils/filesystem-identity';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };

afterEach(() => {
	_internals.realpathSyncNative = originalInternals.realpathSyncNative;
	_internals.realpathSync = originalInternals.realpathSync;
	_internals.lstatSync = originalInternals.lstatSync;
	_internals.platform = originalInternals.platform;
});

describe('existing filesystem identity', () => {
	test('uses native resolution before ordinary realpath and expands aliases', () => {
		_internals.platform = () => 'win32';
		_internals.realpathSyncNative = () => 'C:\\Users\\Long\\Project';
		_internals.realpathSync = () => {
			throw new Error('ordinary should not run');
		};

		expect(canonicalExistingFilesystemPath('short-alias')).toBe(
			'c:/users/long/project',
		);
	});

	test('falls back to ordinary realpath after native failure', () => {
		_internals.platform = () => 'posix';
		_internals.realpathSyncNative = () => {
			throw new Error('native unavailable');
		};
		_internals.realpathSync = () => '/physical/project';

		expect(canonicalExistingFilesystemPath('alias')).toBe('/physical/project');
	});

	test('fails closed when either entry cannot resolve', () => {
		_internals.realpathSyncNative = () => {
			throw new Error('native unavailable');
		};
		_internals.realpathSync = () => {
			throw new Error('ordinary unavailable');
		};

		expect(canonicalExistingFilesystemPath('missing')).toBeNull();
		expect(sameExistingFilesystemPath('missing-a', 'missing-b')).toBe(false);
	});

	test('fails closed for malformed runtime path values', () => {
		expect(canonicalExistingFilesystemPath(12345 as never)).toBeNull();
		expect(sameExistingFilesystemPath({} as never, 'missing')).toBe(false);
	});

	test('compares physical symlink identity but not distinct roots', () => {
		if (process.platform === 'win32') return;
		const temp = canonicalMkdtemp('filesystem-identity-');
		const target = path.join(temp, 'target.txt');
		const alias = path.join(temp, 'alias.txt');
		const other = path.join(temp, 'other.txt');
		fs.writeFileSync(target, 'target');
		fs.writeFileSync(other, 'other');
		fs.symlinkSync(target, alias);
		try {
			expect(sameExistingFilesystemPath(target, alias)).toBe(true);
			expect(sameExistingFilesystemPath(target, other)).toBe(false);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});

	test('keeps POSIX case-sensitive identities distinct', () => {
		_internals.platform = () => 'posix';
		_internals.realpathSyncNative = (entry) => String(entry);

		expect(sameExistingFilesystemPath('/Physical/Case', '/physical/case')).toBe(
			false,
		);
	});

	test('folds Windows case and slash spellings', () => {
		_internals.platform = () => 'win32';
		_internals.realpathSyncNative = (entry) =>
			String(entry).replaceAll('\\', '/');

		expect(
			sameExistingFilesystemPath(
				'C:/Users/Runner/Project',
				'c:\\users\\runner\\project',
			),
		).toBe(true);
	});

	test('pins a missing suffix beneath its nearest physical alias target', () => {
		const holder = canonicalMkdtemp('filesystem-identity-missing-');
		const target = canonicalMkdtemp('filesystem-identity-target-');
		const alias = path.join(holder, 'alias');
		fs.symlinkSync(
			target,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		try {
			const canonicalTarget = canonicalExistingFilesystemPath(target);
			expect(canonicalTarget).not.toBeNull();
			const result = canonicalPathFromExistingAncestor(
				path.join(alias, 'missing', 'child'),
			);
			expect(result?.canonicalPath.toLowerCase()).toBe(
				path
					.join(canonicalTarget!, 'missing', 'child')
					.replaceAll('\\', '/')
					.toLowerCase(),
			);
			expect(result?.existingAncestor.toLowerCase()).toBe(alias.toLowerCase());
			expect(result?.existingAncestorIsLink).toBe(true);
			expect(
				canonicalPathForFutureIo(
					path.join(alias, 'missing', 'child'),
				).toLowerCase(),
			).toBe(
				path
					.join(canonicalTarget!, 'missing', 'child')
					.replaceAll('\\', '/')
					.toLowerCase(),
			);
		} finally {
			fs.rmSync(alias, { recursive: true, force: true });
			fs.rmSync(holder, { recursive: true, force: true });
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	test('future I/O identity fails closed when no physical witness resolves', () => {
		_internals.realpathSyncNative = () => {
			throw new Error('EACCES');
		};
		_internals.realpathSync = () => {
			throw new Error('EACCES');
		};

		expect(canonicalPathForFutureIo('unresolved-alias')).toBeNull();
	});

	test('does not climb past an existing root whose realpath is denied', () => {
		const directory = canonicalMkdtemp('filesystem-identity-denied-');
		const denied = path.resolve(directory).toLowerCase();
		_internals.realpathSyncNative = (entry) => {
			if (path.resolve(String(entry)).toLowerCase() === denied) {
				throw Object.assign(new Error('denied'), { code: 'EACCES' });
			}
			return originalInternals.realpathSyncNative(entry);
		};
		_internals.realpathSync = ((entry) => {
			if (path.resolve(String(entry)).toLowerCase() === denied) {
				throw Object.assign(new Error('denied'), { code: 'EACCES' });
			}
			return originalInternals.realpathSync(entry);
		}) as typeof fs.realpathSync;
		try {
			expect(canonicalExistingFilesystemPath(directory)).toBeNull();
			expect(canonicalPathFromExistingAncestor(directory)).toBeNull();
			expect(canonicalPathForFutureIo(directory)).toBeNull();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
