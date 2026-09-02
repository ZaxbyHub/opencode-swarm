/**
 * Canonical project identity for the swarm.db connection cache (issue #2480).
 *
 * Platform-correct expectations: Windows folds case (one key per real root);
 * POSIX keeps case significant (different roots stay isolated).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	canonicalProjectKey,
} from '../../../src/db/canonical-project.js';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir';

const IS_WIN = process.platform === 'win32';

function tmp(name: string): string {
	return canonicalMkdtemp('canonical-${name}-');
}

describe('canonicalProjectKey', () => {
	const realRealpath = _internals.realpathSync;
	afterEach(() => {
		_internals.realpathSync = realRealpath;
	});

	test('collapses trailing-separator and . segments into one key', () => {
		const dir = tmp('sep');
		const a = canonicalProjectKey(dir);
		expect(canonicalProjectKey(`${dir}/./`)).toBe(a);
		expect(canonicalProjectKey(path.join(dir, 'sub', '..'))).toBe(a);
		rmSync(dir, { recursive: true, force: true });
	});

	test('folds case variants into one key on case-insensitive roots; distinct otherwise', () => {
		const dir = tmp('case');
		const upper = dir.toUpperCase();
		// On a case-INSENSITIVE filesystem (win32, macOS default APFS) the
		// uppercase spelling resolves to the SAME root → one key. On a
		// case-SENSITIVE one (Linux) it is a distinct (nonexistent) root.
		const caseInsensitive = IS_WIN || existsSync(upper);
		if (caseInsensitive) {
			expect(canonicalProjectKey(dir)).toBe(canonicalProjectKey(upper));
		} else {
			expect(canonicalProjectKey(dir)).not.toBe(canonicalProjectKey(upper));
		}
		rmSync(dir, { recursive: true, force: true });
	});

	test('a symlink to the same directory maps to one key', () => {
		withFrozenClock(() => {});
		const dir = tmp('link');
		const linkPath = path.join(
			canonicalTmpDir(),
			`canonical-link-${Date.now()}`,
		);
		let linked = false;
		try {
			try {
				symlinkSync(dir, linkPath);
				linked = true;
			} catch {
				// Windows without developer mode: EPERM. The realpath-collapse
				// behavior itself is covered on CI's linux/macos legs.
			}
			if (linked) {
				expect(canonicalProjectKey(linkPath)).toBe(canonicalProjectKey(dir));
			}
		} finally {
			try {
				rmSync(linkPath, { force: true });
			} catch {
				/* best effort */
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('distinct roots stay isolated', () => {
		const a = tmp('iso-a');
		const b = tmp('iso-b');
		expect(canonicalProjectKey(a)).not.toBe(canonicalProjectKey(b));
		rmSync(a, { recursive: true, force: true });
		rmSync(b, { recursive: true, force: true });
	});

	test('realpath failure degrades to the lexical resolve (never throws)', () => {
		const dir = tmp('fallback');
		// Note: mkdirSync keeps the directory real; only the realpath CALL fails.
		mkdirSync(dir, { recursive: true });
		_internals.realpathSync = () => {
			throw new Error('injected realpath failure');
		};
		expect(() => canonicalProjectKey(dir)).not.toThrow();
		const expected =
			process.platform === 'win32'
				? path.resolve(dir).toLowerCase()
				: path.resolve(dir);
		expect(canonicalProjectKey(dir)).toBe(expected);
		rmSync(dir, { recursive: true, force: true });
	});

	test('a nonexistent path still yields a stable lexical key', () => {
		withFrozenClock(() => {});
		const ghost = path.join(canonicalTmpDir(), `canonical-ghost-${Date.now()}`);
		const key = canonicalProjectKey(ghost);
		expect(key.length).toBeGreaterThan(0);
		expect(canonicalProjectKey(ghost)).toBe(key);
	});
});
