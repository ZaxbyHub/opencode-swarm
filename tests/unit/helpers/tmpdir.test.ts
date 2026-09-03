import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCanonicalPathWithinRoot } from '../../../src/utils/path-security.js';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir';

describe('canonicalTmpDir', () => {
	it('returns the realpath-resolved system temp directory', () => {
		expect(canonicalTmpDir()).toBe(fs.realpathSync(os.tmpdir()));
	});

	it('is already canonical (realpath is a no-op on the result)', () => {
		const dir = canonicalTmpDir();
		expect(fs.realpathSync(dir)).toBe(dir);
	});
});

describe('canonicalMkdtemp', () => {
	it('creates a directory that exists', () => {
		const dir = canonicalMkdtemp('swarm-tmpdir-helper-test-');
		try {
			expect(fs.existsSync(dir)).toBe(true);
			expect(fs.statSync(dir).isDirectory()).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns a directory whose name starts with the given prefix', () => {
		const prefix = 'swarm-tmpdir-helper-prefix-';
		const dir = canonicalMkdtemp(prefix);
		try {
			expect(path.basename(dir).startsWith(prefix)).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns an already realpath-resolved directory (no separate resolve needed)', () => {
		const dir = canonicalMkdtemp('swarm-tmpdir-helper-realpath-');
		try {
			expect(fs.realpathSync(dir)).toBe(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('creates the directory under the canonical tmp base', () => {
		const dir = canonicalMkdtemp('swarm-tmpdir-helper-base-');
		try {
			expect(isCanonicalPathWithinRoot(dir, canonicalTmpDir())).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
