import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	canonicalRootKey,
	canonicalRootKeyFresh,
	canonicalRootKeyFreshAsync,
	lexicalRootAliasKey,
	sameProjectRoot,
} from '../../../src/utils/canonical-root';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };

afterEach(() => {
	_internals.realpathSyncNative = originalInternals.realpathSyncNative;
	_internals.realpathSync = originalInternals.realpathSync;
	_internals.lstatSync = originalInternals.lstatSync;
	_internals.platform = originalInternals.platform;
});

describe('canonical project-root identity', () => {
	test('prefers native realpath and folds Windows separators and case', () => {
		let ordinaryCalls = 0;
		_internals.platform = () => 'win32';
		_internals.realpathSyncNative = () => 'C:/Users/Runner/Project';
		_internals.realpathSync = () => {
			ordinaryCalls += 1;
			return 'C:/wrong';
		};

		expect(
			canonicalRootKeyFresh(path.join(canonicalTmpDir(), 'short-name')),
		).toBe('c:\\users\\runner\\project');
		expect(ordinaryCalls).toBe(0);
	});

	test('falls back to ordinary realpath when native resolution fails', () => {
		_internals.platform = () => 'posix';
		_internals.realpathSyncNative = () => {
			throw new Error('native unavailable');
		};
		_internals.realpathSync = () => '/physical/project';

		expect(canonicalRootKeyFresh('missing-alias')).toBe('/physical/project');
	});

	test('falls back lexically when both physical resolutions fail', () => {
		const input = path.join(canonicalTmpDir(), 'missing-root-2474');
		_internals.platform = () => 'posix';
		_internals.realpathSyncNative = () => {
			throw new Error('native unavailable');
		};
		_internals.realpathSync = () => {
			throw new Error('ordinary unavailable');
		};

		expect(canonicalRootKeyFresh(input)).toBe(
			path.posix.normalize(path.resolve(input)),
		);
	});

	test('async fresh key resolves a physical root and normalizes for Windows', async () => {
		const root = canonicalMkdtemp('canonical-root-async-');
		try {
			_internals.platform = () => 'win32';
			const physical = await fs.promises.realpath(root);
			expect(await canonicalRootKeyFreshAsync(root)).toBe(
				path.win32.normalize(physical).toLowerCase(),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('async fresh key falls back to a normalized lexical path', async () => {
		const input = path.join(canonicalTmpDir(), 'missing-root-async-2489');
		_internals.platform = () => 'posix';
		expect(await canonicalRootKeyFreshAsync(input)).toBe(
			path.posix.normalize(path.resolve(input)),
		);
	});

	test('preserves case on POSIX', () => {
		_internals.platform = () => 'posix';
		_internals.realpathSyncNative = () => '/Physical/Case';

		expect(canonicalRootKeyFresh('case-root')).toBe('/Physical/Case');
	});

	test('lexical alias keys never resolve physical links', () => {
		const input = path.join(canonicalTmpDir(), 'Alias', 'Project');
		_internals.platform = () => process.platform;
		_internals.realpathSyncNative = () => {
			throw new Error('lexical alias keys must not consult realpath');
		};
		const resolved = path.resolve(input);
		const expected =
			process.platform === 'win32'
				? path.win32.normalize(resolved).toLowerCase()
				: path.posix.normalize(resolved);
		expect(lexicalRootAliasKey(input)).toBe(expected);
	});

	test('memoized keys stay stable while Fresh observes a retarget', () => {
		const root = path.join(canonicalTmpDir(), 'memo-root-2474');
		let target = '/physical/first';
		_internals.platform = () => 'posix';
		_internals.realpathSyncNative = () => target;

		const memoized = canonicalRootKey(root);
		target = '/physical/second';

		expect(canonicalRootKey(root)).toBe(memoized);
		expect(canonicalRootKeyFresh(root)).toBe('/physical/second');
		expect(sameProjectRoot(root, root)).toBe(true);
	});

	test('sameProjectRoot follows symlink physical identity and distinguishes roots', () => {
		const temp = canonicalMkdtemp('canonical-root-');
		const target = path.join(temp, 'target');
		const alias = path.join(temp, 'alias');
		const other = path.join(temp, 'other');
		fs.mkdirSync(target);
		fs.mkdirSync(other);
		try {
			fs.symlinkSync(target, alias, 'junction');
			expect(sameProjectRoot(target, alias)).toBe(true);
			expect(sameProjectRoot(target, other)).toBe(false);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});
