import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkingDirectory } from './resolve-working-directory';

let tmpDir: string;
let subDir: string;
let otherDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rwd-anchor-test-'));
	const { mkdirSync } = require('node:fs');
	subDir = path.join(tmpDir, 'src');
	mkdirSync(subDir, { recursive: true });
	// A second, sibling temp directory — exists and is absolute on every
	// platform (unlike a hardcoded '/tmp', which doesn't resolve on Windows),
	// and guaranteed not to be a subdirectory of tmpDir.
	otherDir = mkdtempSync(path.join(os.tmpdir(), 'rwd-other-'));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	try {
		rmSync(otherDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('resolveWorkingDirectory project root anchor (issue #577 regression)', () => {
	it('rejects working_directory pointing to a subdirectory', () => {
		const result = resolveWorkingDirectory(subDir, tmpDir);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('project root');
		}
	});

	it('accepts working_directory pointing to a different absolute path that is not a subdirectory', () => {
		const result = resolveWorkingDirectory(otherDir, tmpDir);
		// otherDir is a valid directory and is not a subdirectory of the project root, so it should be accepted
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(path.resolve(otherDir));
		}
	});

	it('accepts working_directory matching the project root exactly', () => {
		const result = resolveWorkingDirectory(tmpDir, tmpDir);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(path.resolve(tmpDir));
		}
	});

	it('returns fallback directory when working_directory is omitted', () => {
		const result = resolveWorkingDirectory(undefined, tmpDir);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(tmpDir);
		}
	});

	it('returns fallback directory when working_directory is empty string', () => {
		const result = resolveWorkingDirectory('', tmpDir);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(tmpDir);
		}
	});

	it('rejects path traversal sequences', () => {
		const result = resolveWorkingDirectory('../other', tmpDir);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('..');
		}
	});

	it('rejects null bytes', () => {
		const result = resolveWorkingDirectory('/tmp/safe\0evil', tmpDir);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('null bytes');
		}
	});
});
