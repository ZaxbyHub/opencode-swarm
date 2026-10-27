/**
 * The macOS executor passes the SBPL profile INLINE (`sandbox-exec -p`), never
 * staged in a file (#3462 review F-001).
 *
 * The write grant covers the temp dir, so a profile file staged under it could
 * be rewritten by a still-running sandboxed process before a later call's
 * `sandbox-exec -f` read it, and every call also left a file behind. With the
 * profile in argv there is nothing on disk to race or to accumulate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	MacOSSandboxExecutor,
	_internals as macInternals,
} from '../../../src/sandbox/macos/sandbox-exec-executor';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const originalPlatform = process.platform;
const originalProbe = macInternals.probeSandboxExec;

beforeEach(() => {
	Object.defineProperty(process, 'platform', {
		value: 'darwin',
		configurable: true,
	});
	macInternals.probeSandboxExec = () => true;
	macInternals.resetProbeMemo();
});

afterEach(() => {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
	macInternals.probeSandboxExec = originalProbe;
	macInternals.resetProbeMemo();
});

describe('wrapCommand() passes the profile inline', () => {
	test('the wrapped command carries the profile via -p and no -f profile file', () => {
		const wrapped = new MacOSSandboxExecutor(['/scope']).wrapCommand(
			'echo hello',
			[],
		);
		expect(wrapped).toMatch(/sandbox-exec -p '[\s\S]+' bash -c '/);
		expect(wrapped).not.toContain(' -f ');
		expect(wrapped).toContain('(deny file-write*)');
		expect(wrapped).toContain('(subpath "/scope")');
	});

	test('wrapCommand stages nothing in the temp dir', () => {
		const tmpRoot = canonicalMkdtemp('sbpl-wrap-');
		const saved = {
			TMPDIR: process.env.TMPDIR,
			TMP: process.env.TMP,
			TEMP: process.env.TEMP,
		};
		try {
			process.env.TMPDIR = tmpRoot;
			process.env.TMP = tmpRoot;
			process.env.TEMP = tmpRoot;
			new MacOSSandboxExecutor(['/scope']).wrapCommand('echo hello', []);
			expect(fs.readdirSync(tmpRoot)).toEqual([]);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			removeTreeWithRetry(tmpRoot);
		}
	});

	test('a scope path with a single quote, a double quote and a backslash round-trips through the quoting', () => {
		const hostile = `/scope/it's "q" \\b`;
		const wrapped = new MacOSSandboxExecutor([]).wrapCommand('echo hello', [
			hostile,
		]);
		// SBPL layer: " and \ are escaped; shell layer: ' is closed and reopened.
		const sbpl = `/scope/it's \\"q\\" \\\\b`;
		const shell = sbpl.replace(/'/g, `'\\''`);
		expect(wrapped).toContain(`(subpath "${shell}")`);
	});
});
