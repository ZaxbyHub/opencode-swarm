import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { _internals, createSafeTestDir } from '../../helpers/safe-test-dir';

const originalInternals = { ..._internals };

afterEach(() => {
	_internals.realpathSyncNative = originalInternals.realpathSyncNative;
	_internals.realpathSync = originalInternals.realpathSync;
});

describe('safe test directory physical identity', () => {
	test('prefers native realpath and returns a physical directory path', () => {
		let nativeCalls = 0;
		_internals.realpathSyncNative = (target) => {
			nativeCalls += 1;
			return originalInternals.realpathSyncNative(target);
		};

		const fixture = createSafeTestDir('safe-native-identity-');
		try {
			expect(nativeCalls).toBeGreaterThan(1);
			expect(fs.statSync(fixture.dir).isDirectory()).toBe(true);
			expect(fixture.dir.includes('~')).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	test('falls back to ordinary realpath when native resolution fails', () => {
		let ordinaryCalls = 0;
		_internals.realpathSyncNative = () => {
			throw new Error('native unavailable');
		};
		_internals.realpathSync = (target, options) => {
			ordinaryCalls += 1;
			return originalInternals.realpathSync(target, options as never);
		};

		const fixture = createSafeTestDir('safe-ordinary-identity-');
		try {
			expect(ordinaryCalls).toBeGreaterThan(0);
			expect(fs.statSync(fixture.dir).isDirectory()).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});
